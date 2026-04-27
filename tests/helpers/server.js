import { spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const TEST_PORT = 18081;
export const TEST_TOKEN = "vitest-test-token-llamafleet-abc123";
const BRIDGE_TOKEN = "vitest-bridge-token-xyz789";

export const testBase = `http://127.0.0.1:${TEST_PORT}`;

let proc = null;
let dataDir = null;

/**
 * Spawn the API server on a dedicated test port with an isolated temp
 * state directory. Polls /health until the process is ready.
 */
export async function startServer() {
  dataDir = await mkdtemp(join(tmpdir(), "llamafleet-test-"));

  proc = spawn("node", ["apps/api/src/index.js"], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      API_AUTH_TOKEN: TEST_TOKEN,
      BRIDGE_AUTH_TOKEN: BRIDGE_TOKEN,
      STATE_FILE: join(dataDir, "state.json"),
      SHARED_CONFIG_FILE: join(dataDir, "shared-config.yaml"),
      // Point at a non-existent bridge — endpoints that proxy to it will fail,
      // but state/profile/auth logic is fully exercisable without it.
      BRIDGE_URL: "http://127.0.0.1:19090",
    },
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stderr.pipe(process.stderr);

  // Wait up to 10 s for the server to be ready
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${testBase}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Test API server did not become ready within 10 s");
}

/**
 * Gracefully stop the server and delete the temp state directory.
 */
export async function stopServer() {
  if (proc) {
    proc.kill("SIGTERM");
    await new Promise((r) => proc.once("exit", r));
    proc = null;
  }
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
}
