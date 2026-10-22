"use static";

const PI = 3.141592653589793;
const SOLAR_MASS = 4 * PI * PI;
const DAYS_PER_YEAR = 365.24;

class Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mass: number;
  next: Body | null = null;

  constructor(x: number, y: number, z: number, vx: number, vy: number, vz: number, mass: number) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = vx * DAYS_PER_YEAR;
    this.vy = vy * DAYS_PER_YEAR;
    this.vz = vz * DAYS_PER_YEAR;
    this.mass = mass * SOLAR_MASS;
  }
}

class System {
  first: Body;

  constructor() {
    const sun = new Body(0, 0, 0, 0, 0, 0, 1);
    const jupiter = new Body(4.84143144246472090e+00, -1.16032004402742839e+00, -1.03622044471123109e-01,
      1.66007664274403694e-03, 7.69901118419740425e-03, -6.90460016972063023e-05, 9.54791938424326609e-04);
    const saturn = new Body(8.34336671824457987e+00, 4.12479856412430479e+00, -4.03523417114321381e-01,
      -2.76742510726862411e-03, 4.99852801234917238e-03, 2.30417297573763929e-05, 2.85885980666130812e-04);
    const uranus = new Body(1.28943695621391310e+01, -1.51111514016986312e+01, -2.23307578892655734e-01,
      2.96460137564761618e-03, 2.37847173959480950e-03, -2.96589568540237556e-05, 4.36624404335156298e-05);
    const neptune = new Body(1.53796971148509165e+01, -2.59193146099879641e+01, 1.79258772950371181e-01,
      2.68067772490389322e-03, 1.62824170038242295e-03, -9.51592254519715870e-05, 5.15138902046611451e-05);
    sun.next = jupiter;
    jupiter.next = saturn;
    saturn.next = uranus;
    uranus.next = neptune;
    this.first = sun;
    let px = 0.0;
    let py = 0.0;
    let pz = 0.0;
    for (let b: Body | null = sun; b !== null; b = b.next) {
      px += b.vx * b.mass;
      py += b.vy * b.mass;
      pz += b.vz * b.mass;
    }
    sun.vx = -px / SOLAR_MASS;
    sun.vy = -py / SOLAR_MASS;
    sun.vz = -pz / SOLAR_MASS;
  }

  advance(dt: number): void {
    for (let a: Body | null = this.first; a !== null; a = a.next) {
      for (let b = a.next; b !== null; b = b.next) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const mag = dt / (d2 * Math.sqrt(d2));
        a.vx -= dx * b.mass * mag;
        a.vy -= dy * b.mass * mag;
        a.vz -= dz * b.mass * mag;
        b.vx += dx * a.mass * mag;
        b.vy += dy * a.mass * mag;
        b.vz += dz * a.mass * mag;
      }
    }
    for (let b: Body | null = this.first; b !== null; b = b.next) {
      b.x += dt * b.vx;
      b.y += dt * b.vy;
      b.z += dt * b.vz;
    }
  }

  energy(): number {
    let e = 0.0;
    for (let a: Body | null = this.first; a !== null; a = a.next) {
      e += 0.5 * a.mass * (a.vx * a.vx + a.vy * a.vy + a.vz * a.vz);
      for (let b = a.next; b !== null; b = b.next) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        e -= a.mass * b.mass / Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    }
    return e;
  }
}

export function nbody(n: number): string {
  const system = new System();
  const before = system.energy();
  for (let i = 0; i < n; i++) system.advance(0.01);
  return `${before.toFixed(9)}\n${system.energy().toFixed(9)}`;
}
