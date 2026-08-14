import os from "node:os";

/** Prefer private LAN / VPN addresses; skip loopback and link-local. */
export function detectAdvertiseHosts(): string[] {
  const preferred: string[] = [];
  const others: string[] = [];

  let interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return [];
  }

  for (const infos of Object.values(interfaces)) {
    if (!infos) continue;
    for (const info of infos) {
      if (info.internal) continue;
      const family = String(info.family);
      if (family !== "IPv4" && family !== "4") continue;
      const addr = info.address;
      if (!addr || addr.startsWith("169.254.")) continue;
      if (
        addr.startsWith("10.") ||
        addr.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(addr)
      ) {
        preferred.push(addr);
      } else {
        others.push(addr);
      }
    }
  }

  return [...new Set([...preferred, ...others])];
}

export function pickAdvertiseHost(bindHost: string): string {
  const fromEnv = process.env.PAIR_HOST?.trim();
  if (fromEnv) return fromEnv;
  if (bindHost && bindHost !== "0.0.0.0" && bindHost !== "::") return bindHost;
  return detectAdvertiseHosts()[0] || "127.0.0.1";
}
