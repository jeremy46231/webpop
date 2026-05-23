declare module '@babel/generator' {
  import type * as t from '@babel/types';
  interface GeneratorResult { code: string; }
  function generate(ast: t.Node, opts?: object, code?: string | Record<string, string>): GeneratorResult;
  export default generate;
}
