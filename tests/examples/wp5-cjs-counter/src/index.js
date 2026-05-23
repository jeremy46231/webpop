var Counter = require('./components/counter');
var display = require('./components/display');

function main() {
  // Exercise Counter
  var c = new Counter(10);
  c.increment(5).multiply(3).decrement(2).clamp(0, 100);

  var rows = [
    { label: 'Initial', value: 10 },
    { label: 'After +5, *3, -2', value: c.value },
    { label: 'History length', value: c.history.length },
  ];

  console.log(display.renderTable('Counter Demo', rows));
  console.log('');
  console.log(display.renderFactorials(8));
  console.log('');
  console.log(display.formatValue('clamp(150, 0, 100)', c.clamp(0, 100).value));

  return c.value;
}

var result = main();
module.exports = result;
