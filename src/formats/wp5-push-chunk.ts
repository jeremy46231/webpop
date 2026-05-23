import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';
import type { Format, ModuleId, ParsedBundle, RawModule } from '../types.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Helpers (mirrored from webpack-chunk.ts — no shared utils across format files)
// ---------------------------------------------------------------------------

function walk(root: t.Node, visit: (n: t.Node) => boolean | void): void {
  const q: t.Node[] = [root];
  while (q.length) {
    const node = q.shift()!;
    if (visit(node)) continue;
    const keys = (VISITOR_KEYS as Record<string, readonly string[]>)[node.type];
    if (!keys) continue;
    for (const k of keys) {
      const v = (node as unknown as Record<string, unknown>)[k];
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
    if (i === 2) continue;
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
// Truncation recovery
// ---------------------------------------------------------------------------

/**
 * HAR exports often truncate files at exactly 1MB.  Find the last complete
 * module boundary by scanning backwards for `,0x<hexdigits>:` — the pattern
 * that separates module factory entries.  Everything before the LAST such
 * separator is complete; we discard the incomplete tail and close the structure.
 *
 * Using regex on the raw source sidesteps depth-counting issues with regex
 * literals that contain bracket characters.
 */
function repairTruncated(source: string): string {
  // Find the rightmost `,` that is followed (possibly with whitespace) by a
  // hex module key like `0x1f7196997:`.  That comma ends the last complete
  // factory; everything from that point on is the incomplete entry.
  const re = /,(?=\s*0x[0-9a-f]+\s*:)/gi;
  let lastIdx = -1;
  for (const m of source.matchAll(re)) lastIdx = m.index!;
  if (lastIdx === -1) return source;
  // source.slice(0, lastIdx) ends with the closing `}` of the last complete factory.
  // Append `}])` to close: modules object `}`, push-array `]`, push call `)`.
  return source.slice(0, lastIdx) + '}])';
}

// ---------------------------------------------------------------------------
// Core extraction
// ---------------------------------------------------------------------------

/**
 * Extract modules from a Slack-style wp5 push chunk.
 * Format: (globalThis.webpackChunkwebapp=...).push([[chunkIds], {hexId: factory, ...}])
 * Handles files truncated at 1MB by browser HAR export.
 */
export function parseChunkModules(source: string): { modules: Map<ModuleId, RawModule>; chunkName: string | null } {
  let src = source;
  let ast;
  try {
    ast = parse(src, {
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      errorRecovery: true,
    });
    if ((ast.errors?.length ?? 0) > 0 && source.length === 1048576) throw new Error('truncated');
  } catch {
    src = repairTruncated(source);
    try {
      ast = parse(src, {
        sourceType: 'script',
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        errorRecovery: true,
      });
    } catch { return { modules: new Map(), chunkName: null }; }
  }

  let modulesObj: t.ObjectExpression | null = null;
  let chunkName: string | null = null;

  walk(ast, (node) => {
    if (modulesObj) return true;

    // Looking for: something.push([chunkIdsArray, modulesObject, ...])
    if (!t.isCallExpression(node)) return;
    const { callee, arguments: args } = node;
    if (
      !t.isMemberExpression(callee) ||
      !t.isIdentifier((callee as t.MemberExpression).property, { name: 'push' })
    ) return;

    if (args.length !== 1) return;
    const arg = args[0];
    if (!t.isArrayExpression(arg) || arg.elements.length < 2) return;

    // First element: array of chunk IDs
    const firstEl = arg.elements[0];
    if (!firstEl || !t.isArrayExpression(firstEl)) return;

    // Second element: the modules object with hex-keyed factories
    const secondEl = arg.elements[1];
    if (!secondEl || !t.isObjectExpression(secondEl)) return;

    // Verify it looks like module factories (at least one function-valued property)
    const hasFactories = (secondEl as t.ObjectExpression).properties.some(prop => {
      if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) return false;
      if (t.isObjectMethod(prop)) return true;
      const v = (prop as t.ObjectProperty).value;
      return t.isFunctionExpression(v) || t.isArrowFunctionExpression(v);
    });
    if (!hasFactories) return;

    // Extract the first chunk ID string from the chunk IDs array
    const firstChunkIdEl = (firstEl as t.ArrayExpression).elements[0];
    if (firstChunkIdEl && t.isStringLiteral(firstChunkIdEl)) {
      chunkName = firstChunkIdEl.value;
    }

    modulesObj = secondEl as t.ObjectExpression;
    return true;
  });

  if (!modulesObj) return { modules: new Map(), chunkName: null };

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

  return { modules, chunkName };
}

// ---------------------------------------------------------------------------
// Repack config
// ---------------------------------------------------------------------------

function repackConfig(
  bundle: ParsedBundle,
  outDir: string,
  _outputPaths: Map<ModuleId, string>,
): void {
  const chunkArg = bundle.chunkName ? ` # chunk: ${bundle.chunkName}` : '';
  writeFileSync(
    join(outDir, 'repack.sh'),
    `#!/bin/sh
# Reconstructs the webpack push-chunk file from the unpacked modules.
# Usage: sh repack.sh
webpop repack-push-chunk "$(dirname "$0")"${chunkArg}
`,
  );
}

// ---------------------------------------------------------------------------
// Format export
// ---------------------------------------------------------------------------

export const wp5PushChunk: Format = {
  name: 'wp5-push-chunk',

  detect(source) {
    return /webpackChunk\w+\s*=/.test(source) && source.includes('.push([');
  },

  parse(source): ParsedBundle {
    const { modules, chunkName } = parseChunkModules(source);

    if (modules.size === 0) {
      throw new Error('wp5-push-chunk: could not find any module factories in .push() call');
    }

    const ENTRY_ID: ModuleId = '__chunk_init__';
    modules.set(ENTRY_ID, {
      id: ENTRY_ID,
      hintPath: 'chunk_init.js',
      requireParamName: null,
      body: { type: 'BlockStatement', body: [], directives: [] },
    });

    return { modules, entryId: ENTRY_ID, formatName: 'wp5-push-chunk', chunkName: chunkName ?? undefined };
  },

  writeRepackConfig: repackConfig,
};
