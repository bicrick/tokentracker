// Landing sections: each one is a single request to the public v1 API,
// rendered into a component. Skeletons hold the layout until data arrives.
import { api, formatCount } from '/app.js?v=33';

const HANDLE = 'bicrick';
const COLORS = ['#6b9eff', '#f0c463', '#d97757', '#6fd39b', '#c58af9', '#4fd1c5', '#f687b3', '#a0aec0'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// claude-opus-5-5 -> claude-opus-5.5 (tools log versions differently)
const pretty = (name) => String(name).replace(/-(\d)-(\d)(?=$|-)/, '-$1.$2');

/** Reveal a section the first time it scrolls into view (observer + scroll fallback). */
function onEnter(el, fn) {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    el.classList.add('in');
    fn?.();
  };
  if (reduced) return fire();
  const check = () => {
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.85 && r.bottom > 0) {
      window.removeEventListener('scroll', check);
      fire();
    }
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        io.disconnect();
        fire();
      }
    }, { threshold: 0.2 });
    io.observe(el);
  }
  window.addEventListener('scroll', check, { passive: true });
  check();
}

// ── usage: stacked monthly bars by tool ──────────────────────────────────────
function skeletonBars(el, n) {
  el.innerHTML = Array.from({ length: n }, (_, i) => `<div class="col"><div class="stack" style="--h:${20 + ((i * 37) % 60)}%"></div><small>&nbsp;</small></div>`).join('');
}

async function renderUsage() {
  const el = document.getElementById('q-usage');
  const legend = document.getElementById('q-usage-legend');
  const res = await api(`/users/${HANDLE}/usage?range=ytd&group=month&split=tool`);
  const tools = [...new Set(res.rows.flatMap((r) => Object.keys(r.split)))];
  const color = Object.fromEntries(tools.map((t, i) => [t, COLORS[i % COLORS.length]]));
  const max = Math.max(1, ...res.rows.map((r) => r.tokens));
  el.classList.remove('skeleton');
  el.innerHTML = res.rows.map((r, i) => {
    const m = Number(r.period.slice(5)) - 1;
    const segs = Object.entries(r.split).map(([t, v]) => `<span style="flex-grow:${v};background:${color[t]}" title="${esc(t)} · ${formatCount(v)}"></span>`).join('');
    return `<div class="col" title="${MONTHS[m]} · ${formatCount(r.tokens)} tokens"><div class="stack" style="--h:${Math.max(1.5, (r.tokens / max) * 100)}%;--delay:${i * 45}ms">${segs}</div><small>${MONTHS[m][0]}</small></div>`;
  }).join('');
  legend.innerHTML = tools.map((t) => `<span><i style="background:${color[t]}"></i>${esc(t)}</span>`).join('');
}

// ── models: ranked list ──────────────────────────────────────────────────────
async function renderModels() {
  const el = document.getElementById('q-models');
  const res = await api(`/users/${HANDLE}/models?range=ytd`);
  const rows = res.rows.filter((m) => m.model !== 'cursor/all').slice(0, 6);
  const max = Math.max(1, ...rows.map((m) => m.tokens));
  el.classList.remove('skeleton');
  el.innerHTML = rows.map((m, i) => `
    <li>
      <span class="rank">${i + 1}</span>
      <span class="name">${esc(pretty(m.name))}<small>${esc(m.provider || '')} · ${esc(m.tool)}</small></span>
      <span class="bar"><i style="--w:${(m.tokens / max) * 100}%;--delay:${i * 60}ms"></i></span>
      <span class="num">${formatCount(m.tokens)}<small>${m.responses.toLocaleString()} responses</small></span>
    </li>`).join('');
}

// ── tools: share bar + list ──────────────────────────────────────────────────
async function renderTools() {
  const el = document.getElementById('q-tools');
  const res = await api(`/users/${HANDLE}/tools?range=ytd`);
  el.classList.remove('skeleton');
  el.querySelector('.share-bar').innerHTML = res.rows.map((t, i) => `<span style="flex-grow:${t.tokens};background:${COLORS[i % COLORS.length]}" title="${esc(t.name)} · ${Math.round(t.share * 100)}%"></span>`).join('');
  el.querySelector('.share-list').innerHTML = res.rows.map((t, i) => `
    <li><i style="background:${COLORS[i % COLORS.length]}"></i><span>${esc(t.name)}</span><b>${formatCount(t.tokens)}</b><small>${Math.round(t.share * 100)}%</small></li>`).join('');
}

// ── stats: grid ──────────────────────────────────────────────────────────────
async function renderStats() {
  const el = document.getElementById('q-stats');
  const s = await api(`/users/${HANDLE}/stats?range=ytd`);
  const items = [
    ['tokens', formatCount(s.tokens)],
    ['this month', formatCount(s.thisMonth)],
    ['today', formatCount(s.today)],
    ['active days', s.activeDays],
    ['longest streak', `${s.longestStreak}d`],
    ['current streak', `${s.currentStreak}d`],
    ['busiest day', s.busiestDay ? `${formatCount(s.busiestDay.tokens)}` : '-', s.busiestDay?.date],
    ['top model', s.topModel ? pretty(s.topModel.model.split('/').pop()) : '-', s.topModel?.tool],
  ];
  el.classList.remove('skeleton');
  el.innerHTML = items.map(([k, v, note]) => `<div${String(v).length > 9 ? ' class="long"' : ''}><dt>${k}</dt><dd>${esc(v)}${note ? `<small>${esc(note)}</small>` : ''}</dd></div>`).join('');
}

// ── raw: typed curl and its real response ────────────────────────────────────
async function renderRaw() {
  const term = document.getElementById('api-term');
  const path = `/api/v1/users/${HANDLE}/usage?range=30d&group=week`;
  const cmd = `curl tokentracker.patrickbrown.dev${path}`;
  const res = await fetch(path).then((r) => r.json()).catch(() => null);
  if (!reduced) {
    for (let n = 1; n <= cmd.length; n += 1) {
      term.innerHTML = `<span class="t-gray">$</span> ${esc(cmd.slice(0, n))}<span class="caret"></span>`;
      await sleep(18);
    }
    await sleep(250);
  }
  if (!res) {
    term.innerHTML += '\n<span class="t-gray">(could not reach the API)</span>';
    return;
  }
  const compact = {
    handle: res.handle,
    group: res.group,
    totals: { tokens: res.totals.tokens, input: res.totals.input, output: res.totals.output, cacheRead: res.totals.cacheRead, responses: res.totals.responses },
    rows: res.rows.map((r) => ({ period: r.period, tokens: r.tokens, responses: r.responses })),
  };
  const lines = JSON.stringify(compact, null, 2).split('\n');
  term.innerHTML = `<span class="t-gray">$</span> ${esc(cmd)}\n`;
  for (const line of lines) {
    term.innerHTML += `<span class="t-blue">${esc(line)}</span>\n`;
    term.scrollTop = term.scrollHeight;
    if (!reduced) await sleep(30);
  }
}

const safe = (fn, el) => () => fn().catch((err) => {
  const target = document.getElementById(el);
  if (target) target.outerHTML = `<p class="muted">Could not load: ${esc(err.message)}</p>`;
});

// ── agents: a chat answered from the live API ────────────────────────────────
async function renderChat() {
  const el = document.getElementById('q-chat-answer');
  const [s, m] = await Promise.all([api(`/users/${HANDLE}/stats`), api(`/users/${HANDLE}/models?from=${new Date().toISOString().slice(0, 7)}-01`)]);
  // One model can be logged by two tools under slightly different names (4-5 vs 4.5)
  const top = [...new Set(m.rows.filter((x) => x.model !== 'cursor/all').map((x) => pretty(x.name)))].slice(0, 2);
  const big = (n) => formatCount(n).toUpperCase();
  el.textContent = `${big(s.thisMonth)} tokens so far this month${s.today ? `, ${big(s.today)} of them today` : ''}. Mostly ${top.join(' and ') || 'Cursor'}${s.topTool ? `, and ${s.topTool.name} is your biggest tool overall` : ''}. You're on a ${s.currentStreak}-day streak.`;
}

export function mountChapters() {
  skeletonBars(document.getElementById('q-usage'), 11);
  document.getElementById('q-models').innerHTML = Array.from({ length: 5 }, () => '<li><span class="rank">&nbsp;</span><span class="name">&nbsp;</span><span class="bar"><i style="--w:60%"></i></span><span class="num">&nbsp;</span></li>').join('');
  document.getElementById('q-stats').innerHTML = Array.from({ length: 8 }, () => '<div><dt>&nbsp;</dt><dd>&nbsp;</dd></div>').join('');
  onEnter(document.getElementById('ch-usage'), safe(renderUsage, 'q-usage'));
  onEnter(document.getElementById('ch-models'), safe(renderModels, 'q-models'));
  onEnter(document.getElementById('ch-tools'), safe(renderTools, 'q-tools'));
  onEnter(document.getElementById('ch-stats'), safe(renderStats, 'q-stats'));
  onEnter(document.getElementById('ch-agents'), safe(renderChat, 'q-chat-answer'));
  onEnter(document.getElementById('ch-api'), () => renderRaw());
}
