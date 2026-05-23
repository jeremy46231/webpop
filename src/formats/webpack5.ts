import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';
import type { Format, ModuleId, ParsedBundle, RawModule } from '../types.js';
import { writeFileSync } from 'fs';
import { join, relative } from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Comment = { type: string; value: string };

/** Walk a Babel AST, BFS. Return true from visitor to skip that node's children. */
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

/** Extract ./src/utils/math.js from webpack banner: !*** ./src/utils/math.js ***! */
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

/** Require-shim param is always index 2 of the factory function's param list. */
function shimName(params: t.Node[]): string | null {
  const p = params[2];
  return p && t.isIdentifier(p) ? p.name : null;
}

function factoryOf(node: t.Node): { params: t.Node[]; body: t.BlockStatement } | null {
  if (
    (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) &&
    t.isBlockStatement(node.body)
  ) return { params: node.params, body: node.body };

  if (t.isObjectMethod(node) && t.isBlockStatement(node.body)) {
    return { params: node.params, body: node.body };
  }
  return null;
}

function needsShim(name: string | null): boolean {
  if (!name) return false;
  if (name === 'module' || name === 'exports') return false;
  return true;
}

function addParamShims(body: t.BlockStatement, params: t.Node[]): t.BlockStatement {
  const modName = params[0] && t.isIdentifier(params[0]) ? params[0].name : null;
  const expName = params[1] && t.isIdentifier(params[1]) ? params[1].name : null;
  const shims: t.Statement[] = [];
  if (needsShim(modName))
    shims.push(t.variableDeclaration('var', [
      t.variableDeclarator(t.identifier(modName!), t.identifier('module'))
    ]));
  if (needsShim(expName))
    shims.push(t.variableDeclaration('var', [
      t.variableDeclarator(t.identifier(expName!), t.identifier('exports'))
    ]));
  if (shims.length === 0) return body;
  return t.blockStatement([...shims, ...body.body]);
}

function makeModule(id: ModuleId, hintPath: string | null, node: t.Node): RawModule | null {
  const f = factoryOf(node);
  if (!f) return null;
  const body = addParamShims(f.body, f.params);
  return { id, hintPath, requireParamName: shimName(f.params), body };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseSource(source: string): t.File {
  return parse(source, {
    sourceType: 'script',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    attachComment: true,
  });
}

// ---------------------------------------------------------------------------
// Structural helpers for non-obvious bundle variants
// ---------------------------------------------------------------------------

/** Return the body statements of the outermost IIFE, if the bundle is wrapped in one. */
function getOuterIIFEBody(ast: t.File): t.Statement[] | null {
  for (const stmt of ast.program.body) {
    if (!t.isExpressionStatement(stmt)) continue;
    const expr = stmt.expression;
    if (!t.isCallExpression(expr) || expr.arguments.length !== 0) continue;
    const callee = expr.callee;
    if (
      (t.isArrowFunctionExpression(callee) || t.isFunctionExpression(callee)) &&
      t.isBlockStatement(callee.body)
    ) {
      return callee.body.body;
    }
  }
  return null;
}

/**
 * wp5 ESM dev bundles inline the entry module in a trailing zero-arg IIFE:
 *   var __webpack_exports__ = {};
 *   (() => { entry code })();
 */
function findInlinedEntry(
  stmts: t.Statement[],
): { body: t.BlockStatement; hintPath: string | null } | null {
  let seenExportsDecl = false;
  for (const stmt of stmts) {
    if (!seenExportsDecl) {
      if (
        t.isVariableDeclaration(stmt) &&
        stmt.declarations.some(
          d =>
            t.isIdentifier(d.id, { name: '__webpack_exports__' }) &&
            t.isObjectExpression(d.init) &&
            (d.init as t.ObjectExpression).properties.length === 0,
        )
      ) {
        seenExportsDecl = true;
      }
    } else if (
      t.isExpressionStatement(stmt) &&
      t.isCallExpression(stmt.expression) &&
      stmt.expression.arguments.length === 0
    ) {
      const callee = stmt.expression.callee;
      if (
        (t.isArrowFunctionExpression(callee) || t.isFunctionExpression(callee)) &&
        t.isBlockStatement(callee.body)
      ) {
        const body = callee.body;
        const hintPath = body.body.length > 0 ? bannerPath(body.body[0]) : null;
        return { body, hintPath };
      }
    }
  }
  return null;
}

/**
 * wp5 minified: bootstrap is a named function expression called immediately:
 *   !function r(n) { ... }(entryId)
 */
function findMinifiedEntry(stmts: t.Statement[]): ModuleId | null {
  for (const stmt of stmts) {
    if (!t.isExpressionStatement(stmt)) continue;
    let callExpr: t.CallExpression | null = null;

    if (
      t.isUnaryExpression(stmt.expression, { operator: '!' }) &&
      t.isCallExpression(stmt.expression.argument)
    ) {
      callExpr = stmt.expression.argument;
    } else if (t.isCallExpression(stmt.expression)) {
      callExpr = stmt.expression;
    }

    if (!callExpr) continue;
    if (!t.isFunctionExpression(callExpr.callee)) continue;
    if (callExpr.callee.params.length !== 1) continue;
    if (callExpr.arguments.length !== 1) continue;

    const arg = callExpr.arguments[0];
    if (t.isNumericLiteral(arg)) return arg.value;
    if (t.isStringLiteral(arg)) return arg.value;
  }
  return null;
}

/**
 * wp5 minified: module registry is a local variable whose value is an object of
 * function shorthands — e.g. `var t = { 889(t,e,r){…}, 243(t,e,r){…} }`.
 * Empty cache objects (var e = {}) are excluded by the factory-shape check.
 */
function findMinifiedModules(
  stmts: t.Statement[],
): t.ObjectExpression | t.ArrayExpression | null {
  for (const stmt of stmts) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const decl of stmt.declarations) {
      const init = decl.init;
      if (!init) continue;
      if (t.isObjectExpression(init) && isModuleFactoryObject(init)) return init;
      if (t.isArrayExpression(init) && isModuleFactoryArray(init)) return init;
    }
  }
  return null;
}

function isModuleFactoryObject(node: t.ObjectExpression): boolean {
  if (node.properties.length === 0) return false;
  const funcCount = node.properties.filter(prop => {
    if (t.isObjectMethod(prop)) return prop.params.length >= 1 && prop.params.length <= 3;
    if (t.isObjectProperty(prop)) {
      const v = prop.value;
      return t.isFunctionExpression(v) || t.isArrowFunctionExpression(v);
    }
    return false;
  }).length;
  return funcCount > 0 && funcCount >= node.properties.length * 0.8;
}

function isModuleFactoryArray(node: t.ArrayExpression): boolean {
  const elems = node.elements.filter(Boolean);
  if (elems.length === 0) return false;
  const funcCount = elems.filter(
    el => el && (t.isFunctionExpression(el) || t.isArrowFunctionExpression(el)),
  ).length;
  return funcCount > 0 && funcCount >= elems.length * 0.8;
}

/**
 * Some minified wp5 prod bundles (e.g. with large npm deps) use a regular
 * FunctionDeclaration for the bootstrap and inline the entry code directly:
 *   function r(e) { bootstrap }
 *   r.d = ...; r.o = ...;
 *   const result = r(543); ...  ← entry code
 *
 * Returns the entry body and the bootstrap function name (= require shim).
 */
function findBootstrapDeclAndInlineEntry(
  stmts: t.Statement[],
): { body: t.BlockStatement; requireName: string } | null {
  let bootstrapName: string | null = null;
  let bootstrapIdx = -1;

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    if (t.isFunctionDeclaration(stmt) && stmt.id && stmt.params.length === 1) {
      bootstrapName = stmt.id.name;
      bootstrapIdx = i;
      break;
    }
  }
  if (bootstrapIdx === -1 || bootstrapName === null) return null;

  const entryStmts: t.Statement[] = [];
  for (let i = bootstrapIdx + 1; i < stmts.length; i++) {
    const stmt = stmts[i];
    // Skip bootstrap property assignments:  r.X = ...  or  r.X = ..., r.Y = ...
    if (t.isExpressionStatement(stmt)) {
      const expr = stmt.expression;
      if (isBootstrapPropAssign(expr, bootstrapName)) continue;
      if (
        t.isSequenceExpression(expr) &&
        expr.expressions.every(e => isBootstrapPropAssign(e, bootstrapName!))
      )
        continue;
    }
    entryStmts.push(stmt);
  }

  if (entryStmts.length === 0) return null;
  return { body: t.blockStatement(entryStmts), requireName: bootstrapName };
}

function isBootstrapPropAssign(expr: t.Expression | t.Node, name: string): boolean {
  return (
    t.isAssignmentExpression(expr, { operator: '=' }) &&
    t.isMemberExpression(expr.left) &&
    t.isIdentifier((expr.left as t.MemberExpression).object, { name })
  );
}

// ---------------------------------------------------------------------------
// Core extraction
// ---------------------------------------------------------------------------

function extractModules(
  source: string,
): { modules: Map<ModuleId, RawModule>; entryId: ModuleId } {
  const ast = parseSource(source);
  let modulesNode: t.ObjectExpression | t.ArrayExpression | null = null;
  let entryId: ModuleId | null = null;
  let inlinedEntry: { body: t.BlockStatement; hintPath: string | null } | null = null;
  let bootstrapInlineEntry: { body: t.BlockStatement; requireName: string } | null = null;

  // Phase 1: named-identifier scan (dev bundles with __webpack_modules__)
  walk(ast, (node) => {
    if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id)) return;

    if (node.id.name === '__webpack_modules__' && node.init) {
      if (t.isObjectExpression(node.init) || t.isArrayExpression(node.init)) {
        modulesNode = node.init;
      }
    }

    if (node.id.name === '__webpack_exports__' && node.init) {
      if (
        t.isCallExpression(node.init) &&
        t.isIdentifier(node.init.callee, { name: '__webpack_require__' }) &&
        node.init.arguments.length === 1
      ) {
        const arg = node.init.arguments[0];
        if (t.isStringLiteral(arg)) entryId = arg.value;
        else if (t.isNumericLiteral(arg)) entryId = arg.value;
      }
    }
  });

  // Phase 2: structural scan for minified / ESM-with-inlined-entry variants
  const outerBody = getOuterIIFEBody(ast);
  if (outerBody) {
    if (!modulesNode) {
      modulesNode = findMinifiedModules(outerBody);
    }
    if (entryId === null) {
      inlinedEntry = findInlinedEntry(outerBody);
    }
    if (entryId === null && !inlinedEntry) {
      entryId = findMinifiedEntry(outerBody);
    }
    // Phase 3: some minified prod bundles use a FunctionDeclaration bootstrap
    // and inline the entry code directly in the outer IIFE body
    if (entryId === null && !inlinedEntry) {
      bootstrapInlineEntry = findBootstrapDeclAndInlineEntry(outerBody);
      if (bootstrapInlineEntry) {
        entryId = '__webpack_entry__';
      }
    }
  }

  const modules = new Map<ModuleId, RawModule>();

  if (modulesNode) {
    if (t.isObjectExpression(modulesNode)) {
      for (const prop of modulesNode.properties) {
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
      const elems = (modulesNode as t.ArrayExpression).elements;
      for (let i = 0; i < elems.length; i++) {
        const el = elems[i];
        if (!el) continue;
        const mod = makeModule(i, bannerPath(el), el);
        if (mod) modules.set(i, mod);
      }
    }
  }

  // Add the inlined entry module (wp5 ESM dev: entry lives outside __webpack_modules__)
  if (inlinedEntry) {
    const id: ModuleId = inlinedEntry.hintPath ?? '__webpack_entry__';
    entryId = id;
    modules.set(id, {
      id,
      hintPath: inlinedEntry.hintPath,
      requireParamName: '__webpack_require__',
      body: inlinedEntry.body,
    });
  }

  // Add the inline entry from a FunctionDeclaration bootstrap (minified prod bundles)
  if (bootstrapInlineEntry) {
    const id = '__webpack_entry__';
    modules.set(id, {
      id,
      hintPath: null,
      requireParamName: bootstrapInlineEntry.requireName,
      body: bootstrapInlineEntry.body,
    });
  }

  if (modules.size === 0) throw new Error('webpack5: could not find any modules');
  if (entryId === null) throw new Error('webpack5: could not find entry point');

  return { modules, entryId };
}

// ---------------------------------------------------------------------------
// Repack config
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

// ---------------------------------------------------------------------------
// Format export
// ---------------------------------------------------------------------------

export const webpack5: Format = {
  name: 'webpack5',

  detect(source) {
    // Dev: __webpack_modules__ appears as a variable declaration (not just in a comment)
    if (source.includes('var __webpack_modules__') && source.includes('__webpack_require__')) return true;
    // Minified prod: module registry stored as object with numeric shorthand methods
    // e.g.  var t = { 889(t,e,r){ ... }, 243(t,e,r){ ... } }
    return /\bvar\s+\w+\s*=\s*\{\s*\d+\s*\(/.test(source);
  },

  parse(source): ParsedBundle {
    const { modules, entryId } = extractModules(source);
    return { modules, entryId, formatName: 'webpack5' };
  },

  writeRepackConfig: repackConfig,
};
