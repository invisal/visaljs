import http from "node:http";

const port = Number(process.env.PORT ?? 3000);

http
  .createServer((req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end("Hello, world!\n");
  })
  .listen(port, () => console.log(`listening on http://localhost:${port}`));
