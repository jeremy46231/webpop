import { mean } from './ops.js';

export function stats(xs) {
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length;
  return { mean: m, variance };
}
