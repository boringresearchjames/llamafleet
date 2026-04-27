import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// apps/api/src/lib -> apps/web
export const webRoot = path.resolve(__dirname, "../../../web");

export const port = Number(process.env.PORT || 8081);
export const apiToken = process.env.API_AUTH_TOKEN || "change-me";
export const bridgeUrl = process.env.BRIDGE_URL || "http://localhost:8090";
export const bridgeToken = process.env.BRIDGE_AUTH_TOKEN || "change-me";
export const stateFile = process.env.STATE_FILE || path.resolve(process.cwd(), "data", "state.json");
export const sharedConfigFile = process.env.SHARED_CONFIG_FILE || path.resolve(process.cwd(), "data", "shared-config.yaml");
export const apiAuthEnabled = Boolean(apiToken && apiToken !== "change-me");
export const bridgeAuthEnabled = Boolean(bridgeToken && bridgeToken !== "change-me");
export const publicHostOverride = String(process.env.LLAMAFLEET_PUBLIC_HOST || "").trim();
export const modelsDir = String(process.env.MODELS_DIR || "").trim() || path.join(os.homedir(), ".lmstudio", "models");
export const corsOrigin = process.env.CORS_ORIGIN || "*";

if (!apiAuthEnabled) {
  console.warn("API auth disabled: API_AUTH_TOKEN not set.");
}
if (!bridgeAuthEnabled) {
  console.warn("Bridge auth disabled: BRIDGE_AUTH_TOKEN not set.");
}

fs.mkdirSync(path.dirname(stateFile), { recursive: true });
