const _ = require('lodash');
const { v4: uuidv4 } = require('uuid');

const data = _.range(1, 20).map((n) => ({
  id: uuidv4().slice(0, 8),
  n,
  squared: n * n,
}));

const grouped = _.groupBy(data, (d) => (d.squared % 2 === 0 ? 'even' : 'odd'));
const summary = _.mapValues(grouped, (xs) => _.sumBy(xs, 'squared'));

console.log('Lodash + uuid demo');
console.log('first row:', data[0]);
console.log('summary:', summary);
