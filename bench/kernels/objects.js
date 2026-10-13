// Many small objects: allocation, property reads and a method call.
class Point {
  constructor(x, y) { this.x = x; this.y = y; }
  add(o) { return new Point(this.x + o.x, this.y + o.y); }
}
let p = new Point(0, 0);
const step = new Point(1, 2);
for (let i = 0; i < 10000000; i++) p = p.add(step);
console.log(p.x, p.y);
