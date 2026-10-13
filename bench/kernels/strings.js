// String building and character codes.
function build(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(97 + (i % 26));
  return s;
}
function checksum(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
let h = 0;
for (let k = 0; k < 10; k++) h = (h + checksum(build(500000))) | 0;
console.log(h);
