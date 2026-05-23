const path = require('path');

const OUT = path.resolve(__dirname, '../dist');

module.exports = {
  name: 'wp5-async-split',
  mode: 'production',
  entry: './src/index.js',
  output: {
    path: OUT,
    filename: 'wp5-async-split.min.js',
    chunkFilename: 'wp5-async-split-chunk-[name].min.js',
    iife: true,
    clean: false,
  },
  target: 'node',
};
