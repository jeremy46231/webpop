import ms from 'ms';
import pc from 'picocolors';
import leven from 'leven';

import { Stopwatch } from './stopwatch';
import { suggest } from './suggest';

const sw = new Stopwatch('demo');
sw.mark(1000).mark(2500).mark(3700);
console.log(`stopwatch ${sw.name} marks:`, sw.marks);

const words = ['banana', 'apple', 'grape', 'orange'];
const target = 'aple';

console.log(pc.bold('input: ') + target);
for (const w of words) {
  console.log(`  ${w}: distance=${leven(target, w)}`);
}
console.log(pc.green('best match: ') + suggest(target, words));
console.log(pc.dim(`sample duration: ${ms(2 * 60 * 1000)}`));
