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
  webpop scan-npm <dir> [--out report.json]
  webpop organize <dir> [--mode graph|npm|flat]
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

} else if (cmd === 'scan-npm') {
  // -------------------------------------------------------------------------
  // scan-npm: fast heuristic pass to find npm packages across all modules
  // Usage: webpop scan-npm <unpacked-dir> [--out <report.json>]
  // -------------------------------------------------------------------------
  const { positional, flags } = parseArgs(args);
  const dir = resolve(positional[0] ?? '');
  const outFile = flags['out'] as string | undefined ?? join(dir, 'npm-scan.json');

  if (!dir || !existsSync(dir)) {
    console.error('Usage: webpop scan-npm <unpacked-dir-or-chunk-dir> [--out report.json]');
    process.exit(1);
  }

  // Collect all .js module files recursively (skip dist/, node_modules/, .webpop-backup/)
  function collectModuleFiles(root: string): string[] {
    const files: string[] = [];
    function recurse(d: string) {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skip = ['node_modules', 'dist', '.webpop-backup', '.git'];
          if (skip.includes(entry.name)) continue;
          recurse(join(d, entry.name));
        } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
          files.push(join(d, entry.name));
        }
      }
    }
    recurse(root);
    return files;
  }

  // License / package comment patterns
  const LICENSE_RE = /\/\*!?\s*[\s\S]{0,200}?(?:@license|@preserve|copyright\s+\d{4})\s+[\s\S]{0,200}?\*\//gi;
  const PKG_VERSION_RE = /["']([a-z@][a-z0-9@/_.-]{2,50})["']\s*[,:]\s*["'](\d+\.\d+[\d.a-z-]*)["']/gi;
  const VERSION_VAR_RE = /(?:VERSION|version|__VERSION__)\s*[=:]\s*["'](\d+\.\d+[\d.a-z-]*)["']/gi;

  // Known package fingerprints: unique strings that appear in specific packages
  const FINGERPRINTS: Array<{ pkg: string; patterns: RegExp[] }> = [
    { pkg: 'react', patterns: [/\breact\.createElement\b/, /react\.version\s*=/, /"react":\s*"[\d.]+"/] },
    { pkg: 'react-dom', patterns: [/\breactDOM\.render\b/, /ReactDOM\.hydrate/, /\breact-dom\b/] },
    { pkg: 'lodash', patterns: [/\blodash\s*@/, /lodash\/lodash\.js/, /var\s+VERSION\s*=\s*['"]4\.\d+\.\d+['"].*lodash/, /lodash\.com\/license/i] },
    { pkg: 'underscore', patterns: [/\bunderscore\.js\b/, /Underscore\.js\s+\d+\.\d+/, /\b_\.VERSION\s*=/] },
    { pkg: 'backbone', patterns: [/Backbone\.js\s+\d/, /Backbone\.View/, /Backbone\.Model/] },
    { pkg: 'jquery', patterns: [/jQuery\s+v\d/, /\bjQuery\.fn\.jquery\b/, /\$\.fn\.jquery\s*=/] },
    { pkg: 'moment', patterns: [/moment\.js\b/, /\bmoment\b[^a-z].*Moment is/, /moment\.utc\(/, /moment\.locale\(/] },
    { pkg: 'dayjs', patterns: [/dayjs\s+v\d/, /\bdayjs\b.*mini.*dayjs/i] },
    { pkg: 'axios', patterns: [/\baxios\b[^a-z]/, /axios\/lib\//, /\baxios\.create\b/] },
    { pkg: 'bluebird', patterns: [/bluebird\s+@\d/, /Bluebird\s+[\d.]+/, /bluebird\.js/] },
    { pkg: 'immutable', patterns: [/Immutable\.js\s+v\d/, /\bImmutable\.Map\b/, /\bImmutable\.List\b/] },
    { pkg: 'redux', patterns: [/\bcreatStore\b|\bcreateStore\b.*redux/, /\bcombineReducers\b.*redux/, /redux\s+@\d/] },
    { pkg: 'rxjs', patterns: [/\bRxJS\b.*\d+\.\d+/, /rxjs\/operators/, /\bObservable\b.*rxjs/] },
    { pkg: 'classnames', patterns: [/\bclassNames\b.*\bclassnames\b/, /classnames@\d/] },
    { pkg: 'prop-types', patterns: [/prop-types\s+@\d/, /\bPropTypes\b.*facebook/, /react\/lib\/ReactPropTypes/] },
    { pkg: 'reselect', patterns: [/\bcreateSelector\b.*reselect/, /reselect@\d/] },
    { pkg: 'immer', patterns: [/\bimmer\b.*Immer/, /\bproduce\b.*immer/, /immer@\d/] },
    { pkg: 'typescript', patterns: [/typescript\s+@\d/, /Microsoft.*TypeScript/] },
    { pkg: 'webpack', patterns: [/webpack\/lib\//, /webpack\s+@\d/] },
    { pkg: 'highlight.js', patterns: [/highlight\.js\s+@\d/, /\bhljs\.highlight\b/, /hljs\.highlightElement/] },
    { pkg: 'marked', patterns: [/marked\s+@\d/, /\bmarked\s*[\d.]+\s*-\s*a markdown parser/, /marked\.parse\(/] },
    { pkg: 'prismjs', patterns: [/Prism\.js\s+@\d/, /\bPrism\.highlight\b/] },
    { pkg: 'emoji-js', patterns: [/emoji\.js\b/, /emoji-js@\d/] },
    { pkg: 'emoji-mart', patterns: [/emoji-mart@\d/, /\bemojiMart\b/] },
    { pkg: 'dompurify', patterns: [/DOMPurify\s+\d+\.\d+/, /\bdompurify\b.*cure53/i] },
    { pkg: 'sanitize-html', patterns: [/sanitize-html@\d/, /\bsanitizeHtml\b/] },
    { pkg: 'quill', patterns: [/Quill\s+@\d/, /\bQuill\.import\b/, /quilljs\.com/] },
    { pkg: 'draft-js', patterns: [/draft-js@\d/, /\bDraftEditor\b/, /\bEditorState\b.*DraftEditorContents/] },
    { pkg: 'slate', patterns: [/slate@\d/, /\bSlate\b.*editor/, /\bTransforms\b.*slate/] },
    { pkg: 'codemirror', patterns: [/CodeMirror\s+@\d/, /\bCodeMirror\b.*mode/, /codemirror\.net/] },
    { pkg: 'uuid', patterns: [/\buuidv4\b|\buuid\.v4\b/, /uuid@\d/, /\bv4\b.*uuid.*rfc/i] },
    { pkg: 'nanoid', patterns: [/nanoid@\d/, /\bnanoid\b.*\d+.*chars/] },
    { pkg: 'classlist-polyfill', patterns: [/classList.*polyfill/i] },
    { pkg: 'color', patterns: [/\bcolor\.js\b/, /color@\d+\.\d/, /\bColor\b.*hsl.*rgb.*hex/] },
    { pkg: 'tinycolor2', patterns: [/tinycolor\s+@\d/, /\btinycolor\b.*Brian Grinstead/i] },
    { pkg: 'chroma-js', patterns: [/chroma\.js\s+@\d/, /\bchroma\b.*Gregor Aisch/i] },
    { pkg: 'gsap', patterns: [/\bGSAP\b.*TweenMax/, /gsap@\d/] },
    { pkg: 'animejs', patterns: [/anime\.js\s+@\d/, /anime@\d/] },
    { pkg: 'socket.io', patterns: [/socket\.io@\d/, /\bSocketIO\b/] },
    { pkg: 'numeral', patterns: [/numeral\.js\b/, /numeral@\d/] },
    { pkg: 'accounting', patterns: [/accounting\.js\b/, /accounting@\d/] },
    { pkg: 'humanize-duration', patterns: [/humanize-duration@\d/, /\bhumanizeDuration\b/] },
    { pkg: 'ms', patterns: [/\bms\.js\b/, /Convert time.*\bms\b/, / \bms\b.*vercel.com/i] },
    { pkg: 'debounce', patterns: [/\bdebounce@\d/, /\bdebounce\b.*delay.*\btimer\b/] },
    { pkg: 'throttle-debounce', patterns: [/throttle-debounce@\d/] },
    { pkg: 'fuse.js', patterns: [/fuse\.js\s+@\d/, /Fuse\.js.*fuzzy/i] },
    { pkg: 'lunr', patterns: [/lunr\s+@\d/, /\blunr\b.*Olivia Briggs/i, /lunr\.Builder\b/] },
    { pkg: 'pako', patterns: [/pako\s+@\d/, /\bpako\.deflate\b/, /\bpako\.inflate\b/] },
    { pkg: 'lz-string', patterns: [/lz-string@\d/, /\bLZString\b/] },
    { pkg: 'localforage', patterns: [/localforage@\d/, /localForage\.config/] },
    { pkg: 'idb', patterns: [/\bidb@\d/, /\bidb\b.*Jake Archibald/i] },
    { pkg: 'workbox', patterns: [/workbox-\w+@\d/, /\bworkbox\b.*Google/] },
    { pkg: 'flatpickr', patterns: [/flatpickr@\d/, /\bflatpickr\b.*calendar/i] },
    { pkg: 'date-fns', patterns: [/date-fns@\d/, /\bdate-fns\b.*date utility/i] },
    { pkg: 'popper.js', patterns: [/popper\.js\s+@\d/, /\bPopper\.js\b/, /\bcreatPopper\b|\bcreatePopper\b/] },
    { pkg: 'tippy.js', patterns: [/tippy\.js\s+@\d/, /\btippy\b.*tooltip/i] },
    { pkg: 'floating-ui', patterns: [/floating-ui@\d/, /\bfloating-ui\b/] },
    { pkg: 'intersection-observer', patterns: [/IntersectionObserver.*polyfill/i] },
    { pkg: 'resize-observer-polyfill', patterns: [/ResizeObserver.*polyfill/i] },
    { pkg: 'web-vitals', patterns: [/web-vitals@\d/, /\bweb-vitals\b/] },
    { pkg: 'sentry', patterns: [/@sentry\/\w+@\d/, /\bSentry\.init\b/, /sentry\.io/] },
    { pkg: 'amplitude', patterns: [/amplitude-js@\d/, /\bAmplitude\b.*analytics/i] },
    { pkg: 'mixpanel', patterns: [/mixpanel-browser@\d/, /\bmixpanel\.track\b/] },
    { pkg: 'stripe', patterns: [/stripe\.js\b/, /\bStripe\b.*payment/i] },
  ];

  const files = collectModuleFiles(dir);
  console.log(`Scanning ${files.length} module files in ${dir}...`);

  // Results: Map<packageName, {files: string[], evidence: string[]}>
  const results: Map<string, { files: string[]; evidence: string[] }> = new Map();

  function addResult(pkg: string, file: string, evidence: string) {
    const rel = relative(dir, file);
    if (!results.has(pkg)) results.set(pkg, { files: [], evidence: [] });
    const r = results.get(pkg)!;
    if (!r.files.includes(rel)) r.files.push(rel);
    if (!r.evidence.includes(evidence)) r.evidence.push(evidence);
  }

  for (const file of files) {
    let src: string;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }

    // 1. License comments
    const licenseMatches = src.match(LICENSE_RE) ?? [];
    for (const lic of licenseMatches) {
      // Extract package name from license: e.g. "lodash v4.17.21" or "@license React"
      const pkgM = lic.match(/(?:@license|@preserve)?\s+([a-zA-Z@][a-zA-Z0-9@/_.-]{2,40})\s+v?(\d+\.\d+)/);
      if (pkgM) {
        addResult(pkgM[1].toLowerCase().replace(/^@license\s+/i, '').trim(), file,
          `license comment: ${lic.slice(0, 80).replace(/\n/g, ' ')}`);
      }
    }

    // 2. Package version strings: {"name": "foo", "version": "1.2.3"} or "foo@1.2.3"
    const pkgAtVer = src.matchAll(/"([a-z@][a-z0-9@/_.-]{2,40})@(\d+\.\d+[^ "']*)"/g);
    for (const m of pkgAtVer) {
      addResult(m[1], file, `"${m[1]}@${m[2]}"`);
    }

    // 3. Known fingerprints
    for (const { pkg, patterns } of FINGERPRINTS) {
      for (const pat of patterns) {
        if (pat.test(src)) {
          addResult(pkg, file, `fingerprint: ${pat.source.slice(0, 50)}`);
          break;
        }
      }
    }
  }

  // Sort by number of files descending
  const sorted = [...results.entries()].sort((a, b) => b[1].files.length - a[1].files.length);

  console.log(`\nFound ${sorted.length} npm packages:\n`);
  for (const [pkg, { files: pkgFiles, evidence }] of sorted) {
    console.log(`  ${pkg.padEnd(45)} ${pkgFiles.length} module(s)  — ${evidence[0]}`);
  }

  // Write JSON report
  const report: Record<string, { modules: string[]; evidence: string[] }> = {};
  for (const [pkg, { files: pkgFiles, evidence }] of sorted) {
    report[pkg] = { modules: pkgFiles, evidence };
  }
  writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nReport written to ${outFile}`);

} else if (cmd === 'organize') {
  // -------------------------------------------------------------------------
  // organize: arrange modules into a cleaner folder structure using import graph
  // Usage: webpop organize <unpacked-chunk-dir> [--out <new-dir>] [--mode <mode>]
  // Modes: graph (default) | npm | flat
  // -------------------------------------------------------------------------
  const { positional, flags } = parseArgs(args);
  const dir = resolve(positional[0] ?? '');
  const mode = (flags['mode'] as string | undefined) ?? 'graph';

  if (!dir || !existsSync(dir)) {
    console.error('Usage: webpop organize <unpacked-chunk-dir> [--mode graph|npm|flat]');
    process.exit(1);
  }

  const manifest = readManifest(dir);
  if (!manifest) {
    console.error(`No webpop.json in ${dir}`);
    process.exit(1);
  }

  // Build import graph from all module files
  const moduleFiles = Object.keys(manifest.modules).filter(f =>
    f.endsWith('.js') && f !== 'chunk_init.js' && !f.includes('webpack.config'),
  );

  // Parse require() calls in each module
  const deps = new Map<string, Set<string>>();
  for (const mf of moduleFiles) {
    const fp = join(dir, mf);
    if (!existsSync(fp)) continue;
    const src = readFileSync(fp, 'utf8');
    const myDeps = new Set<string>();
    for (const m of src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      const dep = m[1].replace(/^\.\//, '');
      if (dep.endsWith('.js')) myDeps.add(dep);
    }
    deps.set(mf, myDeps);
  }

  // Compute in-degree (how many modules import each module)
  const inDegree = new Map<string, number>();
  for (const mf of moduleFiles) inDegree.set(mf, 0);
  for (const [, myDeps] of deps) {
    for (const dep of myDeps) {
      inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
    }
  }

  if (mode === 'graph') {
    // Cluster by import depth:
    // - depth 0: entry / chunk_init
    // - depth 1: directly imported by entry
    // - shared/: imported by 3+ other modules
    // - util/: small files (< 30 lines) imported by multiple
    // - feature/: modules not in shared

    // Simple approach: bucket by in-degree
    const buckets: Record<string, string[]> = {
      'shared/': [],    // in-degree >= 5
      'util/': [],      // small + in-degree 2-4
      'feature/': [],   // in-degree 0-1 (leaf / directly loaded)
    };

    for (const mf of moduleFiles) {
      if (mf === 'chunk_init.js') continue;
      const deg = inDegree.get(mf) ?? 0;
      const lineCount = readFileSync(join(dir, mf), 'utf8').split('\n').length;
      if (deg >= 5) buckets['shared/'].push(mf);
      else if (deg >= 2 && lineCount < 80) buckets['util/'].push(mf);
      else buckets['feature/'].push(mf);
    }

    // Print proposed structure
    let total = 0;
    for (const [folder, files] of Object.entries(buckets)) {
      console.log(`\n${folder} (${files.length} modules):`);
      for (const f of files.slice(0, 10)) {
        const deg = inDegree.get(f) ?? 0;
        console.log(`  ${f.padEnd(40)} ← ${deg} imports`);
      }
      if (files.length > 10) console.log(`  ... and ${files.length - 10} more`);
      total += files.length;
    }
    console.log(`\nTotal: ${total} modules`);
    console.log('\nTo apply: run this command with --apply (not yet implemented)');
  } else {
    console.error(`Unknown mode: ${mode}. Use: graph, npm, flat`);
    process.exit(1);
  }

} else {
  usage();
}
