# Security

## Architecture and threat model

LlamaFleet is a **single-tenant control plane** intended for use on trusted local networks — homelabs, air-gapped workstations, and private GPU servers. It is not designed or hardened for direct public internet exposure.

One bearer token (`API_AUTH_TOKEN`) gates the entire dashboard and API. There is no per-user auth, per-instance isolation, or multi-tenant access control. Anyone who holds the token, or who can reach the API port on an unprotected network, has full control over every instance and model.

---

## Frontier API key storage

If you configure frontier backends (Copilot, OpenRouter, or any OpenAI-compatible API), their API keys are **stored in plaintext** inside `state.json` (default: `apps/api/data/state.json`).

**What is protected:**
- The browser and API clients never receive the real key. Every API response replaces it with `"••••"`. The key is read server-side only and injected directly into outgoing `Authorization` headers.

**What is not protected:**
- The key is plaintext on disk. Anyone with read access to `state.json` can extract it.
- Backups, `git status` accidents, or log captures of the file will include the key in plaintext.

**Recommended mitigations:**

```bash
# Restrict state.json to the service user only (run as the user owning the process)
chmod 600 apps/api/data/state.json
# Or if deployed via systemd under a dedicated user:
chmod 600 /home/<serviceuser>/llamafleet/data/api/state.json
```

- Add `data/` to `.gitignore` if you version-control your config. It is already listed there by default.
- Use a scoped API key with the minimum required permissions from your frontier provider (e.g. an OpenRouter key with a spend limit, not your primary Copilot token).
- Rotate the key in the Frontier Backends UI if you suspect exposure — LlamaFleet preserves the old key if the field is left blank on edit, so you must actively supply a new value to rotate it.

**Preferred: keep the key off disk entirely using an env var reference.**
In the API Key field, enter `$MY_VAR_NAME` instead of the real key. LlamaFleet resolves it from `process.env` at request time — `state.json` stores only the variable name, never the secret:

```bash
# In your environment file (e.g. /etc/llamafleet/llamafleet.env)
OPENROUTER_KEY=sk-or-...
COPILOT_TOKEN=...
```

Then set the API Key field to `$OPENROUTER_KEY`. This is the same pattern used for `API_AUTH_TOKEN` and `BRIDGE_AUTH_TOKEN`.

---

## Recommended deployment

**Minimum baseline:**
- Set `API_AUTH_TOKEN` and `BRIDGE_AUTH_TOKEN` to independent 32+ character random hex strings. Without these, the API is open to every device on the network.
  ```bash
  openssl rand -hex 32   # run twice, once per token
  ```
- Keep port `8090` (host bridge) bound to `127.0.0.1` — it has no auth. It should never be reachable from other machines.
- Keep port `8081` (API + dashboard) restricted to your LAN interface. Do not bind it to `0.0.0.0` if the host is internet-reachable.

**If you need remote access:**
- Put a TLS-terminating reverse proxy (nginx, Caddy, Traefik) in front of port `8081`. LlamaFleet serves plain HTTP.
- Restrict access with IP allowlisting at the proxy or firewall level.
- Do not expose port `8090` through the proxy under any circumstances.

**Firewall rule summary:**

| Port | Accessible from | Notes |
|------|----------------|-------|
| `8081` | LAN only (or behind reverse proxy) | Dashboard + API |
| `8090` | `127.0.0.1` only | Host bridge — no auth |

---

## Known limitations

- **No TLS** — use a reverse proxy for HTTPS.
- **No per-user or per-instance auth** — one global token for all operations.
- **No rate limiting** — handle at the proxy or firewall layer.
- **No audit log for API calls** — only instance lifecycle events (start, stop, restart) are recorded.
- **CORS defaults to `*`** — set `CORS_ORIGIN` to your specific origin if the dashboard is served over a network.
- **Frontier API keys stored in plaintext** — `state.json` contains API keys in cleartext. Protect the file with filesystem permissions and avoid including it in backups or version control. See the section above.

---

## Reporting vulnerabilities

There is no dedicated security email at this time. Please open a [GitHub Issue](https://github.com/boringresearchjames/llamafleet/issues) and mark it with the `security` label. For sensitive disclosures, use GitHub's private vulnerability reporting feature on the repository's Security tab.
