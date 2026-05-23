import type { BlockStatement } from '@babel/types';

export type ModuleId = string | number;

/** A module extracted from a bundle, with its body as a Babel AST. */
export interface RawModule {
  id: ModuleId;
  /** Best-effort path hint. null means unknown — use module_N.js fallback. */
  hintPath: string | null;
  /** Name of the require-shim identifier inside the factory (e.g. "__webpack_require__", "n", "r"). */
  requireParamName: string | null;
  /** The factory function's body — ready for AST transforms and codegen. */
  body: BlockStatement;
}

export interface ParsedBundle {
  modules: Map<ModuleId, RawModule>;
  entryId: ModuleId;
  formatName: string;
  chunkName?: string;
}

/**
 * A bundle format plugin.
 *
 * detect() must be fast — string scan or one-pass check, called before any full parse.
 * parse() does the full work and returns RawModules with AST bodies.
 * writeRepackConfig() is optional — formats that can be repacked implement it.
 */
export interface Format {
  readonly name: string;
  detect(source: string): boolean;
  parse(source: string): ParsedBundle;
  writeRepackConfig?(bundle: ParsedBundle, outDir: string, outputPaths: Map<ModuleId, string>): void;
}
