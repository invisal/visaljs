import Redis from "ioredis";

const url = process.env.REDIS_URL || "redis://localhost:56379";
const redis = new Redis(url, { lazyConnect: true });
await redis.connect();

const keys = await redis.keys("pkg:ioredis:*");
if (keys.length) await redis.del(...keys);

await redis.set("pkg:ioredis:greeting", "héllo");
console.log("get", await redis.get("pkg:ioredis:greeting"));
console.log("set nx", await redis.set("pkg:ioredis:greeting", "x", "NX"));
await redis.set("pkg:ioredis:ttl", "1", "EX", 100);
console.log("ttl", (await redis.ttl("pkg:ioredis:ttl")) > 90);
console.log("incr", await redis.incr("pkg:ioredis:n"), await redis.incrby("pkg:ioredis:n", 41));
console.log("missing", await redis.get("pkg:ioredis:missing"));
console.log("buffer", (await redis.getBuffer("pkg:ioredis:greeting")).toString("hex"));

await redis.hset("pkg:ioredis:user", { name: "ada", lang: "en", visits: 3 });
await redis.hincrby("pkg:ioredis:user", "visits", 2);
console.log("hash", JSON.stringify(await redis.hgetall("pkg:ioredis:user")));

await redis.rpush("pkg:ioredis:queue", "a", "b", "c");
console.log("list", JSON.stringify(await redis.lrange("pkg:ioredis:queue", 0, -1)), await redis.lpop("pkg:ioredis:queue"));

await redis.zadd("pkg:ioredis:scores", 30, "c", 10, "a", 20, "b");
console.log("zset", JSON.stringify(await redis.zrange("pkg:ioredis:scores", 0, -1, "WITHSCORES")));

console.log("pipeline", JSON.stringify(await redis.pipeline().set("pkg:ioredis:p1", "1").incr("pkg:ioredis:p1").get("pkg:ioredis:p1").exec()));
console.log("multi", JSON.stringify(await redis.multi().incr("pkg:ioredis:m").incr("pkg:ioredis:m").exec()));

redis.defineCommand("incrTwice", { numberOfKeys: 1, lua: "redis.call('INCR', KEYS[1]); return redis.call('INCR', KEYS[1])" });
console.log("lua", await redis.incrTwice("pkg:ioredis:lua"));

try {
  await redis.hget("pkg:ioredis:greeting", "x");
} catch (e) {
  console.log("wrong type", e.name, e.message.split(" ")[0]);
}

const subscriber = redis.duplicate();
const received = new Promise((resolve) => subscriber.on("message", (channel, message) => resolve(`${channel} ${message}`)));
await subscriber.subscribe("pkg:ioredis:channel");
console.log("published", await redis.publish("pkg:ioredis:channel", "ping"));
console.log("message", await received);
subscriber.disconnect();

const scanned = await new Promise((resolve, reject) => {
  const found = [];
  redis.scanStream({ match: "pkg:ioredis:*", count: 100 })
    .on("data", (batch) => found.push(...batch))
    .on("end", () => resolve(found.sort()))
    .on("error", reject);
});
console.log("scan", scanned.join(","));

const parallel = await Promise.all([1, 2, 3, 4, 5, 6].map((k) => redis.incrby("pkg:ioredis:par", k)));
console.log("parallel", Math.max(...parallel));

await redis.del(...scanned, "pkg:ioredis:par");
await redis.quit();
console.log("done");
