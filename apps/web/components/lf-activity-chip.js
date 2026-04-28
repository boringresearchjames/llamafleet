// lf-activity-chip — leaf Web Component (Shadow DOM)
// Usage: <lf-activity-chip inflight="1" max-inflight="4" queue="0" tokens="1234" last-active="2026-04-27T...">
// Re-renders shadow DOM on any observed attribute change.

const sheet = new CSSStyleSheet();
sheet.replaceSync(`
  :host {
    margin-top: 6px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid rgba(159, 176, 216, 0.24);
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 10px;
    font-family: "JetBrains Mono", Consolas, monospace;
    color: var(--muted);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: rgba(107, 122, 154, 0.6);
    flex-shrink: 0;
  }
  .count { color: #d8e6ff; font-weight: 700; }
  .queue { color: #ffc978; }
  .token { color: #ffe3a2; font-weight: 700; }
  .fresh { color: #9dd8ff; }

  :host([activity="processing"]) {
    border-color: rgba(76, 219, 142, 0.4);
    color: #b9f5d3;
  }
  :host([activity="processing"]) .dot {
    background: #4cdb8e;
    box-shadow: 0 0 0 0 rgba(76, 219, 142, 0.55);
    animation: pulse 1.2s infinite;
  }
  :host([activity="idle"]) {
    border-color: rgba(107, 122, 154, 0.3);
  }
  :host([activity="active"]) {
    border-color: rgba(98, 194, 255, 0.35);
    color: #b9eaff;
  }
  :host([activity="active"]) .dot {
    background: #62c2ff;
  }
  @keyframes pulse {
    0%   { box-shadow: 0 0 0 0 rgba(76, 219, 142, 0.55); }
    80%  { box-shadow: 0 0 0 7px rgba(76, 219, 142, 0); }
    100% { box-shadow: 0 0 0 0 rgba(76, 219, 142, 0); }
  }
`);

function fmt(value) {
  const n = Math.max(0, Number(value || 0));
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : "0";
}

class LfActivityChip extends HTMLElement {
  static observedAttributes = ['inflight', 'max-inflight', 'queue', 'tokens', 'last-active'];

  #root;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [sheet];
  }

  connectedCallback() { this.#render(); }
  attributeChangedCallback() { this.#render(); }

  #render() {
    const inflight    = Math.max(0, Number(this.getAttribute('inflight') || 0));
    const maxInflight = Math.max(1, Number(this.getAttribute('max-inflight') || 1));
    const queue       = Math.max(0, Number(this.getAttribute('queue') || 0));
    const tokens      = Math.max(0, Number(this.getAttribute('tokens') || 0));
    const lastActiveMs = Date.parse(this.getAttribute('last-active') || '');

    const isProcessing   = inflight > 0;
    const recentlyActive = !isProcessing
      && Number.isFinite(lastActiveMs)
      && (Date.now() - lastActiveMs) <= 45000;

    const activity   = isProcessing ? 'processing' : (recentlyActive ? 'active' : 'idle');
    const statusText = isProcessing ? 'Processing'  : (recentlyActive ? 'Active'  : 'Idle');
    const agoSec     = recentlyActive
      ? Math.max(1, Math.round((Date.now() - lastActiveMs) / 1000))
      : null;
    const tokenText  = tokens > 0 ? `tok:${fmt(tokens)}` : '';

    // Reflect computed state as attribute for :host([activity=...]) CSS
    this.setAttribute('activity', activity);

    this.#root.innerHTML = `
      <span class="dot"></span>
      <span>${statusText}</span>
      <span class="count">${inflight}/${maxInflight}</span>
      ${queue  > 0           ? `<span class="queue">q:${queue}</span>`     : ''}
      ${tokenText            ? `<span class="token">${tokenText}</span>`   : ''}
      ${agoSec !== null      ? `<span class="fresh">${agoSec}s</span>`     : ''}
    `;
  }
}

customElements.define('lf-activity-chip', LfActivityChip);
