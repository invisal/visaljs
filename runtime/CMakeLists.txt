# Runtime development build: unit tests, sanitizer and
# GC-stress builds. User programs build libjsrt through the visaljs driver.
cmake_minimum_required(VERSION 3.20)
project(jsrt C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

option(JSRT_SANITIZE "Build with AddressSanitizer + UndefinedBehaviorSanitizer" OFF)
option(JSRT_GC_STRESS "Collect at every allocation" OFF)
option(JSRT_WERROR "Treat warnings as errors" ON)

if(MSVC)
  add_compile_options(/W4)
  if(JSRT_WERROR)
    add_compile_options(/WX)
  endif()
else()
  add_compile_options(-Wall -Wextra -Wpedantic -fno-omit-frame-pointer)
  if(JSRT_WERROR)
    add_compile_options(-Werror)
  endif()
  if(JSRT_SANITIZE)
    add_compile_options(-fsanitize=address,undefined -fno-sanitize-recover=all)
    add_link_options(-fsanitize=address,undefined)
  endif()
endif()

add_library(jsrt STATIC
  src/arguments.c
  src/array.c
  src/async_iter.c
  src/atoms.c
  src/builtin_table.c
  src/core_all.c
  src/blob.c
  src/buffer.c
  src/crypto.c
  src/crypto_hash.c
  src/crypto_asym.c
  src/crypto_bn.c
  src/crypto_cipher.c
  src/crypto_host.c
  src/crypto_kdf.c
  src/crypto_key.c
  src/crypto_pkey.c
  src/crypto_subtle.c
  src/crypto_tls.c
  src/builtins.c
  src/components.c
  src/elements.c
  src/console.c
  src/convert.c
  src/error.c
  src/events.c
  src/fetch.c
  src/exception.c
  src/function.c
  src/gc.c
  src/generator.c
  src/headers.c
  src/global.c
  src/inspect.c
  src/iterate.c
  src/iterator.c
  src/jobs.c
  src/jsnum.c
  src/math.c
  src/module.c
  src/object.c
  src/ops.c
  src/process.c
  src/promise.c
  src/os.c
  src/shape.c
  src/streams.c
  src/string.c
  src/string_builtins.c
  src/number.c
  src/uri.c
  src/wrapper.c
  src/json.c
  src/collections.c
  src/reflect.c
  src/proxy.c
  src/arraybuffer.c
  src/typedarray.c
  src/date.c
  src/regexp.c
  src/bigint.c
  src/web.c
  src/domexception.c
  src/encoding.c
  src/base64.c
  src/url.c
  third_party/ada-idna/idna.c
  src/symbol.c
  src/util_types.c
  src/weak.c
  src/writable.c
  src/test_host.c
  third_party/quickjs-dtoa/dtoa.c
  third_party/v8-ieee754/ieee754.c
  third_party/quickjs-regexp/libunicode.c
  third_party/quickjs-regexp/libregexp.c
  third_party/quickjs-regexp/cutils.c
)
# BoringSSL: its own library, from its own source lists (sources.json), as the
# driver builds it: C++ without exceptions or RTTI, per-platform assembly, boringssl_support.cc
enable_language(CXX ASM)
file(READ third_party/boringssl/sources.json BORINGSSL_JSON)
set(BORINGSSL_SOURCES src/boringssl_support.cc)
foreach(part bcm crypto ssl)
  foreach(kind srcs asm)
    string(JSON n LENGTH "${BORINGSSL_JSON}" ${part} ${kind})
    if(n GREATER 0)
      math(EXPR last "${n} - 1")
      foreach(i RANGE ${last})
        string(JSON f GET "${BORINGSSL_JSON}" ${part} ${kind} ${i})
        list(APPEND BORINGSSL_SOURCES third_party/boringssl/${f})
      endforeach()
    endif()
  endforeach()
endforeach()
add_library(boringssl STATIC ${BORINGSSL_SOURCES})
target_include_directories(boringssl PUBLIC third_party/boringssl/include)
set_target_properties(boringssl PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
if(NOT MSVC)
  target_compile_options(boringssl PRIVATE -w $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions -fno-rtti>)
endif()
target_link_libraries(jsrt PRIVATE boringssl)

target_include_directories(jsrt PUBLIC include PRIVATE third_party/quickjs-dtoa third_party/v8-ieee754 third_party/quickjs-regexp third_party/ada-idna)
if(JSRT_GC_STRESS)
  target_compile_definitions(jsrt PUBLIC JS_GC_STRESS=1)
endif()
if(NOT MSVC)
  target_link_libraries(jsrt PUBLIC m)
  # Upstream style; kept unpatched.
  set_source_files_properties(third_party/quickjs-dtoa/dtoa.c third_party/quickjs-regexp/libunicode.c
    third_party/quickjs-regexp/libregexp.c third_party/quickjs-regexp/cutils.c PROPERTIES COMPILE_OPTIONS "-Wno-sign-compare;-Wno-unused-parameter")
  if(CMAKE_C_COMPILER_ID STREQUAL "GNU")
    # upstream fdlibm: GCC can't see that every path sets `fq` in __kernel_rem_pio2
    set_source_files_properties(third_party/v8-ieee754/ieee754.c PROPERTIES COMPILE_OPTIONS "-Wno-maybe-uninitialized")
  endif()
endif()

enable_testing()
add_executable(jsrt_tests
  tests/test_main.c
  tests/test_jsvalue.c
  tests/test_jsnum.c
  tests/test_gc.c
  tests/test_string.c
  tests/test_exception.c
  tests/test_atoms.c
  tests/test_console.c
  tests/test_ops.c
  tests/test_object.c
  tests/test_function.c
  tests/test_realm.c
  tests/test_ic.c
  tests/test_weak.c
)
target_link_libraries(jsrt_tests PRIVATE jsrt)
target_compile_definitions(jsrt_tests PRIVATE
  JSNUM_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/tests/jsnum_fixture.txt"
  CONSOLE_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/tests/console_fixture.txt"
  OPS_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/tests/ops_fixture.txt")
add_test(NAME jsrt_tests COMMAND jsrt_tests)

# An example: a hand-written program on the public API (js_runtime.h only).
add_executable(strings_loop examples/strings_loop.c)
target_link_libraries(strings_loop PRIVATE jsrt)
if(JSRT_GC_STRESS)
  add_test(NAME strings_loop COMMAND strings_loop 3000)
  set_tests_properties(strings_loop PROPERTIES PASS_REGULAR_EXPRESSION "item 2999 of 3000 17\n")
else()
  add_test(NAME strings_loop COMMAND strings_loop)
  set_tests_properties(strings_loop PROPERTIES PASS_REGULAR_EXPRESSION "item 2999999 of 3000000 23\n")
endif()
