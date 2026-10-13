// Date (§21.4): construction from parts, numbers and strings, the getters and setters (local
// and UTC), the string forms, Date.parse's ISO and legacy formats, and how console.log prints
// Dates. Run with TZ=Europe/Lisbon (the program tests pin it), so local times have DST.
const t = (f) => {
  try {
    console.log(f());
  } catch (e) {
    console.log(`${e.constructor.name}: ${e.message}`);
  }
};

// Local time, across a DST change, and the string forms
const winter = new Date(2024, 0, 31, 13, 5, 9, 7);
const summer = new Date(2024, 6, 1, 0, 30);
for (const d of [winter, summer]) {
  console.log(d.toString());
  console.log(d.toDateString(), "|", d.toTimeString());
  console.log(d.toISOString(), "|", d.toUTCString(), "|", d.toJSON());
  console.log(d.toLocaleString(), "|", d.toLocaleDateString(), "|", d.toLocaleTimeString());
  console.log(d.getTimezoneOffset(), d.getDay(), d.getHours(), d.getUTCHours());
}

// Time values: the epoch, the range limits, invalid dates
console.log(new Date(0).getTime(), new Date(8.64e15).toISOString(), new Date(-8.64e15).toISOString());
console.log(new Date(8.64e15 + 1).getTime(), String(new Date(NaN)), new Date("nope").getTime());
t(() => new Date(NaN).toISOString());
console.log(new Date(-62198755200000).toISOString(), new Date(253402300800000).toISOString());

// Date.UTC and two-digit years
console.log(Date.UTC(2020, 1, 29), Date.UTC(99, 11, 31), Date.UTC(2020), Date.UTC());
console.log(new Date(99, 0).getFullYear(), new Date(2024, 13, 1).getMonth(), new Date(2024, 1, 30).getDate());

// Date.parse: the ISO format (date-only is UTC, date-time local) and V8's legacy formats
for (const s of [
  "2024-03-10", "2024-03-10T10:20", "2024-03-10T10:20:30.5Z", "2024-03-10T10:20:30+05:30",
  "+002024-03-10T00:00:00Z", "-000001-01-01T00:00:00Z", "2024-13-01", "2024-03-10T25:00",
  "Thu, 01 Jan 1970 00:00:00 GMT", "Thu Jan 01 1970 01:00:00 GMT+0100 (Central European Standard Time)",
  "March 7, 2021 10:00 PM", "7 Mar 2021 22:00 EST", "3/7/2021", "2021/03/07 12:00", "Mar 7 21",
  "12:00", "", "garbage 2021",
]) {
  console.log(JSON.stringify(s), Date.parse(s));
}

// Round trips through the string forms
const r = new Date(Date.UTC(2001, 8, 9, 1, 46, 40, 123));
console.log(Date.parse(r.toString()) === r.getTime() - 123, Date.parse(r.toISOString()) === r.getTime());
console.log(Date.parse(r.toUTCString()) === r.getTime() - 123);

// Setters: local and UTC, overflowing fields, NaN
const s = new Date(2024, 0, 31);
console.log(s.setMonth(1), s.getDate(), s.setDate(0), s.getMonth(), s.setHours(25, 61, 61, 1001));
console.log(s.setUTCFullYear(2000, 1, 29), s.toISOString(), s.setMinutes(NaN), s.getTime());
console.log(s.setFullYear(2010), s.toISOString(), s.setTime(1e12), s.setMilliseconds(5), s.getYear());
console.log(s.setYear(99), s.getFullYear(), s.setUTCSeconds(30, 250), s.toISOString());

// Conversions: + and template literals use the string, - and < the number
const c = new Date(Date.UTC(2020, 0, 1));
console.log(c - 0, +c, `${c}`, c + "", c < new Date(Date.UTC(2021, 0, 1)), JSON.stringify({ c }));
console.log(c[Symbol.toPrimitive]("number"), c[Symbol.toPrimitive]("default"));
t(() => c[Symbol.toPrimitive]("bogus"));
t(() => Date.prototype.getTime.call({}));
t(() => Date.prototype.toISOString.call(1));
console.log(Object.prototype.toString.call(c), typeof Date(), typeof Date.now(), Date.length);

// Subclasses and how console.log prints Dates
class Day extends Date {
  next() {
    return new Day(this.getTime() + 864e5);
  }
}
const day = new Day(Date.UTC(2024, 1, 28));
console.log(day.next(), day.next() instanceof Day, day.next().next().getUTCDate());
const tagged = new Date(0);
tagged.note = "epoch";
console.log(new Date(0), [new Date(0)], { d: new Date(0) }, tagged, new Date(NaN));
