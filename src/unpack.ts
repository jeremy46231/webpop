import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, relative, resolve, basename } from 'path';
import { writeManifest } from './manifest.js';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';
import _generate from '@babel/generator';
import { detectAndParse, getFormat } from './detect.js';
import { isChunk, parseChunkModules } from './formats/webpack-chunk.js';
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

/**
 * Convert webpack's ESM export runtime helpers to plain CJS so that the
 * repacked bundle doesn't need __webpack_require__.d / .r in scope:
 *
 *   reqName.r(target)                    → (removed)
 *   reqName.d(target, {k: () => v, …})  → target.k = v  (one per entry)
 *
 * These calls appear at the top level of ESM module bodies (both dev and
 * minified).  Handling them here means the repacked bundle stays CJS-clean.
 */
const replaceWebpackHelpers: TransformPass = (body, { mod }) => {
  if (!mod.requireParamName) return body;
  const req = mod.requireParamName;

  // Export assignments are moved to the END of the body so that `const`
  // bindings are initialized before they're assigned to exports.
  const newStmts: t.Statement[] = [];
  const exportAssignments: t.Statement[] = [];

  for (const stmt of body.body) {
    if (!t.isExpressionStatement(stmt)) { newStmts.push(stmt); continue; }
    const expr = stmt.expression;
    if (!t.isCallExpression(expr)) { newStmts.push(stmt); continue; }
    const { callee, arguments: args } = expr;
    if (!t.isMemberExpression(callee)) { newStmts.push(stmt); continue; }
    const obj = (callee as t.MemberExpression).object;
    const prop = (callee as t.MemberExpression).property;
    if (!t.isIdentifier(obj, { name: req })) { newStmts.push(stmt); continue; }

    if (t.isIdentifier(prop, { name: 'r' })) {
      // reqName.r(target) — marks module as ESM; drop it
      continue;
    }

    if (t.isIdentifier(prop, { name: 'd' }) && args.length >= 2) {
      // wp5: reqName.d(target, {k: () => v})
      // wp4: reqName.d(target, "k", function() { return v; })
      const target = args[0] as t.Expression;

      const extractValue = (v: t.Node): t.Expression | null => {
        if ((t.isArrowFunctionExpression(v) || t.isFunctionExpression(v)) && !t.isBlockStatement(v.body))
          return v.body as t.Expression;
        if ((t.isArrowFunctionExpression(v) || t.isFunctionExpression(v)) && t.isBlockStatement(v.body)) {
          const ss = (v.body as t.BlockStatement).body;
          if (ss.length === 1 && t.isReturnStatement(ss[0]) && ss[0].argument) return ss[0].argument;
        }
        return null;
      };

      if (args.length === 2 && t.isObjectExpression(args[1])) {
        // webpack 5 form
        for (const dp of (args[1] as t.ObjectExpression).properties) {
          if (!t.isObjectProperty(dp) && !t.isObjectMethod(dp)) continue;
          const key = (dp as t.ObjectProperty | t.ObjectMethod).key;
          let keyExpr: t.Expression | null = null;
          if (t.isIdentifier(key)) keyExpr = t.identifier(key.name);
          else if (t.isStringLiteral(key)) keyExpr = t.stringLiteral(key.value);
          if (!keyExpr) continue;
          const value = t.isObjectProperty(dp) ? extractValue((dp as t.ObjectProperty).value) : null;
          if (value)
            exportAssignments.push(t.expressionStatement(
              t.assignmentExpression('=', t.memberExpression(target, keyExpr, t.isStringLiteral(keyExpr)), value),
            ));
        }
      } else if (args.length === 3 && (t.isStringLiteral(args[1]) || t.isIdentifier(args[1]))) {
        // webpack 4 form: reqName.d(target, "key", getter)
        const keyName = t.isStringLiteral(args[1]) ? args[1].value : (args[1] as t.Identifier).name;
        const value = extractValue(args[2]);
        if (value)
          exportAssignments.push(t.expressionStatement(
            t.assignmentExpression('=', t.memberExpression(target, t.identifier(keyName)), value),
          ));
      }
      continue;
    }

    newStmts.push(stmt);
  }
  return t.blockStatement([...newStmts, ...exportAssignments]);
};

const PASSES: TransformPass[] = [
  replaceWebpackHelpers,
  replaceRequireCalls,
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

  // shimName.n(m) → Object.assign(()=>m, {a:m})
  // Polyfills __webpack_require__.n(mod) — the CJS/ESM interop wrapper.
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    t.isIdentifier((node.callee as t.MemberExpression).object, { name: shimName }) &&
    t.isIdentifier((node.callee as t.MemberExpression).property, { name: 'n' }) &&
    node.arguments.length === 1 &&
    t.isExpression(node.arguments[0])
  ) {
    const m = node.arguments[0] as t.Expression;
    return t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('assign')), [
      t.arrowFunctionExpression([], m),
      t.objectExpression([t.objectProperty(t.identifier('a'), m)]),
    ]);
  }

  const keys = (VISITOR_KEYS as Record<string, readonly string[]>)[node.type];
  if (!keys) return node;

  let changed = false;
  const updates: Record<string, unknown> = {};

  for (const key of keys) {
    const child = (node as unknown as Record<string, unknown>)[key];
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

export function unpack(bundlePath: string, outDir: string, chunkPaths: string[] = []): UnpackResult {
  const source = readFileSync(bundlePath, 'utf8');
  const bundle = detectAndParse(source);

  // Merge modules from supplementary chunk files (async-split bundles)
  for (const chunkPath of chunkPaths) {
    const chunkSource = readFileSync(chunkPath, 'utf8');
    if (isChunk(chunkSource)) {
      for (const [id, mod] of parseChunkModules(chunkSource)) {
        bundle.modules.set(id, mod);
      }
    }
  }
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

  // Write webpop.json manifest — records format/entry and per-module metadata for identify
  // Keys are relative paths from outDir so nested layouts (dev bundles) work correctly
  const absOut = resolve(outDir);
  const entryFile = relative(absOut, outputPaths.get(bundle.entryId)!);
  const modulesManifest: Record<string, { hintPath?: string; requireParamName?: string | null }> = {};
  for (const [id, mod] of bundle.modules) {
    const file = relative(absOut, outputPaths.get(id)!);
    modulesManifest[file] = {
      ...(mod.hintPath ? { hintPath: mod.hintPath } : {}),
      ...(mod.requireParamName ? { requireParamName: mod.requireParamName } : {}),
    };
  }
  writeManifest(outDir, {
    format: bundle.formatName,
    entry: entryFile,
    chunkName: bundle.chunkName ?? null,
    modules: modulesManifest,
  });

  return { formatName: bundle.formatName, moduleCount: bundle.modules.size, entryId: bundle.entryId, outDir };
}
