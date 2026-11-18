// Ambient rain: dithered gold tokens drifting down the side margins in slow
// motion, forever. A fixed layer behind the content; only drawn where there's
// room beside the content column, and paused when the tab is hidden.

const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
const RAMP = ['#8a5f1c', '#b8862f', '#DBA94C', '#F0C463', '#f8dc96'];
const CELL = 4;   // screen px per dithered pixel
const R = 5;      // coin radius in cells
const GAP = 24;   // px kept clear beside the content

export function mountRain(canvas, { content, density = 1 / 9000 } = {}) {
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0;
  let H = 0;
  let lanes = [];
  let coins = [];
  let raf = 0;
  let last = 0;

  const spawn = (lane, anywhere) => ({
    lane,
    x: lane[0] + R + Math.random() * Math.max(0, lane[1] - lane[0] - 2 * R),
    y: anywhere ? Math.random() * H : -R * 2 - Math.random() * H * 0.3,
    vy: 1.2 + Math.random() * 1.6,          // cells per second: slow motion
    sway: Math.random() * Math.PI * 2,
    spin: Math.random() * Math.PI * 2,
    vs: 0.5 + Math.random() * 0.9,          // radians per second
    size: 0.6 + Math.random() * 0.55,
  });

  const resize = () => {
    W = Math.ceil(window.innerWidth / CELL);
    H = Math.ceil(window.innerHeight / CELL);
    canvas.width = W;
    canvas.height = H;
    const r = content?.getBoundingClientRect();
    lanes = [];
    if (r) {
      const left = [1, Math.floor((r.left - GAP) / CELL)];
      const right = [Math.ceil((r.right + GAP) / CELL), W - 1];
      for (const l of [left, right]) if (l[1] - l[0] >= R * 2 + 2) lanes.push(l);
    }
    coins = [];
    for (const lane of lanes) {
      const n = Math.max(2, Math.round((lane[1] - lane[0]) * H * CELL * CELL * density));
      for (let i = 0; i < n; i += 1) coins.push(spawn(lane, true));
    }
  };

  const drawCoin = (c) => {
    const cos = Math.cos(c.spin);
    const rx = Math.max(0.6, R * c.size * Math.abs(cos));
    const ry = R * c.size;
    const back = cos < 0;
    for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy += 1) {
      for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx += 1) {
        const nx = dx / rx;
        const ny = dy / ry;
        const r = nx * nx + ny * ny;
        if (r > 1) continue;
        const px = Math.round(c.x + dx);
        const py = Math.round(c.y + dy);
        if (py < 0 || py >= H) continue;
        const rim = r > 0.55;
        let v = (rim ? 3 : 2) + (back ? -nx : nx) * -0.5 - ny * 0.5 + (back ? -0.4 : 0.2);
        if (Math.abs(cos) < 0.35) v = 1.4 - ny * 0.4; // edge-on: just the rim
        const lo = Math.floor(v);
        const t = (BAYER8[(py & 7) * 8 + (px & 7)] + 0.5) / 64;
        ctx.fillStyle = RAMP[Math.max(0, Math.min(RAMP.length - 1, v - lo > t ? lo + 1 : lo))];
        ctx.fillRect(px, py, 1, 1);
      }
    }
  };

  const frame = (now) => {
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < coins.length; i += 1) {
      const c = coins[i];
      c.y += c.vy * dt * 4;
      c.sway += dt * 0.6;
      c.x += Math.sin(c.sway) * dt * 0.8;
      c.spin += c.vs * dt;
      if (c.y - R > H) coins[i] = spawn(c.lane, false);
      else drawCoin(c);
    }
    raf = requestAnimationFrame(frame);
  };

  const start = () => {
    cancelAnimationFrame(raf);
    last = 0;
    if (!document.hidden && !reduced) raf = requestAnimationFrame(frame);
  };

  resize();
  window.addEventListener('resize', () => { resize(); if (reduced) { for (const c of coins) drawCoin(c); } });
  document.addEventListener('visibilitychange', start);
  if (reduced) for (const c of coins) drawCoin(c);
  start();
}
