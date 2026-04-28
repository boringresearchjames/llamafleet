/**
 * lf-routing-map — Light DOM panel component.
 * Subscribes to store 'instances' and renders the Model Routing map.
 * Copy-button clicks bubble up to app.js initInstancesEventDelegation handler.
 */
import { store } from '../store.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

class LfRoutingMap extends HTMLElement {
  connectedCallback() {
    this.#render(store.get('instances') || []);
    store.subscribe('instances', (data) => this.#render(data));
  }

  #render(instances) {
    const active = (instances || []).filter(x => x.state !== 'stopped');
    if (active.length === 0) {
      this.innerHTML = '<div class="routing-empty">No active instances \u2014 start an instance to see the routing map.</div>';
      return;
    }

    // Group by base stem of modelRouteName
    const groups = new Map(); // baseStem -> [{ inst, routeName }]
    for (const inst of active) {
      const routeName = inst.modelRouteName || '';
      if (!routeName) continue;
      const baseStem = routeName.replace(/-\d+$/, '');
      if (!groups.has(baseStem)) groups.set(baseStem, []);
      groups.get(baseStem).push({ inst, routeName });
    }

    if (groups.size === 0) {
      this.innerHTML = '<div class="routing-empty">No route names configured \u2014 instances need a modelRouteName.</div>';
      return;
    }

    const html = [];
    for (const [baseStem, members] of groups) {
      html.push(this.#renderGroup(baseStem, members));
    }
    this.innerHTML = html.join('');
  }

  #renderGroup(baseStem, members) {
    const isPool = members.length > 1;

    if (isPool) {
      const instCards = members.map(({ inst, routeName }) => {
        const gpus = Array.isArray(inst.gpus) ? inst.gpus.join(', ') : '-';
        const state = String(inst.state || 'unknown').toLowerCase();
        const isBase = routeName === baseStem;
        const pinnedName = isBase ? `${baseStem}-1` : routeName;
        const pinSection = `<div class="route-inst-pin"><code class="route-inst-pin-name" title="Pin to this GPU: ${escapeHtml(pinnedName)}">${escapeHtml(pinnedName)}</code><button class="icon-btn route-copy-mini" data-route-copy="${escapeHtml(pinnedName)}" title="Copy pinned name to always target this GPU">&#x2398;</button></div>`;
        return `<div class="route-inst-card">
          <div class="route-inst-card-top">
            <span class="state-dot state-${state}"></span>
            <span class="route-inst-gpu-label">GPU ${escapeHtml(gpus)}</span>
          </div>
          <div class="route-inst-profile-name">${escapeHtml(inst.profileName || inst.id.slice(0, 8))}</div>
          ${pinSection}
        </div>`;
      }).join('');

      return `<div class="route-group route-group-pool">
        <div class="route-group-header">
          <span class="route-group-icon route-icon-pool" title="Round-robin pool: each request cycles to the next available instance">&#x21C4;</span>
          <span class="route-group-name">${escapeHtml(baseStem)}</span>
          <span class="route-group-badge">round-robin &middot; ${members.length} instances</span>
          <button class="route-copy-btn" data-route-copy="${escapeHtml(baseStem)}" title="Copy model name">Copy</button>
        </div>
        <div class="route-group-tip">
          &#x1F4A1; Send <code>${escapeHtml(baseStem)}</code> as the model name to automatically spread load across all ${members.length} GPUs.
          To always target a specific GPU, copy the pinned name shown on each card below.
        </div>
        <div class="route-inst-row">${instCards}</div>
      </div>`;
    } else {
      const { inst, routeName } = members[0];
      const gpus = Array.isArray(inst.gpus) ? inst.gpus.join(', ') : '-';
      const state = String(inst.state || 'unknown').toLowerCase();
      return `<div class="route-group route-group-solo">
        <div class="route-group-header">
          <span class="route-group-icon route-icon-solo" title="Direct routing: all requests go to this single instance">&#x2192;</span>
          <span class="route-group-name">${escapeHtml(routeName)}</span>
          <span class="route-group-badge route-group-badge-solo">direct &middot; GPU ${escapeHtml(gpus)}</span>
          <button class="route-copy-btn" data-route-copy="${escapeHtml(routeName)}" title="Copy model name">Copy</button>
        </div>
        <div class="route-inst-row">
          <div class="route-inst-card">
            <div class="route-inst-card-top">
              <span class="state-dot state-${state}"></span>
              <span class="route-inst-gpu-label">GPU ${escapeHtml(gpus)}</span>
            </div>
            <div class="route-inst-profile-name">${escapeHtml(inst.profileName || inst.id.slice(0, 8))}</div>
          </div>
        </div>
      </div>`;
    }
  }
}

customElements.define('lf-routing-map', LfRoutingMap);
