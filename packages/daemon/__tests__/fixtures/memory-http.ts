import { Agent, Server, request, type IncomingHttpHeaders } from "node:http";
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

  const fetchRaw = (path: string, options: { token?: string; body?: string; method?: string; range?: string } = {}):
    Promise<{ status: number; body: Buffer; headers: IncomingHttpHeaders }> => new Promise((resolve, reject) => {
      const { body } = options;
      const req = request(`http://fixture.test${path}`, {
        agent, method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
          ...(options.range === undefined ? {} : { Range: options.range }),
          ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("error", reject);
        res.once("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
      });
      req.once("error", reject);
      req.end(body);
    });

  const fetchJson = async (path: string, options: { token?: string; post?: object; method?: string } = {}):
    Promise<{ status: number; json: Record<string, unknown> }> => {
      const { post, ...rest } = options;
      const { status, body } = await fetchRaw(path, { ...rest, ...(post === undefined ? {} : { body: JSON.stringify(post) }) });
      return { status, json: JSON.parse(body.toString("utf8")) };
    };

  return {
    agent, fetchJson, fetchRaw,
    restoreListen: () => listen.mock.restore(),
    close: () => {
      agent.destroy();
      for (const socket of sockets) socket.destroy();
    },
  };
}
