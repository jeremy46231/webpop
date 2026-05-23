#!/usr/bin/env bun
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { unpack } from './unpack.js';
import { identifyPackages, applyIdentification, autoPropagateDepencies, type IdentifyResult } from './identify.js';
import { readManifest } from './manifest.js';

const [cmd, ...args] = process.argv.slice(2);

function usage(): never {
  console.error(`Usage:
  webpop unpack <bundle.js> [chunk1.js chunk2.js ...] [--out <dir>]
  webpop repack <dir>
  webpop identify <dir> <pkg> [<pkg2> ...] [--apply] [--threshold <0-1>]
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
    applyIdentification(outDir, m.moduleFile, m.pkg);
    console.log(`  ✓ ${m.moduleFile} → require('${m.pkg}')`);
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
          applyIdentification(outDir, best.moduleFile, r.pkg);
          console.log(`  ✓ ${best.moduleFile} → require('${r.pkg}')  (auto)`);
        }
      }
    }
  }

  console.log(`\nDone. Run 'webpop repack ${outDir}' to rebuild.`);

} else {
  usage();
}
