// error: static code imports only static files, "visaljs" and visaljs:host: 'node:path' isn't one
"use static";
import { sep } from "node:path";

export function separator(): string {
  return sep;
}
