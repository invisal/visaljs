// Web Crypto's AES: AES-CBC, AES-CTR, AES-GCM and AES-KW keys, encrypt and decrypt,
// wrapKey and unwrapKey, and AES keys from deriveKey, with Node's errors.
const s = crypto.subtle;
const t = async (f) => {
  try {
    const r = await f();
    console.log(r instanceof ArrayBuffer ? "ArrayBuffer " + Buffer.from(r).toString("hex") : r);
  } catch (e) {
    console.log(`${e.name} [${e.code}]: ${e.message}`);
  }
};
const raw = new Uint8Array(16).fill(1);
const kc = await s.importKey('raw', raw, 'AES-CBC', true, ['encrypt','decrypt']);
console.log(kc);
await t(()=>s.importKey('raw', raw, {name:'AES-CBC', length: 128}, true, ['encrypt']));
await t(()=>s.importKey('raw', new Uint8Array(15), 'AES-CBC', true, ['encrypt']));
await t(()=>s.importKey('raw', raw, 'AES-CBC', true, ['sign']));
await t(()=>s.importKey('raw', raw, 'AES-KW', true, ['encrypt']));
await t(()=>s.importKey('raw', raw, 'AES-KW', true, ['wrapKey','unwrapKey']));
await t(()=>s.importKey('raw', raw, 'AES-CTR', true, []));
await t(()=>s.importKey('jwk', {kty:'oct', k:'AQEBAQEBAQEBAQEBAQEBAQ', alg:'A128CBC'}, 'AES-CBC', true, ['encrypt']));
await t(()=>s.importKey('jwk', {kty:'oct', k:'AQEBAQEBAQEBAQEBAQEBAQ', alg:'A256CBC'}, 'AES-CBC', true, ['encrypt']));
await t(()=>s.importKey('jwk', {kty:'oct', k:'AQEB'}, 'AES-CBC', true, ['encrypt']));
await t(()=>s.importKey('jwk', {kty:'oct', k:'AQEBAQEBAQEBAQEBAQEBAQ', use:'sig'}, 'AES-GCM', true, ['encrypt']));
await t(()=>s.exportKey('jwk', kc));
await t(async()=>s.exportKey('jwk', await s.importKey('raw', new Uint8Array(32), 'AES-KW', true, ['wrapKey'])));
await t(async()=>s.exportKey('jwk', await s.importKey('raw', new Uint8Array(24), 'AES-GCM', true, ['encrypt'])));
await t(async()=>s.exportKey('jwk', await s.importKey('raw', new Uint8Array(32), 'AES-CTR', true, ['encrypt'])));
await t(()=>s.exportKey('spki', kc));
const iv = new Uint8Array(16).fill(2);
await t(()=>s.encrypt({name:'AES-CBC', iv}, kc, new TextEncoder().encode('hello')));
await t(()=>s.encrypt({name:'AES-CBC', iv: new Uint8Array(15)}, kc, new Uint8Array(1)));
await t(()=>s.encrypt({name:'AES-CBC'}, kc, new Uint8Array(1)));
await t(()=>s.decrypt({name:'AES-CBC', iv}, kc, new Uint8Array(16)));
await t(()=>s.decrypt({name:'AES-CBC', iv}, kc, new Uint8Array(15)));
await t(()=>s.encrypt({name:'AES-GCM', iv}, kc, new Uint8Array(1)));
const kg = await s.importKey('raw', raw, 'AES-GCM', true, ['encrypt','decrypt']);
await t(()=>s.encrypt({name:'AES-GCM', iv: new Uint8Array(12)}, kg, new TextEncoder().encode('hello')));
await t(()=>s.encrypt({name:'AES-GCM', iv: new Uint8Array(12), additionalData: new Uint8Array(3), tagLength: 96}, kg, new TextEncoder().encode('hello')));
await t(()=>s.encrypt({name:'AES-GCM', iv: new Uint8Array(12), tagLength: 100}, kg, new Uint8Array(1)));
await t(()=>s.encrypt({name:'AES-GCM', iv: new Uint8Array(0)}, kg, new Uint8Array(1)));
await t(()=>s.encrypt({name:'AES-GCM', iv: new Uint8Array(1)}, kg, new Uint8Array(1)));
await t(()=>s.decrypt({name:'AES-GCM', iv: new Uint8Array(12)}, kg, new Uint8Array(16)));
await t(()=>s.decrypt({name:'AES-GCM', iv: new Uint8Array(12)}, kg, new Uint8Array(15)));
await t(()=>s.decrypt({name:'AES-GCM', iv: new Uint8Array(12), tagLength: 32}, kg, new Uint8Array(3)));
const kt = await s.importKey('raw', raw, 'AES-CTR', true, ['encrypt','decrypt']);
await t(()=>s.encrypt({name:'AES-CTR', counter: new Uint8Array(16).fill(255), length: 8}, kt, new Uint8Array(40)));
await t(()=>s.encrypt({name:'AES-CTR', counter: new Uint8Array(16).fill(255), length: 128}, kt, new Uint8Array(40)));
await t(()=>s.encrypt({name:'AES-CTR', counter: new Uint8Array(16), length: 0}, kt, new Uint8Array(4)));
await t(()=>s.encrypt({name:'AES-CTR', counter: new Uint8Array(16), length: 129}, kt, new Uint8Array(4)));
await t(()=>s.encrypt({name:'AES-CTR', counter: new Uint8Array(15), length: 64}, kt, new Uint8Array(4)));
await t(()=>s.encrypt({name:'AES-CTR', counter: new Uint8Array(16), length: 1}, kt, new Uint8Array(40)));
await t(()=>s.encrypt({name:'AES-CTR', counter: new Uint8Array(16)}, kt, new Uint8Array(4)));
await t(()=>s.generateKey({name:'AES-GCM', length: 256}, true, ['encrypt']).then(k=>[k.algorithm, k.usages]));
await t(()=>s.generateKey({name:'AES-GCM', length: 100}, true, ['encrypt']));
await t(()=>s.generateKey({name:'AES-GCM'}, true, ['encrypt']));
await t(()=>s.generateKey({name:'AES-GCM', length: 128}, true, ['sign']));
await t(()=>s.generateKey({name:'AES-KW', length: 128}, true, ['wrapKey','unwrapKey','wrapKey']).then(k=>k.usages));
const kw = await s.importKey('raw', raw, 'AES-KW', true, ['wrapKey','unwrapKey']);
await t(()=>s.wrapKey('raw', kc, kw, 'AES-KW'));
await t(()=>s.wrapKey('jwk', kc, kw, 'AES-KW'));
await t(()=>s.wrapKey('raw', kc, kg, {name:'AES-GCM', iv: new Uint8Array(12)}));
await t(async()=>s.wrapKey('raw', kc, await s.importKey('raw', raw, 'AES-GCM', true, ['wrapKey']), {name:'AES-GCM', iv: new Uint8Array(12)}));
await t(async()=>s.wrapKey('jwk', kc, await s.importKey('raw', raw, 'AES-GCM', true, ['wrapKey']), {name:'AES-GCM', iv: new Uint8Array(12)}));
await t(async()=>{ const w = await s.wrapKey('raw', kc, kw, 'AES-KW'); const u = await s.unwrapKey('raw', w, kw, 'AES-KW', 'AES-CBC', true, ['encrypt']); return [u.algorithm, u.usages, Buffer.from(await s.exportKey('raw', u)).toString('hex')]; });
await t(()=>s.unwrapKey('raw', new Uint8Array(24), kw, 'AES-KW', 'AES-CBC', true, ['encrypt']));
await t(()=>s.unwrapKey('raw', new Uint8Array(20), kw, 'AES-KW', 'AES-CBC', true, ['encrypt']));
await t(async()=>{ const wk = await s.importKey('raw', raw, 'AES-GCM', true, ['wrapKey','unwrapKey']); const w = await s.wrapKey('jwk', kc, wk, {name:'AES-GCM', iv: new Uint8Array(12)}); const u = await s.unwrapKey('jwk', w, wk, {name:'AES-GCM', iv: new Uint8Array(12)}, 'AES-CBC', false, ['decrypt']); return u; });
await t(async()=>{ const pb = await s.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']); return s.deriveKey({name:'PBKDF2', salt: raw, iterations: 1, hash:'SHA-256'}, pb, {name:'AES-GCM', length: 256}, true, ['encrypt']).then(k=>s.exportKey('raw',k)); });
await t(async()=>{ const pb = await s.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']); return s.deriveKey({name:'PBKDF2', salt: raw, iterations: 1, hash:'SHA-256'}, pb, {name:'AES-GCM', length: 100}, true, ['encrypt']); });
await t(async()=>{ const pb = await s.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']); return s.deriveKey({name:'PBKDF2', salt: raw, iterations: 1, hash:'SHA-256'}, pb, {name:'AES-GCM'}, true, ['encrypt']); });
await t(()=>s.encrypt({name:'AES-CBC', iv}, kg, new Uint8Array(1)));
await t(()=>s.encrypt({name:'AES-KW'}, kw, new Uint8Array(16)));
for (const n of [1, 8, 11, 12, 16, 64]) await t(() => s.encrypt({ name: "AES-GCM", iv: new Uint8Array(n) }, kg, new Uint8Array(1)));
await t(async () => {
  const ct = await s.encrypt({ name: "AES-GCM", iv: new Uint8Array(12), additionalData: new Uint8Array(3) }, kg, new TextEncoder().encode("secret"));
  return new TextDecoder().decode(await s.decrypt({ name: "AES-GCM", iv: new Uint8Array(12), additionalData: new Uint8Array(3) }, kg, ct));
});
await t(async () => {
  const ct = await s.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, kg, new TextEncoder().encode("secret"));
  return s.decrypt({ name: "AES-GCM", iv: new Uint8Array(12), additionalData: new Uint8Array(3) }, kg, ct);
});
await t(async () => {
  const ct = await s.encrypt({ name: "AES-CBC", iv }, kc, new TextEncoder().encode("a longer message, more than one block"));
  return new TextDecoder().decode(await s.decrypt({ name: "AES-CBC", iv }, kc, ct));
});
await t(async () => {
  const ct = await s.encrypt({ name: "AES-CTR", counter: new Uint8Array(16), length: 64 }, kt, new TextEncoder().encode("counter mode"));
  return new TextDecoder().decode(await s.decrypt({ name: "AES-CTR", counter: new Uint8Array(16), length: 64 }, kt, ct));
});
await t(() => s.encrypt({ name: "AES-GCM", iv: new Uint8Array(12), tagLength: 300 }, kg, new Uint8Array(1)));
await t(() => s.encrypt({ name: "AES-CTR", counter: new Uint8Array(16), length: 300 }, kt, new Uint8Array(1)));
await t(() => s.generateKey({ name: "AES-CBC", length: 70000 }, true, ["encrypt"]));
await t(() => s.decrypt({ name: "AES-CBC", iv }, kc, new Uint8Array(16)));
await t(() => s.encrypt({ name: "AES-CBC", iv }, kc, "x"));
await t(() => s.encrypt({ name: "AES-CBC", iv }, 1, new Uint8Array(1)));
await t(() => s.encrypt({ name: "AES-CBC", iv }, kc));
await t(async () => s.encrypt({ name: "AES-CBC", iv }, await s.importKey("raw", raw, "AES-CBC", true, ["decrypt"]), new Uint8Array(1)));
await t(() => s.unwrapKey("jwk", new Uint8Array(24), kw, "AES-KW", "AES-CBC", true, ["encrypt"]));
await t(async () => {
  const wk = await s.importKey("raw", raw, "AES-CBC", true, ["wrapKey", "unwrapKey"]);
  const w = await s.wrapKey("raw", kc, wk, { name: "AES-CBC", iv });
  return s.unwrapKey("jwk", w, wk, { name: "AES-CBC", iv }, "AES-CBC", true, ["encrypt"]);
});
await t(() => s.wrapKey("raw", kc, kw, "AES-CBC"));
await t(() => s.wrapKey("raw", kc, kw, "FOO"));
await t(() => s.wrapKey("raw", kc, kw));
await t(() => s.unwrapKey("raw", new Uint8Array(24), kw, "AES-KW", "AES-CBC", true));
await t(async () => s.wrapKey("raw", await s.importKey("raw", raw, "AES-CBC", false, ["encrypt"]), kw, "AES-KW"));
