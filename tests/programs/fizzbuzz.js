for (let i = 1; i <= 30; i++) {
  let line = "";
  if (i % 3 === 0) line += "Fizz";
  if (i % 5 === 0) line += "Buzz";
  print(line || i);
}
