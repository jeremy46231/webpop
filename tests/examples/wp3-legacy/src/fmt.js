var SYMBOLS = {
  add: '+',
  sub: '-',
  mul: '*',
  div: '/',
};

exports.row = function (a, op, b, result) {
  return a + ' ' + (SYMBOLS[op] || op) + ' ' + b + ' = ' + result;
};
