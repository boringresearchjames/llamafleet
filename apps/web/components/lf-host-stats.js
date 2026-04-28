/**
 * lf-host-stats — Light DOM panel component.
 * Subscribes to store 'hostStats' and renders the host stats strip bar.
 */
import { store } from '../store.js';

class LfHostStats extends HTMLElement {
  connectedCallback() {
    const data = store.get('hostStats');
    if (data) this.#render(data);

    store.subscribe('hostStats', (data) => this.#render(data));

    store.addEventListener('hostStatsError', () => {
      if (this.querySelector('.host-stats-loading')) {
        this.innerHTML = '<span class="host-stats-loading">Host stats unavailable</span>';
      }
    });
  }

  #render(data) {
    const memPct = data.mem_total_mib > 0
      ? Math.round((data.mem_used_mib / data.mem_total_mib) * 100)
      : 0;
    const memUsedGib  = (data.mem_used_mib  / 1024).toFixed(1);
    const memTotalGib = (data.mem_total_mib / 1024).toFixed(1);
    const memColor = memPct >= 90 ? 'var(--danger)' : memPct >= 70 ? '#ffbe5c' : 'var(--accent-2)';

    const cpuPct = data.cpu_utilization_percent ?? 0;
    const cpuColor = cpuPct >= 90 ? 'var(--danger)' : cpuPct >= 60 ? '#ffbe5c' : 'var(--accent)';
    const load1 = data.loadavg ? data.loadavg[0].toFixed(2) : '\u2014';

    const coreSquares = Array.isArray(data.cpu_per_core) && data.cpu_per_core.length > 0
      ? data.cpu_per_core.map((pct) => {
          const c = pct >= 80 ? 'var(--danger)' : pct >= 40 ? '#ffbe5c' : pct >= 10 ? 'var(--accent)' : 'rgba(159,176,216,0.18)';
          return `<span class="hs-core-sq" style="background:${c}" title="${pct}%"></span>`;
        }).join('')
      : '';

    this.innerHTML = `
    <div class="host-strip-stat">
      <span class="hs-label">RAM</span>
      <div class="hs-bar-wrap"><div class="hs-bar-fill" style="width:${memPct}%;background:${memColor}"></div></div>
      <span class="hs-value">${memUsedGib}/${memTotalGib}&thinsp;GiB</span>
    </div>
    <div class="host-strip-stat">
      <span class="hs-label">CPU</span>
      <div class="hs-bar-wrap"><div class="hs-bar-fill" style="width:${cpuPct}%;background:${cpuColor}"></div></div>
      <span class="hs-value">${cpuPct}%</span>
      <span class="hs-muted">load&thinsp;${load1}</span>
    </div>
    ${coreSquares ? `<div class="hs-cores">${coreSquares}</div>` : ''}`;
  }
}

customElements.define('lf-host-stats', LfHostStats);
