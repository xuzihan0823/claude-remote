import { networkInterfaces, hostname } from "node:os";

export interface PairInfo {
  bases: string[];
  token: string;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
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
