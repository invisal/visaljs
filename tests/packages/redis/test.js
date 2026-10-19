import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers/promises";
import { createClient, RESP_TYPES } from "redis";

const url = process.env.REDIS_URL || "redis://localhost:56379";
const client = createClient({ url });
client.on("error", (e) => console.log("client error", e.message));
await client.connect();

const keys = await client.keys("pkg:redis:*");
if (keys.length) await client.del(keys);

await client.set("pkg:redis:greeting", "héllo");
console.log("get", await client.get("pkg:redis:greeting"));
console.log("set nx", await client.set("pkg:redis:greeting", "x", { condition: "NX" }));
await client.set("pkg:redis:ttl", "1", { expiration: { type: "EX", value: 100 } });
console.log("ttl", (await client.ttl("pkg:redis:ttl")) > 90);
console.log("incr", await client.incr("pkg:redis:n"), await client.incrBy("pkg:redis:n", 41));
console.log("missing", await client.get("pkg:redis:missing"));

await client.hSet("pkg:redis:user", { name: "ada", lang: "en", visits: "3" });
await client.hIncrBy("pkg:redis:user", "visits", 2);
console.log("hash", JSON.stringify(await client.hGetAll("pkg:redis:user")));

await client.rPush("pkg:redis:queue", ["a", "b", "c"]);
await client.lPush("pkg:redis:queue", "z");
console.log("list", JSON.stringify(await client.lRange("pkg:redis:queue", 0, -1)), await client.lPop("pkg:redis:queue"));

await client.sAdd("pkg:redis:set", ["x", "y", "z", "x"]);
console.log("set", (await client.sMembers("pkg:redis:set")).sort().join(","), await client.sIsMember("pkg:redis:set", "y"));

await client.zAdd("pkg:redis:scores", [{ score: 30, value: "c" }, { score: 10, value: "a" }, { score: 20, value: "b" }]);
console.log("zset", JSON.stringify(await client.zRangeWithScores("pkg:redis:scores", 0, -1)));

const results = await client.multi().set("pkg:redis:m1", "1").incr("pkg:redis:m1").get("pkg:redis:m1").exec();
console.log("multi", JSON.stringify(results));

const buffer = await client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer }).get("pkg:redis:greeting");
console.log("buffer", Buffer.isBuffer(buffer), buffer.toString("hex"));

try {
  await client.hGet("pkg:redis:greeting", "x");
} catch (e) {
  console.log("wrong type", e.message.split(" ")[0]);
}

const subscriber = client.duplicate();
await subscriber.connect();
const received = new Promise((resolve) => subscriber.subscribe("pkg:redis:channel", (message, channel) => resolve(`${channel} ${message}`)));
await setTimeout(50);
console.log("published", await client.publish("pkg:redis:channel", "ping"));
console.log("message", await received);
await subscriber.unsubscribe("pkg:redis:channel");
await subscriber.quit();

const scanned = [];
for await (const batch of client.scanIterator({ MATCH: "pkg:redis:*", COUNT: 100 })) scanned.push(...batch);
console.log("scan", scanned.sort().join(","));

const parallel = await Promise.all([1, 2, 3, 4, 5, 6].map((k) => client.incrBy("pkg:redis:p", k)));
console.log("parallel", parallel.sort((a, b) => a - b).at(-1));

await client.del(scanned.concat("pkg:redis:p"));
await client.quit();
console.log("done");
