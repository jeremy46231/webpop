#!/usr/bin/env bun
/**
 * Generate webpack example bundles into tests/examples/dist/.
 *
 * Each direct webpack project writes its output directly to ../dist with a
 * filename matching its directory + config name (e.g. wp5-cjs-counter-prod.min.js).
 * Framework starters get scaffolded (idempotent) and their build artefacts are
 * copied into the shared dist with descriptive names.
 *
 * Usage:
 *   bun run generate-examples                # build everything
 *   bun run generate-examples wp5-cjs-counter wp5-ts   # build a subset
 *   SKIP_FRAMEWORKS=1 bun run generate-examples        # skip slow scaffolds
 */
import { $ } from 'bun';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir);
const DIST = join(ROOT, 'dist');

type Project = {
  name: string;
  description: string;
  /** Optional install command. Defaults to `bun install`. */
  install?: () => Promise<void>;
  /** Build command. Defaults to `bun run build`. */
  build?: () => Promise<void>;
  /** Copy/extract bundles into DIST. Defaults to a no-op
   *  (direct webpack configs already write to DIST). */
  collect?: () => Promise<void>;
};

function dirOf(name: string) {
  return join(ROOT, name);
}

const projects: Project[] = [
  { name: 'wp5-cjs-counter', description: 'webpack 5 / CommonJS / 3 configs (named, numeric, prod)' },
  { name: 'wp5-esm-math',    description: 'webpack 5 / ES modules / no deps / dev+prod' },
  { name: 'wp5-prod-lodash', description: 'webpack 5 / production / npm deps (lodash, uuid)' },
  { name: 'wp5-ts',          description: 'webpack 5 / TypeScript via ts-loader / dev+prod' },
  { name: 'wp5-async-split', description: 'webpack 5 / dynamic imports + code splitting' },
  { name: 'wp5-npm-multi',   description: 'webpack 5 / production / npm identify test (ms, semver, picocolors)' },
  { name: 'wp4-cjs-greet',   description: 'webpack 4 / CommonJS / dev+prod' },
  { name: 'wp4-babel-es6',   description: 'webpack 4 / babel-loader / ES6+ source / npm deps' },
  { name: 'wp3-legacy',      description: 'webpack 3 (legacy) / UglifyJsPlugin' },
];

function listProjectDirs(): string[] {
  return readdirSync(ROOT)
    .filter((f) => {
      try {
        const full = join(ROOT, f);
        const stat = Bun.file(full);
        if (f === 'dist' || f === 'node_modules') return false;
        return existsSync(join(full, 'package.json')) || projects.some((p) => p.name === f);
      } catch {
        return false;
      }
    })
    .sort();
}

async function runProject(p: Project) {
  const dir = dirOf(p.name);
  console.log(`\n=== ${p.name} === ${p.description}`);

  if (!existsSync(dir)) {
    console.warn(`  [skip] dir missing: ${dir}`);
    return;
  }

  // Install
  if (!existsSync(join(dir, 'node_modules'))) {
    if (p.install) {
      console.log(`  installing (custom)...`);
      await p.install();
    } else {
      console.log(`  installing (bun install)...`);
      await $`bun install`.cwd(dir);
    }
  }

  // Build
  console.log(`  building...`);
  if (p.build) {
    await p.build();
  } else {
    await $`bun run build`.cwd(dir);
  }

  // Collect
  if (p.collect) {
    console.log(`  collecting bundles...`);
    await p.collect();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const filter = new Set(args.filter((a) => !a.startsWith('--')));
  const clean = args.includes('--clean');

  if (clean) {
    console.log(`Cleaning ${DIST}`);
    rmSync(DIST, { recursive: true, force: true });
  }
  mkdirSync(DIST, { recursive: true });
  // Force Node to treat .min.js bundles as CommonJS regardless of the workspace
  // root's package.json `"type": "module"`. Webpack outputs use require().
  const distPkg = join(DIST, 'package.json');
  if (!existsSync(distPkg)) {
    Bun.write(distPkg, JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
  }

  // Sanity: warn about any dirs not registered
  const known = new Set(projects.map((p) => p.name));
  for (const d of listProjectDirs()) {
    if (!known.has(d)) console.warn(`(unregistered project dir: ${d})`);
  }

  const toRun = projects.filter((p) => {
    if (filter.size && !filter.has(p.name)) return false;
    return true;
  });

  const failures: { name: string; err: unknown }[] = [];
  for (const p of toRun) {
    try {
      await runProject(p);
    } catch (err) {
      console.error(`  ✗ ${p.name} failed:`, err instanceof Error ? err.message : err);
      failures.push({ name: p.name, err });
    }
  }

  console.log(`\n--- summary ---`);
  const bundles = existsSync(DIST)
    ? readdirSync(DIST).filter((f) => f.endsWith('.js')).sort()
    : [];
  console.log(`${bundles.length} bundle(s) in ${DIST}:`);
  for (const b of bundles) console.log('  ' + b);
  if (failures.length) {
    console.log(`\n${failures.length} project(s) failed:`);
    for (const f of failures) console.log('  ✗ ' + f.name);
    process.exit(1);
  }
}

await main();
