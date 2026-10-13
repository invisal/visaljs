async function twice(p) {
  const a = await p;
  const b = await p;
  return a + b;
}
twice(Promise.resolve(21)).then(print);
