// tokentracker web components. One script tag, then:
//   <token-heatmap handle="you"></token-heatmap>
//   <token-total handle="you"></token-total>
// Style with CSS variables (--tt-cell-0 … --tt-cell-4, --tt-gap, --tt-radius,
// --tt-font, --tt-text, --tt-muted) or ::part(cell|months|legend|total).
import { formatTokens, getHeatmap } from './lib/heatmap.js';

const ORIGIN = new URL(import.meta.url).origin;
const cache = new Map();

function load(el) {
  const handle = el.getAttribute('handle');
  const opts = {
    origin: el.getAttribute('origin') || ORIGIN,
    range: el.getAttribute('range') || 'year',
    tools: el.getAttribute('tools')?.split(',').filter(Boolean) || null,
    weekStart: el.getAttribute('week-start') === 'mon' ? 'mon' : 'sun',
  };
  const key = JSON.stringify([handle, opts]);
  if (!cache.has(key)) cache.set(key, getHeatmap(handle, opts));
  return cache.get(key);
}

const BASE = `
  :host {
    --tt-cell-0: #ebedf0; --tt-cell-1: #cfe0ff; --tt-cell-2: #9dbffc; --tt-cell-3: #5b8ef0; --tt-cell-4: #1d4ed8;
    --tt-gap: 3px; --tt-radius: 0px; --tt-text: currentColor; --tt-muted: #6b6f7a;
    --tt-font: ui-monospace, 'SF Mono', Menlo, monospace;
    display: block; font-family: var(--tt-font); color: var(--tt-text);
  }
  @media (prefers-color-scheme: dark) {
    :host { --tt-cell-0: #23252b; --tt-cell-1: #1e3a6e; --tt-cell-2: #2b5cb0; --tt-cell-3: #4d82e0; --tt-cell-4: #6b9eff; --tt-muted: #8b8e97; }
  }
  :host([theme="light"]) { --tt-cell-0: #ebedf0; --tt-cell-1: #cfe0ff; --tt-cell-2: #9dbffc; --tt-cell-3: #5b8ef0; --tt-cell-4: #1d4ed8; --tt-muted: #6b6f7a; }
  :host([theme="dark"]) { --tt-cell-0: #23252b; --tt-cell-1: #1e3a6e; --tt-cell-2: #2b5cb0; --tt-cell-3: #4d82e0; --tt-cell-4: #6b9eff; --tt-muted: #8b8e97; }
`;

class TokenHeatmap extends HTMLElement {
  static observedAttributes = ['handle', 'range', 'tools', 'week-start', 'hide'];

  connectedCallback() {
    this.attachShadow?.({ mode: 'open' });
    this.render();
  }

  attributeChangedCallback() {
    if (this.shadowRoot) this.render();
  }

  async render() {
    const root = this.shadowRoot;
    const hide = new Set((this.getAttribute('hide') || '').split(','));
    try {
      const hm = await load(this);
      const weeks = hm.weeks.length;
      const levels = ['0', '1', '2', '3', '4'];
      root.innerHTML = `<style>${BASE}
        .months { display: grid; grid-template-columns: repeat(${weeks}, 1fr); gap: var(--tt-gap); font-size: 10px; color: var(--tt-muted); margin-bottom: 4px; }
        .grid { display: grid; grid-template-columns: repeat(${weeks}, 1fr); grid-template-rows: repeat(7, auto); grid-auto-flow: column; gap: var(--tt-gap); }
        .cell { aspect-ratio: 1; border-radius: var(--tt-radius); background: var(--tt-cell-0); }
        .cell.out { background: transparent; }
        ${levels.map((l) => `.l${l} { background: var(--tt-cell-${l}); }`).join('\n')}
        .cell:not(.out):hover { outline: 1px solid var(--tt-text); }
        .legend { display: flex; justify-content: flex-end; align-items: center; gap: var(--tt-gap); margin-top: 8px; font-size: 10px; color: var(--tt-muted); }
        .legend .cell { width: 10px; }
      </style>
      ${hide.has('months') ? '' : `<div class="months" part="months">${hm.months.map((m) => `<span style="grid-column:${m.week + 1}">${m.label}</span>`).join('')}</div>`}
      <div class="grid" part="grid">${hm.weeks.flatMap((w) => w.map((d) => (d
        ? `<span class="cell l${d.level}" part="cell level-${d.level}" title="${d.date}${d.future ? '' : ` · ${formatTokens(d.count)}`}"></span>`
        : '<span class="cell out"></span>'))).join('')}</div>
      ${hide.has('legend') ? '' : `<div class="legend" part="legend">less ${levels.map((l) => `<span class="cell l${l}"></span>`).join('')} more</div>`}`;
      this.dispatchEvent(new CustomEvent('tokentracker:load', { detail: hm }));
    } catch (err) {
      root.innerHTML = `<style>${BASE}</style><span style="color:var(--tt-muted);font-size:12px">${err.message}</span>`;
    }
  }
}

class TokenTotal extends HTMLElement {
  static observedAttributes = ['handle', 'range', 'tools', 'format'];

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  // Renders as plain inline text so it inherits the surrounding typography
  async render() {
    try {
      const hm = await load(this);
      this.textContent = this.getAttribute('format') === 'exact' ? hm.total.toLocaleString() : formatTokens(hm.total);
    } catch {
      this.textContent = '—';
    }
  }
}

if (!customElements.get('token-heatmap')) customElements.define('token-heatmap', TokenHeatmap);
if (!customElements.get('token-total')) customElements.define('token-total', TokenTotal);
