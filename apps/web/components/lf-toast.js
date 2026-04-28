// lf-toast — leaf Web Component (Shadow DOM)
// Usage: <lf-toast id="toast"></lf-toast>
// JS: document.getElementById('toast').notify('message text')

const sheet = new CSSStyleSheet();
sheet.replaceSync(`
  :host {
    position: fixed;
    left: 20px;
    bottom: 20px;
    z-index: 999;
    display: block;
    max-width: min(560px, calc(100vw - 40px));
    min-height: 18px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid rgba(125, 248, 221, 0.35);
    background: rgba(5, 11, 22, 0.92);
    color: #d8fff7;
    box-shadow: var(--shadow);
    backdrop-filter: blur(10px);
    font-family: "JetBrains Mono", Consolas, monospace;
    font-size: 12px;
    white-space: pre-wrap;
  }
`);

class LfToast extends HTMLElement {
  #text;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [sheet];
    this.#text = document.createElement('span');
    root.appendChild(this.#text);
  }

  notify(msg) {
    this.#text.textContent = msg;
  }
}

customElements.define('lf-toast', LfToast);
