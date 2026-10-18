#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static double a(int64_t i, int64_t j) { return 1.0 / ((i + j) * (i + j + 1) / 2 + i + 1); }

static void times_a(int64_t n, const double *v, double *out) {
    for (int64_t i = 0; i < n; i++) {
        double sum = 0.0;
        for (int64_t j = 0; j < n; j++) sum += a(i, j) * v[j];
        out[i] = sum;
    }
}

static void times_at(int64_t n, const double *v, double *out) {
    for (int64_t i = 0; i < n; i++) {
        double sum = 0.0;
        for (int64_t j = 0; j < n; j++) sum += a(j, i) * v[j];
        out[i] = sum;
    }
}

static void times_at_a(int64_t n, const double *v, double *out, double *tmp) {
    times_a(n, v, tmp);
    times_at(n, tmp, out);
}

int main(int argc, char **argv) {
    int64_t n = argc > 1 ? atoll(argv[1]) : 0;
    double *u = calloc((size_t)n, sizeof *u), *v = calloc((size_t)n, sizeof *v), *tmp = calloc((size_t)n, sizeof *tmp);
    for (int64_t i = 0; i < n; i++) u[i] = 1.0;
    for (int k = 0; k < 10; k++) {
        times_at_a(n, u, v, tmp);
        times_at_a(n, v, u, tmp);
    }
    double uv = 0.0, vv = 0.0;
    for (int64_t i = 0; i < n; i++) {
        uv += u[i] * v[i];
        vv += v[i] * v[i];
    }
    printf("%.9f\n", sqrt(uv / vv));
    return 0;
}
