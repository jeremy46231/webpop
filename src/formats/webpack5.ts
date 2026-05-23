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

function makeModule(id: ModuleId, hintPath: string | null, node: t.Node): RawModule | null {
  const f = factoryOf(node);
  if (!f) return null;
  return { id, hintPath, requireParamName: shimName(f.params), body: f.body };
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

function extractModules(source: string): { modules: Map<ModuleId, RawModule>; entryId: ModuleId } {
  const ast = parseSource(source);
  let modulesNode: t.ObjectExpression | t.ArrayExpression | null = null;
  let entryId: ModuleId | null = null;

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

  if (!modulesNode) throw new Error('webpack5: could not find __webpack_modules__');
  if (entryId === null) throw new Error('webpack5: could not find entry point');

  const modules = new Map<ModuleId, RawModule>();

  if (t.isObjectExpression(modulesNode)) {
    for (const prop of modulesNode.properties) {
      if (!t.isObjectMethod(prop) && !t.isObjectProperty(prop)) continue;
      const key = prop.key;
      if (!t.isStringLiteral(key)) continue;
      const id = key.value;
      const valueNode = t.isObjectMethod(prop) ? prop : (prop as t.ObjectProperty).value as t.Node;
      const mod = makeModule(id, id, valueNode);
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
    return source.includes('__webpack_modules__') && source.includes('__webpack_require__');
  },

  parse(source): ParsedBundle {
    const { modules, entryId } = extractModules(source);
    return { modules, entryId, formatName: 'webpack5' };
  },

  writeRepackConfig: repackConfig,
};
