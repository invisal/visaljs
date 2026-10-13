// HTTP differential testing: a server run by Node and compiled by visaljs must
// answer the same raw requests with the same bytes (the Date header aside). Each server reads
// its port from $PORT and prints a line once it listens. Both run in production (NODE_ENV): visaljs
// builds fix it there by default, and Express's error pages depend on it.
import { type ChildProcess, spawn } from "node:child_process";
import { connect } from "node:net";

export interface Server {
  process: ChildProcess;
  port: number;
}

/** Starts `command` with $PORT set, and resolves once it prints its first line. */
export function start(command: string, args: string[], port: number, cwd: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, NODE_ENV: "production", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => reject(new Error(`${command} didn't start:\n${output}`)), 20000);
    const onData = (d: Buffer) => {
      output += d.toString();
      if (output.includes("\n")) {
        clearTimeout(timer);
        child.stdout!.off("data", onData);
        resolve({ process: child, port });
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", (d: Buffer) => (output += d.toString()));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${command} exited with ${code}:\n${output}`));
    });
  });
}

export function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (server.process.exitCode !== null) return resolve();
    server.process.removeAllListeners("exit");
    server.process.once("exit", () => resolve());
    server.process.kill();
  });
}

/** Where a response ends in `data` (bytes after the head: a Content-Length, a chunked body, or
 *  none), or -1 while it's incomplete. `head` says the request was a HEAD. */
function responseEnd(data: Buffer, from: number, head: boolean): number {
  const sep = data.indexOf("\r\n\r\n", from);
  if (sep < 0) return -1;
  const headText = data.subarray(from, sep).toString("latin1");
  const bodyStart = sep + 4;
  const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(headText)?.[1]);
  if (head || status === 204 || status === 304 || (status >= 100 && status < 200)) return bodyStart;
  const length = /\r\ncontent-length: *(\d+)/i.exec(headText);
  if (length) return data.length >= bodyStart + Number(length[1]) ? bodyStart + Number(length[1]) : -1;
  if (/\r\ntransfer-encoding: *chunked/i.test(headText)) {
    let at = bodyStart;
    for (;;) {
      const line = data.indexOf("\r\n", at);
      if (line < 0) return -1;
      const size = parseInt(data.subarray(at, line).toString("latin1"), 16);
      if (size === 0) {
        const end = data.indexOf("\r\n", line + 2);
        return end < 0 ? -1 : end + 2;
      }
      at = line + 2 + size + 2;
      if (at > data.length) return -1;
    }
  }
  return -2;  /* the body ends with the connection */
}

/** Sends raw requests on one connection, one after another; the responses, Date normalized. */
export function exchange(port: number, requests: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const responses: string[] = [];
    let data = Buffer.alloc(0);
    let index = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no complete response to request ${index}: ${JSON.stringify(data.toString("latin1"))}`));
    }, 10000);
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(responses.map((r) => r.replace(/\r\nDate: [^\r]*/i, "\r\nDate: <date>")));
    };
    const next = () => {
      if (index === requests.length) return finish();
      socket.write(requests[index]!);
    };
    socket.on("connect", next);
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      for (;;) {
        const end = responseEnd(data, 0, requests[index]!.startsWith("HEAD "));
        if (end === -1 || end === -2) return;
        responses.push(data.subarray(0, end).toString("latin1"));
        data = data.subarray(end);
        index++;
        if (index === requests.length) return finish();
        next();
      }
    });
    socket.on("end", () => {
      if (data.length) responses.push(data.toString("latin1"));
      finish();
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Sends `count` pipelined requests and closes the connection without reading the responses:
 *  the server's writes then fail (EPIPE), which must not end it. */
export function abandon(port: number, request: string, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(request.repeat(count), () => {
        socket.resetAndDestroy();
        resolve();
      });
    });
    socket.on("error", reject);
  });
}
