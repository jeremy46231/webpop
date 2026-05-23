const path = require('path');

const OUT = path.resolve(__dirname, '../dist');

module.exports = {
  name: 'wp5-prod-lodash',
  mode: 'production',
  entry: './src/index.js',
  output: { path: OUT, filename: 'wp5-prod-lodash.min.js', iife: true },
  target: 'node',
  optimization: {
    minimize: true,
    runtimeChunk: false,
    splitChunks: false,
  },
};
