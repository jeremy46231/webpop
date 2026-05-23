/**
 * Parser for webpack 3 and webpack 4 bundles.
 *
 * These bundles use a bootstrap IIFE that receives the module registry as an
 * argument, rather than storing it in a named variable like webpack 5:
 *
 *   Dev:      (function(modules) { bootstrap })({"./src/foo.js": function(...){...}, ...})
 *   Minified: !function(e) { bootstrap }([function(...){...}, ...])
 *
 * Entry detection: the bootstrap calls `__webpack_require__(__webpack_require__.s = ID)`
 * or in minified form `o(o.s = ID)`.
 */

import { writeFileSync } from 'fs';
import { join, relative } from 'path';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';
import type { Format, ModuleId, ParsedBundle, RawModule } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers (self-contained — no shared utils between format files)
// ---------------------------------------------------------------------------

type Comment = { type: string; value: string };

function walk(root: t.Node, visit: (n: t.Node) => boolean | void): void {
  const q: t.Node[] = [root];
  while (q.length) {
    const node = q.shift()!;
    if (visit(node)) continue;
    const keys = (VISITOR_KEYS as Record<string, readonly string[]>)[node.type];
    if (!keys) continue;
    for (const k of keys) {
      const v = (node as Record<string, unknown>)[k];
      if (Array.isArray(v)) {
        for (const c of v) if (c && (c as t.Node).type) q.push(c as t.Node);
      } else if (v && (v as t.Node).type) {
        q.push(v as t.Node);
      }
    }
  }
}

function bannerPath(node: t.Node): string | null {
  const comments = ((node as Record<string, unknown>).leadingComments ?? []) as Comment[];
  for (const c of comments) {
    if (c.type === 'CommentBlock') {
      const m = c.value.match(/!\*+\s+(\.\/\S+?)\s+\*+!/);
      if (m) return m[1];
    }
  }
  return null;
}

function shimName(params: t.Node[]): string | null {
  const p = params[2];
  return p && t.isIdentifier(p) ? p.name : null;
}

function factoryOf(node: t.Node): { params: t.Node[]; body: t.BlockStatement } | null {
  if (
    (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) &&
    t.isBlockStatement(node.body)
  )
    return { params: node.params, body: node.body };
  if (t.isObjectMethod(node) && t.isBlockStatement(node.body))
    return { params: node.params, body: node.body };
  return null;
}

const WEBPACK_PARAM_NAMES = ['module', 'exports', '__webpack_require__'];

function addParamShims(body: t.BlockStatement, params: t.Node[]): t.BlockStatement {
  const shims: t.Statement[] = [];
  for (let i = 0; i < Math.min(params.length, 3); i++) {
    const p = params[i];
    if (!t.isIdentifier(p)) continue;
    if (p.name === WEBPACK_PARAM_NAMES[i]) continue;
    shims.push(t.variableDeclaration('var', [
      t.variableDeclarator(t.identifier(p.name), t.identifier(WEBPACK_PARAM_NAMES[i])),
    ]));
  }
  if (shims.length === 0) return body;
  return t.blockStatement([...shims, ...body.body]);
}

function makeModule(id: ModuleId, hintPath: string | null, node: t.Node): RawModule | null {
  const f = factoryOf(node);
  if (!f) return null;
  const body = addParamShims(f.body, f.params);
  return { id, hintPath, requireParamName: shimName(f.params), body };
}

function parseSource(source: string): t.File {
  return parse(source, {
    sourceType: 'script',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    attachComment: true,
  });
}

// ---------------------------------------------------------------------------
// Bootstrap IIFE detection
// ---------------------------------------------------------------------------

/**
 * Find the `(function(modules){...})(arg)` or `!function(modules){...}(arg)` IIFE
 * that is the webpack 3/4 bootstrap wrapper. Returns both the modules argument
 * and the bootstrap function body.
 */
function findBootstrapIIFE(
  ast: t.File,
): { modulesArg: t.ObjectExpression | t.ArrayExpression; bootstrapBody: t.BlockStatement } | null {
  for (const stmt of ast.program.body) {
    if (!t.isExpressionStatement(stmt)) continue;
    let expr: t.Expression = stmt.expression;

    // !function(modules){...}(arg)  →  strip the leading !
    if (t.isUnaryExpression(expr, { operator: '!' }) && t.isCallExpression(expr.argument)) {
      expr = expr.argument;
    }

    if (!t.isCallExpression(expr)) continue;

    const callee = expr.callee;
    if (!t.isFunctionExpression(callee)) continue;
    if (callee.params.length !== 1) continue;
    if (!t.isBlockStatement(callee.body)) continue;

    if (expr.arguments.length !== 1) continue;
    const arg = expr.arguments[0];
    if (!t.isObjectExpression(arg) && !t.isArrayExpression(arg)) continue;

    return { modulesArg: arg, bootstrapBody: callee.body };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry-point extraction
// ---------------------------------------------------------------------------

/**
 * Walk the bootstrap body to find:
 *   __webpack_require__(__webpack_require__.s = ID)   (dev)
 *   o(o.s = ID)                                        (minified)
 *
 * The pattern is: CallExpression whose single argument is an assignment
 * `X.s = LITERAL`.
 */
function findLegacyEntry(body: t.BlockStatement): ModuleId | null {
  let entryId: ModuleId | null = null;

  walk(body, (node) => {
    if (!t.isCallExpression(node)) return;
    if (node.arguments.length !== 1) return;

    const arg = node.arguments[0];
    if (!t.isAssignmentExpression(arg, { operator: '=' })) return;

    const left = arg.left;
    if (
      !t.isMemberExpression(left) ||
      left.computed ||
      !t.isIdentifier(left.property, { name: 's' })
    )
      return;

    const right = arg.right;
    if (t.isStringLiteral(right)) {
      entryId = right.value;
      return true;
    }
    if (t.isNumericLiteral(right)) {
      entryId = right.value;
      return true;
    }
  });

  return entryId;
}

// ---------------------------------------------------------------------------
// Module extraction
// ---------------------------------------------------------------------------

function extractModules(
  source: string,
): { modules: Map<ModuleId, RawModule>; entryId: ModuleId } {
  const ast = parseSource(source);

  const bootstrap = findBootstrapIIFE(ast);
  if (!bootstrap) throw new Error('webpackLegacy: could not find bootstrap IIFE');

  const { modulesArg, bootstrapBody } = bootstrap;

  const entryId = findLegacyEntry(bootstrapBody);
  if (entryId === null) throw new Error('webpackLegacy: could not find entry point (.s assignment)');

  const modules = new Map<ModuleId, RawModule>();

  if (t.isObjectExpression(modulesArg)) {
    for (const prop of modulesArg.properties) {
      if (!t.isObjectMethod(prop) && !t.isObjectProperty(prop)) continue;
      const key = (prop as t.ObjectMethod | t.ObjectProperty).key;
      let id: ModuleId;
      if (t.isStringLiteral(key)) id = key.value;
      else if (t.isNumericLiteral(key)) id = key.value;
      else continue;
      const hintPath = typeof id === 'string' ? id : bannerPath(prop);
      const valueNode = t.isObjectMethod(prop)
        ? prop
        : ((prop as t.ObjectProperty).value as t.Node);
      const mod = makeModule(id, hintPath, valueNode);
      if (mod) modules.set(id, mod);
    }
  } else {
    for (let i = 0; i < modulesArg.elements.length; i++) {
      const el = modulesArg.elements[i];
      if (!el) continue;
      const mod = makeModule(i, bannerPath(el), el);
      if (mod) modules.set(i, mod);
    }
  }

  if (modules.size === 0) throw new Error('webpackLegacy: no modules found in bundle');

  return { modules, entryId };
}

// ---------------------------------------------------------------------------
// Format export
// ---------------------------------------------------------------------------

function repackConfig(
  bundle: ParsedBundle,
  outDir: string,
  outputPaths: Map<ModuleId, string>,
): void {
  const entryAbs = outputPaths.get(bundle.entryId)!;
  const entryRel = './' + relative(outDir, entryAbs);

  const isNamed = [...bundle.modules.values()].some(m => typeof m.id === 'string');
  const moduleIds = isNamed ? 'named' : 'size';

  writeFileSync(
    join(outDir, 'webpack.config.js'),
    `const path = require('path');
module.exports = {
  mode: 'development',
  devtool: false,
  entry: ${JSON.stringify(entryRel)},
  output: { path: path.resolve(__dirname, 'dist'), filename: 'bundle.js', iife: true },
  optimization: { moduleIds: ${JSON.stringify(moduleIds)}, runtimeChunk: false },
  target: 'node',
};\n`,
  );

  writeFileSync(
    join(outDir, 'package.json'),
    JSON.stringify(
      {
        name: 'webpop-repacked',
        version: '1.0.0',
        private: true,
        scripts: { build: 'webpack' },
        devDependencies: { webpack: '^5.0.0', 'webpack-cli': '^5.0.0' },
      },
      null,
      2,
    ) + '\n',
  );
}

export const webpackLegacy: Format = {
  name: 'webpackLegacy',

  detect(source) {
    // wp5 declares __webpack_modules__ as a variable; leave those for the wp5 parser.
    if (source.includes('var __webpack_modules__')) return false;

    // Dev bundles: __webpack_require__ identifier is preserved literally.
    if (source.includes('__webpack_require__')) return true;

    // Minified bundles: all identifiers renamed, but the bundle starts with
    // `!function(` and contains `.s=` (the entry assignment shorthand).
    const trimmed = source.trimStart();
    return (trimmed.startsWith('!function(') || trimmed.startsWith('(function(')) &&
      /\.\s*s\s*=/.test(source);
  },

  parse(source): ParsedBundle {
    const { modules, entryId } = extractModules(source);
    return { modules, entryId, formatName: 'webpackLegacy' };
  },

  writeRepackConfig: repackConfig,
};
