const path = require('path');

const OUT = path.resolve(__dirname, '../dist');

const common = {
  entry: './src/index.js',
  target: 'node',
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: { presets: [['@babel/preset-env', { targets: { node: '14' } }]] },
        },
      },
    ],
  },
};

module.exports = [
  {
    ...common,
    name: 'wp4-babel-es6-dev',
    mode: 'development',
    devtool: false,
    output: { path: OUT, filename: 'wp4-babel-es6-dev.min.js' },
    optimization: { namedModules: true },
  },
  {
    ...common,
    name: 'wp4-babel-es6-prod',
    mode: 'production',
    output: { path: OUT, filename: 'wp4-babel-es6-prod.min.js' },
  },
];
