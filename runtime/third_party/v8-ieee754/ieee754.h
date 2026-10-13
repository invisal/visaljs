/* V8's fdlibm port (ieee754.c): Math's functions with Node's results. */
#ifndef JS_IEEE754_H
#define JS_IEEE754_H

double js_ieee754_acos(double x);
double js_ieee754_acosh(double x);
double js_ieee754_asin(double x);
double js_ieee754_asinh(double x);
double js_ieee754_atan(double x);
double js_ieee754_atan2(double y, double x);
double js_ieee754_cos(double x);
double js_ieee754_exp(double x);
double js_ieee754_atanh(double x);
double js_ieee754_log(double x);
double js_ieee754_log1p(double x);
double js_ieee754_log2(double x);
double js_ieee754_log10(double x);
double js_ieee754_expm1(double x);
double js_ieee754_cbrt(double x);
double js_ieee754_sin(double x);
double js_ieee754_tan(double x);
double js_ieee754_cosh(double x);
double js_ieee754_pow(double x, double y);
double js_ieee754_sinh(double x);
double js_ieee754_tanh(double x);

#endif /* JS_IEEE754_H */
