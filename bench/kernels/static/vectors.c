#include <stdio.h>
#include <stdlib.h>

typedef struct { double x, y, z; } Vec3;

static double dot(const Vec3 *a, const Vec3 *o) { return a->x * o->x + a->y * o->y + a->z * o->z; }

static void add_in_place(Vec3 *a, const Vec3 *o) {
    a->x += o->x;
    a->y += o->y;
    a->z += o->z;
}

static void scale_in_place(Vec3 *a, double k) {
    a->x *= k;
    a->y *= k;
    a->z *= k;
}

int main(int argc, char **argv) {
    long n = argc > 1 ? atol(argv[1]) : 0;
    Vec3 *a = malloc(sizeof *a), *b = malloc(sizeof *b), *c = malloc(sizeof *c);
    *a = (Vec3){ 1, 2, 3 };
    *b = (Vec3){ 0.5, -0.25, 0.125 };
    *c = (Vec3){ 0, 0, 0 };
    double s = 0.0;
    for (long i = 0; i < n; i++) {
        add_in_place(c, a);
        scale_in_place(c, 0.5);
        s += dot(c, b);
    }
    printf("%.6f\n", s);
    return 0;
}
