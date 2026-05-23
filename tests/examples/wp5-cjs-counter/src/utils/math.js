function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a * b;
}

function factorial(n) {
  if (n <= 1) return 1;
  return multiply(n, factorial(n - 1));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

module.exports = { add, multiply, factorial, clamp };
