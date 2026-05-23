export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const product = (xs) => xs.reduce((a, b) => a * b, 1);
export const mean = (xs) => sum(xs) / xs.length;
