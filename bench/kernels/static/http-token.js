// Calls from JS into typed code: the boundary's cost, and charCodeAt as C.
import { isToken } from "./http-token.ts";

const names = ["Content-Type", "X-Request-Id", "bad header", "Accept-Encoding", "x-forwarded-for", "Set-Cookie", "Cache-Control", "café"];
const rounds = Number(process.argv[2]);
let valid = 0;
for (let r = 0; r < rounds; r++) for (const name of names) if (isToken(name)) valid++;
console.log(valid);
