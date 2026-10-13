// BigInt (§6.1.6.2, §21.2): literals, every operator, mixing rules, comparisons with Numbers and
// strings, conversions, BigInt() and its statics, BigInt.prototype, keys in Maps and Sets, and
// how console.log prints them.
const t = (f) => {
  try {
    console.log(f());
  } catch (e) {
    console.log(`${e.constructor.name}: ${e.message}`);
  }
};

// Literals: decimal, hex, octal, binary, separators, beyond 64 bits
console.log(0n, 123n, 0xffn, 0o17n, 0b1010n, 1_000_000n, 18446744073709551616n, -9007199254740993n);

// Arithmetic, truncating division, signed remainders, powers
const big = 2n ** 64n - 1n;
console.log(big, -big, big + 1n, big * big, big / 3n, big % 7n);
console.log(-7n / 2n, 7n / -2n, -7n % 2n, 7n % -2n, 2n ** 100n, (-2n) ** 63n, 0n ** 0n, (-1n) ** 1001n);
console.log(10n ** 50n / 7n ** 20n, (10n ** 40n + 1n) % 97n, 123456789012345678901234567890n * -987654321098765432109876543210n);

// Bitwise and shifts (two's complement, unbounded)
console.log(0xffn & 0x0fn, -1n | 0x10n, 5n ^ -3n, ~5n, ~-1n, -8n & 0xffn, (1n << 200n) | 1n);
console.log(1n << 100n, -(1n << 100n) >> 3n, -1n >> 1000n, 5n >> -2n, 1n << -1n, (2n ** 64n) >> 63n);

// Increment, decrement, compound assignment, unary minus
let i = 0n;
i++;
++i;
i += 10n;
i *= -3n;
i--;
console.log(i, -i, -(-0n), typeof i, typeof Object(i));

// Equality and order, with Numbers and strings compared by value
console.log(1n == 1, 1n === 1, 1n == "1", 1n == "0x1", 1n == "x", 0n == false, 1n == true, 2n == 2.5);
console.log(2n > 1, 2n < 2.5, 1n < "2", 1n < "x", "10" > 9n, 3n >= 3, NaN < 1n, 1n < Infinity, -(2n ** 64n) < -1e19);
console.log([5n, -2n, 10n, 0n].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), [1n, 2n].includes(2n), [1n].indexOf(1n));
console.log(new Map([[1n, "one"]]).get(1n), new Set([1n, 1n, 2n]).size, Object.is(0n, -0n), 0n ? "truthy" : "falsy", !!1n);

// Conversions
console.log(String(-123n), `${7n}`, 7n + "", Number(2n ** 64n), Number(-(2n ** 53n) - 1n), parseInt(15n), +[], [1n, 2n].join());
console.log(BigInt("0x1f"), BigInt(" 42 "), BigInt("-12"), BigInt(""), BigInt(2 ** 60), BigInt(true), BigInt(Object(9n)));
console.log({ [1n]: "a" }[1], (255n).toString(16), (-255n).toString(2), (2n ** 70n).toString(36), (1234567n).toLocaleString());
console.log(BigInt.asIntN(8, 255n), BigInt.asUintN(8, -1n), BigInt.asIntN(64, 2n ** 63n), BigInt.asUintN(64, -1n), BigInt.asIntN(0, 5n));
console.log(Object.prototype.toString.call(1n), Object(1n) instanceof BigInt, BigInt.prototype.valueOf.call(Object(3n)));

// Errors
t(() => 1n + 1);
t(() => +1n);
t(() => 1n / 0n);
t(() => 1n % 0n);
t(() => 2n ** -1n);
t(() => 1n >>> 1n);
t(() => Math.max(1n));
t(() => JSON.stringify({ a: 1n }));
t(() => BigInt(1.5));
t(() => BigInt("1e3"));
t(() => BigInt(undefined));
t(() => new BigInt(1));
t(() => (1n).toString(37));
t(() => BigInt.prototype.toString.call(1));
t(() => 2n ** (2n ** 40n));

// JSON with a toJSON, and console.log
BigInt.prototype.toJSON = function () {
  return `${this}n`;
};
console.log(JSON.stringify({ a: 1n, b: [2n] }));
console.log([1n, -2n], { big: 10n ** 20n }, Object(5n), [Object(-6n)]);
console.log("%d and %i and %s", 5n, 6n, 7n);

// BigInt64Array, BigUint64Array and DataView's BigInt methods: 64-bit elements, wrapping on store
const a = new BigInt64Array([1n, -2n, 2n ** 63n, -(2n ** 63n) - 1n]);
const u = BigUint64Array.from([1n, -1n, 2n ** 64n + 5n]);
console.log(a, u, a.length, BigInt64Array.BYTES_PER_ELEMENT, a[2], u[1], a.join("|"));
a[0] = 10n ** 20n;
u[0] = -3n;
console.log(a[0], u[0], a.includes(-2n), a.indexOf(-2n), u.toString());
console.log(a.slice().sort(), u.toSorted(), a.toReversed(), u.with(1, 7n), a.map((x) => x * 2n), a.reduce((s, x) => s + x, 0n));
const view = new DataView(new ArrayBuffer(16));
view.setBigInt64(0, -5n);
view.setBigUint64(8, 2n ** 64n - 2n, true);
console.log(view.getBigInt64(0), view.getBigUint64(0), view.getBigUint64(8, true), view.getBigInt64(8, true), view.getUint8(7));
console.log(new BigInt64Array(new BigUint64Array([2n ** 64n - 1n])), new BigUint64Array(a.buffer, 8, 1), a.fill(7n, 1, 3));
t(() => {
  a[0] = 1;
});
t(() => new BigInt64Array([1]));
t(() => new BigInt64Array(new Int8Array(1)));
t(() => view.setBigInt64(0, 1));
