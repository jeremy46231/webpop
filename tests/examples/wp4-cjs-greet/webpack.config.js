const path = require('path');

const OUT = path.resolve(__dirname, '../dist');

module.exports = [
  {
    name: 'wp4-cjs-greet-dev',
    mode: 'development',
    devtool: false,
    entry: './src/index.js',
    output: { path: OUT, filename: 'wp4-cjs-greet-dev.min.js' },
    target: 'node',
    optimization: { namedModules: true },
  },
  {
    name: 'wp4-cjs-greet-prod',
    mode: 'production',
    entry: './src/index.js',
    output: { path: OUT, filename: 'wp4-cjs-greet-prod.min.js' },
    target: 'node',
  },
];
