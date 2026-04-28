/**
 * lf-config-library.js — Light DOM custom element <lf-config-library>
 * Owns: config library section HTML, save/load/delete/export/import handlers.
 */
import { api, settings } from '../api.js';
import { store } from '../store.js';
import { setOperationPending } from './lf-launch-form.js';
import { downloadTextFile } from './utils.js';

const $ = (id) => document.getElementById(id);

function toast(msg) {
  $('toast')?.notify(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function refreshConfigLibrary() {
  try {
    const { data = [] } = await api("/v1/instance-configs");
    const select = $("savedConfigSelect");
    const previous = select.value;
    select.innerHTML = data.length === 0
      ? '<option value="">-- No saved configs --</option>'
      : '<option value="">-- Select saved config --</option>';

    for (const cfg of data) {
      const option = document.createElement("option");
      option.value = cfg.id;
      option.textContent = `${cfg.name} (${cfg.instanceCount} instances)`;
      select.appendChild(option);
    }

    if (previous && Array.from(select.options).some((opt) => opt.value === previous)) {
      select.value = previous;
    }

    $("configLibraryResult").textContent = data.length === 0
      ? "No saved configs yet. Save current instances to create one."
      : `Saved configs: ${data.length}`;
  } catch (error) {
    $("configLibraryResult").textContent = `Config list unavailable: ${error.message}`;
  }
}

class LfConfigLibrary extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
<section class="card span-12">
  <h2>Config Library</h2>
  <p class="card-subtitle">Save current instance settings as named configs, load a saved config, or export YAML.</p>
  <div class="launch-grid">
    <label class="launch-field launch-field-span-2">
      Config Name
      <input id="configName" class="launch-input" placeholder="e.g. Qwen 2x Mix" />
    </label>
    <label class="launch-field launch-field-span-2">
      Saved Configs
      <select id="savedConfigSelect" class="launch-input">
        <option value="">-- No saved configs --</option>
      </select>
    </label>
    <div class="launch-actions-row config-actions-row">
      <button id="saveCurrentConfig">Save Current</button>
      <button id="loadSelectedConfig">Load Selected</button>
      <button id="deleteSelectedConfig" class="kill">Delete Selected</button>
      <button id="exportSelectedConfig">Download YAML</button>
      <button id="importConfigYaml" class="copy">Import YAML</button>
      <input type="file" id="importConfigYamlFile" accept=".yaml,.yml,application/yaml,text/plain" style="display:none" />
    </div>
  </div>
  <pre id="configLibraryResult"></pre>
</section>`;

    this._wireEvents();
    refreshConfigLibrary();
  }

  _wireEvents() {
    $("saveCurrentConfig").onclick = async () => {
      try {
        const name = $("configName").value.trim() || `Config ${new Date().toLocaleString()}`;
        const payload = await api("/v1/instance-configs/save-current", {
          method: "POST",
          body: JSON.stringify({ name })
        });
        $("configLibraryResult").textContent = JSON.stringify(payload, null, 2);
        toast("Current config saved");
        await refreshConfigLibrary();
        $("savedConfigSelect").value = payload.id;
      } catch (error) {
        toast(`Save config failed: ${error.message}`);
      }
    };

    $("loadSelectedConfig").onclick = async () => {
      try {
        const id = $("savedConfigSelect").value;
        if (!id) { toast("Select a saved config first"); return; }

        const cfgSelect = $("savedConfigSelect");
        const cfgName = cfgSelect.options[cfgSelect.selectedIndex]?.textContent || id;
        const loadPoll = setInterval(() => { void store.refresh('instances').catch(() => {}); }, 1000);
        setOperationPending({ type: "config-load", name: cfgName, startedAt: Date.now() });

        let payload;
        try {
          payload = await api(`/v1/instance-configs/${id}/load`, {
            method: "POST",
            body: JSON.stringify({ replaceExisting: true })
          });
        } finally {
          clearInterval(loadPoll);
          setOperationPending(null);
        }

        $("configLibraryResult").textContent = JSON.stringify(payload, null, 2);
        toast(`Loaded config: started ${payload.started?.length || 0}, failed ${payload.failed?.length || 0}`);
        await store.refresh('instances');
      } catch (error) {
        toast(`Load config failed: ${error.message}`);
      }
    };

    $("deleteSelectedConfig").onclick = async () => {
      try {
        const id = $("savedConfigSelect").value;
        if (!id) { toast("Select a saved config first"); return; }
        await api(`/v1/instance-configs/${id}`, { method: "DELETE" });
        toast("Config deleted");
        await refreshConfigLibrary();
      } catch (error) {
        toast(`Delete config failed: ${error.message}`);
      }
    };

    $("exportSelectedConfig").onclick = async () => {
      try {
        const id = $("savedConfigSelect").value;
        if (!id) { toast("Select a saved config first"); return; }
        const response = await fetch(`${settings.apiBase}/v1/instance-configs/${id}/export.yaml`, {
          headers: { authorization: `Bearer ${settings.token}` }
        });
        const text = await response.text();
        if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
        downloadTextFile(`instance-config-${id}.yaml`, text);
        toast("Config YAML downloaded");
      } catch (error) {
        toast(`Download failed: ${error.message}`);
      }
    };

    $("importConfigYaml").onclick = () => { $("importConfigYamlFile").click(); };

    $("importConfigYamlFile").onchange = async () => {
      const file = $("importConfigYamlFile").files?.[0];
      if (!file) return;
      $("importConfigYamlFile").value = "";
      try {
        const text = await file.text();
        const response = await fetch(`${settings.apiBase}/v1/instance-configs/import.yaml`, {
          method: "POST",
          headers: {
            "Content-Type": "application/yaml",
            ...(settings.token ? { authorization: `Bearer ${settings.token}` } : {})
          },
          body: text
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
        toast(`Imported config: ${data.name}`);
        await refreshConfigLibrary();
      } catch (error) {
        toast(`Import failed: ${error.message}`);
      }
    };
  }
}

customElements.define('lf-config-library', LfConfigLibrary);
