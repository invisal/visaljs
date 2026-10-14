/* Host primitives for node:fs: synchronous file access through stdio and POSIX, and
 * libuv's synchronous calls for stat, readdir and reads by position.
 * The prelude (node/prelude/fs.js) validates arguments and builds Node's errors from the
 * -errno these return. Linked only into programs whose prelude imports them. */
#define _GNU_SOURCE  /* access, unlink under -std=c11; every open flag the platform has (O_NOATIME, O_DIRECT) */
#include "js_node.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <fcntl.h>
#include <sys/stat.h>
#include <uv.h>

#include "js_buffer.h"
#include "js_exception.h"
#include "js_ops.h"
#include "js_web.h"
#include "jsstring.h"

#ifdef _WIN32
#include <io.h>
#include <sys/stat.h>
#define access _access
#define unlink _unlink
#define F_OK 0
#else
#include <sys/statvfs.h>
#include <unistd.h>
#endif

char *js_host_path_arg(JSContext *ctx, uint32_t argc, const JSValue *argv, uint32_t i) {
    JSValue v = i < argc ? argv[i] : JS_UNDEFINED;
    if (!js_is_string(v)) {
        JSValue e = js_throw_type_error(ctx, "path must be a string");
        (void)e;
        return NULL;
    }
    JSStrView view = js_string_view(ctx, v);
    size_t n = js_view_to_utf8(view, NULL, 0);
    char *s = malloc(n + 1);
    if (!s) js_fatal("out of memory");
    js_view_to_utf8(view, s, n);
    s[n] = '\0';
    return s;
}

static JSValue errno_result(int e) {
    return js_int32(js_node_uv_error(e ? e : EIO));
}

/* fsReadFile(path, bytes): the file's contents as a Buffer when `bytes`, else decoded as UTF-8
 * (invalid sequences → U+FFFD). */
JSValue js_host_fs_read_file(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                             const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    char *path = js_host_path_arg(ctx, argc, argv, 0);
    if (!path) return JS_EXCEPTION;
    FILE *f = fopen(path, "rb");
    int e = errno;
#ifdef _WIN32
    /* Windows won't open a directory as a file (EACCES); elsewhere the open succeeds and the read
     * fails with EISDIR, which Node reports on Windows too */
    struct _stat st;
    if (!f && e == EACCES && _stat(path, &st) == 0 && (st.st_mode & _S_IFDIR)) e = EISDIR;
#endif
    free(path);
    if (!f) return errno_result(e);
    size_t length = 0, cap = 4096;
    char *buf = malloc(cap);
    if (!buf) js_fatal("out of memory");
    for (;;) {
        length += fread(buf + length, 1, cap - length, f);
        if (length < cap) break;
        cap *= 2;
        char *grown = realloc(buf, cap);
        if (!grown) js_fatal("out of memory");
        buf = grown;
    }
    int failed = ferror(f) ? errno : 0;
    fclose(f);
    bool bytes = argc > 1 && js_truthy(argv[1]);
    JSValue r = failed ? errno_result(failed)
                : bytes ? js_new_buffer_from_bytes(ctx, (const uint8_t *)buf, length)
                        : js_new_string_utf8(ctx, buf, length);
    free(buf);
    return r;
}

/* fsWriteFile(path, data, append): writes the bytes, or the string as UTF-8, replacing or appending. */
JSValue js_host_fs_write_file(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                              const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    uint8_t *bytes;
    size_t n;
    bool is_bytes = argc >= 2 && js_buffer_source_bytes(argv[1], &bytes, &n);
    if (argc < 2 || (!is_bytes && !js_is_string(argv[1]))) return js_throw_type_error(ctx, "data must be a string or bytes");
    char *path = js_host_path_arg(ctx, argc, argv, 0);
    if (!path) return JS_EXCEPTION;
    bool append = argc > 2 && js_truthy(argv[2]);
    FILE *f = fopen(path, append ? "ab" : "wb");
    free(path);
    if (!f) return errno_result(errno);
    char *buf = NULL;
    if (!is_bytes) {
        JSStrView view = js_string_view(ctx, argv[1]);
        n = js_view_to_utf8(view, NULL, 0);
        buf = malloc(n ? n : 1);
        if (!buf) js_fatal("out of memory");
        js_view_to_utf8(view, buf, n);
    }
    int failed = fwrite(is_bytes ? (const void *)bytes : buf, 1, n, f) < n ? errno : 0;
    free(buf);
    if (fclose(f) != 0 && !failed) failed = errno;
    return failed ? errno_result(failed) : JS_UNDEFINED;
}

/* fsExists(path): whether the path names something (access F_OK). */
JSValue js_host_fs_exists(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                          const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    char *path = js_host_path_arg(ctx, argc, argv, 0);
    if (!path) return JS_EXCEPTION;
    bool exists = access(path, F_OK) == 0;
    free(path);
    return js_bool(exists);
}

/* fsUnlink(path): removes a file (not a directory). */
JSValue js_host_fs_unlink(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                          const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    char *path = js_host_path_arg(ctx, argc, argv, 0);
    if (!path) return JS_EXCEPTION;
    int r = unlink(path);
    int e = errno;
    free(path);
    return r == 0 ? JS_UNDEFINED : errno_result(e);
}

/* ---- stat, readdir and reads by position, through libuv's synchronous calls (every platform) */

static double ms_of(uv_timespec_t t) { return (double)t.tv_sec * 1000.0 + (double)t.tv_nsec / 1e6; }

/* a stat as fsStat gives it (host_fswatch.c's watchFile too) */
JSValue js_host_stat_array(JSContext *ctx, const uv_stat_t *s) {
    JSValue items[14] = {
        js_number((double)s->st_mode), js_number((double)s->st_size), js_number(ms_of(s->st_mtim)),
        js_number(ms_of(s->st_atim)), js_number(ms_of(s->st_ctim)), js_number(ms_of(s->st_birthtim)),
        js_number((double)s->st_ino), js_number((double)s->st_dev), js_number((double)s->st_nlink),
        js_number((double)s->st_uid), js_number((double)s->st_gid), js_number((double)s->st_rdev),
        js_number((double)s->st_blksize), js_number((double)s->st_blocks),
    };
    return js_new_array_from(ctx, items, 14);
}

/* fsStat(path, follow): [mode, size, mtimeMs, atimeMs, ctimeMs, birthtimeMs, ino, dev, nlink,
 * uid, gid, rdev, blksize, blocks], or -errno: stat(2), lstat(2) when !follow. */
JSValue js_host_fs_stat(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                        const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    char *path = js_host_path_arg(ctx, argc, argv, 0);
    if (!path) return JS_EXCEPTION;
    bool follow = argc < 2 || js_truthy(argv[1]);
    uv_fs_t req;
    int r = follow ? uv_fs_stat(uv_default_loop(), &req, path, NULL) : uv_fs_lstat(uv_default_loop(), &req, path, NULL);
    free(path);
    if (r < 0) {
        uv_fs_req_cleanup(&req);
        return js_int32(r);
    }
    JSValue a = js_host_stat_array(ctx, &req.statbuf);
    uv_fs_req_cleanup(&req);
    return a;
}

/* fsReaddir(path): [name, type, …], or -errno; type is libuv's uv_dirent_type_t (0 unknown,
 * 1 file, 2 directory, 3 symlink, 4 FIFO, 5 socket, 6 character device, 7 block device). */
JSValue js_host_fs_readdir(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                           const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    char *path = js_host_path_arg(ctx, argc, argv, 0);
    if (!path) return JS_EXCEPTION;
    uv_fs_t req;
    int r = uv_fs_scandir(uv_default_loop(), &req, path, 0, NULL);
    free(path);
    if (r < 0) {
        uv_fs_req_cleanup(&req);
        return js_int32(r);
    }
    JSValue out = js_new_array(ctx, (uint32_t)(2 * r));
    uv_dirent_t ent;
    while (uv_fs_scandir_next(&req, &ent) != UV_EOF) {
        JSValue name = js_new_string_cstr(ctx, ent.name);
        if (js_array_push(ctx, js_as_object(out), name) < 0 || js_array_push(ctx, js_as_object(out), js_int32((int32_t)ent.type)) < 0) {
            uv_fs_req_cleanup(&req);
            return JS_EXCEPTION;
        }
    }
    uv_fs_req_cleanup(&req);
    return out;
}

/* fsReadAt(path, position, length): up to `length` bytes from `position`, as a Buffer (shorter
 * at the end of the file; empty past it), or -errno: what a read stream reads, a chunk at a time. */
JSValue js_host_fs_read_at(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                           const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    char *path = js_host_path_arg(ctx, argc, argv, 0);
    if (!path) return JS_EXCEPTION;
    double position = argc > 1 && js_is_number(argv[1]) ? js_as_number(argv[1]) : 0;
    double length = argc > 2 && js_is_number(argv[2]) ? js_as_number(argv[2]) : 65536;
    if (!(length >= 0 && length <= 1 << 30)) length = 65536;
    uv_fs_t req;
    int fd = uv_fs_open(uv_default_loop(), &req, path, UV_FS_O_RDONLY, 0, NULL);
    uv_fs_req_cleanup(&req);
    free(path);
    if (fd < 0) return js_int32(fd);
    char *buf = malloc((size_t)length + 1);
    if (!buf) js_fatal("out of memory");
    size_t got = 0;
    int r = 0;
    while (got < (size_t)length) {  /* a read may return less than asked before the end */
        uv_buf_t b = uv_buf_init(buf + got, (unsigned)((size_t)length - got));
        r = uv_fs_read(uv_default_loop(), &req, fd, &b, 1, (int64_t)position + (int64_t)got, NULL);
        uv_fs_req_cleanup(&req);
        if (r <= 0) break;
        got += (size_t)r;
    }
    uv_fs_close(uv_default_loop(), &req, fd, NULL);
    uv_fs_req_cleanup(&req);
    JSValue out = r < 0 ? js_int32(r) : js_new_buffer_from_bytes(ctx, (const uint8_t *)buf, got);
    free(buf);
    return out;
}

/* fsRealpath(path): the canonical absolute path (symlinks resolved), or -errno: realpath(3). */
JSValue js_host_fs_realpath(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                            const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    char *path = js_host_path_arg(ctx, argc, argv, 0);
    if (!path) return JS_EXCEPTION;
    uv_fs_t req;
    int r = uv_fs_realpath(uv_default_loop(), &req, path, NULL);
    free(path);
    JSValue out = r < 0 ? js_int32(r) : js_new_string_cstr(ctx, (const char *)req.ptr);
    uv_fs_req_cleanup(&req);
    return out;
}

/* fsMkdir(path, mode): creates one directory, or -errno. */
JSValue js_host_fs_mkdir(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                         const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    char *path = js_host_path_arg(ctx, argc, argv, 0);
    if (!path) return JS_EXCEPTION;
    int mode = argc > 1 && js_is_number(argv[1]) ? (int)js_as_number(argv[1]) : 0777;
    uv_fs_t req;
    int r = uv_fs_mkdir(uv_default_loop(), &req, path, mode, NULL);
    uv_fs_req_cleanup(&req);
    free(path);
    return r < 0 ? js_int32(r) : JS_UNDEFINED;
}

/* fsUtimes(path, atime, mtime): sets the times, in seconds since the epoch, or -errno. */
JSValue js_host_fs_utimes(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                          const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    char *path = js_host_path_arg(ctx, argc, argv, 0);
    if (!path) return JS_EXCEPTION;
    double atime = argc > 1 && js_is_number(argv[1]) ? js_as_number(argv[1]) : 0;
    double mtime = argc > 2 && js_is_number(argv[2]) ? js_as_number(argv[2]) : 0;
    uv_fs_t req;
    int r = uv_fs_utime(uv_default_loop(), &req, path, atime, mtime, NULL);
    uv_fs_req_cleanup(&req);
    free(path);
    return r < 0 ? js_int32(r) : JS_UNDEFINED;
}

/* ---- file descriptors ---------------------------------------------------------------------- */

/* fsOpen(path, flags, mode): a file descriptor, or -errno. `flags` is Node's string ("r", "w+",
 * "ax", …; the prelude has checked it) or a number of the platform's O_* flags. */
JSValue js_host_fs_open(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                        const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    int flags = UV_FS_O_RDONLY;
    if (argc > 1 && js_is_number(argv[1])) {
        flags = (int)js_as_number(argv[1]);
    } else if (argc > 1 && js_is_string(argv[1])) {
        char f[8] = { 0 };
        JSStrView view = js_string_view(ctx, argv[1]);
        js_view_to_utf8(view, f, sizeof f - 1);
        bool plus = strchr(f, '+') != NULL, excl = strchr(f, 'x') != NULL, sync = strchr(f, 's') != NULL;
        int access_mode = plus ? UV_FS_O_RDWR : f[0] == 'r' ? UV_FS_O_RDONLY : UV_FS_O_WRONLY;
        flags = access_mode | (excl ? UV_FS_O_EXCL : 0) | (sync ? UV_FS_O_SYNC : 0);
        if (strchr(f, 'w')) flags |= UV_FS_O_CREAT | UV_FS_O_TRUNC;
        else if (strchr(f, 'a')) flags |= UV_FS_O_CREAT | UV_FS_O_APPEND;
    }
    int mode = argc > 2 && js_is_number(argv[2]) ? (int)js_as_number(argv[2]) : 0666;
    char *path = js_host_path_arg(ctx, argc, argv, 0);
    if (!path) return JS_EXCEPTION;
    uv_fs_t req;
    int fd = uv_fs_open(uv_default_loop(), &req, path, flags, mode, NULL);
    uv_fs_req_cleanup(&req);
    free(path);
    return js_int32(fd);
}

/* fsClose(fd): undefined, or -errno. */
JSValue js_host_fs_close(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                         const JSValue *argv, JSValue new_target) {
    (void)ctx, (void)callee, (void)this_val, (void)new_target;
    int fd = argc > 0 && js_is_number(argv[0]) ? (int)js_as_number(argv[0]) : -1;
    uv_fs_t req;
    int r = uv_fs_close(uv_default_loop(), &req, fd, NULL);
    uv_fs_req_cleanup(&req);
    return r < 0 ? js_int32(r) : JS_UNDEFINED;
}

/* fsWrite(fd, bytes, offset, length, position): the bytes written (all of them, unless an error
 * cuts it short), or -errno. A position of -1 writes at the file's current offset. */
JSValue js_host_fs_write(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                         const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    uint8_t *bytes;
    size_t n;
    if (argc < 5 || !js_buffer_source_bytes(argv[1], &bytes, &n)) return js_throw_type_error(ctx, "fsWrite: bytes expected");
    int fd = (int)js_as_number(argv[0]);
    size_t offset = (size_t)js_as_number(argv[2]), length = (size_t)js_as_number(argv[3]);
    int64_t position = (int64_t)js_as_number(argv[4]);
    if (offset > n || length > n - offset) return js_throw_type_error(ctx, "fsWrite: out of range");
    size_t done = 0;
    while (done < length) {  /* a write may take fewer bytes than given */
        uv_buf_t b = uv_buf_init((char *)bytes + offset + done, (unsigned)(length - done));
        uv_fs_t req;
        int r = uv_fs_write(uv_default_loop(), &req, fd, &b, 1, position < 0 ? -1 : position + (int64_t)done, NULL);
        uv_fs_req_cleanup(&req);
        if (r < 0) return done ? js_number((double)done) : js_int32(r);
        done += (size_t)r;
    }
    return js_number((double)done);
}

/* fsRead(fd, bytes, offset, length, position): the bytes read into `bytes` (0 at the end of the
 * file), or -errno. A position of -1 reads from the file's current offset. */
JSValue js_host_fs_read(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                        const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    uint8_t *bytes;
    size_t n;
    if (argc < 5 || !js_buffer_source_bytes(argv[1], &bytes, &n)) return js_throw_type_error(ctx, "fsRead: bytes expected");
    int fd = (int)js_as_number(argv[0]);
    size_t offset = (size_t)js_as_number(argv[2]), length = (size_t)js_as_number(argv[3]);
    int64_t position = (int64_t)js_as_number(argv[4]);
    if (offset > n || length > n - offset) return js_throw_type_error(ctx, "fsRead: out of range");
    uv_buf_t b = uv_buf_init((char *)bytes + offset, (unsigned)length);
    uv_fs_t req;
    int r = uv_fs_read(uv_default_loop(), &req, fd, &b, 1, position < 0 ? -1 : position, NULL);
    uv_fs_req_cleanup(&req);
    return js_int32(r);
}

/* fsConstants(): fs.constants as a flat [name, number, …], in Node's order (node_constants.cc):
 * libuv's, then the platform's open flags, file types and modes, those it defines. */
JSValue js_host_fs_constants(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                             const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
#define C(name) { #name, name }
#define UV(name, value) { #name, value }
    static const struct { const char *name; int value; } CONSTANTS[] = {
        UV(UV_FS_SYMLINK_DIR, UV_FS_SYMLINK_DIR), UV(UV_FS_SYMLINK_JUNCTION, UV_FS_SYMLINK_JUNCTION),
        UV(O_RDONLY, UV_FS_O_RDONLY), UV(O_WRONLY, UV_FS_O_WRONLY), UV(O_RDWR, UV_FS_O_RDWR),
        C(UV_DIRENT_UNKNOWN), C(UV_DIRENT_FILE), C(UV_DIRENT_DIR), C(UV_DIRENT_LINK), C(UV_DIRENT_FIFO),
        C(UV_DIRENT_SOCKET), C(UV_DIRENT_CHAR), C(UV_DIRENT_BLOCK),
#ifdef _WIN32
        { "EXTENSIONLESS_FORMAT_JAVASCRIPT", 0 }, { "EXTENSIONLESS_FORMAT_WASM", 1 },
#endif
        C(S_IFMT), C(S_IFREG), C(S_IFDIR), C(S_IFCHR),
#ifdef S_IFBLK
        C(S_IFBLK),
#endif
#ifdef S_IFIFO
        C(S_IFIFO),
#endif
#ifdef S_IFLNK
        C(S_IFLNK),
#endif
#ifdef S_IFSOCK
        C(S_IFSOCK),
#endif
        UV(O_CREAT, UV_FS_O_CREAT), UV(O_EXCL, UV_FS_O_EXCL), C(UV_FS_O_FILEMAP),
#ifndef _WIN32
#ifdef O_NOCTTY
        C(O_NOCTTY),
#endif
#endif
        UV(O_TRUNC, UV_FS_O_TRUNC), UV(O_APPEND, UV_FS_O_APPEND),
#ifndef _WIN32
#ifdef O_DIRECTORY
        C(O_DIRECTORY),
#endif
#ifdef O_NOATIME
        C(O_NOATIME),
#endif
#ifdef O_NOFOLLOW
        C(O_NOFOLLOW),
#endif
#ifdef O_SYNC
        C(O_SYNC),
#endif
#ifdef O_DSYNC
        C(O_DSYNC),
#endif
#ifdef O_SYMLINK
        C(O_SYMLINK),
#endif
#ifdef O_DIRECT
        C(O_DIRECT),
#endif
#ifdef O_NONBLOCK
        C(O_NONBLOCK),
#endif
#endif
#ifdef _WIN32
        { "UV_FS_O_SEQUENTIAL", UV_FS_O_SEQUENTIAL }, { "UV_FS_O_RANDOM", UV_FS_O_RANDOM },
        { "UV_FS_O_SHORT_LIVED", UV_FS_O_SHORT_LIVED }, { "UV_FS_O_TEMPORARY", UV_FS_O_TEMPORARY },
#endif
#ifdef S_IRWXU
        C(S_IRWXU),
#endif
#ifdef S_IRUSR
        C(S_IRUSR),
#endif
#ifdef S_IWUSR
        C(S_IWUSR),
#endif
#ifdef S_IXUSR
        C(S_IXUSR),
#endif
#ifdef S_IRWXG
        C(S_IRWXG), C(S_IRGRP), C(S_IWGRP), C(S_IXGRP), C(S_IRWXO), C(S_IROTH), C(S_IWOTH), C(S_IXOTH),
#endif
        { "F_OK", 0 }, { "R_OK", 4 }, { "W_OK", 2 }, { "X_OK", 1 },
        C(UV_FS_COPYFILE_EXCL), UV(COPYFILE_EXCL, UV_FS_COPYFILE_EXCL),
        C(UV_FS_COPYFILE_FICLONE), UV(COPYFILE_FICLONE, UV_FS_COPYFILE_FICLONE),
        C(UV_FS_COPYFILE_FICLONE_FORCE), UV(COPYFILE_FICLONE_FORCE, UV_FS_COPYFILE_FICLONE_FORCE),
    };
#undef C
#undef UV
    const uint32_t n = sizeof CONSTANTS / sizeof CONSTANTS[0];
    JSValue a = js_new_array(ctx, 2 * n);
    if (js_is_exception(a)) return a;
    for (uint32_t i = 0; i < n; i++)
        if (js_array_append(ctx, a, js_new_string_cstr(ctx, CONSTANTS[i].name)) < 0 || js_array_append(ctx, a, js_int32(CONSTANTS[i].value)) < 0)
            return JS_EXCEPTION;
    return a;
}

/* fsCall(op, …): the rest of node:fs's system calls, through libuv's synchronous forms, by number
 * (FS_OPS in node/prelude/fs.js). Each gives -errno on failure, else undefined, or its result:
 * readlink and mkdtemp a path, fstat fsStat's array, statfs [type, bsize, blocks, bfree, bavail,
 * files, ffree]. */
enum {
    FS_RENAME, FS_LINK, FS_SYMLINK, FS_READLINK, FS_RMDIR, FS_CHMOD, FS_FCHMOD, FS_CHOWN, FS_FCHOWN, FS_LCHOWN,
    FS_FSYNC, FS_FDATASYNC, FS_FTRUNCATE, FS_FUTIME, FS_LUTIME, FS_COPYFILE, FS_MKDTEMP, FS_ACCESS, FS_FSTAT, FS_STATFS,
};

JSValue js_host_fs_call(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                        const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    if (argc < 2 || !js_is_number(argv[0])) return js_throw_type_error(ctx, "fsCall: an operation expected");
    int op = (int)js_as_number(argv[0]);
    const JSValue *args = argv + 1;
    uint32_t n = argc - 1;
#define NUM(i) (n > (i) && js_is_number(args[i]) ? js_as_number(args[i]) : 0)
    /* the operations on a file descriptor take no path */
    bool by_fd = op == FS_FCHMOD || op == FS_FCHOWN || op == FS_FSYNC || op == FS_FDATASYNC || op == FS_FTRUNCATE ||
                 op == FS_FUTIME || op == FS_FSTAT;
    char *path = by_fd ? NULL : js_host_path_arg(ctx, n, args, 0);
    if (!by_fd && !path) return JS_EXCEPTION;
    bool two = op == FS_RENAME || op == FS_LINK || op == FS_SYMLINK || op == FS_COPYFILE;
    char *dest = two ? js_host_path_arg(ctx, n, args, 1) : NULL;
    if (two && !dest) {
        free(path);
        return JS_EXCEPTION;
    }
    uv_loop_t *loop = uv_default_loop();
    uv_file fd = by_fd ? (uv_file)NUM(0) : -1;
    uv_fs_t req;
    int r;
    double frsize = -1;  /* statfs's */
#ifndef _WIN32
    struct statvfs vfs;
#endif
    switch (op) {
    case FS_RENAME: r = uv_fs_rename(loop, &req, path, dest, NULL); break;
    case FS_LINK: r = uv_fs_link(loop, &req, path, dest, NULL); break;
    case FS_SYMLINK: r = uv_fs_symlink(loop, &req, path, dest, (int)NUM(2), NULL); break;
    case FS_READLINK: r = uv_fs_readlink(loop, &req, path, NULL); break;
    case FS_RMDIR: r = uv_fs_rmdir(loop, &req, path, NULL); break;
    case FS_CHMOD: r = uv_fs_chmod(loop, &req, path, (int)NUM(1), NULL); break;
    case FS_FCHMOD: r = uv_fs_fchmod(loop, &req, fd, (int)NUM(1), NULL); break;
    case FS_CHOWN: r = uv_fs_chown(loop, &req, path, (uv_uid_t)NUM(1), (uv_gid_t)NUM(2), NULL); break;
    case FS_FCHOWN: r = uv_fs_fchown(loop, &req, fd, (uv_uid_t)NUM(1), (uv_gid_t)NUM(2), NULL); break;
    case FS_LCHOWN: r = uv_fs_lchown(loop, &req, path, (uv_uid_t)NUM(1), (uv_gid_t)NUM(2), NULL); break;
    case FS_FSYNC: r = uv_fs_fsync(loop, &req, fd, NULL); break;
    case FS_FDATASYNC: r = uv_fs_fdatasync(loop, &req, fd, NULL); break;
    case FS_FTRUNCATE: r = uv_fs_ftruncate(loop, &req, fd, (int64_t)NUM(1), NULL); break;
    case FS_FUTIME: r = uv_fs_futime(loop, &req, fd, NUM(1), NUM(2), NULL); break;
    case FS_LUTIME: r = uv_fs_lutime(loop, &req, path, NUM(1), NUM(2), NULL); break;
    case FS_COPYFILE: r = uv_fs_copyfile(loop, &req, path, dest, (int)NUM(2), NULL); break;
    case FS_MKDTEMP: r = uv_fs_mkdtemp(loop, &req, path, NULL); break;
    case FS_ACCESS: r = uv_fs_access(loop, &req, path, (int)NUM(1), NULL); break;
    case FS_FSTAT: r = uv_fs_fstat(loop, &req, fd, NULL); break;
    case FS_STATFS:
        r = uv_fs_statfs(loop, &req, path, NULL);
#ifndef _WIN32
        /* frsize (Node 24, libuv 1.52's f_frsize): statvfs's fragment size, as libuv reads it */
        if (r >= 0 && statvfs(path, &vfs) == 0) frsize = (double)vfs.f_frsize;
#endif
        break;
    default:
        free(path), free(dest);
        return js_throw_type_error(ctx, "fsCall: unknown operation");
    }
#undef NUM
    free(path), free(dest);
    JSValue result = JS_UNDEFINED;
    if (r < 0) result = js_int32(r);
    else if (op == FS_READLINK) result = js_new_string_cstr(ctx, (const char *)req.ptr);
    else if (op == FS_MKDTEMP) result = js_new_string_cstr(ctx, req.path);
    else if (op == FS_FSTAT) result = js_host_stat_array(ctx, &req.statbuf);
    else if (op == FS_STATFS) {
        const uv_statfs_t *f = req.ptr;
        if (frsize < 0) frsize = (double)f->f_bsize;  /* no statvfs: the block size */
        JSValue v[8] = { js_number((double)f->f_type), js_number((double)f->f_bsize), js_number(frsize), js_number((double)f->f_blocks),
                         js_number((double)f->f_bfree), js_number((double)f->f_bavail), js_number((double)f->f_files),
                         js_number((double)f->f_ffree) };
        result = js_new_array_from(ctx, v, 8);
    }
    uv_fs_req_cleanup(&req);
    return result;
}
