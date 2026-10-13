function count(n) {
  let hits = 0;
  outer: for (let i = 0; i < n; i++) {
    let j = 0;
    while (true) {
      j++;
      if (j > i) continue outer;
      if (i * j > 20) break outer;
      hits++;
    }
  }
  do {
    hits--;
  } while (hits > 100);
  return hits;
}
print(count(8));
