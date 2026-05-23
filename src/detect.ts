import type { Format, ParsedBundle } from './types.js';
import { webpack5 } from './formats/webpack5.js';
import { webpackLegacy } from './formats/webpack-legacy.js';

/** All known formats, tried in order. */
const FORMATS: Format[] = [
  webpack5,       // wp5 dev + minified prod (detect by __webpack_modules__ or numeric shorthand methods)
  webpackLegacy,  // wp3/wp4 dev + minified prod (detect by bootstrap IIFE with modules argument)
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
