var path = require('path');
var webpack = require('webpack');

var OUT = path.resolve(__dirname, '../dist');

var common = {
  entry: './src/index.js',
  target: 'node',
};

module.exports = [
  Object.assign({}, common, {
    output: { path: OUT, filename: 'wp3-legacy-dev.min.js' },
  }),
  Object.assign({}, common, {
    output: { path: OUT, filename: 'wp3-legacy-prod.min.js' },
    plugins: [
      new webpack.optimize.UglifyJsPlugin({ compress: { warnings: false } }),
    ],
  }),
];
