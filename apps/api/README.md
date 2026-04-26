# LlamaFleet API

Control plane for instance lifecycle, config profiles, routing manifest, and agent integration. Also serves the browser dashboard.

## Local run

```bash
npm install
npm start
```

Default port: **8081**

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8081` | Listen port |
| `API_AUTH_TOKEN` | *(unset)* | Bearer token for all `/v1` endpoints. When unset, auth is disabled. |
| `BRIDGE_URL` | `http://localhost:8090` | URL of the host bridge |
| `BRIDGE_AUTH_TOKEN` | *(unset)* | Token sent to the bridge via `X-Bridge-Token` |
| `STATE_FILE` | `./data/state.json` | Persistent state path |
| `SHARED_CONFIG_FILE` | `./data/shared-config.yaml` | Shared config (profiles, security settings) |
| `MODELS_DIR` | `~/.lmstudio/models` | Directory scanned for `.gguf` model files |
| `LLAMAFLEET_PUBLIC_HOST` | *(unset)* | This machine's IP, used to construct proxy URLs shown in the dashboard |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` header value |

## Endpoints

### Unauthenticated

- `GET /health` — health check
- `GET /help` — HTML API reference
- `POST /auth/login` — exchange username + password for a session token
- `POST /auth/logout` — invalidate current session token

### Instances (`/v1`)

- `GET /v1/instances` — list all instances with state and GPU telemetry
- `POST /v1/instances/start` — launch a new `llama-server` instance
- `POST /v1/instances/:id/stop` — graceful stop
- `POST /v1/instances/:id/kill` — force kill
- `DELETE /v1/instances/:id` — kill (if running) and remove
- `POST /v1/instances/:id/drain` — pause/resume request intake
- `POST /v1/instances/:id/model` — hot-swap model (`applyMode`: `next_restart` | `restart_now`)
- `GET /v1/instances/:id/logs` — tail logs (`?lines=200`)
- `GET /v1/instances/:id/connection` — copy-ready proxy URLs and model fields
- `ALL /v1/instances/:id/proxy/*` — OpenAI-compatible reverse proxy to the instance

### Manifest

- `GET /v1/manifest/ready` — ready instances with routing policy and capacity fields (for load balancers / agents)

### Profiles

- `GET /v1/profiles` — list saved launch profiles
- `POST /v1/profiles` — create a profile
- `DELETE /v1/profiles/:id` — delete a profile

### Config library

- `GET /v1/instance-configs` — list saved configs
- `GET /v1/instance-configs/:id` — get one config
- `POST /v1/instance-configs/save-current` — snapshot running instances as a named config
- `POST /v1/instance-configs/:id/load` — launch all instances from a saved config
- `GET /v1/instance-configs/current/export.yaml` — export running instances as YAML
- `GET /v1/instance-configs/:id/export.yaml` — export a saved config as YAML
- `POST /v1/instance-configs/import.yaml` — import a config from YAML body
- `DELETE /v1/instance-configs/:id` — delete a saved config

### System

- `GET /v1/gpus` — GPU list via bridge
- `GET /v1/local-models` — scan `MODELS_DIR` for `.gguf` files
- `GET /v1/audit` — audit log

### Agent interface

- `GET /v1/agent/capabilities` — list available actions and schemas
- `POST /v1/agent/action` — execute an action by name

```json
{ "action": "instances.start", "input": { "profileId": "prof_qwen", "instanceId": "inst_1" } }
```

Available actions: `manifest.ready`, `profiles.list`, `instances.list`, `instances.start`, `instances.stop`, `instances.kill`, `instances.drain`, `instances.switchModel`, `instances.logs`, `instances.connection`

### Admin (require server API token)

- `GET /PUT /v1/settings/security` — read/write security settings
- `GET /v1/users` — list local users
- `POST /v1/users` — create a local user
- `DELETE /v1/users/:username` — delete a user
- `GET /v1/config/export.yaml` — export full server config as YAML
- `POST /v1/config/import.yaml` — import full server config from YAML (`?dryRun=true` supported)
- `GET /v1/config/status` — config sync status and current hash
- `GET /v1/system/gpus` — GPU list via bridge (admin-gated)
- `POST /v1/system/close` — graceful shutdown
