import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface ModuleEntry {
  npm?: string;
}

export interface WebpopManifest {
  format: string;
  entry: string | number;
  modules: Record<string, ModuleEntry>;
}

const FILE = 'webpop.json';

export function readManifest(outDir: string): WebpopManifest | null {
  const p = join(outDir, FILE);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function writeManifest(outDir: string, m: WebpopManifest): void {
  writeFileSync(join(outDir, FILE), JSON.stringify(m, null, 2) + '\n');
}

export function updateManifest(outDir: string, fn: (m: WebpopManifest) => WebpopManifest): void {
  const existing = readManifest(outDir);
  if (!existing) throw new Error(`No webpop.json in ${outDir}`);
  writeManifest(outDir, fn(existing));
}
