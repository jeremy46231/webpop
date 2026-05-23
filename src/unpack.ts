import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, relative, resolve } from 'path';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';
import _generate from '@babel/generator';
import { detectAndParse, getFormat } from './detect.js';
import type { ModuleId, ParsedBundle, RawModule } from './types.js';

const generate = ((_generate as unknown as Record<string, unknown>).default ?? _generate) as typeof _generate;

// ---------------------------------------------------------------------------
// AST transform pipeline
//
// Each pass is a pure function: (BlockStatement, context) -> BlockStatement.
// Passes run in order. Future passes (identifier renaming, etc.) plug in here.
// ---------------------------------------------------------------------------

type TransformPass = (body: t.BlockStatement, ctx: TransformContext) => t.BlockStatement;

interface TransformContext {
  mod: RawModule;
  resolveId: (id: ModuleId) => string;
}

/** Replace requireParamName(id) calls with require("resolved/path") nodes. */
const replaceRequireCalls: TransformPass = (body, { mod, resolveId }) => {
  if (!mod.requireParamName) return body;
  return transformNode(body, mod.requireParamName, resolveId) as t.BlockStatement;
};

const PASSES: TransformPass[] = [
  replaceRequireCalls,
  // future: renameIdentifiers, inlineConstants, ...
];

// ---------------------------------------------------------------------------
// Pure functional AST node transformer
// Returns the same node reference if nothing changed.
// ---------------------------------------------------------------------------

function transformNode(
  node: t.Node,
  shimName: string,
  resolveId: (id: ModuleId) => string,
): t.Node {
  // Replace shimName(id) → require("path")
  if (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee, { name: shimName }) &&
    node.arguments.length === 1
  ) {
    const arg = node.arguments[0];
    let id: ModuleId | null = null;
    if (t.isStringLiteral(arg)) id = arg.value;
    else if (t.isNumericLiteral(arg)) id = arg.value;
    if (id !== null) {
      return t.callExpression(t.identifier('require'), [t.stringLiteral(resolveId(id))]);
    }
  }

  const keys = (VISITOR_KEYS as Record<string, readonly string[]>)[node.type];
  if (!keys) return node;

  let changed = false;
  const updates: Record<string, unknown> = {};

  for (const key of keys) {
    const child = (node as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      let arrChanged = false;
      const next = (child as unknown[]).map(item => {
        if (!item || !(item as t.Node).type) return item;
        const t2 = transformNode(item as t.Node, shimName, resolveId);
        if (t2 !== item) arrChanged = true;
        return t2;
      });
      if (arrChanged) { updates[key] = next; changed = true; }
    } else if (child && (child as t.Node).type) {
      const t2 = transformNode(child as t.Node, shimName, resolveId);
      if (t2 !== child) { updates[key] = t2; changed = true; }
    }
  }

  return changed ? { ...node, ...updates } : node;
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

function generateModule(mod: RawModule, resolveId: (id: ModuleId) => string): string {
  const ctx: TransformContext = { mod, resolveId };
  const transformed = PASSES.reduce((body, pass) => pass(body, ctx), mod.body);
  const { code } = generate(t.program(transformed.body));
  return code + '\n';
}

// ---------------------------------------------------------------------------
// Output path assignment
// ---------------------------------------------------------------------------

function assignOutputPaths(bundle: ParsedBundle, outDir: string): Map<ModuleId, string> {
  const map = new Map<ModuleId, string>();
  for (const [id, mod] of bundle.modules) {
    const p = mod.hintPath
      ? resolve(join(outDir, mod.hintPath.replace(/^\.\//, '')))
      : resolve(join(outDir, `module_${id}.js`));
    map.set(id, p);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UnpackResult {
  formatName: string;
  moduleCount: number;
  entryId: ModuleId;
  outDir: string;
}

export function unpack(bundlePath: string, outDir: string): UnpackResult {
  const source = readFileSync(bundlePath, 'utf8');
  const bundle = detectAndParse(source);
  const outputPaths = assignOutputPaths(bundle, outDir);

  for (const [id, mod] of bundle.modules) {
    const myPath = outputPaths.get(id)!;
    const resolveId = (depId: ModuleId): string => {
      const target = outputPaths.get(depId);
      if (!target) return `./unknown_${depId}`;
      let rel = relative(dirname(myPath), target);
      if (!rel.startsWith('.')) rel = './' + rel;
      return rel;
    };

    const code = generateModule(mod, resolveId);
    mkdirSync(dirname(myPath), { recursive: true });
    writeFileSync(myPath, code);
  }

  // Let the format write its repack config if it knows how
  const fmt = getFormat(bundle.formatName);
  mkdirSync(outDir, { recursive: true });
  fmt?.writeRepackConfig?.(bundle, outDir, outputPaths);

  return { formatName: bundle.formatName, moduleCount: bundle.modules.size, entryId: bundle.entryId, outDir };
}
