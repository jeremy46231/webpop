import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { VISITOR_KEYS } from '@babel/types';
import type { Format, ModuleId, ParsedBundle, RawModule } from '../types.js';
import { basename } from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walk(root: t.Node, visit: (n: t.Node) => boolean | void): void {
  const q: t.Node[] = [root];
  while (q.length) {
    const node = q.shift()!;
    if (visit(node)) continue;
    const keys = (VISITOR_KEYS as Record<string, readonly string[]>)[node.type];
    if (!keys) continue;
    for (const k of keys) {
      const v = (node as unknown as Record<string, unknown>)[k];
      if (Array.isArray(v)) {
        for (const c of v) if (c && (c as t.Node).type) q.push(c as t.Node);
      } else if (v && (v as t.Node).type) {
        q.push(v as t.Node);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// System.register parser
//
// Format:
//   System.register([dep1, dep2, ...], function(export, context) {
//     "use strict";
//     var importedVar1, importedVar2, ...;
//     return {
//       setters: [function(m) { ... }, ...],
//       execute: function() { ... }
//     };
//   });
//
// We extract the execute() body as the module body, and record deps as hintPaths.
// The module is identified by its source filename (passed as chunkName).
// ---------------------------------------------------------------------------

interface SystemModule {
  deps: string[];
  executeBody: t.BlockStatement;
  setterCount: number;
}

function parseSystemRegister(source: string): SystemModule | null {
  let ast;
  try {
    ast = parse(source, {
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
    });
  } catch {
    return null;
  }

  let result: SystemModule | null = null;

  walk(ast, (node) => {
    if (result) return true;

    // Looking for: System.register([...deps], function(...) { ... })
    if (!t.isCallExpression(node)) return;
    const { callee, arguments: args } = node;
    if (
      !t.isMemberExpression(callee) ||
      !t.isIdentifier((callee as t.MemberExpression).object, { name: 'System' }) ||
      !t.isIdentifier((callee as t.MemberExpression).property, { name: 'register' })
    ) return;

    // Two forms:
    // System.register([deps], factory)
    // System.register("name", [deps], factory)  (named)
    let depsNode: t.Node | undefined;
    let factoryNode: t.Node | undefined;

    if (args.length === 2) {
      depsNode = args[0];
      factoryNode = args[1];
    } else if (args.length === 3 && t.isStringLiteral(args[0])) {
      depsNode = args[1];
      factoryNode = args[2];
    } else {
      return;
    }

    if (!t.isArrayExpression(depsNode) || !t.isFunctionExpression(factoryNode)) return;

    const deps: string[] = [];
    for (const el of (depsNode as t.ArrayExpression).elements) {
      if (t.isStringLiteral(el)) deps.push(el.value);
    }

    // The factory returns { execute: function() {...}, setters: [...] }
    // Find the return statement with an ObjectExpression
    const factoryBody = (factoryNode as t.FunctionExpression).body.body;
    let executeBody: t.BlockStatement | null = null;
    let setterCount = 0;

    for (const stmt of factoryBody) {
      if (!t.isReturnStatement(stmt) || !t.isObjectExpression(stmt.argument)) continue;
      const obj = stmt.argument as t.ObjectExpression;
      for (const prop of obj.properties) {
        if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) continue;
        const key = (prop as t.ObjectProperty | t.ObjectMethod).key;
        if (t.isIdentifier(key, { name: 'execute' })) {
          if (t.isObjectMethod(prop) && t.isBlockStatement((prop as t.ObjectMethod).body)) {
            executeBody = (prop as t.ObjectMethod).body as t.BlockStatement;
          } else if (t.isObjectProperty(prop)) {
            const val = (prop as t.ObjectProperty).value;
            if ((t.isFunctionExpression(val) || t.isArrowFunctionExpression(val)) && t.isBlockStatement(val.body)) {
              executeBody = val.body as t.BlockStatement;
            }
          }
        }
        if (t.isIdentifier(key, { name: 'setters' }) && t.isObjectProperty(prop)) {
          const val = (prop as t.ObjectProperty).value;
          if (t.isArrayExpression(val)) setterCount = (val as t.ArrayExpression).elements.length;
        }
      }
    }

    if (!executeBody) {
      // Module with no execute — create empty body
      executeBody = t.blockStatement([]);
    }

    result = { deps, executeBody, setterCount };
    return true;
  });

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Extract a hintPath from the //# sourceMappingURL comment, if present. */
function extractSourceMapHint(source: string): string | null {
  const m = source.match(/\/\/[#@] sourceMappingURL=([^\s]+)$/m);
  if (!m) return null;
  // e.g. https://quip.com/-/js-source-map/QpN_K8gO4HB9sk3iY7rvcw-chunk
  // → QpN_K8gO4HB9sk3iY7rvcw-chunk.js
  const urlPart = m[1].split('/').pop() ?? '';
  return urlPart ? urlPart.replace(/\.(map|js)$/, '') + '.js' : null;
}

/**
 * Parse a file that may contain one or more System.register() calls.
 * Each call becomes a separate module. When there's only one call, the
 * module ID is the source filename (passed as hintPath).
 * Multi-module files use hintPath + "#N" for subsequent calls.
 */
export function parseSystemRegisterFile(
  source: string,
  hintPath: string | null,
): Map<ModuleId, RawModule> {
  // Try to derive hintPath from sourceMappingURL if not supplied
  if (!hintPath) hintPath = extractSourceMapHint(source);
  const modules = new Map<ModuleId, RawModule>();

  let ast;
  try {
    ast = parse(source, {
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
    });
  } catch {
    return modules;
  }

  let idx = 0;
  walk(ast, (node) => {
    if (!t.isCallExpression(node)) return;
    const { callee, arguments: args } = node;
    if (
      !t.isMemberExpression(callee) ||
      !t.isIdentifier((callee as t.MemberExpression).object, { name: 'System' }) ||
      !t.isIdentifier((callee as t.MemberExpression).property, { name: 'register' })
    ) return;

    let depsNode: t.Node | undefined;
    let factoryNode: t.Node | undefined;
    let moduleHintPath = hintPath;

    if (args.length === 2) {
      depsNode = args[0];
      factoryNode = args[1];
    } else if (args.length === 3 && t.isStringLiteral(args[0])) {
      // Named module: System.register("name", [deps], factory)
      const name = (args[0] as t.StringLiteral).value;
      moduleHintPath = name.endsWith('.js') ? name : `${name}.js`;
      depsNode = args[1];
      factoryNode = args[2];
    } else {
      return;
    }

    if (!t.isArrayExpression(depsNode)) return;
    const factory = factoryNode;
    if (!factory || (!t.isFunctionExpression(factory) && !t.isArrowFunctionExpression(factory))) return;

    // Build dep-import shims from setters: each dep becomes a require()
    const deps: string[] = [];
    for (const el of (depsNode as t.ArrayExpression).elements) {
      if (t.isStringLiteral(el)) deps.push(el.value);
    }

    const factoryBody = t.isBlockStatement((factory as t.FunctionExpression | t.ArrowFunctionExpression).body)
      ? ((factory as t.FunctionExpression | t.ArrowFunctionExpression).body as t.BlockStatement).body
      : [];

    // Find execute() body
    let executeBody: t.BlockStatement = t.blockStatement([]);
    let setterStmts: t.Statement[] = [];

    for (const stmt of factoryBody) {
      if (!t.isReturnStatement(stmt) || !t.isObjectExpression(stmt.argument)) continue;
      const obj = stmt.argument as t.ObjectExpression;
      for (const prop of obj.properties) {
        if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) continue;
        const key = (prop as t.ObjectProperty | t.ObjectMethod).key;
        if (t.isIdentifier(key, { name: 'execute' })) {
          if (t.isObjectMethod(prop)) {
            executeBody = (prop as t.ObjectMethod).body as t.BlockStatement;
          } else if (t.isObjectProperty(prop)) {
            const val = (prop as t.ObjectProperty).value;
            if ((t.isFunctionExpression(val) || t.isArrowFunctionExpression(val)) && t.isBlockStatement(val.body)) {
              executeBody = val.body as t.BlockStatement;
            }
          }
        }
        if (t.isIdentifier(key, { name: 'setters' }) && t.isObjectProperty(prop)) {
          const val = (prop as t.ObjectProperty).value;
          if (t.isArrayExpression(val)) {
            // Convert each setter to: var _dep = require("./dep")
            (val as t.ArrayExpression).elements.forEach((setter, i) => {
              const depPath = deps[i] ?? `./unknown_dep_${i}`;
              setterStmts.push(
                t.variableDeclaration('var', [
                  t.variableDeclarator(
                    t.identifier(`_dep${i}`),
                    t.callExpression(t.identifier('require'), [t.stringLiteral(depPath)]),
                  ),
                ]),
              );
              // If the setter does anything, add a call to it
              if (setter && (t.isFunctionExpression(setter) || t.isArrowFunctionExpression(setter))) {
                const setterBody = (setter as t.FunctionExpression | t.ArrowFunctionExpression).body;
                if (t.isBlockStatement(setterBody)) {
                  // Inline setter body, replacing its param with _depN
                  setterStmts.push(...(setterBody as t.BlockStatement).body);
                }
              }
            });
          }
        }
      }
    }

    const fullBody = t.blockStatement([...setterStmts, ...executeBody.body]);

    // For single-module files use hintPath as id (without .js) so output is named after the source.
    // For multi-module files fall back to integer IDs.
    const idBase = moduleHintPath ? moduleHintPath.replace(/\.js$/, '') : null;
    const id: ModuleId = idx === 0 && idBase ? idBase : idx;
    modules.set(id, {
      id,
      hintPath: moduleHintPath,
      requireParamName: null,
      body: fullBody,
    });
    idx++;
  });

  return modules;
}

// ---------------------------------------------------------------------------
// Format export
// ---------------------------------------------------------------------------

export const systemRegister: Format = {
  name: 'system-register',

  detect(source) {
    return source.includes('System.register(') &&
      !source.includes('globalThis.webpackChunk');
  },

  parse(source): ParsedBundle {
    const modules = parseSystemRegisterFile(source, null);

    if (modules.size === 0) {
      throw new Error('system-register: no System.register() calls found');
    }

    // Entry is the first module
    const entryId = modules.keys().next().value as ModuleId;

    return {
      modules,
      entryId,
      formatName: 'system-register',
    };
  },
};
