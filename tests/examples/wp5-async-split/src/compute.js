export function compute(n) {
  // fibonacci
  if (n < 2) return n;
  return compute(n - 1) + compute(n - 2);
}
