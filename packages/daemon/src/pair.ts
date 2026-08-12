import { networkInterfaces, hostname } from "node:os";
import type { IncomingHttpHeaders } from "node:http";

export interface PairInfo {
  bases: string[];
  token: string;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * 配对端点仅能由本机直接访问。运行在本机的隧道或反向代理也会以 loopback
 * 地址连接，因而必须拒绝其注入的代理头，防止配对 token 被转发到网络外。
 */
export function looksProxied(headers: IncomingHttpHeaders): boolean {
  const markers = [
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "forwarded",
    "cf-connecting-ip",
    "cf-ray",
    "cf-ipcountry",
    "cf-visitor",
    "ngrok-trace-id",
  ];
  return markers.some((name) => headers[name] !== undefined);
}

function isIpv4(address: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address);
}

function isTailscaleAddress(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

function interfaceIpv4(name: string): string | undefined {
  return networkInterfaces()[name]?.find((entry) => !entry.internal && entry.family === "IPv4" && isIpv4(entry.address))?.address;
}

export function enumeratePairBases(port: number): string[] {
  const tailscale: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === "IPv4" && isTailscaleAddress(entry.address)) {
        tailscale.push(entry.address);
      }
    }
  }
  const lan = interfaceIpv4("en0");
  const localHostname = hostname().toLowerCase().endsWith(".local") ? hostname().toLowerCase() : `${hostname().toLowerCase()}.local`;
  const addresses = [...tailscale, ...(lan === undefined ? [] : [lan]), localHostname];
  return [...new Set(addresses)].map((address) => `http://${address}:${port}`);
}

export function pairPayload(info: PairInfo): string {
  const bases = info.bases.map((base) => encodeURIComponent(base)).join(",");
  return `claude-remote://setup?v=1&token=${encodeURIComponent(info.token)}&bases=${bases}`;
}
