/**
 * npm module identification: match extracted webpack modules against known npm packages
 * by comparing export key sets (Jaccard), string literal overlap (Dice), and path hints.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';
import { readManifest, updateManifest, type ModuleEntry } from './manifest.js';
import { buildImportGraph, findExclusivelyCovered } from './graph.js';

// ---------------------------------------------------------------------------
// Package spec parsing:  ms  |  ms@2.1.3  |  lodash/chunk  |  react@18/jsx-runtime
//                        @scope/pkg  |  @scope/pkg@1.0  |  @scope/pkg@1.0/sub
// ---------------------------------------------------------------------------

export interface PackageSpec {
  name: string;        // npm package name, e.g. 'react' or '@scope/pkg'
  version: string;     // version/range, '*' if not specified
  subpath: string | null;
  installSpec: string; // what to pass to `bun add`, e.g. 'react@18'
  requireSpec: string; // what to put in require(), e.g. 'react/jsx-runtime'
}

export function parsePackageSpec(spec: string): PackageSpec {
  let name: string;
  let version = '*';
  let subpath: string | null = null;

  if (spec.startsWith('@')) {
    // @scope/pkgname[@version][/subpath]
    const scopeSlash = spec.indexOf('/', 1);
    if (scopeSlash === -1) throw new Error(`Invalid scoped package: ${spec}`);
    const rest = spec.slice(scopeSlash + 1); // 'pkgname[@version][/subpath]'
    const atIdx = rest.indexOf('@');
    const slashIdx = rest.indexOf('/');
    if (atIdx !== -1 && (slashIdx === -1 || atIdx < slashIdx)) {
      name = spec.slice(0, scopeSlash + 1 + atIdx);
      const afterAt = rest.slice(atIdx + 1);
      const subSlash = afterAt.indexOf('/');
      if (subSlash === -1) { version = afterAt; }
      else { version = afterAt.slice(0, subSlash); subpath = afterAt.slice(subSlash + 1); }
    } else if (slashIdx !== -1) {
      name = spec.slice(0, scopeSlash + 1 + slashIdx);
      subpath = rest.slice(slashIdx + 1);
    } else {
      name = spec;
    }
  } else {
    const atIdx = spec.indexOf('@');
    const slashIdx = spec.indexOf('/');
    if (atIdx !== -1 && (slashIdx === -1 || atIdx < slashIdx)) {
      name = spec.slice(0, atIdx);
      const afterAt = spec.slice(atIdx + 1);
      const subSlash = afterAt.indexOf('/');
      if (subSlash === -1) { version = afterAt; }
      else { version = afterAt.slice(0, subSlash); subpath = afterAt.slice(subSlash + 1); }
    } else if (slashIdx !== -1) {
      name = spec.slice(0, slashIdx);
      subpath = spec.slice(slashIdx + 1);
    } else {
      name = spec;
    }
  }

  const installSpec = version !== '*' ? `${name}@${version}` : name;
  const requireSpec = subpath ? `${name}/${subpath}` : name;
  return { name, version, subpath, installSpec, requireSpec };
}

// ---------------------------------------------------------------------------
// Backup types
// ---------------------------------------------------------------------------

const BACKUP_DIR = '.webpop-backup';

interface BackupManifest {
  pkg: string;
  requireSpec: string;
  moduleFile: string;
  backedUpFiles: string[];
  originalManifestEntries: Record<string, ModuleEntry>;
}

export interface ApplyResult {
  moduleFile: string;
  pkg: string;
  requireSpec: string;
  coveredCount: number;
  backupDir: string;
}

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
      const v = (node as unknown as Record<string, unknown>)[k];
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

export async function getPackageInfo(specStr: string): Promise<PackageInfo | null> {
  const spec = parsePackageSpec(specStr);
  const tmpDir = join('/tmp', `webpop-probe-${spec.name.replace(/[^a-z0-9]/gi, '_')}`);
  mkdirSync(tmpDir, { recursive: true });

  const pkgJsonPath = join(tmpDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({ name: 'probe', private: true }, null, 2));
  }

  const install = Bun.spawn(['bun', 'add', spec.installSpec], { cwd: tmpDir, stdout: 'pipe', stderr: 'pipe' });
  const installCode = await install.exited;
  if (installCode !== 0) {
    const err = await new Response(install.stderr).text();
    throw new Error(`Failed to install ${spec.installSpec}: ${err.trim()}`);
  }

  // Probe using the requireSpec (e.g. 'lodash/chunk') so we inspect the right export surface
  const probe = await runProbe(tmpDir, spec.requireSpec);
  if (!probe) return null;

  let strings = new Set<string>();
  if (probe.sourceFile && existsSync(probe.sourceFile)) {
    strings = extractStringLiterals(probe.sourceFile);
  }

  return { name: spec.requireSpec, keys: probe.keys, isFunction: probe.isFunction, strings, sourceFile: probe.sourceFile };
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

// Recursively collect .js files relative to baseDir, skipping noise dirs/files
function collectJsFiles(dir: string, baseDir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === '.webpop-probe.cjs' || entry.name === BACKUP_DIR) continue;
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

  for (const specStr of packages) {
    onProgress?.(`  Fetching ${specStr}...`);
    const info = await getPackageInfo(specStr);
    if (!info) { onProgress?.(`  ✗ could not inspect ${specStr}`); continue; }

    const matches: IdentifyMatch[] = mods
      .map(mod => ({ moduleFile: mod.file, score: scoreMatch(mod, info) }))
      .sort((a, b) => b.score.total - a.score.total);

    results.push({ pkg: specStr, matches, info });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Apply an identification: backup + delete covered modules, write npm proxy
// ---------------------------------------------------------------------------

export function applyIdentification(outDir: string, moduleFile: string, specStr: string): ApplyResult {
  const spec = parsePackageSpec(specStr);
  const manifest = readManifest(outDir);
  const absOut = resolve(outDir);

  // Build full import graph over all JS files in the tree
  const allFiles = collectJsFiles(outDir, outDir);
  const graph = buildImportGraph(allFiles, outDir);

  // Entry from manifest (relative path like 'module___webpack_entry__.js')
  const entryFile = manifest ? String(manifest.entry) : moduleFile;

  // Modules exclusively reachable through `moduleFile` — safe to delete
  const covered = findExclusivelyCovered(entryFile, moduleFile, graph);

  // Save original manifest entries for all files we're touching
  const originalEntries: Record<string, ModuleEntry> = {};
  const allTouched = [moduleFile, ...covered];
  for (const f of allTouched) {
    originalEntries[f] = manifest?.modules?.[f] ?? {};
  }

  // Write backup: copy all touched files + manifest
  const safePkgName = spec.name.replace(/\//g, '__').replace(/[^a-z0-9@_.-]/gi, '_');
  const backupBase = join(absOut, BACKUP_DIR, safePkgName);
  mkdirSync(backupBase, { recursive: true });
  for (const f of allTouched) {
    const src = join(absOut, f);
    if (existsSync(src)) {
      const dst = join(backupBase, f);
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, readFileSync(src));
    }
  }
  const backupManifest: BackupManifest = {
    pkg: spec.name,
    requireSpec: spec.requireSpec,
    moduleFile,
    backedUpFiles: allTouched,
    originalManifestEntries: originalEntries,
  };
  writeFileSync(join(backupBase, 'MANIFEST.json'), JSON.stringify(backupManifest, null, 2) + '\n');

  // Delete exclusively covered files from tree
  for (const f of covered) {
    const abs = join(absOut, f);
    if (existsSync(abs)) unlinkSync(abs);
  }

  // Rewrite module file as interop-aware npm proxy
  writeFileSync(join(absOut, moduleFile),
    `const _m = require(${JSON.stringify(spec.requireSpec)});\n` +
    `module.exports = _m && _m.__esModule ? _m.default : _m;\n`,
  );

  // Add to package.json dependencies
  const pkgJsonPath = join(absOut, 'package.json');
  if (existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    pkgJson.dependencies = pkgJson.dependencies ?? {};
    pkgJson.dependencies[spec.name] = spec.version !== '*' ? spec.version : '*';
    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
  }

  // Update webpop.json: mark module as npm proxy, remove covered entries
  updateManifest(outDir, m => {
    const modules = { ...m.modules };
    modules[moduleFile] = { ...modules[moduleFile], npm: spec.requireSpec };
    for (const f of covered) delete modules[f];
    return { ...m, modules };
  });

  return { moduleFile, pkg: spec.name, requireSpec: spec.requireSpec, coveredCount: covered.size, backupDir: backupBase };
}

// ---------------------------------------------------------------------------
// Undo: restore backed-up files, remove proxy, update manifest
// ---------------------------------------------------------------------------

export function undoIdentification(outDir: string, pkgName: string): void {
  const absOut = resolve(outDir);
  const safePkgName = pkgName.replace(/\//g, '__').replace(/[^a-z0-9@_.-]/gi, '_');
  const backupBase = join(absOut, BACKUP_DIR, safePkgName);
  const manifestPath = join(backupBase, 'MANIFEST.json');
  if (!existsSync(manifestPath)) throw new Error(`No backup found for ${pkgName} in ${backupBase}`);

  const bm: BackupManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  // Restore all backed-up files
  for (const f of bm.backedUpFiles) {
    const src = join(backupBase, f);
    const dst = join(absOut, f);
    if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, readFileSync(src));
    }
  }

  // Remove from package.json
  const pkgJsonPath = join(absOut, 'package.json');
  if (existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    if (pkgJson.dependencies) {
      delete pkgJson.dependencies[bm.pkg];
      writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
    }
  }

  // Restore manifest entries
  updateManifest(outDir, m => {
    const modules = { ...m.modules };
    for (const [f, entry] of Object.entries(bm.originalManifestEntries)) {
      modules[f] = entry;
    }
    return { ...m, modules };
  });
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
