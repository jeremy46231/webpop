var math = require('../utils/math');

function Counter(initial) {
  this.value = initial || 0;
  this.history = [];
}

Counter.prototype.increment = function(amount) {
  amount = amount || 1;
  this.history.push(this.value);
  this.value = math.add(this.value, amount);
  return this;
};

Counter.prototype.decrement = function(amount) {
  amount = amount || 1;
  this.history.push(this.value);
  this.value = math.add(this.value, -amount);
  return this;
};

Counter.prototype.multiply = function(factor) {
  this.history.push(this.value);
  this.value = math.multiply(this.value, factor);
  return this;
};

Counter.prototype.clamp = function(min, max) {
  this.value = math.clamp(this.value, min, max);
  return this;
};

Counter.prototype.reset = function() {
  this.history.push(this.value);
  this.value = 0;
  return this;
};

Counter.prototype.valueOf = function() {
  return this.value;
};

module.exports = Counter;
