#!/usr/bin/env bun
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { unpack } from './unpack.js';

const [cmd, ...args] = process.argv.slice(2);

function usage(): never {
  console.error(`Usage:
  webpop unpack <bundle.js> [--out <dir>]
  webpop repack <dir>
`);
  process.exit(1);
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i] ?? '';
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

if (cmd === 'unpack') {
  const { positional, flags } = parseArgs(args);
  const bundlePath = positional[0];
  if (!bundlePath) usage();

  const outDir = flags.out ?? bundlePath.replace(/\.js$/, '') + '-unpacked';
  const result = unpack(resolve(bundlePath), resolve(outDir));

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
  if (!existsSync(join(dir, 'node_modules'))) {
    console.log('Installing dependencies...');
    execSync('bun install', { cwd: dir, stdio: 'inherit' });
  }
  execSync('bun run build', { cwd: dir, stdio: 'inherit' });
  console.log(`Bundle written to ${join(dir, 'dist/bundle.js')}`);

} else {
  usage();
}
