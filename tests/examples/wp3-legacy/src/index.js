var calc = require('./calc');
var fmt = require('./fmt');

var ops = [
  { a: 12, b: 5, op: 'add' },
  { a: 12, b: 5, op: 'sub' },
  { a: 12, b: 5, op: 'mul' },
  { a: 12, b: 5, op: 'div' },
];

for (var i = 0; i < ops.length; i++) {
  var o = ops[i];
  var result = calc.apply(o.op, o.a, o.b);
  console.log(fmt.row(o.a, o.op, o.b, result));
}
