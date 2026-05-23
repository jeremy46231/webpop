const ms = require('ms');
const semver = require('semver');
const pc = require('picocolors');

// ms: single-function module (time parsing/formatting)
console.log(pc.bold('=== ms timing ==='));
console.log(ms(2 * 60 * 1000));           // '2m'
console.log(ms('1.5h'));                   // 90000
console.log(ms(86400000, { long: true })); // '1 day'

// semver: many named exports (version comparison)
console.log(pc.bold('\n=== semver ==='));
const versions = ['1.0.0', '2.1.0', '3.0.0-beta.1', '2.5.4'];
for (const v of versions) {
  console.log(`${pc.cyan(v)}: valid=${semver.valid(v)}, major=${semver.major(v)}`);
}
console.log('gt(2.1.0, 1.0.0):', semver.gt('2.1.0', '1.0.0'));
console.log('satisfies(2.5.4, ^2.0.0):', semver.satisfies('2.5.4', '^2.0.0'));
console.log('sorted:', semver.rsort(versions.filter(v => !v.includes('-'))).join(', '));

// picocolors: color output utilities
console.log(pc.bold('\n=== picocolors ==='));
console.log(pc.green('Success!'), pc.red('Error!'), pc.yellow('Warning!'));
console.log(pc.dim('dim text'), pc.underline('underlined'), pc.italic('italic'));
