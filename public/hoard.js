// "The hoard": a year of tokens as stacks of dithered gold coins, one stack per
// month, piling up as the section scrolls into view, over a dithered blue glow.

const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
const bayer = (x, y) => (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64;

const GOLD = ['#6e4a14', '#8a5f1c', '#b8862f', '#DBA94C', '#F0C463', '#f8dc96'];
const BLUE = ['#16213a', '#1e3a6e', '#2b5cb0', '#4d82e0'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const W = 240;       // canvas cells
const H = 110;
const COIN_W = 13;   // ellipse width in cells
const COIN_H = 4;    // ellipse height (face seen from above at an angle)
const STEP = 2;      // vertical spacing between stacked coins

function seeded(n) {
  let s = n * 9301 + 49297;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/** Pick a ramp colour with ordered dithering between two neighbouring levels. */
function pick(ramp, value, x, y) {
  const lo = Math.floor(value);
  const idx = value - lo > bayer(x, y) ? lo + 1 : lo;
  return ramp[Math.max(0, Math.min(ramp.length - 1, idx))];
}

function drawCoin(px, cx, cy, light) {
  const a = COIN_W / 2;
  const b = COIN_H / 2;
  // Edge band first (the coin's thickness), then the face on top
  for (let y = Math.floor(cy - b); y <= Math.ceil(cy + b + 1.5); y += 1) {
    for (let x = Math.floor(cx - a); x <= Math.ceil(cx + a); x += 1) {
      const dx = (x + 0.5 - cx) / a;
      const fy = (y + 0.5 - cy) / b;
      const ey = (y + 0.5 - cy - 1.5) / b;
      const inFace = dx * dx + fy * fy <= 1;
      const inEdge = dx * dx + ey * ey <= 1 || (Math.abs(dx) <= 1 && y + 0.5 > cy && y + 0.5 < cy + 1.5);
      if (inFace) {
        const r = Math.hypot(dx, fy);
        const v = (r > 0.68 ? 4 : 3) + light - dx * 0.6 - fy * 0.3;
        px(x, y, pick(GOLD, v, x, y));
      } else if (inEdge) {
        px(x, y, pick(GOLD, 1.6 - dx * 0.8 + light * 0.5, x, y));
      }
    }
  }
}

export function mountHoard(canvas, labels, data, { perCoin = 50e6 } = {}) {
  const ctx = canvas.getContext('2d');
  canvas.width = W;
  canvas.height = H;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const year = String(new Date().getFullYear());
  const monthly = Array(12).fill(0);
  for (const d of data.activityCounts || []) {
    if (d.date.startsWith(year)) monthly[Number(d.date.slice(5, 7)) - 1] += d.count;
  }
  const lastMonth = new Date().getMonth();
  const maxCoins = Math.floor((H - 16) / STEP);
  const counts = monthly.map((m) => Math.min(maxCoins, Math.round(m / perCoin)));

  const slot = W / 12;
  const floor = H - 6;
  const rand = seeded(7);
  // Per-coin wobble so stacks look hand-piled, fixed so redraws don't jitter
  const wobble = counts.map((n) => Array.from({ length: n }, () => (rand() - 0.5) * 1.6));
  const loose = Array.from({ length: 26 }, () => ({ x: rand() * W, y: floor - rand() * 3, m: Math.floor(rand() * 12) }));

  labels.replaceChildren(...MONTHS.map((m, i) => {
    const el = document.createElement('span');
    el.textContent = m;
    if (i > lastMonth) el.className = 'future';
    return el;
  }));

  let shown = -1;
  const render = (progress) => {
    const img = ctx.createImageData(W, H);
    const px = (x, y, hex) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = (y * W + x) * 4;
      img.data[i] = parseInt(hex.slice(1, 3), 16);
      img.data[i + 1] = parseInt(hex.slice(3, 5), 16);
      img.data[i + 2] = parseInt(hex.slice(5, 7), 16);
      img.data[i + 3] = 255;
    };

    // Dithered blue glow rising from the floor
    for (let y = 0; y < H; y += 1) {
      const t = 1 - y / H;
      for (let x = 0; x < W; x += 1) {
        const v = (1 - t) ** 2.6 * 2.7 - 0.7 + Math.sin(x / 19) * 0.15;
        if (v > bayer(x, y)) px(x, y, pick(BLUE, v, x, y));
      }
    }

    // Loose coins on the floor appear once their month's stack has started
    for (const c of loose) {
      if (counts[c.m] && progress * 1.4 - c.m * 0.06 > 0.1) drawCoin(px, c.x, c.y, -0.4);
    }

    // Stacks rise left to right as the section scrolls in
    counts.forEach((n, m) => {
      const local = Math.max(0, Math.min(1, progress * 1.6 - m * 0.05));
      const visible = Math.round(n * local);
      const cx = slot * m + slot / 2;
      for (let i = 0; i < visible; i += 1) {
        drawCoin(px, cx + wobble[m][i], floor - 3 - i * STEP, i === visible - 1 ? 0.5 : 0);
      }
    });

    ctx.putImageData(img, 0, 0);
  };

  if (reduced) {
    render(1);
    return;
  }

  const update = () => {
    const r = canvas.getBoundingClientRect();
    const vh = window.innerHeight;
    // 0 when the top enters the viewport, 1 when the hoard is fully in view
    const progress = Math.max(0, Math.min(1, (vh - r.top) / (vh * 0.55 + r.height * 0.5)));
    const q = Math.round(progress * 200);
    if (q !== shown) {
      shown = q;
      render(progress);
    }
  };
  let raf = 0;
  const onScroll = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(update);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  update();
}
