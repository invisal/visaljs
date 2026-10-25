// Classes: number fields read and written in a loop, bodies linked through a field of the class's
// own type, method calls on `this`.
import { nbody } from "./nbody.ts";

console.log(nbody(Number(process.argv[2])));
