async function main() {
  const { greet } = await import(/* webpackChunkName: "greeter" */ './greeter.js');
  const { compute } = await import(/* webpackChunkName: "compute" */ './compute.js');

  console.log(greet('world'));
  console.log('compute(7):', compute(7));
}

main();
