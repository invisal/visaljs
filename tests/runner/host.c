/*
 * The test262 host: loads one batch
 * library and runs its compile units, each in a forked child so a crash,
 * a hang or a runaway allocation only takes that test down.
 *
 *   host <batch.so> <timeout-seconds> <prefix>...
 *
 * Each unit exports `int <prefix>run(void)` (the compiler's emitUnit). For each,
 * the host prints one record to stdout:
 *
 *   <prefix> <exit|signal> <code> <n>\n<n bytes of the unit's stdout+stderr>
 *
 * A timeout is `signal 14` (SIGALRM). Output beyond 16 KiB is dropped.
 * The runtime is linked into this program (-rdynamic): batches use its symbols.
 */
#define _POSIX_C_SOURCE 200809L
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

#define MAX_OUTPUT 16384
#define MEMORY_LIMIT ((rlim_t)2 << 30)  /* per test: 2 GiB of address space */

typedef int (*UnitFn)(void);

static void run_one(UnitFn fn, const char *prefix, unsigned timeout) {
    int fds[2];
    if (pipe(fds) != 0) {
        perror("host: pipe");
        exit(2);
    }
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) {
        perror("host: fork");
        exit(2);
    }
    if (pid == 0) {
        close(fds[0]);
        dup2(fds[1], 1);
        dup2(fds[1], 2);
        close(fds[1]);
        struct rlimit mem = { MEMORY_LIMIT, MEMORY_LIMIT };
        setrlimit(RLIMIT_AS, &mem);
        alarm(timeout);
        int status = fn();
        fflush(NULL);
        _exit(status & 0xff);
    }
    close(fds[1]);
    static char out[MAX_OUTPUT];
    size_t n = 0;
    char drain[4096];
    for (;;) {
        ssize_t r = n < MAX_OUTPUT ? read(fds[0], out + n, MAX_OUTPUT - n) : read(fds[0], drain, sizeof drain);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) break;
        if (n < MAX_OUTPUT) n += (size_t)r;
    }
    close(fds[0]);
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    if (WIFSIGNALED(status)) printf("%s signal %d %zu\n", prefix, WTERMSIG(status), n);
    else printf("%s exit %d %zu\n", prefix, WEXITSTATUS(status), n);
    fwrite(out, 1, n, stdout);
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: host <batch.so> <timeout-seconds> <prefix>...\n");
        return 2;
    }
    void *lib = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!lib) {
        fprintf(stderr, "host: %s\n", dlerror());
        return 2;
    }
    unsigned timeout = (unsigned)atoi(argv[2]);
    for (int i = 3; i < argc; i++) {
        char symbol[256];
        snprintf(symbol, sizeof symbol, "%srun", argv[i]);
        UnitFn fn = (UnitFn)(uintptr_t)dlsym(lib, symbol);
        if (!fn) {
            printf("%s missing 0 0\n", argv[i]);
            continue;
        }
        run_one(fn, argv[i], timeout);
    }
    fflush(stdout);
    return 0;
}
