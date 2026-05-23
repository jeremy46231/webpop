const path = require('path');

const OUT = path.resolve(__dirname, '../dist');

module.exports = [
  {
    name: 'wp5-esm-math-dev',
    mode: 'development',
    devtool: false,
    entry: './src/index.js',
    output: { path: OUT, filename: 'wp5-esm-math-dev.min.js', iife: true },
    optimization: { moduleIds: 'named' },
    target: 'node',
  },
  {
    name: 'wp5-esm-math-prod',
    mode: 'production',
    entry: './src/index.js',
    output: { path: OUT, filename: 'wp5-esm-math-prod.min.js', iife: true },
    target: 'node',
  },
];
