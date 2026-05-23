import { sum, product } from './ops.js';
import { stats } from './stats.js';

const nums = [3, 7, 12, 19, 4, 8];

const s = sum(nums);
const p = product(nums);
const st = stats(nums);

console.log('sum =', s);
console.log('product =', p);
console.log('mean =', st.mean);
console.log('variance =', st.variance);
