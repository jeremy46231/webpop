/**
 * npm module identification: match extracted webpack modules against known npm packages
 * by comparing export key sets (Jaccard), string literal overlap (Dice), and path hints.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';
import { readManifest, updateManifest } from './manifest.js';

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function walkAst(root: t.Node, visit: (n: t.Node) => void): void {
  const q: t.Node[] = [root];
  while (q.length) {
    const node = q.shift()!;
    visit(node);
    const keys = (VISITOR_KEYS as Record<string, readonly string[]>)[node.type];
    if (!keys) continue;
    for (const k of keys) {
      const v = (node as Record<string, unknown>)[k];
      if (Array.isArray(v)) {
        for (const c of v) if (c && (c as t.Node).type) q.push(c as t.Node);
      } else if (v && (v as t.Node).type) q.push(v as t.Node);
    }
  }
}

function parseFile(filePath: string): t.File | null {
  try {
    const src = readFileSync(filePath, 'utf8');
    return parse(src, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, errorRecovery: true });
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Export key extraction from a module file (AST, no eval)
// ---------------------------------------------------------------------------

export function extractExportKeys(filePath: string): string[] {
  const ast = parseFile(filePath);
  if (!ast) return [];

  // Build set of names that alias `exports` (from shim declarations)
  const exportAliases = new Set<string>(['exports']);
  // Names that alias `module`
  const moduleAliases = new Set<string>(['module']);

  for (const stmt of ast.program.body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const decl of stmt.declarations) {
      if (!t.isIdentifier(decl.id) || !decl.init) continue;
      const init = decl.init;
      if (t.isIdentifier(init, { name: 'exports' })) exportAliases.add(decl.id.name);
      if (t.isIdentifier(init, { name: 'module' })) moduleAliases.add(decl.id.name);
    }
  }

  const keys = new Set<string>();

  walkAst(ast, node => {
    if (!t.isAssignmentExpression(node) || node.operator !== '=') return;
    const left = node.left;
    if (!t.isMemberExpression(left)) return;

    const obj = left.object;
    const prop = left.property;

    const addKey = (p: t.Node) => {
      if (t.isIdentifier(p)) keys.add(p.name);
      else if (t.isStringLiteral(p)) keys.add(p.value);
    };

    // exports.KEY = ... or aliasOfExports.KEY = ...
    if (t.isIdentifier(obj) && exportAliases.has(obj.name)) {
      addKey(prop);
      return;
    }

    // module.exports.KEY = ... or alias.exports.KEY = ...
    if (
      t.isMemberExpression(obj) &&
      t.isIdentifier(obj.property, { name: 'exports' }) &&
      t.isIdentifier(obj.object) &&
      moduleAliases.has((obj.object as t.Identifier).name)
    ) {
      addKey(prop);
      return;
    }

    // module.exports = { KEY: ... } — inline object
    if (
      t.isIdentifier(obj) && moduleAliases.has(obj.name) &&
      t.isIdentifier(prop, { name: 'exports' }) &&
      t.isObjectExpression(node.right)
    ) {
      for (const p of (node.right as t.ObjectExpression).properties) {
        if (t.isObjectProperty(p) || t.isObjectMethod(p)) {
          const k = (p as t.ObjectProperty | t.ObjectMethod).key;
          if (t.isIdentifier(k)) keys.add(k.name);
          else if (t.isStringLiteral(k)) keys.add(k.value);
        }
      }
    }
  });

  // Remove noise keys (keep 'default' — it IS a meaningful signal for single-export modules)
  const noise = new Set(['__esModule', 'length', 'name', 'prototype']);
  for (const k of noise) keys.delete(k);

  return [...keys];
}

// ---------------------------------------------------------------------------
// String literal extraction (filters noise to keep distinctive strings)
// ---------------------------------------------------------------------------

// Common JS/generic strings unlikely to be package-specific
const NOISE_STRINGS = new Set([
  '', 'undefined', 'null', 'true', 'false', 'object', 'function', 'string', 'number',
  'boolean', 'symbol', 'bigint', 'default', '__esModule', 'use strict', 'constructor',
  'prototype', 'length', 'name', 'toString', 'valueOf', 'hasOwnProperty',
]);

export function extractStringLiterals(filePath: string): Set<string> {
  const ast = parseFile(filePath);
  if (!ast) return new Set();
  const strs = new Set<string>();
  walkAst(ast, node => {
    if (t.isStringLiteral(node) && node.value.length >= 3 && !NOISE_STRINGS.has(node.value)) {
      strs.add(node.value);
    }
  });
  return strs;
}

// ---------------------------------------------------------------------------
// npm package introspection
// ---------------------------------------------------------------------------

export interface PackageInfo {
  name: string;
  keys: string[];      // exported named keys
  isFunction: boolean; // module.exports is a function
  strings: Set<string>; // string literals from package source
  sourceFile: string;
}

// Writes a tiny probe script and runs it to inspect the installed package
async function runProbe(tmpDir: string, pkg: string): Promise<{ keys: string[]; isFunction: boolean; sourceFile: string } | null> {
  const script = `
const m = require(${JSON.stringify(pkg)});
const sourceFile = require.resolve(${JSON.stringify(pkg)});
console.log(JSON.stringify({
  keys: m && typeof m === 'object' ? Object.keys(m).filter(k => k !== '__esModule') : (typeof m === 'function' ? Object.keys(m) : []),
  isFunction: typeof m === 'function',
  sourceFile,
}));
`;
  const scriptPath = join(tmpDir, '.webpop-probe.cjs');
  writeFileSync(scriptPath, script);
  const proc = Bun.spawn(['bun', 'run', scriptPath], { cwd: tmpDir, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try { return JSON.parse(out.trim()); } catch { return null; }
}

export async function getPackageInfo(pkg: string): Promise<PackageInfo | null> {
  const tmpDir = join('/tmp', `webpop-probe-${pkg.replace(/[^a-z0-9]/gi, '_')}`);
  mkdirSync(tmpDir, { recursive: true });

  // Write minimal package.json so bun add works
  const pkgJson = join(tmpDir, 'package.json');
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, JSON.stringify({ name: 'probe', private: true }, null, 2));
  }

  // Install package
  const install = Bun.spawn(['bun', 'add', pkg], { cwd: tmpDir, stdout: 'pipe', stderr: 'pipe' });
  const installCode = await install.exited;
  if (installCode !== 0) {
    const err = await new Response(install.stderr).text();
    throw new Error(`Failed to install ${pkg}: ${err.trim()}`);
  }

  const probe = await runProbe(tmpDir, pkg);
  if (!probe) return null;

  // Extract string literals from the package's source file
  let strings = new Set<string>();
  if (probe.sourceFile && existsSync(probe.sourceFile)) {
    strings = extractStringLiterals(probe.sourceFile);
  }

  return { name: pkg, keys: probe.keys, isFunction: probe.isFunction, strings, sourceFile: probe.sourceFile };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const k of sa) if (sb.has(k)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  return (2 * inter) / (a.size + b.size);
}

export interface ScoreDetail {
  total: number;
  keyScore: number;
  stringScore: number;
  pathHint: boolean;
  reason: string;
}

export function scoreMatch(
  mod: { file: string; keys: string[]; strings: Set<string>; hintPath?: string | null },
  pkg: PackageInfo,
): ScoreDetail {
  // Path hint: if the module's relative path or hintPath mentions this package name
  const pathsToCheck = [mod.file, mod.hintPath].filter(Boolean) as string[];
  for (const candidate of pathsToCheck) {
    const p = candidate.toLowerCase().replace(/\\/g, '/');
    const pkgLower = pkg.name.toLowerCase();
    const pkgBase = pkgLower.replace(/^@[^/]+\//, ''); // strip @scope/ prefix
    if (p.includes(`node_modules/${pkgLower}`) || p.includes(`node_modules/${pkgBase}`)) {
      return { total: 1.0, keyScore: 1, stringScore: 1, pathHint: true, reason: `path hint: ${candidate}` };
    }
  }

  const keyScore = jaccard(mod.keys, pkg.keys);
  const stringScore = dice(mod.strings, pkg.strings);

  // Weight: if the module has several named exports, key matching is more reliable.
  // If few/no named exports, lean on string similarity.
  const keyWeight = mod.keys.length >= 4 ? 0.7 : mod.keys.length >= 1 ? 0.4 : 0.1;
  const strWeight = 1 - keyWeight;
  const total = keyWeight * keyScore + strWeight * stringScore;

  const reasons: string[] = [];
  if (keyScore > 0) reasons.push(`${mod.keys.filter(k => pkg.keys.includes(k)).length}/${pkg.keys.length} export keys match`);
  if (stringScore > 0) {
    const sharedCount = [...mod.strings].filter(s => pkg.strings.has(s)).length;
    reasons.push(`${sharedCount} shared string literals`);
  }

  return { total, keyScore, stringScore, pathHint: false, reason: reasons.join(', ') || 'no signal' };
}

// ---------------------------------------------------------------------------
// Module file listing
// ---------------------------------------------------------------------------

export interface ModuleCandidate {
  file: string;      // relative path from outDir, e.g. 'module_2.js' or 'node_modules/ms/index.js'
  absPath: string;
  keys: string[];
  strings: Set<string>;
  hintPath: string | null;
}

// Recursively collect .js files relative to baseDir, skipping dist/ and .webpop-probe files
function collectJsFiles(dir: string, baseDir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === '.webpop-probe.cjs') continue;
    const absPath = join(dir, entry.name);
    const relPath = relative(baseDir, absPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(absPath, baseDir));
    } else if (entry.name.endsWith('.js') && entry.name !== 'webpack.config.js') {
      results.push(relPath);
    }
  }
  return results;
}

export function listModuleCandidates(outDir: string): ModuleCandidate[] {
  const manifest = readManifest(outDir);
  const results: ModuleCandidate[] = [];

  for (const relFile of collectJsFiles(outDir, outDir)) {
    // Skip already-identified modules
    if (manifest?.modules?.[relFile]?.npm) continue;
    const absPath = join(outDir, relFile);
    const keys = extractExportKeys(absPath);
    const strings = extractStringLiterals(absPath);
    const hintPath = (manifest?.modules?.[relFile] as Record<string, string> | undefined)?.hintPath ?? null;
    results.push({ file: relFile, absPath, keys, strings, hintPath });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main identify function
// ---------------------------------------------------------------------------

export interface IdentifyMatch {
  moduleFile: string;
  score: ScoreDetail;
}

export interface IdentifyResult {
  pkg: string;
  matches: IdentifyMatch[]; // sorted best-first
  info: PackageInfo;
}

export async function identifyPackages(
  outDir: string,
  packages: string[],
  onProgress?: (msg: string) => void,
): Promise<IdentifyResult[]> {
  const mods = listModuleCandidates(outDir);
  if (mods.length === 0) throw new Error('No module files found in ' + outDir);

  const results: IdentifyResult[] = [];

  for (const pkg of packages) {
    onProgress?.(`  Fetching ${pkg}...`);
    const info = await getPackageInfo(pkg);
    if (!info) { onProgress?.(`  ✗ could not inspect ${pkg}`); continue; }

    const matches: IdentifyMatch[] = mods
      .map(mod => ({ moduleFile: mod.file, score: scoreMatch(mod, info) }))
      .sort((a, b) => b.score.total - a.score.total);

    results.push({ pkg, matches, info });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Apply an identification: rewrite module as npm proxy, update package.json + manifest
// ---------------------------------------------------------------------------

export function applyIdentification(outDir: string, moduleFile: string, pkg: string): void {
  // Rewrite the module file as an interop-aware proxy.
  // TypeScript CJS packages set __esModule=true and put the real value at .default;
  // plain CJS packages don't, and the module IS the value.  This handles both.
  const absPath = join(outDir, moduleFile);
  writeFileSync(absPath,
    `const _m = require(${JSON.stringify(pkg)});\n` +
    `module.exports = _m && _m.__esModule ? _m.default : _m;\n`,
  );

  // Add pkg to outDir's package.json dependencies
  const pkgJsonPath = join(outDir, 'package.json');
  if (existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    pkgJson.dependencies = pkgJson.dependencies ?? {};
    pkgJson.dependencies[pkg] = '*';
    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
  }

  // Update manifest
  updateManifest(outDir, m => ({
    ...m,
    modules: {
      ...m.modules,
      [moduleFile]: { ...m.modules[moduleFile], npm: pkg },
    },
  }));
}

// ---------------------------------------------------------------------------
// Auto-propagation: given an identified package, try to match its direct deps
// ---------------------------------------------------------------------------

export async function autoPropagateDepencies(
  outDir: string,
  pkg: string,
  installDir: string,
  onProgress?: (msg: string) => void,
): Promise<IdentifyResult[]> {
  // Read the installed package's own package.json for its deps
  const pkgJsonPath = join(installDir, 'node_modules', pkg, 'package.json');
  if (!existsSync(pkgJsonPath)) return [];

  let deps: string[] = [];
  try {
    const pj = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    deps = Object.keys(pj.dependencies ?? {});
  } catch { return []; }

  if (deps.length === 0) return [];
  onProgress?.(`  Auto-checking sub-deps: ${deps.join(', ')}`);
  return identifyPackages(outDir, deps, onProgress);
}
