/**
 * Parser for fully inlined/tree-shaken webpack 5 bundles.
 *
 * When webpack tree-shakes everything into a single chunk with no dynamic
 * imports, the result is just a plain arrow IIFE with no module registry:
 *
 *   (()=>{"use strict"; ...all code inlined...})();
 *
 * There is no module structure to recover.  We extract the entire IIFE body
 * as one synthetic module so the bundle can at least be represented and
 * repacked into a functionally identical output.
 */

import { writeFileSync } from 'fs';
import { join, relative } from 'path';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import type { Format, ModuleId, ParsedBundle, RawModule } from '../types.js';

const ENTRY_ID: ModuleId = '__entry__';

function getIIFEBody(source: string): t.Statement[] | null {
  const ast = parse(source, {
    sourceType: 'script',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  });
  for (const stmt of ast.program.body) {
    if (!t.isExpressionStatement(stmt)) continue;
    const expr = stmt.expression;
    if (!t.isCallExpression(expr) || expr.arguments.length !== 0) continue;
    const callee = expr.callee;
    if (
      (t.isArrowFunctionExpression(callee) || t.isFunctionExpression(callee)) &&
      t.isBlockStatement(callee.body)
    ) {
      return callee.body.body;
    }
  }
  return null;
}

function repackConfig(
  bundle: ParsedBundle,
  outDir: string,
  outputPaths: Map<ModuleId, string>,
): void {
  const entryAbs = outputPaths.get(bundle.entryId)!;
  const entryRel = './' + relative(outDir, entryAbs);

  writeFileSync(
    join(outDir, 'webpack.config.js'),
    `const path = require('path');
module.exports = {
  mode: 'development',
  devtool: false,
  entry: ${JSON.stringify(entryRel)},
  output: { path: path.resolve(__dirname, 'dist'), filename: 'bundle.js', iife: true },
  optimization: { moduleIds: 'named', runtimeChunk: false },
  target: 'node',
};\n`,
  );

  writeFileSync(
    join(outDir, 'package.json'),
    JSON.stringify(
      {
        name: 'webpop-repacked',
        version: '1.0.0',
        private: true,
        scripts: { build: 'webpack' },
        devDependencies: { webpack: '^5.0.0', 'webpack-cli': '^5.0.0' },
      },
      null,
      2,
    ) + '\n',
  );
}

export const wp5Inlined: Format = {
  name: 'wp5Inlined',

  detect(source: string): boolean {
    if (!source.trimStart().startsWith('(()=>')) return false;
    if (source.includes('__webpack_require__')) return false;
    if (source.includes('var __webpack_modules__')) return false;
    if (source.includes('exports.modules')) return false;
    if (source.includes('Promise.all(')) return false;
    return true;
  },

  parse(source: string): ParsedBundle {
    const stmts = getIIFEBody(source);
    if (!stmts) throw new Error('wp5Inlined: could not find outer IIFE');

    // Drop the "use strict" directive — webpack will add its own
    const body = stmts.filter(
      s => !(t.isExpressionStatement(s) && t.isStringLiteral((s as t.ExpressionStatement).expression)),
    );

    const entryModule: RawModule = {
      id: ENTRY_ID,
      hintPath: 'entry.js',
      requireParamName: null,
      body: t.blockStatement(body),
    };

    const modules = new Map<ModuleId, RawModule>();
    modules.set(ENTRY_ID, entryModule);
    return { modules, entryId: ENTRY_ID, formatName: 'wp5Inlined' };
  },

  writeRepackConfig: repackConfig,
};
