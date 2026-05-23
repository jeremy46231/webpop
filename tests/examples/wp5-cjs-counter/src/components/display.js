var str = require('../utils/string');
var math = require('../utils/math');

var BORDER_CHAR = '=';
var BORDER_WIDTH = 40;

function formatValue(label, value) {
  var labelPart = str.truncate(label, 20);
  var valuePart = str.pad(String(value), 10);
  return labelPart + ' | ' + valuePart;
}

function renderBorder() {
  return str.repeat(BORDER_CHAR, BORDER_WIDTH);
}

function renderTitle(title) {
  var inner = ' ' + str.capitalize(title) + ' ';
  var padding = Math.floor((BORDER_WIDTH - inner.length) / 2);
  return str.repeat(BORDER_CHAR, padding) + inner + str.repeat(BORDER_CHAR, padding);
}

function renderTable(title, rows) {
  var lines = [];
  lines.push(renderBorder());
  lines.push(renderTitle(title));
  lines.push(renderBorder());
  rows.forEach(function(row) {
    lines.push(formatValue(row.label, row.value));
  });
  lines.push(renderBorder());
  return lines.join('\n');
}

function renderFactorials(upTo) {
  var rows = [];
  for (var i = 1; i <= upTo; i++) {
    rows.push({ label: i + '!', value: math.factorial(i) });
  }
  return renderTable('Factorials', rows);
}

module.exports = { renderTable, renderFactorials, formatValue };
