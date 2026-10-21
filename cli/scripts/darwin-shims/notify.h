/* The two calls of Apple's <notify.h> c-ares's DNS configuration watcher makes (libSystem has them),
 * for prebuilt.ts: Zig's macOS headers don't include it. */
#ifndef VISALJS_DARWIN_NOTIFY_H
#define VISALJS_DARWIN_NOTIFY_H
#include <stdint.h>
#define NOTIFY_STATUS_OK 0
uint32_t notify_register_file_descriptor(const char *name, int *notify_fd, int flags, int *out_token);
uint32_t notify_cancel(int token);
#endif
