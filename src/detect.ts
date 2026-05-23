import type { Format, ParsedBundle } from './types.js';
import { webpack5 } from './formats/webpack5.js';
import { webpackLegacy } from './formats/webpack-legacy.js';
import { wp5Inlined } from './formats/wp5-inlined.js';

/** All known formats, tried in order. */
const FORMATS: Format[] = [
  webpack5,       // wp5 dev + minified prod + async-split main
  webpackLegacy,  // wp3/wp4 dev + minified prod
  wp5Inlined,     // fully tree-shaken bundles with no module registry
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
