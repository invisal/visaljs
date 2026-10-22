#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#define PI 3.141592653589793
#define SOLAR_MASS (4 * PI * PI)
#define DAYS_PER_YEAR 365.24

typedef struct Body {
    double x, y, z, vx, vy, vz, mass;
    struct Body *next;
} Body;

static Body *body(double x, double y, double z, double vx, double vy, double vz, double mass) {
    Body *b = malloc(sizeof *b);
    *b = (Body){ x, y, z, vx * DAYS_PER_YEAR, vy * DAYS_PER_YEAR, vz * DAYS_PER_YEAR, mass * SOLAR_MASS, NULL };
    return b;
}

static Body *system_new(void) {
    Body *sun = body(0, 0, 0, 0, 0, 0, 1);
    Body *jupiter = body(4.84143144246472090e+00, -1.16032004402742839e+00, -1.03622044471123109e-01,
                         1.66007664274403694e-03, 7.69901118419740425e-03, -6.90460016972063023e-05, 9.54791938424326609e-04);
    Body *saturn = body(8.34336671824457987e+00, 4.12479856412430479e+00, -4.03523417114321381e-01,
                        -2.76742510726862411e-03, 4.99852801234917238e-03, 2.30417297573763929e-05, 2.85885980666130812e-04);
    Body *uranus = body(1.28943695621391310e+01, -1.51111514016986312e+01, -2.23307578892655734e-01,
                        2.96460137564761618e-03, 2.37847173959480950e-03, -2.96589568540237556e-05, 4.36624404335156298e-05);
    Body *neptune = body(1.53796971148509165e+01, -2.59193146099879641e+01, 1.79258772950371181e-01,
                         2.68067772490389322e-03, 1.62824170038242295e-03, -9.51592254519715870e-05, 5.15138902046611451e-05);
    sun->next = jupiter;
    jupiter->next = saturn;
    saturn->next = uranus;
    uranus->next = neptune;
    double px = 0.0, py = 0.0, pz = 0.0;
    for (Body *b = sun; b; b = b->next) {
        px += b->vx * b->mass;
        py += b->vy * b->mass;
        pz += b->vz * b->mass;
    }
    sun->vx = -px / SOLAR_MASS;
    sun->vy = -py / SOLAR_MASS;
    sun->vz = -pz / SOLAR_MASS;
    return sun;
}

static void advance(Body *first, double dt) {
    for (Body *a = first; a; a = a->next)
        for (Body *b = a->next; b; b = b->next) {
            double dx = a->x - b->x, dy = a->y - b->y, dz = a->z - b->z;
            double d2 = dx * dx + dy * dy + dz * dz;
            double mag = dt / (d2 * sqrt(d2));
            a->vx -= dx * b->mass * mag;
            a->vy -= dy * b->mass * mag;
            a->vz -= dz * b->mass * mag;
            b->vx += dx * a->mass * mag;
            b->vy += dy * a->mass * mag;
            b->vz += dz * a->mass * mag;
        }
    for (Body *b = first; b; b = b->next) {
        b->x += dt * b->vx;
        b->y += dt * b->vy;
        b->z += dt * b->vz;
    }
}

static double energy(const Body *first) {
    double e = 0.0;
    for (const Body *a = first; a; a = a->next) {
        e += 0.5 * a->mass * (a->vx * a->vx + a->vy * a->vy + a->vz * a->vz);
        for (const Body *b = a->next; b; b = b->next) {
            double dx = a->x - b->x, dy = a->y - b->y, dz = a->z - b->z;
            e -= a->mass * b->mass / sqrt(dx * dx + dy * dy + dz * dz);
        }
    }
    return e;
}

int main(int argc, char **argv) {
    long n = argc > 1 ? atol(argv[1]) : 0;
    Body *system = system_new();
    printf("%.9f\n", energy(system));
    for (long i = 0; i < n; i++) advance(system, 0.01);
    printf("%.9f\n", energy(system));
    return 0;
}
