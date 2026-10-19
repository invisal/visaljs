/* os.h — memory and time from the operating system. Runtime-internal. */
#ifndef JS_OS_H
#define JS_OS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Page-granular mapping, zero-filled. `size` must be a multiple of the page size. */
void *js_os_map(size_t size);
/* Mapping aligned to `align` (a power of two, a multiple of 64 KiB). */
void *js_os_map_aligned(size_t size, size_t align);
void js_os_unmap(void *p, size_t size);
/* Gives a mapping's pages back to the OS, keeping the addresses: they read as zeros after
 * js_os_commit, which they need before they're used again. */
void js_os_decommit(void *p, size_t size);
bool js_os_commit(void *p, size_t size);
/* Gives malloc's free memory back to the OS, where the C library can. */
void js_os_trim(void);

/* Threads, for the collector's helpers: a runtime has one mutator
 * thread; these mark alongside it in the pauses. A lock and a condition, allocated. */
typedef struct JSOsLock JSOsLock;
typedef struct JSOsCond JSOsCond;
typedef struct JSOsThread JSOsThread;
JSOsLock *js_os_lock_new(void);
void js_os_lock_free(JSOsLock *l);
void js_os_lock(JSOsLock *l);
void js_os_unlock(JSOsLock *l);
JSOsCond *js_os_cond_new(void);
void js_os_cond_free(JSOsCond *c);
void js_os_cond_wait(JSOsCond *c, JSOsLock *l);
void js_os_cond_signal(JSOsCond *c);
void js_os_cond_broadcast(JSOsCond *c);
/* NULL when it can't */
JSOsThread *js_os_thread_start(void (*fn)(void *), void *arg);
void js_os_thread_join(JSOsThread *t);
/* The processors this process may run on (at least 1). */
unsigned js_os_cpu_count(void);

size_t js_os_page_size(void);
/* The calling thread's stack: [*low, *high). Stacks grow down, so *high is the base. */
void js_os_stack_bounds(void **low, void **high);
/* The event loop's clock: monotonic milliseconds, and sleeping. */
uint64_t js_os_now_ms(void);
double js_os_now_ms_precise(void);  /* the same clock, with its sub-millisecond part */
void js_os_sleep_ms(uint64_t ms);
/* The calling thread's CPU time (user and system) in milliseconds, for the GC's policy. */
double js_os_thread_cpu_ms(void);
/* The process's peak resident memory in bytes (0 if unknown), for the GC's statistics. */
size_t js_os_peak_rss(void);

/* Date (the date component): wall-clock milliseconds since the epoch; the local time zone's
 * offset from UTC, in seconds, at an instant (and whether daylight saving applies then); the
 * local zone's IANA id ("Europe/Lisbon"), or an empty string when it can't be told. */
double js_os_time_ms(void);
int32_t js_os_local_offset(int64_t seconds, bool *dst);
const char *js_os_timezone_id(void);
/* TZ changed (process.env.TZ): local time and the zone's id are looked up again. */
void js_os_timezone_changed(void);

#endif /* JS_OS_H */
