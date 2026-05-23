import type { Format, ParsedBundle } from './types.js';
import { webpack5 } from './formats/webpack5.js';

/** All known formats, tried in order. */
const FORMATS: Format[] = [
  webpack5,
  // future: vite, esbuild, turbopack, ...
];

export function detectAndParse(source: string): ParsedBundle {
  for (const fmt of FORMATS) {
    if (fmt.detect(source)) {
      return fmt.parse(source);
    }
  }
  throw new Error(
    'Unrecognized bundle format. Detected formats: ' + FORMATS.map(f => f.name).join(', '),
  );
}

export function getFormat(name: string): Format | undefined {
  return FORMATS.find(f => f.name === name);
}
