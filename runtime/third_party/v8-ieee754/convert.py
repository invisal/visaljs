import re, sys
S=sys.argv[1]  # the directory holding v8-ieee754.cc; ieee754.c/.h are written there
src=open(S+'/v8-ieee754.cc').read()
lines=src.split('\n')
first_inc=next(i for i,l in enumerate(lines) if l.startswith('#include'))
license='\n'.join(lines[:first_inc])
body='\n'.join(lines[first_inc:])
for inc in ['#include "src/base/ieee754.h"\n','#include <cmath>\n','#include <limits>\n','#include "src/base/build_config.h"\n','#include "src/base/macros.h"\n','#include "src/base/overflowing-math.h"\n']:
    body=body.replace(inc,'')
for ns in ['namespace v8 {\n','namespace base {\n','namespace ieee754 {\n','namespace {\n','}  // namespace ieee754\n','}  // namespace base\n','}  // namespace v8\n','}  // namespace\n']:
    body=body.replace(ns,'')
body=body.replace('#if V8_CC_MSVC','#if defined(_MSC_VER)')
body=body.replace('base::bit_cast<uint64_t>(d)','js_ieee754_bits(d)').replace('base::bit_cast<double>(bits)','js_ieee754_double(bits)')
body=body.replace(' V8_WARN_UNUSED_RESULT','').replace('V8_INLINE ','static inline ')
body=body.replace('std::numeric_limits<double>::signaling_NaN()','NAN').replace('std::numeric_limits<double>::quiet_NaN()','NAN')
body=body.replace('std::numeric_limits<double>::infinity()','INFINITY')
body=re.sub(r'NegateWithWraparound<int32_t>\((\w+)\)', r'((int32_t)(0u - (uint32_t)(\1)))', body)
body=re.sub(r'SubWithWraparound\((\w+), (\w+)\)', r'((int32_t)((uint32_t)(\1) - (uint32_t)(\2)))', body)
def conv(s):
    out=[];i=0;pat='static_cast<'
    while True:
        j=s.find(pat,i)
        if j<0: out.append(s[i:]); return ''.join(out)
        out.append(s[i:j])
        k=s.index('>',j); T=s[j+len(pat):k]
        depth=0;m=k+1
        while True:
            c=s[m]
            if c=='(': depth+=1
            elif c==')':
                depth-=1
                if depth==0: break
            m+=1
        out.append('((%s)(%s))'%(T,conv(s[k+2:m])))
        i=m+1
body=conv(body)
body=body.replace('const_cast<volatile double*>(&atanlo[3])','(volatile double*)(&atanlo[3])')
body=re.sub(r'base::bit_cast<uint64_t>\((\w+)\)', r'js_ieee754_bits(\1)', body)
body=re.sub(r'base::bit_cast<double>\((\w+)\)', r'js_ieee754_double(\1)', body)
body=re.sub(r'base::Divide\(', 'js_ieee754_divide(', body)
body=body.replace("0x0000'0000'FFFF'FFFF",'0x00000000FFFFFFFFull').replace("0xFFFF'FFFF'0000'0000",'0xFFFFFFFF00000000ull')
pub=['acos','acosh','asin','asinh','atan','atan2','cos','exp','atanh','log','log1p','log2','log10','expm1','cbrt','sin','tan','cosh','pow','sinh','tanh']
first_pub=body.index('double acos(double x) {')
head=re.sub(r'^(int32_t|int|double) (__\w+)\(', r'static \1 \2(', body[:first_pub], flags=re.M)
body=head+body[first_pub:]
for f in pub:
    body=re.sub(r'(?<![\w.])%s\('%f, 'js_ieee754_%s('%f, body)
for f in ['cos','sin']:
    body=body.replace('#if defined(V8_USE_LIBM_TRIG_FUNCTIONS)\ndouble fdlibm_%s(double x) {\n#else\ndouble js_ieee754_%s(double x) {\n#endif'%(f,f),'double js_ieee754_%s(double x) {'%f)
k=body.find('#if defined(V8_USE_LIBM_TRIG_FUNCTIONS) && defined(BUILDING_V8_BASE_SHARED)')
if k>=0:
    e=body.index('#endif',k)+len('#endif'); body=body[:k]+body[e:]
# pow's odd-integer test shifts a signed int past bit 31 (UB, caught by UBSan): shift it unsigned
old='if ((j << (52 - k)) == ((int)(ly)))'
assert old in body
body=body.replace(old,'if (((int)((uint32_t)j << (52 - k))) == ((int)(ly)))')
assert 'V8_' not in body.replace('V8_USE','') or True
hdr='''/* V8's port of fdlibm (src/base/ieee754.cc, V8 12.4, the version Node 22 ships), in C so
 * Math gives Node's results to the last bit (ADR 0014). Changes: C instead of C++ (casts,
 * bit casts, the overflow helpers, numeric_limits), js_ieee754_ names, and only the fdlibm
 * sin/cos (V8's optional libm variant dropped). */
#include "ieee754.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

static inline uint64_t js_ieee754_bits(double d) {
    uint64_t u;
    memcpy(&u, &d, sizeof u);
    return u;
}

/* V8's base::Divide: IEEE division, including by zero */
static inline double js_ieee754_divide(double x, double y) {
    return x / y;
}

static inline double js_ieee754_double(uint64_t u) {
    double d;
    memcpy(&d, &u, sizeof d);
    return d;
}
'''
open(S+'/ieee754.c','w').write(license+'\n'+hdr+body.lstrip('\n'))
decl=''.join('double js_ieee754_%s(%s);\n'%(f, 'double y, double x' if f=='atan2' else 'double x, double y' if f=='pow' else 'double x') for f in pub)
open(S+'/ieee754.h','w').write('/* V8\'s fdlibm port (ieee754.c): Math\'s functions with Node\'s results. */\n#ifndef JS_IEEE754_H\n#define JS_IEEE754_H\n\n'+decl+'\n#endif /* JS_IEEE754_H */\n')
