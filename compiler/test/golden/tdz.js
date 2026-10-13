function early() {
  return late;
}
let late = 1;
const fixed = 2;
{
  let inner = late + fixed;
  print(inner);
}
function write() {
  late = 3;
}
write();
print(early());
