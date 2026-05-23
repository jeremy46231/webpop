/**
 * Parser for webpack 5 async chunk files.
 *
 * Chunk files are NOT standalone bundles — they are supplementary files loaded
 * at runtime by an async-split main bundle.  Their structure is:
 *
 *   "use strict";
 *   exports.id = 694,
 *   exports.ids = [694],
 *   exports.modules = { 609(t, e, s) { ... } };
 *
 * Usage: pass chunk file paths alongside the main bundle on the CLI.
 * The unpack layer merges the extracted modules into the main bundle's map.
 */

import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';
import type { ModuleId, RawModule } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers (mirrored from webpack5.ts — no shared utils across format files)
// ---------------------------------------------------------------------------

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

function makeModule(id: ModuleId, node: t.Node): RawModule | null {
  const f = factoryOf(node);
  if (!f) return null;
  const body = addParamShims(f.body, f.params);
  return { id, hintPath: null, requireParamName: shimName(f.params), body };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isChunk(source: string): boolean {
  return source.includes('exports.ids') && source.includes('exports.modules');
}

export function parseChunkModules(source: string): Map<ModuleId, RawModule> {
  const ast = parse(source, {
    sourceType: 'script',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  });

  let modulesObj: t.ObjectExpression | null = null;

  walk(ast, (node) => {
    if (!t.isAssignmentExpression(node, { operator: '=' })) return;
    const { left, right } = node;
    if (
      t.isMemberExpression(left) &&
      t.isIdentifier((left as t.MemberExpression).object, { name: 'exports' }) &&
      t.isIdentifier((left as t.MemberExpression).property, { name: 'modules' }) &&
      t.isObjectExpression(right)
    ) {
      modulesObj = right;
      return true; // stop after first match
    }
  });

  if (!modulesObj) throw new Error('webpack chunk: could not find exports.modules');

  const modules = new Map<ModuleId, RawModule>();
  for (const prop of (modulesObj as t.ObjectExpression).properties) {
    if (!t.isObjectMethod(prop) && !t.isObjectProperty(prop)) continue;
    const key = (prop as t.ObjectMethod | t.ObjectProperty).key;
    let id: ModuleId;
    if (t.isStringLiteral(key)) id = key.value;
    else if (t.isNumericLiteral(key)) id = key.value;
    else continue;
    const valueNode = t.isObjectMethod(prop) ? prop : ((prop as t.ObjectProperty).value as t.Node);
    const mod = makeModule(id, valueNode);
    if (mod) modules.set(id, mod);
  }

  return modules;
}
