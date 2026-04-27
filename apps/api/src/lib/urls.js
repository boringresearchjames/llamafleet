import os from "os";
import { port, publicHostOverride } from "./config.js";

export function instanceBaseUrl(instance) {
  return `http://${instance.host || "127.0.0.1"}:${instance.port}`;
}

export function detectMachineIpv4() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (!item) continue;
      const family = typeof item.family === "string" ? item.family : String(item.family);
      if (family !== "IPv4") continue;
      if (item.internal) continue;
      const addr = String(item.address || "").trim();
      if (!addr || addr.startsWith("169.254.")) continue;
      return addr;
    }
  }
  return null;
}

export function resolveAdvertisedHost(instance) {
  const bindHost = String(instance?.bindHost || "0.0.0.0").trim().toLowerCase();
  const internalHost = String(instance?.host || "127.0.0.1").trim() || "127.0.0.1";
  const localhostOnly = bindHost === "127.0.0.1" || bindHost === "localhost" || bindHost === "::1";
  if (localhostOnly) return internalHost;
  if (publicHostOverride) return publicHostOverride;
  return detectMachineIpv4() || internalHost;
}

export function instancePublicBaseUrl(instance) {
  return `http://${resolveAdvertisedHost(instance)}:${instance.port}`;
}

export function apiPublicBaseUrl() {
  const host = publicHostOverride || detectMachineIpv4() || "127.0.0.1";
  return `http://${host}:${port}`;
}
