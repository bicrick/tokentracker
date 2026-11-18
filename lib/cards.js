// SVG cards for embedding anywhere an image works (GitHub READMEs, sites,
// Notion). Pure string rendering on top of the headless heatmap library.
import { buildHeatmap, buildSeries, formatTokens, MONTHS } from '../public/lib/heatmap.js';

export const CARD_TYPES = ['heatmap', 'stats', 'badge', 'breakdown', 'line'];
export const CELL_STYLES = ['square', 'round', 'dot', 'dither'];

const THEMES = {
  dark: { bg: '#121317', text: '#ecece8', muted: '#8b8e97', rule: '#2a2c33', empty: '#23252b', accent: '#6b9eff' },
  light: { bg: '#ffffff', text: '#16181d', muted: '#6b6f7a', rule: '#e3e3e0', empty: '#edeef0', accent: '#1d4ed8' },
  gold: { bg: '#121317', text: '#ecece8', muted: '#8b8e97', rule: '#2a2c33', empty: '#23252b', accent: '#f0c463' },
};
const TOOL_COLORS = ['#6b9eff', '#f0c463', '#d97757', '#6fd39b', '#c58af9', '#4fd1c5', '#f687b3', '#a0aec0'];
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function hex(v, fallback) {
  if (!v || !HEX.test(v)) return fallback;
  let h = v.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return `#${h.toLowerCase()}`;
}

function mix(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** Parse and clamp card options from a query object. */
export function parseOptions(q = {}) {
  const base = THEMES[q.theme] || THEMES.dark;
  const transparent = q.bg === 'transparent' || q.theme === 'transparent';
  const theme = {
    ...base,
    bg: transparent ? 'none' : hex(q.bg, base.bg),
    text: hex(q.text, base.text),
    muted: hex(q.muted, base.muted),
    empty: hex(q.empty, base.empty),
    accent: hex(q.accent, base.accent),
  };
  const emptyBase = theme.empty;
  const ramp = [emptyBase, ...[0.28, 0.5, 0.75, 1].map((t) => mix(emptyBase, theme.accent, t))];
  const hide = new Set(String(q.hide || '').split(',').filter(Boolean));
  const tools = q.tools ? String(q.tools).split(',').filter((t) => /^[a-z0-9-]{1,30}$/.test(t)) : null;
  const range = /^(year|\d{1,3}d|365d|rolling|\d{4})$/.test(q.range || '') ? q.range : 'year';
  return {
    type: CARD_TYPES.includes(q.type) ? q.type : 'heatmap',
    cells: CELL_STYLES.includes(q.cells) ? q.cells : 'square',
    theme,
    ramp,
    hide,
    tools,
    range,
    label: String(q.label || 'AI tokens').slice(0, 40),
    weekStart: q.week === 'mon' ? 'mon' : 'sun',
    border: q.border !== '0' && !transparent,
  };
}

const FONT = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

function frame(w, h, opts, body) {
  const { theme, border } = opts;
  const bg = theme.bg === 'none' ? '' : `<rect width="${w}" height="${h}" fill="${theme.bg}"/>`;
  const edge = border ? `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="none" stroke="${theme.rule}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}" role="img">${bg}${edge}${body}</svg>`;
}

function header(hm, opts, x, w) {
  if (opts.hide.has('title')) return { svg: '', h: 0 };
  const { theme } = opts;
  const total = opts.hide.has('total') ? '' : `<text x="${x + w}" y="22" text-anchor="end" font-size="13" fill="${theme.text}" font-weight="600">${esc(formatTokens(hm.total))} tokens</text>`;
  return {
    svg: `<text x="${x}" y="22" font-size="13" fill="${theme.text}" font-weight="600">@${esc(hm.handle)}</text>${total}`,
    h: 34,
  };
}

function cell(x, y, s, level, opts) {
  const fill = opts.ramp[level];
  if (opts.cells === 'round') return `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * 0.25}" fill="${fill}"/>`;
  if (opts.cells === 'dot') return `<circle cx="${x + s / 2}" cy="${y + s / 2}" r="${s * 0.42}" fill="${fill}"/>`;
  if (opts.cells === 'dither') {
    // 4×4 ordered dither between the empty colour and this level's colour
    const p = s / 4;
    const t = level / (opts.ramp.length - 1);
    let out = `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${opts.ramp[0]}"/>`;
    if (level) {
      const on = opts.ramp[opts.ramp.length - 1];
      for (let i = 0; i < 16; i += 1) {
        if ((BAYER4[i] + 0.5) / 16 < t) out += `<rect x="${x + (i % 4) * p}" y="${y + Math.floor(i / 4) * p}" width="${p}" height="${p}" fill="${on}"/>`;
      }
    }
    return out;
  }
  return `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${fill}"/>`;
}

function heatmapCard(data, opts) {
  const hm = buildHeatmap(data, { range: opts.range, tools: opts.tools, weekStart: opts.weekStart });
  const s = 10;
  const gap = 3;
  const pad = 16;
  const gridW = hm.weeks.length * (s + gap) - gap;
  const w = gridW + pad * 2;
  const head = header(hm, opts, pad, gridW);
  const monthsH = opts.hide.has('months') ? 0 : 16;
  const legendH = opts.hide.has('legend') ? 0 : 22;
  const top = pad + head.h - (head.h ? 8 : 0);
  const h = top + monthsH + 7 * (s + gap) - gap + legendH + pad;

  let body = head.svg;
  if (monthsH) {
    for (const m of hm.months) {
      body += `<text x="${pad + m.week * (s + gap)}" y="${top + 10}" font-size="10" fill="${opts.theme.muted}">${m.label}</text>`;
    }
  }
  const gy = top + monthsH;
  hm.weeks.forEach((week, wi) => {
    week.forEach((d, di) => {
      if (!d) return;
      const tip = d.future ? d.date : `${d.date} · ${formatTokens(d.count)} tokens`;
      body += `<g class="tt-day"><title>${tip}</title>${cell(pad + wi * (s + gap), gy + di * (s + gap), s, d.level, opts)}</g>`;
    });
  });
  if (legendH) {
    const ly = gy + 7 * (s + gap) + 8;
    let lx = pad + gridW - (5 * (s + gap)) - 34;
    body += `<text x="${lx - 6}" y="${ly + 9}" font-size="10" text-anchor="end" fill="${opts.theme.muted}">less</text>`;
    for (let l = 0; l < 5; l += 1) {
      body += cell(lx, ly, s, l, opts);
      lx += s + gap;
    }
    body += `<text x="${lx + 3}" y="${ly + 9}" font-size="10" fill="${opts.theme.muted}">more</text>`;
  }
  return frame(w, h, opts, body);
}

function statsCard(data, opts) {
  const hm = buildHeatmap(data, { range: opts.range, tools: opts.tools });
  const { theme } = opts;
  const w = 440;
  const h = 150;
  const top = hm.tools[0];
  const stats = [
    ['tokens', formatTokens(hm.total)],
    ['busiest day', hm.max ? formatTokens(hm.max) : '-'],
    ['longest streak', `${hm.longestStreak}d`],
    ['top tool', top ? top.name : '-'],
  ];
  let body = opts.hide.has('title') ? '' : `<text x="20" y="30" font-size="13" font-weight="600" fill="${theme.text}">@${esc(hm.handle)}</text><text x="${w - 20}" y="30" text-anchor="end" font-size="11" fill="${theme.muted}">${esc(opts.range === 'year' ? hm.range.start.slice(0, 4) : `last ${opts.range}`)}</text>`;
  stats.forEach(([label, value], i) => {
    const x = 20 + (i % 2) * 210;
    const y = 66 + Math.floor(i / 2) * 50;
    body += `<text x="${x}" y="${y}" font-size="10" fill="${theme.muted}">${esc(label)}</text>`;
    body += `<text x="${x}" y="${y + 22}" font-size="${i === 0 ? 22 : 17}" font-weight="600" fill="${i === 0 ? theme.accent : theme.text}">${esc(value)}</text>`;
  });
  return frame(w, h, opts, body);
}

function badgeCard(data, opts) {
  const hm = buildHeatmap(data, { range: opts.range, tools: opts.tools });
  const label = opts.label;
  const value = formatTokens(hm.total);
  const cw = 6.6;
  const lw = Math.round(label.length * cw + 20);
  const vw = Math.round(value.length * cw + 20);
  const h = 20;
  // Dark label half in every theme (like shields.io); a light bg would hide the white label text
  const lum = (h) => [1, 3, 5].reduce((t, i, k) => t + parseInt(h.slice(i, i + 2), 16) * [0.299, 0.587, 0.114][k], 0);
  const labelBg = opts.theme.bg === 'none' || lum(opts.theme.bg) > 140 ? '#4a4f5c' : mix(opts.theme.bg, '#ffffff', 0.12);
  const body = `<rect width="${lw}" height="${h}" fill="${labelBg}"/><rect x="${lw}" width="${vw}" height="${h}" fill="${opts.theme.accent}"/>`
    + `<text x="${lw / 2}" y="14" text-anchor="middle" font-size="11" fill="#fff">${esc(label)}</text>`
    + `<text x="${lw + vw / 2}" y="14" text-anchor="middle" font-size="11" font-weight="600" fill="${mix(opts.theme.accent, '#000000', 0.75)}">${esc(value)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="${h}" viewBox="0 0 ${lw + vw} ${h}" font-family="${FONT}" role="img" aria-label="${esc(`${label}: ${value}`)}">${body}</svg>`;
}

function breakdownCard(data, opts) {
  const hm = buildHeatmap(data, { range: opts.range, tools: opts.tools });
  const { theme } = opts;
  const w = 440;
  const rows = hm.tools.slice(0, 6);
  const h = 70 + rows.length * 22;
  let body = opts.hide.has('title') ? '' : `<text x="20" y="30" font-size="13" font-weight="600" fill="${theme.text}">@${esc(hm.handle)}</text><text x="${w - 20}" y="30" text-anchor="end" font-size="13" font-weight="600" fill="${theme.text}">${esc(formatTokens(hm.total))}</text>`;
  let x = 20;
  const barW = w - 40;
  rows.forEach((t, i) => {
    const segW = Math.max(2, t.share * barW);
    body += `<rect class="tt-seg" data-tool="${esc(t.id)}" x="${x}" y="44" width="${segW}" height="8" fill="${TOOL_COLORS[i % TOOL_COLORS.length]}"><title>${esc(t.name)} · ${esc(formatTokens(t.tokens))}</title></rect>`;
    x += segW;
  });
  rows.forEach((t, i) => {
    const y = 76 + i * 22;
    body += `<g class="tt-row" data-tool="${esc(t.id)}"><title>${esc(t.name)} · ${esc(formatTokens(t.tokens))} tokens</title><rect x="14" y="${y - 15}" width="${w - 28}" height="21" fill="transparent"/>`;
    body += `<rect x="20" y="${y - 9}" width="9" height="9" fill="${TOOL_COLORS[i % TOOL_COLORS.length]}"/>`;
    body += `<text x="36" y="${y}" font-size="11" fill="${theme.text}">${esc(t.name)}</text>`;
    body += `<text x="${w - 20}" y="${y}" text-anchor="end" font-size="11" fill="${theme.muted}">${esc(formatTokens(t.tokens))} · ${Math.round(t.share * 100)}%</text></g>`;
  });
  return frame(w, h, opts, body);
}

function lineCard(data, opts) {
  const series = buildSeries(data, { range: opts.range, tools: opts.tools });
  const { theme } = opts;
  const w = 480;
  const h = 170;
  const px = 20;
  const top = opts.hide.has('title') ? 16 : 46;
  const bottom = h - 26;
  const max = series.at(-1)?.cumulative || 1;
  const x = (i) => px + (i / Math.max(1, series.length - 1)) * (w - px * 2);
  const y = (v) => bottom - (v / max) * (bottom - top);
  const pts = series.map((d, i) => `${x(i).toFixed(1)},${y(d.cumulative).toFixed(1)}`);
  let body = opts.hide.has('title') ? '' : `<text x="${px}" y="28" font-size="13" font-weight="600" fill="${theme.text}">@${esc(data.handle)}</text><text x="${w - px}" y="28" text-anchor="end" font-size="13" font-weight="600" fill="${theme.accent}">${esc(formatTokens(max))}</text>`;
  if (pts.length > 1) {
    body += `<polygon points="${px},${bottom} ${pts.join(' ')} ${x(series.length - 1)},${bottom}" fill="${theme.accent}" fill-opacity="0.18"/>`;
    body += `<path d="M${pts.join('L')}" fill="none" stroke="${theme.accent}" stroke-width="2" stroke-linejoin="round"/>`;
  }
  body += `<line x1="${px}" x2="${w - px}" y1="${bottom}" y2="${bottom}" stroke="${theme.rule}"/>`;
  // Invisible per-day strips: hover tooltips, plus hooks for interactive embeds
  const stripW = (w - px * 2) / Math.max(1, series.length);
  series.forEach((d, i) => {
    body += `<rect class="tt-point" data-x="${x(i).toFixed(1)}" data-y="${y(d.cumulative).toFixed(1)}" x="${(x(i) - stripW / 2).toFixed(1)}" y="${top}" width="${stripW.toFixed(2)}" height="${bottom - top}" fill="transparent"><title>${d.date} · ${esc(formatTokens(d.cumulative))} total</title></rect>`;
  });
  const seen = new Set();
  series.forEach((d, i) => {
    const m = Number(d.date.slice(5, 7)) - 1;
    if (d.date.endsWith('-01') && !seen.has(m) && series.length > 60) {
      seen.add(m);
      body += `<text x="${x(i)}" y="${bottom + 16}" font-size="9" fill="${theme.muted}">${MONTHS[m]}</text>`;
    }
  });
  return frame(w, h, opts, body);
}

export function renderCard(data, query) {
  const opts = parseOptions(query);
  const render = { heatmap: heatmapCard, stats: statsCard, badge: badgeCard, breakdown: breakdownCard, line: lineCard }[opts.type];
  return render(data, opts);
}
