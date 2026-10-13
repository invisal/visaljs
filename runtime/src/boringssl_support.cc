// What BoringSSL needs from a C++ library that programs don't link: BoringSSL is
// built without exceptions, RTTI or the C++ library, and allocates with OPENSSL_malloc, but its
// classes' virtual destructors name operator delete (never called), libstdc++'s headers name its
// throw helpers, and libc++ (Zig's) keeps a std::sort instantiation and its assertion handler in
// its own library. Part of libboringssl.
#include <cstddef>
#include <cstdlib>

void operator delete(void *) noexcept { abort(); }
void operator delete(void *, std::size_t) noexcept { abort(); }

#if defined(__GLIBCXX__)
/* libstdc++'s string_view checks, which throw (abort, without exceptions) */
namespace std {
[[noreturn]] void __throw_out_of_range_fmt(const char *, ...) { abort(); }
}  // namespace std
#endif

#if defined(_LIBCPP_VERSION)
#include <__verbose_abort>
#include <algorithm>

_LIBCPP_BEGIN_NAMESPACE_STD
/* the one instantiation BoringSSL uses (short lists of 16-bit ids): an insertion sort */
template <class Comp, class RandomAccessIterator>
void __sort(RandomAccessIterator first, RandomAccessIterator last, Comp) {
  for (RandomAccessIterator i = first; i != last; ++i)
    for (RandomAccessIterator j = i; j != first && *j < *(j - 1); --j) std::swap(*j, *(j - 1));
}
template void __sort<__less<unsigned short> &, unsigned short *>(unsigned short *, unsigned short *, __less<unsigned short> &);

/* noexcept since libc++ 20, but not in older ones (Xcode 16's): match whichever header this is */
void __libcpp_verbose_abort(const char *, ...) noexcept(noexcept(__libcpp_verbose_abort(""))) {
  abort();
}
_LIBCPP_END_NAMESPACE_STD
#endif
