// Page background: a dithered sea of gold tokens at the bottom of the viewport,
// fed by waterfalls of tumbling coins that pour in as you scroll. Everything is
// drawn on a coarse square-pixel grid with 8×8 ordered (Bayer) dithering.

const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
const bayer = (x, y) => (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64;

const GOLD = [[0x6e, 0x4a, 0x14], [0x8a, 0x5f, 0x1c], [0xb8, 0x86, 0x2f], [0xdb, 0xa9, 0x4c], [0xf0, 0xc4, 0x63], [0xf8, 0xdc, 0x96]];
const BLUE = [[0x16, 0x21, 0x3a], [0x1e, 0x3a, 0x6e], [0x2b, 0x5c, 0xb0], [0x4d, 0x82, 0xe0]];

const CELL = 4;        // screen px per dithered pixel
const COIN_W = 13;
const COIN_H = 4;
const GRAVITY = 0.09;  // cells per frame²

function rng(seed) {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

export function mountTokenSea(canvas, { content } = {}) {
  const ctx = canvas.getContext('2d', { alpha: true });
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0;
  let H = 0;
  let img = null;
  let bumps = new Float32Array(0);   // landed coins raise the sea locally
  let seaCoins = [];
  const falling = [];
  let scrollP = 0;
  let raf = 0;
  let lastY = window.scrollY;

  const resize = () => {
    W = Math.ceil(window.innerWidth / CELL);
    H = Math.ceil(window.innerHeight / CELL);
    canvas.width = W;
    canvas.height = H;
    img = ctx.createImageData(W, H);
    bumps = new Float32Array(W);
    // A staggered bed of coins; only those below the surface get drawn
    const rand = rng(11);
    seaCoins = [];
    for (let row = 0; row < Math.ceil(H / 3); row += 1) {
      for (let x = -COIN_W; x < W + COIN_W; x += 12 + Math.floor(rand() * 5)) {
        seaCoins.push({ x: x + (row % 2) * 7 + rand() * 4, depth: row * 3 + rand() * 1.5, light: rand() * 0.9 - 0.45 });
      }
    }
    schedule();
  };

  // Content column: waterfalls pour in the gutters beside it on wide screens
  const gutters = () => {
    const rect = content?.getBoundingClientRect();
    if (!rect || window.innerWidth < 1000) return [[0, W]];
    const l = rect.left / CELL;
    const r = rect.right / CELL;
    return [[2, Math.max(4, l - 6)], [Math.min(W - 4, r + 6), W - 2]];
  };

  const surfaceAt = (x) => {
    const base = H * (0.08 + 0.17 * scrollP);
    // Mounds, like a hoard heaped in piles
    const wave = Math.sin(x / 41) * 6 + Math.sin(x / 17 + 1.3) * 2.5 + Math.sin(x / 7 + 0.4) * 0.8;
    return H - base - wave - (bumps[Math.max(0, Math.min(W - 1, Math.round(x)))] || 0);
  };

  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    img.data[i] = rgb[0];
    img.data[i + 1] = rgb[1];
    img.data[i + 2] = rgb[2];
    img.data[i + 3] = 255;
  };

  const pick = (ramp, v, x, y) => {
    const lo = Math.floor(v);
    const idx = v - lo > bayer(x, y) ? lo + 1 : lo;
    return ramp[Math.max(0, Math.min(ramp.length - 1, idx))];
  };

  // A coin seen at an angle; `turn` squashes it horizontally as it tumbles
  const coin = (cx, cy, light, turn = 1) => {
    const a = Math.max(1, (COIN_W / 2) * Math.abs(turn));
    const b = COIN_H / 2;
    for (let y = Math.floor(cy - b); y <= Math.ceil(cy + b + 1.5); y += 1) {
      for (let x = Math.floor(cx - a - 1); x <= Math.ceil(cx + a + 1); x += 1) {
        const dx = (x + 0.5 - cx) / a;
        const fy = (y + 0.5 - cy) / b;
        const ey = (y + 0.5 - cy - 1.5) / b;
        if (dx * dx + fy * fy <= 1) {
          const r = Math.hypot(dx, fy);
          put(x, y, pick(GOLD, (r > 0.68 ? 4 : 3) + light - dx * 0.6 - fy * 0.3, x, y));
        } else if (dx * dx + ey * ey <= 1 || (Math.abs(dx) <= 1 && y + 0.5 > cy && y + 0.5 < cy + 1.5)) {
          put(x, y, pick(GOLD, 1.6 - dx * 0.8 + light * 0.5, x, y));
        }
      }
    }
  };

  const draw = () => {
    img.data.fill(0);

    // Blue glow rising from the bottom
    const glowTop = H * (0.55 - 0.2 * scrollP);
    for (let y = Math.max(0, Math.floor(glowTop)); y < H; y += 1) {
      const t = (y - glowTop) / (H - glowTop);
      for (let x = 0; x < W; x += 1) {
        const v = t ** 2.2 * 2.6 - 0.4 + Math.sin(x / 19) * 0.12;
        if (v > bayer(x, y)) put(x, y, pick(BLUE, v, x, y));
      }
    }

    // The sea: draw back rows first so nearer coins overlap them
    for (let i = seaCoins.length - 1; i >= 0; i -= 1) {
      const c = seaCoins[i];
      const y = surfaceAt(c.x) + c.depth;
      if (y < H + 4) coin(c.x, y, c.depth < 4 ? c.light + 0.35 : c.light - Math.min(1.6, c.depth / 22));
    }

    for (const f of falling) coin(f.x, f.y, f.light, Math.cos(f.spin));
    ctx.putImageData(img, 0, 0);
  };

  const step = () => {
    raf = 0;
    let active = false;
    for (let i = falling.length - 1; i >= 0; i -= 1) {
      const f = falling[i];
      f.vy += GRAVITY;
      f.y += f.vy;
      f.x += f.vx;
      f.spin += f.vs;
      if (f.y >= surfaceAt(f.x) - 1) {
        // Land: raise the sea a little around the impact
        for (let dx = -8; dx <= 8; dx += 1) {
          const x = Math.round(f.x) + dx;
          if (x >= 0 && x < W) bumps[x] = Math.min(H * 0.12, bumps[x] + 0.35 * Math.exp(-(dx * dx) / 18));
        }
        falling.splice(i, 1);
      }
    }
    // Landed coins slowly settle back into the sea
    for (let x = 0; x < W; x += 1) {
      if (bumps[x] > 0.01) {
        bumps[x] *= 0.997;
        active = true;
      }
    }
    draw();
    if (falling.length || active) schedule();
  };

  function schedule() {
    if (!raf) raf = requestAnimationFrame(step);
  }

  // Each gutter gets one narrow stream, so falling coins read as a waterfall
  const streams = () => gutters().map(([a, b]) => a + (b - a) * 0.5);

  const pour = (amount) => {
    const lanes = streams();
    const rand = Math.random;
    for (let n = 0; n < amount; n += 1) {
      const center = lanes[Math.floor(rand() * lanes.length)];
      const spread = (rand() + rand() + rand() - 1.5) * 7;
      falling.push({
        x: center + spread,
        y: -8 - rand() * 30,
        vx: spread * 0.006,
        vy: rand() * 0.6,
        spin: rand() * Math.PI * 2,
        vs: 0.08 + rand() * 0.14,
        light: rand() * 0.6 - 0.2,
      });
    }
    if (falling.length > 220) falling.splice(0, falling.length - 220);
    schedule();
  };

  const onScroll = () => {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    scrollP = Math.min(1, window.scrollY / max);
    const dy = Math.abs(window.scrollY - lastY);
    lastY = window.scrollY;
    if (!reduced && dy > 0) pour(Math.min(12, Math.ceil(dy / 45)));
    else schedule();
  };

  window.addEventListener('resize', resize);
  window.addEventListener('scroll', onScroll, { passive: true });
  resize();
  onScroll();
  // A first trickle so the waterfalls are visible before anyone scrolls
  if (!reduced) pour(14);
  draw();
}
