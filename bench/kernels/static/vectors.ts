"use static";

class Vec3 {
  x: number;
  y: number;
  z: number;

  constructor(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  dot(o: Vec3): number {
    return this.x * o.x + this.y * o.y + this.z * o.z;
  }

  addInPlace(o: Vec3): void {
    this.x += o.x;
    this.y += o.y;
    this.z += o.z;
  }

  scaleInPlace(k: number): void {
    this.x *= k;
    this.y *= k;
    this.z *= k;
  }
}

export function vectors(n: number): string {
  const a = new Vec3(1, 2, 3);
  const b = new Vec3(0.5, -0.25, 0.125);
  const c = new Vec3(0, 0, 0);
  let s = 0.0;
  for (let i = 0; i < n; i++) {
    c.addInPlace(a);
    c.scaleInPlace(0.5);
    s += c.dot(b);
  }
  return s.toFixed(6);
}
