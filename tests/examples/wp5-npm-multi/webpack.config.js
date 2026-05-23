const path = require('path');

const common = {
  target: 'node',
  devtool: false,
  entry: './src/index.js',
  output: { path: path.resolve(__dirname, '../dist'), iife: true },
};

module.exports = [
  {
    ...common,
    mode: 'development',
    output: { ...common.output, filename: 'wp5-npm-multi-dev.min.js' },
  },
  {
    ...common,
    mode: 'production',
    output: { ...common.output, filename: 'wp5-npm-multi-prod.min.js' },
  },
];
