/* Memory and time from the operating system. */
#define _GNU_SOURCE  /* MAP_ANONYMOUS under -std=c11, pthread_getattr_np */
#include "os.h"

#include <stdint.h>

#ifdef _WIN32
#include <windows.h>
#include <malloc.h>
#include <psapi.h>
#include <stdlib.h>
#include <time.h>

size_t js_os_page_size(void) {
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    return si.dwPageSize;
}

void *js_os_map(size_t size) {
    return VirtualAlloc(NULL, size, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
}

/* The allocation granularity is already 64 KiB. */
void *js_os_map_aligned(size_t size, size_t align) {
    void *p = js_os_map(size);
    if (p && ((uintptr_t)p & (align - 1))) {
        js_os_unmap(p, size);
        return NULL;
    }
    return p;
}

void js_os_unmap(void *p, size_t size) {
    (void)size;
    VirtualFree(p, 0, MEM_RELEASE);
}

void js_os_decommit(void *p, size_t size) {
    VirtualFree(p, size, MEM_DECOMMIT);
}

bool js_os_commit(void *p, size_t size) {
    return VirtualAlloc(p, size, MEM_COMMIT, PAGE_READWRITE) != NULL;
}

void js_os_trim(void) {
    _heapmin();
}

struct JSOsLock { SRWLOCK lock; };
struct JSOsCond { CONDITION_VARIABLE cond; };
struct JSOsThread { HANDLE handle; void (*fn)(void *); void *arg; };

JSOsLock *js_os_lock_new(void) {
    JSOsLock *l = calloc(1, sizeof *l);
    if (l) InitializeSRWLock(&l->lock);
    return l;
}
void js_os_lock_free(JSOsLock *l) { free(l); }
void js_os_lock(JSOsLock *l) { AcquireSRWLockExclusive(&l->lock); }
void js_os_unlock(JSOsLock *l) { ReleaseSRWLockExclusive(&l->lock); }
JSOsCond *js_os_cond_new(void) {
    JSOsCond *c = calloc(1, sizeof *c);
    if (c) InitializeConditionVariable(&c->cond);
    return c;
}
void js_os_cond_free(JSOsCond *c) { free(c); }
void js_os_cond_wait(JSOsCond *c, JSOsLock *l) { SleepConditionVariableSRW(&c->cond, &l->lock, INFINITE, 0); }
void js_os_cond_signal(JSOsCond *c) { WakeConditionVariable(&c->cond); }
void js_os_cond_broadcast(JSOsCond *c) { WakeAllConditionVariable(&c->cond); }

static DWORD WINAPI thread_main(LPVOID p) {
    JSOsThread *t = p;
    t->fn(t->arg);
    return 0;
}
JSOsThread *js_os_thread_start(void (*fn)(void *), void *arg) {
    JSOsThread *t = calloc(1, sizeof *t);
    if (!t) return NULL;
    t->fn = fn;
    t->arg = arg;
    t->handle = CreateThread(NULL, 0, thread_main, t, 0, NULL);
    if (!t->handle) {
        free(t);
        return NULL;
    }
    return t;
}
void js_os_thread_join(JSOsThread *t) {
    WaitForSingleObject(t->handle, INFINITE);
    CloseHandle(t->handle);
    free(t);
}
unsigned js_os_cpu_count(void) {
    DWORD_PTR process, system;
    if (!GetProcessAffinityMask(GetCurrentProcess(), &process, &system)) return 1;
    unsigned n = 0;
    for (; process; process &= process - 1) n++;
    return n ? n : 1;
}


void js_os_stack_bounds(void **low, void **high) {
    ULONG_PTR lo, hi;
    GetCurrentThreadStackLimits(&lo, &hi);
    *low = (void *)lo;
    *high = (void *)hi;
}

uint64_t js_os_now_ms(void) {
    static LARGE_INTEGER freq;
    LARGE_INTEGER now;
    if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&now);
    return (uint64_t)(now.QuadPart / (freq.QuadPart / 1000));
}

double js_os_now_ms_precise(void) {
    static LARGE_INTEGER freq;
    LARGE_INTEGER now;
    if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&now);
    return (double)now.QuadPart * 1000.0 / (double)freq.QuadPart;
}

void js_os_sleep_ms(uint64_t ms) {
    Sleep((DWORD)ms);
}

double js_os_time_ms(void) {
    FILETIME ft;
    GetSystemTimePreciseAsFileTime(&ft);
    uint64_t t = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;  /* 100 ns since 1601 */
    return (double)(t / 10000) - 11644473600000.0;
}

int32_t js_os_local_offset(int64_t seconds, bool *dst) {
    __time64_t t = seconds;
    struct tm tm;
    if (_localtime64_s(&tm, &t) != 0) {
        *dst = false;
        return 0;
    }
    *dst = tm.tm_isdst > 0;
    return (int32_t)(_mkgmtime64(&tm) - t);
}

const char *js_os_timezone_id(void) {
    const char *tz = getenv("TZ");
    return tz && *tz ? tz : "";  /* Windows zone names aren't IANA ids: the offset fallback */
}

void js_os_timezone_changed(void) {
    _tzset();
}


double js_os_thread_cpu_ms(void) {
    FILETIME created, exited, kernel, user;
    if (!GetThreadTimes(GetCurrentThread(), &created, &exited, &kernel, &user)) return js_os_now_ms_precise();
    uint64_t k = ((uint64_t)kernel.dwHighDateTime << 32) | kernel.dwLowDateTime;
    uint64_t u = ((uint64_t)user.dwHighDateTime << 32) | user.dwLowDateTime;
    return (double)(k + u) / 1e4;  /* 100 ns units */
}

size_t js_os_peak_rss(void) {
    PROCESS_MEMORY_COUNTERS pmc;
    return K32GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof pmc) ? pmc.PeakWorkingSetSize : 0;
}
#else
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <time.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#if defined(__GLIBC__)
#include <malloc.h>
#elif defined(__APPLE__)
#include <malloc/malloc.h>
#endif

size_t js_os_page_size(void) {
    return (size_t)sysconf(_SC_PAGESIZE);
}

void *js_os_map(size_t size) {
    void *p = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    return p == MAP_FAILED ? NULL : p;
}

/* Map size + align, then trim the unaligned ends. */
void *js_os_map_aligned(size_t size, size_t align) {
    char *raw = js_os_map(size + align);
    if (!raw) return NULL;
    char *p = (char *)(((uintptr_t)raw + align - 1) & ~(uintptr_t)(align - 1));
    size_t head = (size_t)(p - raw), tail = align - head;
    if (head) munmap(raw, head);
    if (tail) munmap(p + size, tail);
    return p;
}

void js_os_unmap(void *p, size_t size) {
    munmap(p, size);
}

void js_os_decommit(void *p, size_t size) {
#ifdef __linux__
    madvise(p, size, MADV_DONTNEED);  /* private anonymous pages: zero-filled when touched again */
#else
    /* a fresh mapping in place: MADV_DONTNEED doesn't promise zeros everywhere */
    mmap(p, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
#endif
}

bool js_os_commit(void *p, size_t size) {
    (void)p, (void)size;  /* the pages come back when touched */
    return true;
}

void js_os_trim(void) {
#if defined(__GLIBC__)
    malloc_trim(0);
#elif defined(__APPLE__)
    malloc_zone_pressure_relief(NULL, 0);
#endif
}

struct JSOsLock { pthread_mutex_t mutex; };
struct JSOsCond { pthread_cond_t cond; };
struct JSOsThread { pthread_t thread; void (*fn)(void *); void *arg; };

JSOsLock *js_os_lock_new(void) {
    JSOsLock *l = calloc(1, sizeof *l);
    if (l && pthread_mutex_init(&l->mutex, NULL) != 0) {
        free(l);
        return NULL;
    }
    return l;
}
void js_os_lock_free(JSOsLock *l) {
    pthread_mutex_destroy(&l->mutex);
    free(l);
}
void js_os_lock(JSOsLock *l) { pthread_mutex_lock(&l->mutex); }
void js_os_unlock(JSOsLock *l) { pthread_mutex_unlock(&l->mutex); }
JSOsCond *js_os_cond_new(void) {
    JSOsCond *c = calloc(1, sizeof *c);
    if (c && pthread_cond_init(&c->cond, NULL) != 0) {
        free(c);
        return NULL;
    }
    return c;
}
void js_os_cond_free(JSOsCond *c) {
    pthread_cond_destroy(&c->cond);
    free(c);
}
void js_os_cond_wait(JSOsCond *c, JSOsLock *l) { pthread_cond_wait(&c->cond, &l->mutex); }
void js_os_cond_signal(JSOsCond *c) { pthread_cond_signal(&c->cond); }
void js_os_cond_broadcast(JSOsCond *c) { pthread_cond_broadcast(&c->cond); }

static void *thread_main(void *p) {
    JSOsThread *t = p;
    t->fn(t->arg);
    return NULL;
}
JSOsThread *js_os_thread_start(void (*fn)(void *), void *arg) {
    JSOsThread *t = calloc(1, sizeof *t);
    if (!t) return NULL;
    t->fn = fn;
    t->arg = arg;
    if (pthread_create(&t->thread, NULL, thread_main, t) != 0) {
        free(t);
        return NULL;
    }
    return t;
}
void js_os_thread_join(JSOsThread *t) {
    pthread_join(t->thread, NULL);
    free(t);
}
unsigned js_os_cpu_count(void) {
#if defined(__linux__)
    cpu_set_t set;
    if (sched_getaffinity(0, sizeof set, &set) == 0) {
        int n = CPU_COUNT(&set);
        if (n > 0) return (unsigned)n;
    }
#endif
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    return n > 0 ? (unsigned)n : 1;
}

void js_os_stack_bounds(void **low, void **high) {
#ifdef __APPLE__
    pthread_t self = pthread_self();
    *high = pthread_get_stackaddr_np(self);
    *low = (char *)*high - pthread_get_stacksize_np(self);
#else
    pthread_attr_t attr;
    size_t size;
    if (pthread_getattr_np(pthread_self(), &attr) != 0) abort();
    pthread_attr_getstack(&attr, low, &size);
    pthread_attr_destroy(&attr);
    *high = (char *)*low + size;
#endif
}

uint64_t js_os_now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}

double js_os_now_ms_precise(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}

void js_os_sleep_ms(uint64_t ms) {
    struct timespec ts = { (time_t)(ms / 1000), (long)(ms % 1000) * 1000000 };
    while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {}
}

double js_os_time_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)(ts.tv_nsec / 1000000);
}

static bool tz_initialized, tz_id_done;

void js_os_timezone_changed(void) {
    tzset();
    tz_initialized = true;
    tz_id_done = false;
}

int32_t js_os_local_offset(int64_t seconds, bool *dst) {
    if (!tz_initialized) {
        tzset();
        tz_initialized = true;
    }
    time_t t = (time_t)seconds;
    struct tm tm;
    if (!localtime_r(&t, &tm)) {
        *dst = false;
        return 0;
    }
    *dst = tm.tm_isdst > 0;
    return (int32_t)tm.tm_gmtoff;
}

/* TZ if set (":Europe/Lisbon", or a path into a zoneinfo directory), else where /etc/localtime
 * points. */
const char *js_os_timezone_id(void) {
    static char id[512];
    if (tz_id_done) return id;
    tz_id_done = true;
    const char *tz = getenv("TZ");
    char path[512] = "";
    if (tz && *tz) {
        if (*tz == ':') tz++;
        snprintf(path, sizeof path, "%s", tz);
    } else {
        ssize_t n = readlink("/etc/localtime", path, sizeof path - 1);
        path[n > 0 ? n : 0] = '\0';
        if (n <= 0) snprintf(path, sizeof path, "UTC");  /* no local zone configured: UTC */
    }
    const char *z = strstr(path, "zoneinfo/");
    snprintf(id, sizeof id, "%s", z ? z + 9 : path);
    return id;
}

double js_os_thread_cpu_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) != 0) return js_os_now_ms_precise();
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}

size_t js_os_peak_rss(void) {
    struct rusage ru;
    if (getrusage(RUSAGE_SELF, &ru) != 0) return 0;
#ifdef __APPLE__
    return (size_t)ru.ru_maxrss;           /* bytes */
#else
    return (size_t)ru.ru_maxrss * 1024;    /* KiB */
#endif
}
#endif
