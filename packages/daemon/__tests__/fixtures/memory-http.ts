import { Agent, Server, request } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import type { TestContext } from "node:test";

/** Exercise Node's HTTP parsing and WS upgrade without an OS listener. */
class MemorySocket extends Duplex {
  peer?: MemorySocket;
  readonly remoteAddress = "127.0.0.1";
  readonly connecting = false;

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void): void {
    if (this.peer?.destroyed === false) this.peer.push(Buffer.from(chunk));
    done();
  }

  override _final(done: () => void): void {
    this.peer?.push(null);
    done();
  }

  override _destroy(error: Error | null, done: (error: Error | null) => void): void {
    if (this.peer?.destroyed === false) this.peer.push(null);
    done(error);
  }

  setTimeout(_ms: number, callback?: () => void): this {
    if (callback) this.once("timeout", callback);
    return this;
  }

  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  destroySoon(): void { this.end(); }
}

export function memoryHttp(t: TestContext) {
  let server: Server | undefined;
  const sockets = new Set<MemorySocket>();
  const listen = t.mock.method(Server.prototype, "listen", function (this: Server, _port: number, _host: string, ready: () => void) {
    server = this;
    this.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 12345 });
    queueMicrotask(ready);
    return this;
  });

  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => {
    if (!server) throw new Error("missing HTTP server");
    const client = new MemorySocket();
    const incoming = new MemorySocket();
    client.peer = incoming;
    incoming.peer = client;
    for (const socket of [client, incoming]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    }
    server.emit("connection", incoming);
    return client as unknown as Socket;
  };

  const fetchJson = (path: string, options: { token?: string; post?: object; method?: string } = {}): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const body = options.post === undefined ? undefined : JSON.stringify(options.post);
      const req = request(`http://fixture.test${path}`, {
        agent, method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
          ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("error", reject);
        res.once("end", () => {
          try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
          catch (error) { reject(error); }
        });
      });
      req.once("error", reject);
      req.end(body);
    });

  return {
    agent, fetchJson,
    restoreListen: () => listen.mock.restore(),
    close: () => {
      agent.destroy();
      for (const socket of sockets) socket.destroy();
    },
  };
}
