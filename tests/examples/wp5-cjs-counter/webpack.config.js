const path = require('path');

const OUT = path.resolve(__dirname, '../dist');

module.exports = [
  // webpack 5 development with named (path-based) module IDs
  {
    name: 'wp5-cjs-counter-named',
    mode: 'development',
    devtool: false,
    entry: './src/index.js',
    output: { path: OUT, filename: 'wp5-cjs-counter-named.min.js', iife: true },
    optimization: { moduleIds: 'named', runtimeChunk: false },
    target: 'node',
  },
  // webpack 5 development with numeric (size-based) module IDs
  {
    name: 'wp5-cjs-counter-numeric',
    mode: 'development',
    devtool: false,
    entry: './src/index.js',
    output: { path: OUT, filename: 'wp5-cjs-counter-numeric.min.js', iife: true },
    optimization: { moduleIds: 'size', runtimeChunk: false },
    target: 'node',
  },
  // webpack 5 production (minified)
  {
    name: 'wp5-cjs-counter-prod',
    mode: 'production',
    entry: './src/index.js',
    output: { path: OUT, filename: 'wp5-cjs-counter-prod.min.js', iife: true },
    target: 'node',
  },
];
