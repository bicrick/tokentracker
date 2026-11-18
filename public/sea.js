// Page background: a dragon's hoard of dithered gold tokens. Hidden at the top
// of the page; scrolling raises it from below (tall stacks in the side gutters,
// lower heaped piles across the floor) and pours waterfalls of coins onto it.
// Drawn on a coarse square-pixel grid with 8×8 ordered (Bayer) dithering, and
// clipped so it never draws over the content's charts.

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
const STEP = 2;        // stacked coin spacing
const GRAVITY = 0.09;

function rng(seed) {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

export function mountTokenSea(canvas, { content, avoid = [], ground } = {}) {
  const ctx = canvas.getContext('2d', { alpha: true });
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0;
  let H = 0;
  let img = null;
  let stacks = [];
  let piles = [];
  let bumps = new Float32Array(0);
  let lanes = [[0, 0]];
  const falling = [];
  let reveal = 0;
  let raf = 0;
  let lastY = window.scrollY;
  let clip = { from: 0, to: 0, y: -1 }; // columns of content, and the y above which they stay clear

  const inGutter = (x) => lanes.length > 1 && (x < lanes[0][1] || x > lanes[1][0]);

  const build = () => {
    const rand = rng(29);
    const rect = content?.getBoundingClientRect();
    const wide = window.innerWidth >= 1000 && rect;
    lanes = wide
      ? [[2, rect.left / CELL - 4], [rect.right / CELL + 4, W - 2]]
      : [[0, W]];

    // Tall, tidy stacks stand in the gutters; short ones dot the floor
    stacks = [];
    for (const [a, b] of lanes) {
      for (let x = a + 6; x < b - 6; x += 11 + rand() * 9) {
        const tall = wide;
        const count = Math.round((tall ? 18 + rand() * 46 : 3 + rand() * 9) * (0.55 + 0.45 * Math.sin(x / 13) ** 2));
        stacks.push({ x, count, wobble: Array.from({ length: 120 }, () => (rand() - 0.5) * 1.4) });
      }
    }
    // Heaped piles: a coin bed under a lumpy mound profile
    piles = [];
    for (let row = 0; row < 40; row += 1) {
      for (let x = -COIN_W; x < W + COIN_W; x += 11 + rand() * 6) {
        piles.push({ x: x + (row % 2) * 6, depth: row * 2.6 + rand() * 1.4, light: rand() * 0.9 - 0.45 });
      }
    }
  };

  let groundCells = 0;

  // The canvas sits in the page above the footer, so the hoard scrolls in with
  // the content instead of fading in on a fixed layer.
  const resize = () => {
    W = Math.ceil(canvas.clientWidth / CELL);
    H = Math.ceil(canvas.clientHeight / CELL);
    groundCells = ground ? Math.ceil(ground.offsetHeight / CELL) : 0;
    canvas.width = W;
    canvas.height = H;
    img = ctx.createImageData(W, H);
    bumps = new Float32Array(W);
    build();
    update();
    draw(); // resizing a canvas clears it
  };

  // Stacks stand on the footer's top edge
  const floorY = () => H - groundCells - 1;
  const pileTop = (x) => {
    const mound = Math.max(0, Math.sin(x / 31 + 0.7)) * 9 + Math.max(0, Math.sin(x / 13 + 2)) * 4 + 2;
    const lower = inGutter(x) ? 2.4 : 0.45; // keep the middle low and calm
    return floorY() - mound * lower - (bumps[Math.max(0, Math.min(W - 1, Math.round(x)))] || 0);
  };

  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= W || y > H - groundCells - 1) return; // nothing below the ground line
    if (x >= clip.from && x < clip.to && y < clip.y) return; // never over the charts
    const i = (y * W + x) * 4;
    img.data[i] = rgb[0];
    img.data[i + 1] = rgb[1];
    img.data[i + 2] = rgb[2];
    img.data[i + 3] = 255;
  };

  const putGround = (x, y, rgb) => {
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

  const coin = (cx, cy, light, turn = 1) => {
    if (cy < -4 || cy > H + 4) return;
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

    // Low blue band rising from the ground
    const floor = floorY();
    const band = H * 0.2;
    const top = floor - band;
    for (let y = Math.max(0, Math.floor(top)); y <= floor; y += 1) {
      const t = (y - top) / (floor - top || 1);
      for (let x = 0; x < W; x += 1) {
        const v = t ** 1.8 * 2.4 - 0.5 + Math.sin(x / 19) * 0.12;
        if (v > bayer(x, y)) put(x, y, pick(BLUE, v, x, y));
      }
    }

    // Below the ground line: deep blue water the footer sits in, darkening
    // with depth and dithered into the page background at the very bottom
    for (let y = floor + 1; y < H; y += 1) {
      const t = (y - floor) / (H - floor || 1);
      for (let x = 0; x < W; x += 1) {
        const v = 1.5 - t * 1.9 + Math.sin(x / 23 + y / 3) * 0.08;
        if (v > -0.6 * bayer(x, y)) putGround(x, y, pick(BLUE, Math.max(0, v), x, y));
      }
    }

    // Back to front: stacks behind, then the heaped piles, then falling coins
    for (const s of stacks) {
      const base = floorY() - 3;
      for (let i = 0; i < s.count; i += 1) {
        coin(s.x + s.wobble[i % s.wobble.length], base - i * STEP, i === s.count - 1 ? 0.5 : (i % 5 === 0 ? -0.25 : 0));
      }
    }
    for (let i = piles.length - 1; i >= 0; i -= 1) {
      const p = piles[i];
      const y = pileTop(p.x) + p.depth;
      if (y < H + 4) coin(p.x, y, p.depth < 3 ? p.light + 0.35 : p.light - Math.min(1.6, p.depth / 20));
    }
    for (const f of falling) coin(f.x, f.y, f.light, Math.cos(f.spin));
    ctx.putImageData(img, 0, 0);
  };

  const land = (f) => {
    const stack = stacks.find((s) => Math.abs(s.x - f.x) < COIN_W * 0.4);
    if (stack && stack.count < 120) {
      stack.count += 1;
      return;
    }
    for (let dx = -8; dx <= 8; dx += 1) {
      const x = Math.round(f.x) + dx;
      if (x >= 0 && x < W) bumps[x] = Math.min(H * 0.1, bumps[x] + 0.4 * Math.exp(-(dx * dx) / 18));
    }
  };

  const surfaceAt = (x) => {
    const stack = stacks.find((s) => Math.abs(s.x - x) < COIN_W * 0.4);
    const stackTop = stack ? floorY() - 3 - stack.count * STEP : Infinity;
    return Math.min(stackTop, pileTop(x));
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
        land(f);
        falling.splice(i, 1);
      }
    }
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

  const pour = (amount) => {
    const rand = Math.random;
    for (let n = 0; n < amount; n += 1) {
      const [a, b] = lanes[Math.floor(rand() * lanes.length)];
      const center = a + (b - a) * 0.5;
      const spread = (rand() + rand() + rand() - 1.5) * 7;
      falling.push({
        x: center + spread,
        // Start just above the visible part of the canvas
        y: Math.max(-8, -canvas.getBoundingClientRect().top / CELL) - 8 - rand() * 20,
        vx: spread * 0.006,
        vy: rand() * 0.6,
        spin: rand() * Math.PI * 2,
        vs: 0.08 + rand() * 0.14,
        light: rand() * 0.6 - 0.2,
      });
    }
    if (falling.length > 200) falling.splice(0, falling.length - 200);
    schedule();
  };

  function update() {
    const vh = window.innerHeight;
    // How much of the hoard is on screen; waterfalls only pour once it's visible
    const cr = canvas.getBoundingClientRect();
    reveal = Math.max(0, Math.min(1, (vh - cr.top) / cr.height));

    // Clear zone: the content column stays empty above the lowest visible chart
    const rect = content?.getBoundingClientRect();
    let clearY = -1;
    for (const el of avoid) {
      const r = el.getBoundingClientRect();
      if (r.bottom > cr.top) clearY = Math.max(clearY, Math.ceil((r.bottom - cr.top + 12) / CELL));
    }
    clip = rect
      ? { from: Math.floor((rect.left - 16) / CELL), to: Math.ceil((rect.right + 16) / CELL), y: clearY }
      : { from: 0, to: 0, y: -1 };
  }

  const onScroll = () => {
    update();
    const dy = Math.abs(window.scrollY - lastY);
    lastY = window.scrollY;
    // Waterfalls only once the hoard is in view
    if (!reduced && reveal > 0.25 && dy > 0) pour(Math.min(10, Math.ceil(dy / 50)));
    else schedule();
  };

  window.addEventListener('resize', resize);
  window.addEventListener('scroll', onScroll, { passive: true });
  resize();
  draw();
  return { resize };
}
