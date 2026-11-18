// Landing hero: type the command, fly through a mock onboarding, reveal the heatmap.
import { formatCount } from '/app.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const NAMES = { 'claude-code': 'Claude Code', opencode: 'OpenCode', codex: 'Codex', 'gemini-cli': 'Gemini CLI', 'copilot-cli': 'Copilot CLI', cline: 'Cline' };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const span = (cls, s) => `<span class="${cls}">${esc(s)}</span>`;

let runId = 0;

// 8×8 Bayer threshold matrix (values 0..63). Ordered dithering stays stable
// frame to frame, so it animates cleanly instead of boiling like noise.
const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

/**
 * Dissolve the terminal into the page with an ordered-dither wipe: a canvas the
 * terminal's color covers the demo, and square blocks drop out in Bayer order,
 * biased left-to-right so the reveal sweeps like the heatmap fills.
 */
function ditherWipe(demo, term, { block = 6, duration = 900 } = {}) {
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

  return new Promise((resolve) => {
    const start = performance.now();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      canvas.remove();
      resolve();
    };
    // Animation frames pause in background tabs; never leave the overlay behind
    setTimeout(finish, duration + 300);
    const frame = (now) => {
      if (done) return;
      const t = Math.min(1, (now - start) / duration);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = color;
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
          const threshold = (BAYER8[(y % 8) * 8 + (x % 8)] + 0.5) / 64;
          // Sweep: cells further right need a later t to disappear
          const local = t * 1.6 - (x / cols) * 0.6;
          if (threshold > local) ctx.fillRect(x * size, y * size, size, size);
        }
      }
      if (t < 1) requestAnimationFrame(frame);
      else finish();
    };
    requestAnimationFrame(frame);
  });
}

export async function playDemo({ demo, body, data, onReveal }) {
  const id = ++runId;
  const alive = () => id === runId;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  demo.classList.remove('revealed');
  body.innerHTML = '';

  if (reduced) {
    demo.classList.add('revealed', 'instant');
    await onReveal();
    return;
  }

  const add = (html = '') => {
    const el = document.createElement('div');
    el.innerHTML = html || '&nbsp;';
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  };

  const type = async (el, prefix, text, speed = 38) => {
    for (let i = 1; i <= text.length; i += 1) {
      if (!alive()) return;
      el.innerHTML = `${prefix}${esc(text.slice(0, i))}<span class="caret"></span>`;
      await sleep(speed + Math.random() * 30);
    }
    el.innerHTML = `${prefix}${esc(text)}`;
  };

  const spin = async (text, done, ms = 700) => {
    const el = add();
    const start = performance.now();
    let i = 0;
    while (performance.now() - start < ms) {
      if (!alive()) return;
      el.innerHTML = `  ${span('t-blue', FRAMES[i % FRAMES.length])} ${esc(text)}`;
      i += 1;
      await sleep(70);
    }
    el.innerHTML = `  ${span('t-green', '✓')} ${done}`;
  };

  // 1. type the command
  const prompt = add();
  await sleep(500);
  await type(prompt, `${span('t-gray', '$')} `, 'npx github:bicrick/tokentracker init');
  if (!alive()) return;
  await sleep(450);

  // 2. welcome
  add();
  const W = 46;
  const row = (plain, html) => `${span('t-gray', '│')}  ${html}${' '.repeat(W - 2 - plain.length)}${span('t-gray', '│')}`;
  for (const l of [
    span('t-gray', `╭${'─'.repeat(W)}╮`),
    row('✻ Welcome to tokentracker', `${span('t-blue', '✻')} ${span('t-bold', 'Welcome to tokentracker')}`),
    row('  every AI token, every tool, every machine', span('t-gray', '  every AI token, every tool, every machine')),
    span('t-gray', `╰${'─'.repeat(W)}╯`),
  ]) {
    if (!alive()) return;
    add(`  ${l}`);
    await sleep(60);
  }
  add();

  // 3. scan, using the example profile's real per-tool totals
  const d = await data;
  const local = Object.entries(d?.totals || { 'claude-code': 1.39e9, opencode: 3.6e8 })
    .filter(([k]) => k !== 'cursor')
    .sort((a, b) => b[1] - a[1]);
  await spin('Looking for AI tools on this machine…', `Found ${local.length} tools with usage`, 900);
  for (const [k, v] of local) {
    if (!alive()) return;
    add(`    ${span('t-gray', '·')} ${esc((NAMES[k] || k).padEnd(12))} ${span('t-blue', formatCount(v).toUpperCase().padStart(6))} ${span('t-gray', 'tokens')}`);
    await sleep(120);
  }
  add();
  await sleep(300);
  add(`  ${span('t-green', '✓')} Which tools should be tracked? ${span('t-blue', local.map(([k]) => NAMES[k] || k).join(', '))}`);
  await sleep(380);
  add(`  ${span('t-green', '✓')} Where should your usage live? ${span('t-blue', 'Create a free account')}`);
  await sleep(380);
  const handle = add();
  await type(handle, `  ${span('t-green', '✓')} Pick a public handle `, 'you', 90);
  await sleep(250);
  add();
  await spin('Uploading your history', 'Uploaded 412 day/model rows', 800);
  await spin('Turning on background sync', `Background sync on ${span('t-gray', '(hourly, no admin needed)')}`, 500);
  add();
  add(`  ${span('t-green', '✓')} ${span('t-bold', "You're all set")}  ${span('t-blue t-under', 'tokentracker-nu.vercel.app/u/you')}`);
  if (!alive()) return;

  // 4. dither-dissolve into the real profile
  await sleep(1100);
  if (!alive()) return;
  const term = demo.querySelector('.term');
  const wipe = ditherWipe(demo, term);
  demo.classList.add('revealed');
  await onReveal();
  await wipe;
}
