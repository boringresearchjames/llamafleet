# LlamaFleet — Ubuntu 24.04 systemd deployment

One systemd unit runs everything. The bridge spawns one `llama-server` child process per instance, each pinned to its assigned GPUs via `CUDA_VISIBLE_DEVICES`.

## How it works

- `llamafleet.service` starts `run-native.mjs` which launches the API (port 8081) and bridge (port 8090) as child processes under a single `llamafleet` system user.
- When you start an instance from the dashboard, the bridge spawns a dedicated `llama-server` process for it with the exact GPU IDs you selected set in all CUDA/ROCm/Vulkan visibility env vars.
- Stopping/removing an instance sends SIGTERM to that process only.

## Install

```bash
# From the repo root on your Ubuntu host:
sudo bash scripts/install-ubuntu-systemd.sh
```

The installer:
1. Creates a `llamafleet` system user
2. Installs `deploy/systemd/llamafleet.service` to `/etc/systemd/system/`
3. Writes a starter env file to `/etc/llamafleet/llamafleet.env` (if not already present)
4. Enables and starts the service
5. Adds a `LlamaFleet` desktop launcher for the invoking sudo user (if a Desktop directory exists)

## Manual install (no script)

```bash
sudo useradd -r -m -d /var/lib/llamafleet/llamafleet -s /usr/sbin/nologin llamafleet
sudo install -d -m 0755 /etc/llamafleet
sudo install -d -m 0750 -o llamafleet -g llamafleet /var/lib/llamafleet/api
sudo install -m 0644 deploy/systemd/llamafleet.service /etc/systemd/system/llamafleet.service
sudo install -m 0640 deploy/systemd/env/llamafleet.env.example /etc/llamafleet/llamafleet.env
# Edit /etc/llamafleet/llamafleet.env before starting
sudo systemctl daemon-reload
sudo systemctl enable --now llamafleet
```

## Configure

Edit `/etc/llamafleet/llamafleet.env` — the important fields:

| Variable | Description |
|---|---|
| `API_AUTH_TOKEN` | Bearer token for the dashboard/API (required) |
| `BRIDGE_AUTH_TOKEN` | Internal API↔bridge token (required, set both the same) |
| `LLAMA_SERVER_BIN` | Full path to your `llama-server` binary |
| `LLAMAFLEET_PUBLIC_HOST` | This machine's IP, used in proxy URLs shown in the dashboard |
| `DATA_ROOT` | Where bridge logs and instance metadata are stored |

Then restart:

```bash
sudo systemctl restart llamafleet
```

## Verify

```bash
systemctl status llamafleet
journalctl -u llamafleet -n 100 --no-pager
```

Open `http://<host>:8081` in a browser.
