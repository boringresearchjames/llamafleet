# Changelog

## [0.6.0] — 2026-05-02

### Added
- **llama.cpp update check** — API fetches the latest llama.cpp release tag on startup and shows an update badge on the About page when a newer build is available.
- **GPU VRAM bar in instances footer** — aggregate used/total VRAM bar (with colour thresholds) added alongside CPU and RAM in the instances table footer; updates live as GPU state changes.
- **GPU count and total VRAM bar in host stats strip** — compact GPU count and aggregate VRAM bar in the host stats strip above the instances table.

### Fixed
- **GGUF tokenizer buffer exhaustion** — large models (Qwen3, Llama3 70B+) embed 150K+ tokenizer strings in GGUF metadata, exhausting the 2 MB read buffer before model parameter fields were reached. Fixed by returning early once all required fields are found and catching `RangeError` mid-array to preserve partial results.
- **llama.cpp build tag display** — surfaces the real build tag from `llama-server` stderr (`b760272`, `b1-b760272` etc.) instead of showing version `1`. Seeds from existing log files at startup so the tag is correct before the first inference request.
- **Update badge for non-standard build tags** — custom/self-compiled builds (e.g. `b1-b760272`) now always show the latest release badge rather than silently failing the version comparison.
- **Port-in-use error reporting** — `llama-server` bind failures (`couldn't bind HTTP server socket`) are now captured and surfaced as a human-readable `lastError` on the instance.
- **Unhealthy instance restart** — bridge no longer returns 409 when restarting an instance in `unhealthy` state.
- **Model list accuracy** — partial downloads, mmproj sidecars, and multi-shard naming corrections in the local model scanner.
- **Host stats render ordering** — `gpuHardware` data is now fetched before the first render to avoid a blank GPU bar on initial load.

### Tests
- Expanded test suite from 44 → 69 tests across 4 files: `system/info`, `local-models`, `settings` (security + config import/export), and full `instance-configs` CRUD.

### Docs
- Binary download table updated to reflect current llama.cpp release asset names (Linux CUDA requires building from source; no pre-built Ubuntu CUDA packages in recent releases).
- Screenshots refreshed to show GPU VRAM footer, active instances, routing map, and live download.

---

## [0.5.0] — 2026-04-30

### Added
- **Local Models management** — `DELETE /local-models` endpoint to delete `.gguf` files from any scanned directory (primary models dir, Ollama, HuggingFace cache, Unsloth, and external drives). Requires admin token; validates paths against allowed roots to prevent traversal. Associated `.part` and `.part.meta.json` sidecars cleaned up automatically.
- **Local Models section in Hub UI** — list, pin, and delete local models directly from the Hub page; pinned models persist across reloads.
- **Multi-part download grouping** — files sharing a common base name in the repository file list are now grouped with a single "Download All N" button.
- **Subdirectory-prefixed filenames** — downloads now support filenames with repository subdirectory segments (e.g. `UD-Q4_K_M/Model-00001-of-00004.gguf`); each path segment is individually percent-encoded for the HuggingFace URL while the bare filename is used for local storage.
- **`install-systemd.sh` ACL grants** — installer now runs `grant_extra_scan_dirs()` to grant the `llamafleet` service account rwx on Ollama, HuggingFace, Unsloth, and `/media/<user>/*` mount directories at install time.

### Fixed
- Systemd service sandbox directives (`ProtectSystem`, `ProtectHome`, `PrivateTmp`, `ReadWritePaths`) removed — caused `226/NAMESPACE` startup failures when the working directory is not under a standard system path.
- Regex typo in HuggingFace download path-traversal check (`(?\/|$)` → `(?:\/|$)`) that caused a `SyntaxError: Invalid regular expression` on API startup.
- Resume/restore (`restorePartialDownloads`) now persists and restores `hfFilePath` from `.part.meta.json` sidecar so subdirectory-prefixed downloads resume against the correct HF URL.

---

## [0.4.0] — 2026-04-27

### Added
- **Model Browser** — browse and download GGUF models directly from Hugging Face: search, quant guide, resumable downloads with pause/resume/discard, favorites pinned for one-click launch, and local library scan.
- **Host stats bar** — CPU, RAM, and per-core utilisation bars in the instances table footer with compact utilisation squares and rounded corners.
- **Per-instance `headersTimeoutMs`** — configurable headers timeout exposed in the launch form Advanced section; prevents proxy stalls on slow inference starts.
- **Model dropdown source groups** — models grouped by origin (Local / Ollama / HuggingFace / Unsloth) with file sizes shown alongside each entry.
- **Unload All button** (⏏) — stops all running instances while keeping the service up; one-click fleet drain from the dashboard.
- **Footer** with llama emoji.
- **Vitest integration test suite** — high-level API tests covering instance lifecycle and routing.
- **`Why LlamaFleet?` README section** — comparison table against Ollama and LM Studio.
- **SECURITY.md** — deployment guidance for network hardening, token generation, and reverse-proxy setup.

### Changed
- Full frontend refactor into ES modules and Web Components (Phases 3–5): `lf-state-chip`, `lf-activity-chip`, `lf-toast`, `lf-host-stats`, `lf-routing-map`.
- `apps/api/src/index.js` split into `lib/` + `routes/` modules for maintainability.
- CPU-only instances now display a **CPU** label instead of GPU in the routing map and pool.
- Removed `--flash-attn` and `--mlock` from default server args (incompatible with V100 and pre-Ampere hardware).
- Dashboard section renamed to "In App Screenshots" with full-page screenshots added to README.

### Fixed
- 6 security audit findings: timing side-channels, session handling, proxy timeout, and body-size limits.
- XSS in Model Hub `onclick` handlers; state file writes are now atomic.
- Proxy headers timeout now emits a structured log and returns a proper 504 instead of dropping the connection; stale-ref finalise race fixed.
- Download reliability: cancel, pause/resume via `Promise.race` abort, flush on cancel, stale paused/error job eviction on resume, duplicate row prevention.
- LFS file size display, download rate, and ETA shown correctly.
- `display:contents` on Web Component wrappers restores CSS grid layout.
- `signal.aborted` checked after read loop before rename to prevent false completion on pause.
- `inflightRequests` counter preserved through bridge polling cycles (previously reset to 0 on every poll).
- Single-quote escaping in `onclick` handlers throughout Model Hub.

---

## [0.3.0] — 2026-04-26

### Added
- **Named model routing with round-robin pool support** — `POST /v1/chat/completions` now automatically distributes load across all running instances of the same model. Start multiple instances of the same GGUF and they form a pool; requests cycle across GPUs in round-robin order with no client-side changes required.
- **`GET /v1/models` pool + individual entries** — returns both a pool entry (for round-robin) and per-instance pinned aliases (`ModelName-1`, `-2`, `-3`, …) so any OpenAI-compatible client can discover and target specific GPUs via standard model selection.
- **Virtual `-1` alias for base pool member** — the first instance in a pool (whose route name has no numeric suffix) is addressable as `ModelName-1`, both in the API and shown in the dashboard, so all members are consistently pinnable.
- **Model Routing dashboard section** — visual overview between Instances and Config Library showing each model as either a round-robin pool (⇄) or a direct solo route (→), with per-instance GPU labels, pinned model names, and one-click copy buttons.

### Changed
- `GET /v1/models` response now includes `pool: true` entries alongside individual pinned-name entries (previously only returned raw instance names).
- Instance table "Copy Model ID" button now copies the `-1`-suffixed name for base pool members instead of the bare route name.
- Routing map copy buttons redesigned: pill-style "COPY" label, no clipboard emoji, consistent with dashboard aesthetic.

### Fixed
- Round-robin counter (`modelRoundRobinCounters`) correctly cycles across all active same-model instances.
- `usedNames` uniqueness check during start/restart now scans all instances (not just active), preventing duplicate route name collisions.

---

## [0.2.1] — 2026-04-24

### Added
- `GET /v1/local-models` scans Ollama, HuggingFace hub, and Unsloth Studio model directories in addition to the primary `MODELS_DIR`.
- Auto-install script (`scripts/install-llama-server.sh`) detects GPU type (NVIDIA/AMD ROCm/Vulkan/CPU) and downloads the correct `llama-server` binary from llama.cpp releases.
- GitHub Actions release pipeline (`build-release.sh`, `.github/workflows/release.yml`) with `curl` one-liner install.
- Systemd deployment runbook (`deploy/systemd/README.md`) and env template (`llamafleet.env.example`).
- Bridge router app (`apps/bridge-router`) for multi-host deployments.
- Llama emoji favicon.

### Fixed
- `CUDA_DEVICE_ORDER=PCI_BUS_ID` set on all spawned `llama-server` processes to ensure GPU index matches `nvidia-smi` PCI bus order.

---

## [0.2.0] — 2026-04-23

### Added
- Wake/restart button in the instance table (⚡) — restarts a stopped or crashed instance with its existing config.
- Prometheus metrics endpoint (`GET /metrics`) with per-instance and per-GPU telemetry.
- Smoke check support (`SMOKE_CHECK_ENABLED`, `STRICT_SMOKE_CHECK`) — optional test inference after startup.
- Per-instance log viewer with auto-tail mode and clone-setup action.
- Config profiles — save, load, delete, import/export YAML instance configurations.

---

## [0.1.0] — 2026-04-20

### Initial release
- Multi-instance `llama-server` lifecycle management (start, stop, drain, kill, remove) from a browser dashboard.
- Per-instance GPU pinning via `CUDA_VISIBLE_DEVICES` and AMD/Intel/Metal equivalents.
- OpenAI-compatible reverse proxy per instance (`/v1/instances/<id>/proxy/v1/...`).
- Top-level `/v1/chat/completions` routing by model name.
- Auto-restart with configurable backoff on unclean exits.
- 30-second health polling with auto-restart on unhealthy instances.
- Global bearer token auth for dashboard and all proxy traffic.
- VRAM bar visualisation with utilisation %, temperature, and power per GPU.
