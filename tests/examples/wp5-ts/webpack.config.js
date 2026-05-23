const path = require('path');

const OUT = path.resolve(__dirname, '../dist');

const common = {
  entry: './src/index.ts',
  target: 'node',
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
};

module.exports = [
  {
    ...common,
    name: 'wp5-ts-dev',
    mode: 'development',
    devtool: false,
    output: { path: OUT, filename: 'wp5-ts-dev.min.js', iife: true },
    optimization: { moduleIds: 'named' },
  },
  {
    ...common,
    name: 'wp5-ts-prod',
    mode: 'production',
    output: { path: OUT, filename: 'wp5-ts-prod.min.js', iife: true },
  },
];
