#!/usr/bin/env bun
import { resolve, join, relative, dirname, basename } from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { unpack } from './unpack.js';
import { identifyPackages, applyIdentification, undoIdentification, autoPropagateDepencies, type IdentifyResult } from './identify.js';
import { readManifest } from './manifest.js';
import { parse as babelParse } from '@babel/parser';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';
import _generate from '@babel/generator';

const generate = ((_generate as unknown as Record<string, unknown>).default ?? _generate) as typeof _generate;

const [cmd, ...args] = process.argv.slice(2);

function usage(): never {
  console.error(`Usage:
  webpop unpack <bundle.js> [chunk1.js ...] [--out <dir>]
  webpop repack <dir>
  webpop repack-push-chunk <dir>
  webpop analyze-slack <dir>
  webpop identify <dir> <pkg[@ver][/sub]> ... [--apply] [--threshold <0-1>]
  webpop identify undo <dir> <pkg>
`);
  process.exit(1);
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      // boolean flags (no value) vs value flags
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = 'true';
    } else positional.push(argv[i]);
  }
  return { positional, flags };
}

function stars(score: number): string {
  const full = Math.round(score * 5);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

function printResults(results: IdentifyResult[], threshold: number): void {
  for (const r of results) {
    console.log(`\nPackage: ${r.pkg}  (${r.info.keys.length} exports, ${r.info.strings.size} strings)`);
    const best = r.matches.slice(0, 5);
    for (const m of best) {
      const bar = stars(m.score.total);
      const pct = (m.score.total * 100).toFixed(0).padStart(3);
      const flag = m.score.total >= threshold ? ' ← best match' : '';
      console.log(`  ${bar} ${pct}%  ${m.moduleFile.padEnd(20)}  ${m.score.reason}${flag}`);
    }
  }
}

if (cmd === 'unpack') {
  const { positional, flags } = parseArgs(args);
  const bundlePath = positional[0];
  if (!bundlePath) usage();

  const chunkPaths = positional.slice(1).map(p => resolve(p));
  const outDir = flags.out ?? bundlePath.replace(/\.js$/, '') + '-unpacked';
  const result = unpack(resolve(bundlePath), resolve(outDir), chunkPaths);

  console.log(`[${result.formatName}] Extracted ${result.moduleCount} modules → ${result.outDir}`);
  console.log(`Entry: ${result.entryId}`);
  console.log(`\nTo repack: webpop repack ${result.outDir}`);

} else if (cmd === 'repack') {
  const { positional } = parseArgs(args);
  const dir = resolve(positional[0] ?? '');
  if (!dir || !existsSync(join(dir, 'webpack.config.js'))) {
    console.error(`No webpack.config.js in ${dir}. Run 'webpop unpack' first.`);
    process.exit(1);
  }
  if (!existsSync(join(dir, 'node_modules', '.bin', 'webpack'))) {
    console.log('Installing dependencies...');
    execSync('bun install', { cwd: dir, stdio: 'inherit' });
  }
  execSync('bun run build', { cwd: dir, stdio: 'inherit' });
  console.log(`Bundle written to ${join(dir, 'dist/bundle.js')}`);

} else if (cmd === 'identify') {
  const { positional, flags } = parseArgs(args);

  // identify undo <dir> <pkg>
  if (positional[0] === 'undo') {
    const outDir = resolve(positional[1] ?? '');
    const pkgName = positional[2];
    if (!outDir || !pkgName) {
      console.error('Usage: webpop identify undo <dir> <pkg>');
      process.exit(1);
    }
    undoIdentification(outDir, pkgName);
    console.log(`✓ Restored backup for ${pkgName} in ${outDir}`);
    process.exit(0);
  }

  const outDir = resolve(positional[0] ?? '');
  const packages = positional.slice(1);

  if (!outDir || !existsSync(outDir)) {
    console.error('First argument must be an unpacked bundle directory.');
    process.exit(1);
  }
  if (!readManifest(outDir)) {
    console.error(`No webpop.json in ${outDir}. Run 'webpop unpack' first.`);
    process.exit(1);
  }
  if (packages.length === 0) {
    console.error('Specify at least one npm package name to identify.');
    process.exit(1);
  }

  const threshold = parseFloat(flags.threshold ?? '0.15');
  const autoApply = flags.apply === 'true';

  console.log(`Scanning modules in ${outDir}...\n`);

  const results = await identifyPackages(outDir, packages, msg => process.stdout.write(msg + '\n'));
  printResults(results, threshold);

  // Collect best matches above threshold
  const toApply: Array<{ moduleFile: string; pkg: string; score: number }> = [];
  for (const r of results) {
    const best = r.matches[0];
    if (best && best.score.total >= threshold) {
      toApply.push({ moduleFile: best.moduleFile, pkg: r.pkg, score: best.score.total });
    }
  }

  if (toApply.length === 0) {
    console.log('\nNo matches above threshold. Use --threshold to adjust (default 0.15).');
    process.exit(0);
  }

  console.log('\n--- Proposed mappings ---');
  for (const m of toApply) {
    console.log(`  ${m.moduleFile}  →  ${m.pkg}  (${(m.score * 100).toFixed(0)}%)`);
  }

  if (!autoApply) {
    console.log(`\nRun with --apply to write these mappings.`);
    process.exit(0);
  }

  // Apply
  console.log('\nApplying...');
  for (const m of toApply) {
    const result = applyIdentification(outDir, m.moduleFile, m.pkg);
    const covered = result.coveredCount > 0 ? ` (+${result.coveredCount} covered files backed up & removed)` : '';
    console.log(`  ✓ ${m.moduleFile} → require('${result.requireSpec}')${covered}`);
  }

  // Auto-propagate: check each identified package's own deps
  const installDirs = packages.map(pkg =>
    join('/tmp', `webpop-probe-${pkg.replace(/[^a-z0-9]/gi, '_')}`)
  );
  for (let i = 0; i < packages.length; i++) {
    const subResults = await autoPropagateDepencies(outDir, packages[i], installDirs[i], msg => process.stdout.write(msg + '\n'));
    if (subResults.length > 0) {
      console.log(`\nSub-dependency suggestions for ${packages[i]}:`);
      printResults(subResults, threshold);
      for (const r of subResults) {
        const best = r.matches[0];
        if (best && best.score.total >= threshold) {
          const result = applyIdentification(outDir, best.moduleFile, r.pkg);
          const covered = result.coveredCount > 0 ? ` (+${result.coveredCount} backed up)` : '';
          console.log(`  ✓ ${best.moduleFile} → require('${result.requireSpec}')${covered}  (auto)`);
        }
      }
    }
  }

  console.log(`\nDone. Run 'webpop repack ${outDir}' to rebuild.`);

} else if (cmd === 'repack-push-chunk') {
  const { positional } = parseArgs(args);
  const dir = resolve(positional[0] ?? '');
  if (!dir || !existsSync(dir)) {
    console.error('Usage: webpop repack-push-chunk <unpacked-dir>');
    process.exit(1);
  }

  const manifest = readManifest(dir);
  if (!manifest) {
    console.error(`No webpop.json in ${dir}. Run 'webpop unpack' first.`);
    process.exit(1);
  }
  if (manifest.format !== 'wp5-push-chunk') {
    console.error(`Expected format wp5-push-chunk, got ${manifest.format}`);
    process.exit(1);
  }

  const chunkName = manifest.chunkName ?? 'bundle';

  // Walk AST and replace require('./module_N.js') / require('./unknown_X') with requireShim(originalArg)
  function rewriteRequires(node: t.Node, requireShimName: string): t.Node {
    if (
      t.isCallExpression(node) &&
      t.isIdentifier(node.callee, { name: 'require' }) &&
      node.arguments.length === 1 &&
      t.isStringLiteral(node.arguments[0])
    ) {
      const val = (node.arguments[0] as t.StringLiteral).value;
      // './module_8444275607.js' → hex call
      const modMatch = val.match(/\/module_(\d+)\.js$/);
      if (modMatch) {
        const id = Number(modMatch[1]);
        const hexNode = t.numericLiteral(id);
        (hexNode as t.NumericLiteral & { extra?: { raw: string; rawValue: number } }).extra = {
          raw: '0x' + id.toString(16), rawValue: id,
        };
        return t.callExpression(t.identifier(requireShimName), [hexNode]);
      }
      // './unknown_X' — reverse the ./unknown_${depId} encoding from unpack
      const unkMatch = val.match(/\/unknown_(.+)$/);
      if (unkMatch) {
        const raw = unkMatch[1];
        const asInt = /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!isNaN(asInt)) {
          // Integer module ID → hex
          const hexNode = t.numericLiteral(asInt);
          (hexNode as t.NumericLiteral & { extra?: { raw: string; rawValue: number } }).extra = {
            raw: '0x' + asInt.toString(16), rawValue: asInt,
          };
          return t.callExpression(t.identifier(requireShimName), [hexNode]);
        }
        const asFloat = Number(raw);
        if (!isNaN(asFloat)) {
          // Float ID → numeric literal
          return t.callExpression(t.identifier(requireShimName), [t.numericLiteral(asFloat)]);
        }
        // String ID → string literal
        return t.callExpression(t.identifier(requireShimName), [t.stringLiteral(raw)]);
      }
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
          const t2 = rewriteRequires(item as t.Node, requireShimName);
          if (t2 !== item) arrChanged = true;
          return t2;
        });
        if (arrChanged) { updates[key] = next; changed = true; }
      } else if (child && (child as t.Node).type) {
        const t2 = rewriteRequires(child as t.Node, requireShimName);
        if (t2 !== child) { updates[key] = t2; changed = true; }
      }
    }

    return changed ? { ...node, ...updates } : node;
  }

  // Strip leading `var X = module` and `var Y = exports` shims from body
  function stripParamShims(stmts: t.Statement[]): t.Statement[] {
    const result: t.Statement[] = [];
    let i = 0;
    while (i < stmts.length) {
      const stmt = stmts[i];
      if (
        t.isVariableDeclaration(stmt) &&
        stmt.kind === 'var' &&
        stmt.declarations.length === 1 &&
        t.isIdentifier(stmt.declarations[0].init) &&
        (
          (stmt.declarations[0].init as t.Identifier).name === 'module' ||
          (stmt.declarations[0].init as t.Identifier).name === 'exports'
        )
      ) {
        i++;
        continue;
      }
      result.push(...stmts.slice(i));
      break;
    }
    return result;
  }

  const factories: Array<[number, string]> = [];

  for (const [moduleFile, entry] of Object.entries(manifest.modules)) {
    // Skip chunk_init.js and webpack.config.js — not real module factories
    if (moduleFile === 'chunk_init.js' || moduleFile === 'webpack.config.js') continue;
    const idMatch = moduleFile.match(/module_(\d+)\.js$/);
    if (!idMatch) continue;
    const moduleId = Number(idMatch[1]);

    const filePath = join(dir, moduleFile);
    if (!existsSync(filePath)) continue;

    const source = readFileSync(filePath, 'utf8');
    let ast;
    try {
      ast = babelParse(source, {
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        errorRecovery: true,
      });
    } catch {
      console.warn(`  Warning: could not parse ${moduleFile}, skipping`);
      continue;
    }

    const requireShimName = entry.requireParamName ?? 'n';
    let stmts = ast.program.body as t.Statement[];

    // Strip module/exports param shims if we have a requireParamName
    // (means original had at least 3 params)
    if (entry.requireParamName) {
      stmts = stripParamShims(stmts);
    }

    // Rewrite require('./module_N.js') → requireShim(hexId)
    const rewritten = stmts.map(s => rewriteRequires(s, requireShimName) as t.Statement);

    // Wrap in arrow function factory: (module, exports, requireShim) => { ...body... }
    // Only wrap if the original had a require param (i.e. had 3 params)
    let factoryCode: string;
    if (entry.requireParamName) {
      // Pick param names that don't clash with requireShimName
      const p1 = requireShimName === 'module' ? '__module' : 'module';
      const p2 = requireShimName === 'exports' ? '__exports' : 'exports';
      const arrowFn = t.arrowFunctionExpression(
        [t.identifier(p1), t.identifier(p2), t.identifier(requireShimName)],
        t.blockStatement(rewritten),
      );
      factoryCode = generate(arrowFn).code;
    } else {
      const arrowFn = t.arrowFunctionExpression(
        [t.identifier('module'), t.identifier('exports')],
        t.blockStatement(rewritten),
      );
      factoryCode = generate(arrowFn).code;
    }

    factories.push([moduleId, factoryCode]);
  }

  if (factories.length === 0) {
    console.error('No module factories found to repack.');
    process.exit(1);
  }

  // Build the modules object entries, using hex keys
  const moduleEntries = factories
    .map(([id, code]) => `0x${id.toString(16)}:${code}`)
    .join(',');

  const output = `"use strict";(globalThis.webpackChunkwebapp=globalThis.webpackChunkwebapp||[]).push([["${chunkName}"],{${moduleEntries}}])\n`;

  mkdirSync(join(dir, 'dist'), { recursive: true });
  const outFile = join(dir, 'dist', `${chunkName}.js`);
  writeFileSync(outFile, output);
  console.log(`[wp5-push-chunk] Repacked ${factories.length} modules → ${outFile}`);

} else if (cmd === 'analyze-slack') {
  const { positional } = parseArgs(args);
  const dir = resolve(positional[0] ?? '');
  if (!dir || !existsSync(dir)) {
    console.error('Usage: webpop analyze-slack <unpacked-chunks-dir>');
    process.exit(1);
  }

  // Each subdirectory with a webpop.json is a chunk
  const chunkDirs = readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => join(dir, e.name))
    .filter(d => existsSync(join(d, 'webpop.json')));

  if (chunkDirs.length === 0) {
    console.error(`No unpacked chunk directories found in ${dir}`);
    process.exit(1);
  }

  // module id (decimal string) → chunk name
  const moduleIndex = new Map<string, string>();
  const chunkStats: Array<{ name: string; moduleCount: number; crossRefs: number }> = [];

  for (const chunkDir of chunkDirs) {
    const manifest = readManifest(chunkDir);
    if (!manifest) continue;
    const chunkLabel = manifest.chunkName ?? basename(chunkDir);
    let moduleCount = 0;
    for (const moduleFile of Object.keys(manifest.modules)) {
      if (moduleFile === 'chunk_init.js' || moduleFile === 'webpack.config.js') continue;
      const idMatch = moduleFile.match(/module_(\d+)\.js$/);
      if (!idMatch) continue;
      moduleIndex.set(idMatch[1], chunkLabel);
      moduleCount++;
    }
    chunkStats.push({ name: chunkLabel, moduleCount, crossRefs: 0 });
  }

  // Count cross-chunk references: require('./unknown_N') in each chunk
  const unknownRe = /require\(['"]\.\/unknown_(\d+)['"]\)/g;
  let totalTrulyCrossChunk = 0;  // refs to modules in other captured chunks
  let totalMissing = 0;          // refs to modules not in any captured chunk

  for (let ci = 0; ci < chunkDirs.length; ci++) {
    const chunkDir = chunkDirs[ci];
    const manifest = readManifest(chunkDir);
    if (!manifest) continue;
    let crossRefs = 0;
    for (const moduleFile of Object.keys(manifest.modules)) {
      if (moduleFile === 'chunk_init.js' || moduleFile === 'webpack.config.js') continue;
      const filePath = join(chunkDir, moduleFile);
      if (!existsSync(filePath)) continue;
      const src = readFileSync(filePath, 'utf8');
      for (const match of src.matchAll(unknownRe)) {
        const decId = match[1];
        if (moduleIndex.has(decId)) {
          totalTrulyCrossChunk++;  // resolvable in another captured chunk
        } else {
          crossRefs++;
          totalMissing++;
        }
      }
    }
    chunkStats[ci].crossRefs = crossRefs;
  }

  // Write cross-chunk-index.json: hex module ID → chunk name
  const indexObj: Record<string, string> = {};
  for (const [decId, chunkName] of moduleIndex) {
    indexObj['0x' + Number(decId).toString(16)] = chunkName;
  }
  writeFileSync(join(dir, 'cross-chunk-index.json'), JSON.stringify(indexObj, null, 2) + '\n');

  const totalModules = chunkStats.reduce((s, c) => s + c.moduleCount, 0);
  console.log(`Total modules: ${totalModules} across ${chunkStats.length} chunks`);
  console.log(`Cross-chunk refs (within captured chunks): ${totalTrulyCrossChunk} (resolved by webpack runtime)`);
  console.log(`Cross-chunk refs (to uncaptured chunks):  ${totalMissing} (from webpack runtime / other bundles)`);
  console.log(`Written: ${join(dir, 'cross-chunk-index.json')} (hex module ID → chunk name)`);
  console.log('');
  for (const cs of chunkStats.sort((a, b) => b.moduleCount - a.moduleCount)) {
    console.log(`  Chunk: ${cs.name.padEnd(50)} ${String(cs.moduleCount).padStart(5)} modules, ${cs.crossRefs} missing cross-refs`);
  }

} else {
  usage();
}
