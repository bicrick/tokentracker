// Landing demo, driven by scroll: the section pins while scrolling types the
// command, steps through a mock onboarding, then dither-dissolves into the real
// profile. Scrolling back up rewinds it. Rendering is a pure function of
// progress, so any scroll position shows a consistent frame.
import { formatCount } from '/app.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const NAMES = { 'claude-code': 'Claude Code', opencode: 'OpenCode', codex: 'Codex', 'gemini-cli': 'Gemini CLI', 'copilot-cli': 'Copilot CLI', cline: 'Cline' };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const span = (cls, s) => `<span class="${cls}">${esc(s)}</span>`;
const ok = (html) => `  ${span('t-green', '✓')} ${html}`;

// 8×8 Bayer thresholds for the dissolve
const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

/** Ordered-dither wipe from the terminal colour to transparent over the shared cell. */
function ditherWipe(demo, term, { block = 6, duration = 800 } = {}) {
  const rect = term.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.className = 'dither';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.ceil(rect.width * dpr);
  canvas.height = Math.ceil(rect.height * dpr);
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  demo.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const color = getComputedStyle(term).backgroundColor;
  const cols = Math.ceil(rect.width / block);
  const rows = Math.ceil(rect.height / block);
  const size = block * dpr;
  const start = performance.now();
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      canvas.remove();
    }
  };
  setTimeout(finish, duration + 300); // animation frames pause in background tabs
  const frame = (now) => {
    if (done) return;
    const t = Math.min(1, (now - start) / duration);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const threshold = (BAYER8[(y % 8) * 8 + (x % 8)] + 0.5) / 64;
        if (threshold > t * 1.6 - (x / cols) * 0.6) ctx.fillRect(x * size, y * size, size, size);
      }
    }
    if (t < 1) requestAnimationFrame(frame);
    else finish();
  };
  requestAnimationFrame(frame);
}

/** The onboarding as weighted steps; weights set how much scroll each takes. */
function timeline(totals) {
  const local = Object.entries(totals || { 'claude-code': 1.39e9, opencode: 3.6e8 })
    .filter(([k]) => k !== 'cursor')
    .sort((a, b) => b[1] - a[1]);
  const W = 46;
  const row = (plain, html) => `  ${span('t-gray', '│')}  ${html}${' '.repeat(Math.max(0, W - 2 - plain.length))}${span('t-gray', '│')}`;
  return [
    { type: 'type', prefix: `${span('t-gray', '$')} `, text: 'npx @bicrick/tokentracker init', w: 3 },
    { type: 'lines', w: 0.8, lines: [
      '',
      `  ${span('t-gray', `╭${'─'.repeat(W)}╮`)}`,
      row('✻ Welcome to tokentracker', `${span('t-blue', '✻')} ${span('t-bold', 'Welcome to tokentracker')}`),
      row('  every AI token, every tool, every machine', span('t-gray', '  every AI token, every tool, every machine')),
      `  ${span('t-gray', `╰${'─'.repeat(W)}╯`)}`,
      '',
    ] },
    { type: 'spin', text: 'Looking for AI tools on this machine…', done: `Found ${local.length} tools with usage`, w: 1 },
    { type: 'lines', w: 0.7, lines: [
      ...local.map(([k, v]) => `    ${span('t-gray', '·')} ${esc((NAMES[k] || k).padEnd(12))} ${span('t-blue', formatCount(v).toUpperCase().padStart(6))} ${span('t-gray', 'tokens')}`),
      '',
    ] },
    { type: 'lines', w: 0.6, lines: [ok(`Which tools should be tracked? ${span('t-blue', local.map(([k]) => NAMES[k] || k).join(', '))}`)] },
    { type: 'lines', w: 0.7, lines: [
      '',
      `  ${span('t-bold', 'Sign in to GitHub')}`,
      `  ${span('t-gray', '❯')} Open ${span('t-blue t-under', 'github.com/login/device')} and enter ${span('t-bold', 'WDJB-MJHT')}`,
    ] },
    { type: 'spin', text: 'Waiting for you to enter the code', done: 'Signed in to GitHub', w: 1.1 },
    { type: 'spin', text: 'Setting up tokentracker-data on your GitHub', done: `Created ${span('t-blue', 'you/tokentracker-data')} ${span('t-gray', '· GitHub Pages on')}`, w: 0.9 },
    { type: 'lines', w: 0.2, lines: [''] },
    { type: 'spin', text: 'Saving your history', done: `Saved 412 day/model rows to ${span('t-blue', 'you/tokentracker-data')}`, w: 0.9 },
    { type: 'spin', text: 'Turning on background sync', done: `Background sync on ${span('t-gray', '(hourly, no admin needed)')}`, w: 0.7 },
    { type: 'lines', w: 1.2, lines: [
      '',
      `  ${span('t-gray', `╭${'─'.repeat(W)}╮`)}`,
      row("✓ You're all set", `${span('t-green', '✓')} ${span('t-bold', "You're all set")}`),
      row('data     github.com/you/tokentracker-data', `${span('t-gray', 'data    ')} ${span('t-blue t-under', 'github.com/you/tokentracker-data')}`),
      row('api      /api/v1/users/you', `${span('t-gray', 'api     ')} ${span('t-blue', '/api/v1/users/you')}`),
      row('profile  tokentracker.patrickbrown.dev/u/you', `${span('t-gray', 'profile ')} tokentracker.patrickbrown.dev/u/you`),
      `  ${span('t-gray', `╰${'─'.repeat(W)}╯`)}`,
    ] },
  ];
}

function renderTerminal(steps, p) {
  const total = steps.reduce((s, x) => s + x.w, 0);
  let t = p * total;
  const out = [];
  for (const step of steps) {
    const local = Math.max(0, Math.min(1, t / step.w));
    t -= step.w;
    if (local <= 0) break;
    if (step.type === 'type') {
      const n = Math.round(step.text.length * local);
      out.push(`${step.prefix}${esc(step.text.slice(0, n))}${local < 1 ? '<span class="caret"></span>' : ''}`);
    } else if (step.type === 'lines') {
      out.push(...step.lines.slice(0, Math.ceil(step.lines.length * local)));
    } else if (step.type === 'spin') {
      out.push(local < 1
        ? `  ${span('t-blue', FRAMES[Math.floor(local * 24) % FRAMES.length])} ${esc(step.text)}`
        : ok(step.done));
    }
    if (local < 1) break;
  }
  if (!out.length) out.push(`${span('t-gray', '$')} <span class="caret"></span>`);
  return out.map((l) => `<div>${l || '&nbsp;'}</div>`).join('');
}

const DURATION = 5200;
export function mountDemo({ demo, body, data, skipButton }) {
  // The terminal plays the setup once and stays on its final screen. The page
  // scrolls freely the whole time; the skip button jumps to the end, then
  // becomes a replay button.
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let steps = timeline(null);
  let run = 0;
  let skipping = false;
  let finished = false;

  data.then((d) => {
    steps = timeline(d?.totals);
  });

  const setButton = (done) => {
    finished = done;
    if (skipButton) skipButton.textContent = done ? 'replay ↺' : 'skip →';
  };

  const play = () => {
    const id = ++run;
    skipping = false;
    setButton(false);
    const start = performance.now();
    const tick = () => {
      if (id !== run) return;
      const p = skipping || reduced ? 1 : Math.min(1, (performance.now() - start) / DURATION);
      body.innerHTML = renderTerminal(steps, p);
      body.scrollTop = body.scrollHeight; // follow the latest line, like a real terminal
      if (p < 1) setTimeout(tick, 33);
      else setButton(true);
    };
    tick();
  };

  skipButton?.addEventListener('click', () => {
    if (finished) play();
    else skipping = true;
  });

  if (window.scrollY < 40 || reduced) play();
  else {
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        io.disconnect();
        play();
      }
    }, { threshold: 0.25 });
    io.observe(demo);
  }
  return { replay: play };
}
