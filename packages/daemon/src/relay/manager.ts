// relay 管理器：按配置增删 connector，让 cr 改 relay 配置时不必重启 daemon。
//
// 只处理 RELAY_* 带来的连接变化；进程级配置（端口、token、通知）仍要重启。
// 按 URL 对齐：参数完全没变的连接原样保留，正在跑的手机轮次和直连通道都不受影响。

import type { RelaySettings } from "../config.js";
import type { RelayStatus } from "../server.js";
import { RelayConnector } from "./connector.js";

export type RelayConnectorLike = Pick<RelayConnector, "start" | "stop" | "status">;

export interface RelayManagerOptions {
  /** 测试可注入假 connector。 */
  create?: (settings: RelaySettings) => RelayConnectorLike;
}

interface Entry {
  settings: RelaySettings;
  connector: RelayConnectorLike;
}

function sameSettings(left: RelaySettings, right: RelaySettings): boolean {
  return left.url === right.url && left.secret === right.secret
    && left.deviceId === right.deviceId && left.deviceKey === right.deviceKey;
}

export class RelayManager {
  readonly #create: (settings: RelaySettings) => RelayConnectorLike;
  #entries: Entry[] = [];
  #address: { host: string; port: number } | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: RelayManagerOptions = {}) {
    this.#create = options.create ?? ((settings) => new RelayConnector({ settings }));
  }

  get size(): number {
    return this.#entries.length;
  }

  /** daemon listen() 之后调用；之后新增的 connector 也会立即连上。 */
  start(address: { host: string; port: number }): void {
    this.#address = address;
    for (const entry of this.#entries) entry.connector.start(address);
  }

  statuses(): RelayStatus[] {
    return this.#entries.map((entry) => entry.connector.status());
  }

  /**
   * 用新配置替换现有连接：未变的复用，新增的立刻连，删除或改密钥的断开。
   * 串行执行，避免两次并发 reload 为同一地址建出两个连接。
   */
  reload(settings: RelaySettings[]): Promise<RelayStatus[]> {
    const run = async (): Promise<RelayStatus[]> => {
      const previous = this.#entries;
      const reused = new Set<Entry>();
      const next: Entry[] = [];
      for (const setting of settings) {
        const existing = previous.find((entry) => sameSettings(entry.settings, setting));
        if (existing !== undefined) {
          reused.add(existing);
          next.push(existing);
          continue;
        }
        const connector = this.#create(setting);
        if (this.#address !== undefined) connector.start(this.#address);
        next.push({ settings: setting, connector });
      }
      this.#entries = next;
      const dropped = previous.filter((entry) => !reused.has(entry));
      await Promise.all(dropped.map((entry) => entry.connector.stop()));
      return this.statuses();
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async stop(): Promise<void> {
    const entries = this.#entries;
    this.#entries = [];
    await Promise.all(entries.map((entry) => entry.connector.stop()));
  }
}
