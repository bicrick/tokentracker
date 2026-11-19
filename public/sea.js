// Page background: a dragon's hoard of dithered gold resting on the footer.
//
// Composition: an orderly sea of coins across the bottom, smooth heaped piles
// in the side margins when they're wide enough, and small hand-stacked groups
// of coin stacks standing in front.
//
// Layout rule: nothing is ever clipped. The hoard lives on a measured stage.
// Under the content it may only rise to just below the last content block; in
// the margins it may rise higher, but only within the margin. Every pile and
// stack is sized against the full width it occupies and shrinks to fit, or is
// left out. Static, on a coarse square-pixel grid with 8×8 ordered dithering.

const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
const bayer = (x, y) => (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64;

const GOLD = [[0x6e, 0x4a, 0x14], [0x8a, 0x5f, 0x1c], [0xb8, 0x86, 0x2f], [0xdb, 0xa9, 0x4c], [0xf0, 0xc4, 0x63], [0xf8, 0xdc, 0x96]];
const BLUE_DARK = [[0x16, 0x21, 0x3a], [0x1e, 0x3a, 0x6e], [0x2b, 0x5c, 0xb0], [0x4d, 0x82, 0xe0]];
// Light pages get pale water so the footer stays airy on white
const BLUE_LIGHT = [[0xee, 0xf3, 0xff], [0xd6, 0xe4, 0xff], [0xb4, 0xcc, 0xfb], [0x8c, 0xb0, 0xf6]];
const lightScheme = window.matchMedia('(prefers-color-scheme: light)');
let BLUE = lightScheme.matches ? BLUE_LIGHT : BLUE_DARK;

const COIN_H = 4; // coin face height in cells
const STEP = 2;   // vertical spacing of stacked coins
const ROW = 2.3;  // vertical spacing of rows in the coin sea

// Phones get finer pixels so the coins read as coins, not blocks
const scale = () => (window.innerWidth < 720 ? { cell: 2, coin: 11 } : { cell: 4, coin: 13 });

function rng(seed) {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

export function mountTokenSea(canvas, { content, avoid = [], ground } = {}) {
  const ctx = canvas.getContext('2d', { alpha: true });

  let CELL = 4;
  let COIN_W = 13;
  let W = 0;
  let H = 0;
  let img = null;
  let floor = 0;      // y of the ground line (top of the footer)
  let view = 0;       // viewport height in cells
  let col = [0, 0];   // content column [from, to) in cells
  let stageTop = 0;   // highest y anything may reach over the content column
  let surf = new Float32Array(0);
  let stacks = [];

  // The highest point (smallest y) allowed at column x
  const ceilingAt = (x) => {
    if (x >= col[0] && x < col[1]) return stageTop;
    return Math.max(stageTop - view * 0.45, floor - view * 0.62, 2);
  };
  // ...and across a span: the most restrictive column wins
  const ceilingOver = (x0, x1) => {
    let c = -Infinity;
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x += 1) c = Math.max(c, ceilingAt(x));
    return c;
  };

  const measure = () => {
    ({ cell: CELL, coin: COIN_W } = scale());
    W = Math.ceil(canvas.clientWidth / CELL);
    H = Math.ceil(canvas.clientHeight / CELL);
    view = Math.ceil(window.innerHeight / CELL);
    floor = H - (ground ? Math.ceil(ground.offsetHeight / CELL) : 0) - 1;

    const cr = canvas.getBoundingClientRect();
    const rect = content?.getBoundingClientRect();
    col = rect ? [Math.floor((rect.left - 8) / CELL), Math.ceil((rect.right + 8) / CELL)] : [0, 0];
    let lowest = 0;
    for (const el of avoid) {
      const r = el.getBoundingClientRect();
      if (r.height) lowest = Math.max(lowest, r.bottom - cr.top);
    }
    stageTop = Math.ceil((lowest + 28) / CELL);
  };

  const build = () => {
    const rand = rng(29);
    const room = floor - stageTop; // stage height over the content column
    const gutter = col[0];         // margin width in cells (symmetric layout)
    const wideMargins = gutter >= COIN_W * 3.5;

    // Coin sea: a calm, low swell
    const seaDepth = Math.max(4, Math.min(view * 0.08, room * 0.3));
    const seaAt = (x) => seaDepth + Math.sin(x / 23) * 1.1 + Math.sin(x / 9 + 1) * 0.5;

    // Piles: smooth bell mounds, one per side, sized to their margin
    const piles = [];
    const pileSpots = wideMargins
      ? [[gutter * 0.42, gutter * 0.5], [W - gutter * 0.42, gutter * 0.5]]
      : [[W * 0.04, W * 0.16], [W * 0.96, W * 0.16]];
    for (const [x, half] of pileSpots) {
      const top = ceilingOver(x - half * 0.6, x + half * 0.6);
      const height = Math.min(view * (wideMargins ? 0.3 : 0.12), floor - top - 2);
      if (height > seaDepth + 2) piles.push({ x, half, height });
    }

    surf = new Float32Array(W);
    for (let x = 0; x < W; x += 1) {
      let h = seaAt(x);
      for (const p of piles) {
        const d = (x - p.x) / p.half;
        h = Math.max(h, seaAt(x) + (p.height - seaAt(x)) * Math.exp(-d * d * 2.2));
      }
      // Never above the ceiling here
      surf[x] = Math.max(floor - h, ceilingAt(x) + 1);
    }

    // Stacks: stepped groups by each pile, stepping down toward the content,
    // plus a couple of short ones out in the sea. Each one is sized to fit.
    const targets = [];
    if (wideMargins) {
      const heights = [0.4, 0.3, 0.21];
      for (const side of [-1, 1]) {
        let x = side < 0 ? gutter * 0.78 : W - gutter * 0.78;
        heights.forEach((h) => {
          targets.push({ x, h: view * h });
          x -= side * (COIN_W + 1 + rand() * 3);
        });
      }
      targets.push({ x: W * 0.43, h: room * 0.3 }, { x: W * 0.58, h: room * 0.22 });
    } else {
      targets.push(
        { x: W * 0.2, h: room * 0.55 }, { x: W * 0.2 + COIN_W + 2, h: room * 0.38 },
        { x: W * 0.5, h: room * 0.22 },
        { x: W * 0.8, h: room * 0.48 }, { x: W * 0.8 - COIN_W - 2, h: room * 0.32 },
      );
    }

    stacks = [];
    for (const t of targets) {
      const half = COIN_W / 2 + 2.5; // coin half-width plus the drift allowance
      const top = ceilingOver(t.x - half, t.x + half);
      const base = groundUnder(t.x, half) + 2;
      const fit = base - top - 3;
      const height = Math.min(t.h * (0.88 + rand() * 0.24), fit);
      const count = Math.floor(height / STEP);
      if (count < 4) continue; // no room: leave it out rather than clip it
      let drift = 0;
      const lean = (rand() - 0.5) * 0.05;
      const offsets = [];
      for (let i = 0; i < count; i += 1) {
        drift = Math.max(-1.8, Math.min(1.8, drift * 0.9 + lean + (rand() - 0.5) * 0.4));
        offsets.push(drift + (rand() - 0.5) * (rand() < 0.08 ? 1.2 : 0.6));
      }
      stacks.push({ x: t.x, base, count, offsets, shade: (rand() - 0.5) * 0.3, spill: rand() < 0.5 ? (rand() < 0.5 ? -1 : 1) : 0 });
    }
  };

  const surface = (x) => surf[Math.max(0, Math.min(W - 1, Math.round(x)))] ?? floor;
  // Lowest ground under a footprint: a stack on a slope must reach down to it,
  // or a gap opens under its downhill side
  const groundUnder = (x, half) => {
    let y = -Infinity;
    for (let i = Math.floor(x - half); i <= Math.ceil(x + half); i += 1) y = Math.max(y, surface(i));
    return y;
  };

  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= W || y > floor) return;
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

  // One coin seen slightly from above: a lit elliptical face over a darker rim
  const coin = (cx, cy, light, turn = 1) => {
    const a = Math.max(1, (COIN_W / 2) * turn);
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
    const rand = rng(7);

    // Water: a dithered glow behind the hoard, deep blue under the ground line
    const band = view * 0.12;
    const top = floor - band;
    for (let y = Math.max(0, Math.floor(top)); y <= floor; y += 1) {
      const t = (y - top) / (floor - top || 1);
      for (let x = 0; x < W; x += 1) {
        const v = t ** 1.8 * 2.4 - 0.5;
        if (v > bayer(x, y)) {
          const i = (y * W + x) * 4;
          const c = pick(BLUE, v, x, y);
          img.data.set([c[0], c[1], c[2], 255], i);
        }
      }
    }
    for (let y = floor + 1; y < H; y += 1) {
      const t = (y - floor) / (H - floor || 1);
      for (let x = 0; x < W; x += 1) {
        const v = 1.5 - t * 1.9 + Math.sin(x / 23 + y / 3) * 0.08;
        if (v > -0.6 * bayer(x, y)) {
          const c = pick(BLUE, Math.max(0, v), x, y);
          img.data.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
        }
      }
    }

    // Solid core: the whole pile is gold behind the coins, so nothing shows
    // through where the rows don't tile perfectly
    for (let x = 0; x < W; x += 1) {
      const t0 = Math.ceil(surface(x)) + 2;
      for (let y = t0; y <= floor; y += 1) {
        const depth = (y - t0) / Math.max(1, floor - t0);
        put(x, y, pick(GOLD, 2.1 - depth * 0.9 + Math.sin(x / 3 + y) * 0.15, x, y));
      }
    }

    // Coin sea and piles: even staggered rows, deepest first so the surface
    // sits on top. Each coin stays fully below the surface line, so the pile
    // edge is the surface itself, never a ragged overshoot.
    let deepest = 0;
    for (let x = 0; x < W; x += 1) deepest = Math.max(deepest, floor - surface(x));
    const rows = Math.ceil(deepest / ROW) + 1;
    const pitch = COIN_W * 0.78;
    for (let d = rows; d >= 0; d -= 1) {
      const offset = (d % 2) * pitch * 0.5;
      for (let x = -COIN_W + offset; x < W + COIN_W; x += pitch) {
        const jx = x + (rand() - 0.5) * 1.2;
        const s = Math.max(surface(jx - COIN_W / 2), surface(jx), surface(jx + COIN_W / 2));
        const y = s + COIN_H / 2 + d * ROW + rand() * 0.5;
        if (y > floor + 2) continue;
        const slope = surface(jx + 2) - surface(jx - 2);
        const lit = Math.max(-0.4, Math.min(0.4, -slope * 0.1));
        const shade = d === 0 ? 0.3 + lit : lit * 0.5 - Math.min(1.2, d * 0.06) - 0.12;
        coin(jx, y, shade, 0.9 + rand() * 0.1);
      }
    }

    // Stacks in front, standing on the sea
    for (const st of stacks) {
      const base = st.base + 1;
      if (st.spill) coin(st.x + st.spill * COIN_W * 0.9, base - 1, 0.35, 0.7);
      for (let i = 0; i < st.count; i += 1) {
        const band = i % 7 === 0 ? -0.3 : 0;
        coin(st.x + st.offsets[i], base - i * STEP, (i === st.count - 1 ? 0.55 : band) + st.shade);
      }
    }

    ctx.putImageData(img, 0, 0);
    // Layout for tests and debugging
    canvas.hoard = { cell: CELL, coin: COIN_W, floor, surf, stacks: stacks.map((st) => ({ x: st.x, base: st.base })) };
  };

  const render = () => {
    measure();
    canvas.width = W;
    canvas.height = H;
    img = ctx.createImageData(W, H);
    build();
    draw();
  };

  // Content above (charts, terminal) fills in after load and moves the stage,
  // so redraw whenever the page or the viewport changes size
  let last = '';
  const check = () => {
    const key = `${canvas.clientWidth}x${canvas.clientHeight}x${window.innerHeight}`;
    if (key !== last) {
      last = key;
      render();
    }
  };
  new ResizeObserver(check).observe(document.body);
  window.addEventListener('resize', check);
  lightScheme.addEventListener?.('change', (e) => {
    BLUE = e.matches ? BLUE_LIGHT : BLUE_DARK;
    draw();
  });
  check();
  return { resize: render };
}
