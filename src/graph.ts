/**
 * Import graph utilities: parse require() calls in extracted module files,
 * build a directed graph, and compute which nodes are exclusively reachable
 * through a given module (so they can be cleaned up when that module is
 * replaced by an npm proxy).
 */

import { readFileSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';

function walkForRequires(filePath: string): string[] {
  let src: string;
  try { src = readFileSync(filePath, 'utf8'); } catch { return []; }
  let ast: t.File;
  try {
    ast = parse(src, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, errorRecovery: true });
  } catch { return []; }

  const required: string[] = [];
  const q: t.Node[] = [ast];
  while (q.length) {
    const node = q.shift()!;
    if (
      t.isCallExpression(node) &&
      t.isIdentifier(node.callee, { name: 'require' }) &&
      node.arguments.length === 1 &&
      t.isStringLiteral(node.arguments[0])
    ) {
      const val = node.arguments[0].value;
      if (val.startsWith('.')) required.push(val);
    }
    const keys = (VISITOR_KEYS as Record<string, readonly string[]>)[node.type];
    if (!keys) continue;
    for (const k of keys) {
      const v = (node as unknown as Record<string, unknown>)[k];
      if (Array.isArray(v)) {
        for (const c of v) if (c && (c as t.Node).type) q.push(c as t.Node);
      } else if (v && (v as t.Node).type) q.push(v as t.Node);
    }
  }
  return required;
}

/**
 * Build a directed import graph.
 * Keys and values are relative paths from outDir (e.g. 'module_589.js').
 * Only edges to files in `relFiles` are tracked; npm requires are ignored.
 */
export function buildImportGraph(relFiles: string[], outDir: string): Map<string, Set<string>> {
  const absOut = resolve(outDir);
  const fileSet = new Set(relFiles);
  const graph = new Map<string, Set<string>>();
  for (const f of relFiles) graph.set(f, new Set());

  for (const f of relFiles) {
    const absFile = join(absOut, f);
    const rawRequires = walkForRequires(absFile);
    for (const req of rawRequires) {
      const absResolved = resolve(dirname(absFile), req);
      let rel = relative(absOut, absResolved).replace(/\\/g, '/');
      if (!fileSet.has(rel) && fileSet.has(rel + '.js')) rel = rel + '.js';
      if (fileSet.has(rel)) graph.get(f)!.add(rel);
    }
  }
  return graph;
}

/** BFS from `start`, following all edges. Returns all reachable nodes (including start). */
export function reachableFrom(start: string, graph: Map<string, Set<string>>): Set<string> {
  const visited = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const node = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const dep of graph.get(node) ?? []) queue.push(dep);
  }
  return visited;
}

/**
 * BFS from `start`, but treat `deadEnd` as a leaf — visit it but don't
 * follow its outgoing edges. Used to compute what is still reachable after
 * `deadEnd` becomes a proxy with no internal requires.
 */
export function reachableFromExcluding(
  start: string,
  graph: Map<string, Set<string>>,
  deadEnd: string,
): Set<string> {
  const visited = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const node = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node === deadEnd) continue;
    for (const dep of graph.get(node) ?? []) queue.push(dep);
  }
  return visited;
}

/**
 * Returns the set of modules that are exclusively covered by `target` —
 * reachable from `target` but NOT reachable from `entry` once `target`
 * becomes a proxy (dead end in the graph).  The target itself is excluded.
 */
export function findExclusivelyCovered(
  entry: string,
  target: string,
  graph: Map<string, Set<string>>,
): Set<string> {
  const stillReachable = reachableFromExcluding(entry, graph, target);
  const fromTarget = reachableFrom(target, graph);
  const result = new Set<string>();
  for (const node of fromTarget) {
    if (node !== target && !stillReachable.has(node)) result.add(node);
  }
  return result;
}
