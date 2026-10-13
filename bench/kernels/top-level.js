// A loop written at the top level of a module: its variables are module bindings.
let sum = 0;
for (let i = 0; i < 30000000; i++) {
  if (i % 3 === 0) sum += i;
  else sum -= 1;
}
console.log(sum);
