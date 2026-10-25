"use static";

export class Vec {
  x: number;
  y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  plus(o: Vec): Vec {
    return new Vec(this.x + o.x, this.y + o.y);
  }

  dot(o: Vec): number {
    return this.x * o.x + this.y * o.y;
  }
}
