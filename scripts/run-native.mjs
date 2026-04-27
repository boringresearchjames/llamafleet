import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env from the repo root if present (dev convenience — systemd uses EnvironmentFile instead)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(__dirname, "..", ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

const isWindows = process.platform === "win32";
const npmCmd = "npm";
const isDev = process.argv.includes("--dev");

const services = [
  {
    name: "bridge",
    command: npmCmd,
    args: ["run", isDev ? "dev:bridge" : "start:bridge"],
    env: {
      BRIDGE_PORT: process.env.BRIDGE_PORT || "8090"
    }
  },
  {
    name: "api",
    command: npmCmd,
    args: ["run", isDev ? "dev:api" : "start:api"],
    env: {
      PORT: process.env.PORT || "8081",
      BRIDGE_URL: process.env.BRIDGE_URL || "http://127.0.0.1:8090"
    }
  }
];

const children = [];
let shuttingDown = false;

function log(name, message) {
  process.stdout.write(`[${name}] ${message}`);
}

for (const svc of services) {
  const child = spawn(svc.command, svc.args, {
    shell: isWindows,
    windowsHide: true,
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, ...svc.env }
  });

  child.stdout.on("data", (chunk) => log(svc.name, chunk.toString()));
  child.stderr.on("data", (chunk) => log(svc.name, chunk.toString()));

  child.on("exit", (code, signal) => {
    log(svc.name, `exited code=${String(code)} signal=${String(signal)}\n`);
    if (!shuttingDown) {
      shuttingDown = true;
      for (const other of children) {
        if (other.pid && other.pid !== child.pid) {
          other.kill("SIGTERM");
        }
      }
      process.exitCode = Number(code || 1);
    }
  });

  children.push(child);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.pid) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(0), 300);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
