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
    { type: 'type', prefix: `${span('t-gray', '$')} `, text: 'npx github:bicrick/tokentracker init', w: 3 },
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
    { type: 'lines', w: 0.6, lines: [ok(`Where should your usage live? ${span('t-blue', 'Create a free account')}`)] },
    { type: 'type', prefix: ok('Pick a public handle '), text: 'you', w: 0.6 },
    { type: 'lines', w: 0.2, lines: [''] },
    { type: 'spin', text: 'Uploading your history', done: 'Uploaded 412 day/model rows', w: 0.9 },
    { type: 'spin', text: 'Turning on background sync', done: `Background sync on ${span('t-gray', '(hourly, no admin needed)')}`, w: 0.7 },
    { type: 'lines', w: 1.2, lines: [
      '',
      `  ${span('t-gray', `╭${'─'.repeat(W)}╮`)}`,
      row("✓ You're all set", `${span('t-green', '✓')} ${span('t-bold', "You're all set")}`),
      row('profile  tokentracker-nu.vercel.app/u/you', `${span('t-gray', 'profile ')} ${span('t-blue t-under', 'tokentracker-nu.vercel.app/u/you')}`),
      row('embed    ![AI tokens](…/u/you.svg)', `${span('t-gray', 'embed   ')} ![AI tokens](…/u/you.svg)`),
      row('api      …/u/you.json', `${span('t-gray', 'api     ')} …/u/you.json`),
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
const SKIP_DISTANCE = 500; // px of attempted scrolling that fills the skip bar

// While the onboarding plays, scroll attempts don't move the page. They fill a
// bar behind the skip button instead; a full bar skips straight to the heatmap.
// Scrolling is released the moment the heatmap starts rendering.
function scrollToSkip(button, onSkip) {
  let intent = 0;
  let lastTouch = null;
  const fill = (dy) => {
    intent = Math.max(0, intent + dy);
    const p = Math.min(1, intent / SKIP_DISTANCE);
    button?.style.setProperty('--fill', `${p * 100}%`);
    if (p >= 1) onSkip();
  };
  const onWheel = (e) => {
    e.preventDefault();
    fill(Math.abs(e.deltaY) * (e.deltaMode === 1 ? 16 : 1));
  };
  const onTouchStart = (e) => { lastTouch = e.touches[0]?.clientY ?? null; };
  const onTouchMove = (e) => {
    const y = e.touches[0]?.clientY;
    if (lastTouch != null && y != null) fill(Math.abs(lastTouch - y) * 1.5);
    lastTouch = y;
    e.preventDefault();
  };
  const KEYS = new Set(['ArrowDown', 'PageDown', ' ', 'End', 'ArrowUp', 'PageUp', 'Home']);
  const onKey = (e) => {
    if (!KEYS.has(e.key) || e.target.closest?.('input, textarea, select, button')) return;
    e.preventDefault();
    fill(SKIP_DISTANCE / 3);
  };
  const opts = { passive: false };
  window.addEventListener('wheel', onWheel, opts);
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove', onTouchMove, opts);
  window.addEventListener('keydown', onKey);
  return () => {
    window.removeEventListener('wheel', onWheel, opts);
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove, opts);
    window.removeEventListener('keydown', onKey);
    button?.style.setProperty('--fill', '0%');
  };
}

export function mountDemo({ demo, body, data, onReveal, skipButton }) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const term = demo.querySelector('.term');
  let steps = timeline(null);
  let profileReady = false;
  let run = 0;
  let skipping = false;
  let release = null;
  const unhold = () => {
    release?.();
    release = null;
  };

  data.then((d) => {
    steps = timeline(d?.totals);
  });

  const reveal = async (id) => {
    unhold(); // scrolling is back as soon as the heatmap starts rendering
    if (!reduced) ditherWipe(demo, term);
    demo.classList.add('revealed');
    if (!profileReady) {
      profileReady = true;
      await onReveal();
    }
  };

  const play = ({ hold = false } = {}) => {
    const id = ++run;
    skipping = false;
    demo.classList.remove('revealed');
    if (hold) {
      // On short screens the demo starts below the fold: centre it first
      const r = demo.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) {
        const top = window.scrollY + r.top - Math.max(12, (window.innerHeight - r.height) / 2);
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        setTimeout(() => {
          if (id === run && !demo.classList.contains('revealed')) release = scrollToSkip(skipButton, () => { skipping = true; });
        }, 600);
      } else {
        release = scrollToSkip(skipButton, () => { skipping = true; });
      }
    }
    if (skipButton) skipButton.hidden = false;
    const start = performance.now();
    const tick = () => {
      if (id !== run) return;
      const p = skipping ? 1 : Math.min(1, (performance.now() - start) / DURATION);
      body.innerHTML = renderTerminal(steps, p);
      body.scrollTop = body.scrollHeight; // follow the latest line, like a real terminal
      if (p < 1) setTimeout(tick, 33);
      else {
        if (skipButton) skipButton.hidden = true;
        if (skipping) unhold();
        setTimeout(() => id === run && reveal(id), skipping ? 60 : 900);
      }
    };
    tick();
  };

  skipButton?.addEventListener('click', () => {
    skipping = true;
  });

  if (reduced) {
    demo.classList.add('revealed', 'instant');
    if (skipButton) skipButton.hidden = true;
    onReveal();
    return { replay() {} };
  }

  // On screen at load (the usual case): play and hold the page until it's done
  if (window.scrollY < 40) {
    play({ hold: true });
    return { replay: () => play() };
  }

  const io = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) {
      io.disconnect();
      play();
    }
  }, { threshold: 0.25 });
  io.observe(demo);

  return { replay: () => play() };
}
