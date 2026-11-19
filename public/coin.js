// Hero mark: the token coin, spun in 3D and rendered with 8×8 ordered (Bayer)
// dithering on a coarse square-pixel grid. Ordered dithering is stable frame to
// frame, so the shading reads as texture rather than noise while it turns.

const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

// Gold ramp, darkest to lightest. Shading picks between neighbours via dither.
const RAMP = ['#8a5f1c', '#b8862f', '#DBA94C', '#F0C463', '#f8dc96'];

const TILT = -0.32;    // radians the spin axis leans, so it turns at a cant
const RIM = 1;        // outer ring of the face, in coin radii
const INNER = 0.712;  // inner disc radius (168/236 in the logo)
const STAR = 0.42;    // star size in coin radii

// 4-point concave star like the logo's: astroid-style superellipse.
function inStar(x, y) {
  const p = 0.78;
  return Math.abs(x / STAR) ** p + Math.abs(y / STAR) ** p < 1;
}

export function mountCoin(canvas, { cells = 72 } = {}) {
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let raf = 0;
  let visible = true;

  const resize = () => {
    const px = canvas.clientWidth;
    canvas.width = cells;
    canvas.height = cells;
    canvas.style.height = `${px}px`;
  };

  const draw = (time) => {
    renderCoin(ctx, cells, reduced ? 0.35 : (time / 7000) * Math.PI * 2);
    if (!reduced && visible) raf = requestAnimationFrame(draw);
  };

  // Only animate while on screen
  const io = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    cancelAnimationFrame(raf);
    if (visible) raf = requestAnimationFrame(draw);
  });

  resize();
  window.addEventListener('resize', resize);
  io.observe(canvas);
  raf = requestAnimationFrame(draw);
}

const HALF = 0.09; // half the coin's thickness, in coin radii
// Fixed light from the upper left, towards the viewer (who looks along +z)
const LIGHT = (() => {
  const v = [-0.45, -0.55, -0.7];
  const m = Math.hypot(...v);
  return v.map((x) => x / m);
})();

/**
 * Draw one frame of the coin at the given turn angle onto a cells×cells context.
 * The coin is a real 3D disc (two faces and a rim) spinning about its vertical
 * axis, ray-cast per pixel with a fixed light, so it reads as one continuous
 * revolution: the rim and the highlight keep moving the same way all the way round.
 */
export function renderCoin(ctx, cells, angle) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const ct = Math.cos(TILT);
  const st = Math.sin(TILT);
  ctx.clearRect(0, 0, cells, cells);
  const half = cells / 2;
  const radius = half * 0.86;

  for (let py = 0; py < cells; py += 1) {
    for (let px = 0; px < cells; px += 1) {
      const ux = (px + 0.5 - half) / radius;
      const uy = (py + 0.5 - half) / radius;
      // Screen into the tilted frame
      const x = ux * ct - uy * st;
      const y = ux * st + uy * ct;
      if (Math.abs(y) > 1) continue;

      // Ray (x, y, z), z increasing away from the viewer. In coin space:
      //   x' = x cos a - z sin a,  z' = x sin a + z cos a
      let best = Infinity;
      let kind = null; // 'face' | 'rim'
      let lx = 0;
      let face = 0;

      if (Math.abs(ca) > 1e-4) {
        for (const side of [-1, 1]) {
          const z = (side * HALF - x * sa) / ca;
          const fx = x * ca - z * sa;
          const r = Math.hypot(fx, y);
          if (r <= RIM && !inStar(fx * side, y) && z < best) {
            best = z;
            kind = 'face';
            lx = fx * side; // mirror the back so it isn't a reflection of the front
            face = side;
          }
        }
      }
      if (Math.abs(sa) > 1e-4) {
        const w = Math.sqrt(1 - y * y);
        for (const xr of [-w, w]) {
          const z = (x * ca - xr) / sa;
          const zr = x * sa + z * ca;
          if (Math.abs(zr) <= HALF && z < best) {
            best = z;
            kind = 'rim';
            lx = xr;
          }
        }
      }
      if (!kind) continue;

      // World-space normal of what we hit, facing the viewer
      let n;
      if (kind === 'face') n = [face * sa, 0, face * ca];
      else n = [lx * ca, y, -lx * sa];
      if (n[2] > 0) n = n.map((v) => -v);
      const diffuse = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);

      let value;
      if (kind === 'face') {
        const r = Math.hypot(lx, y);
        value = (r > INNER ? 3 : 2) + (diffuse - 0.55) * 2.2 + (face > 0 ? -0.25 : 0);
        if (r > INNER && r < INNER + 0.05) value -= 0.6; // bevel line
      } else {
        value = 1 + (diffuse - 0.4) * 2;
      }

      const threshold = (BAYER8[(py % 8) * 8 + (px % 8)] + 0.5) / 64;
      const lo = Math.floor(value);
      const idx = Math.min(RAMP.length - 1, Math.max(0, value - lo > threshold ? lo + 1 : lo));
      ctx.fillStyle = RAMP[idx];
      ctx.fillRect(px, py, 1, 1);
    }
  }
}
