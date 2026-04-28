// lf-state-chip — leaf Web Component (Shadow DOM)
// Usage: <lf-state-chip state="running">running</lf-state-chip>
// The text content is projected via <slot>; dot colour is driven by [state] attr + CSS.

const sheet = new CSSStyleSheet();
sheet.replaceSync(`
  :host {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: rgba(107, 122, 154, 0.55);
  }
  :host([state="running"]) .dot {
    background: #4cdb8e;
    box-shadow: 0 0 5px rgba(76, 219, 142, 0.5);
  }
  :host([state="unhealthy"]) .dot {
    background: #ff5c7a;
    box-shadow: 0 0 5px rgba(255, 92, 122, 0.45);
  }
  :host([state="stopped"]) .dot {
    background: rgba(107, 122, 154, 0.38);
  }
  :host([state="starting"]) .dot,
  :host([state="warming"]) .dot,
  :host([state="switching_model"]) .dot {
    background: var(--accent-2);
    animation: pulse 1.2s infinite;
  }
  :host([state="draining"]) .dot {
    background: #f5a623;
    box-shadow: 0 0 5px rgba(245, 166, 35, 0.45);
    animation: pulse-amber 1.4s infinite;
  }
  @keyframes pulse {
    0%   { box-shadow: 0 0 0 0   rgba(125, 248, 221, 0.6); }
    80%  { box-shadow: 0 0 0 8px rgba(125, 248, 221, 0); }
    100% { box-shadow: 0 0 0 0   rgba(125, 248, 221, 0); }
  }
  @keyframes pulse-amber {
    0%   { box-shadow: 0 0 0 0   rgba(245, 166, 35, 0.6); }
    80%  { box-shadow: 0 0 0 8px rgba(245, 166, 35, 0); }
    100% { box-shadow: 0 0 0 0   rgba(245, 166, 35, 0); }
  }
`);

class LfStateChip extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = '<span class="dot"></span><slot></slot>';
  }
}

customElements.define('lf-state-chip', LfStateChip);
