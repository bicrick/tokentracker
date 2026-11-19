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

/** Draw one frame of the coin at the given turn angle onto a cells×cells context. */
export function renderCoin(ctx, cells, angle) {
  {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const squash = Math.max(Math.abs(c), 0.04);
    const thick = 0.12 * Math.abs(s);
    // Light sweeps across the face as it turns
    const light = 0.5 + 0.5 * Math.sin(angle + 0.8);

    ctx.clearRect(0, 0, cells, cells);
    const half = cells / 2;
    const radius = half * 0.86;

    for (let py = 0; py < cells; py += 1) {
      for (let px = 0; px < cells; px += 1) {
        const ux = (px + 0.5 - half) / radius;
        const uy = (py + 0.5 - half) / radius;
        // Rotate screen space into the coin's tilted frame
        const sx = ux * Math.cos(TILT) - uy * Math.sin(TILT);
        const ny = ux * Math.sin(TILT) + uy * Math.cos(TILT);
        const threshold = (BAYER8[(py % 8) * 8 + (px % 8)] + 0.5) / 64;

        // Face coordinates after undoing the horizontal squash of the turn
        // Past 90° we're looking at the back: mirror it so the turn reads as one
        // continuous revolution instead of bouncing back off the edge
        const back = c < 0;
        const fx = (sx / squash) * (back ? -1 : 1);
        const r = Math.hypot(fx, ny);

        let level = -1;
        let shade = 0;

        // The rim: the band swept between the front face and the back face,
        // which sits `thick` behind it and shifts sideways as it turns
        const inEdge = () => {
          if (Math.abs(ny) >= 1 || thick <= 0.005) return false;
          const w = squash * Math.sqrt(1 - ny * ny);
          const shift = thick * Math.sign(s);
          return sx >= Math.min(-w, -w - shift) && sx <= Math.max(w, w - shift);
        };

        if (r <= RIM && !inStar(fx, ny)) {
          const base = r > INNER ? 3 : 2;
          // Diagonal gradient plus the moving highlight
          shade = (-fx * 0.35 - ny * 0.45) * 0.6 + (light - 0.5) * 0.9 * (back ? -1 : 1) - (back ? 0.35 : 0);
          if (r > INNER && r < INNER + 0.05) shade -= 0.6; // bevel line
          level = base;
        } else if ((r > RIM || squash < 0.3) && inEdge()) {
          // Outside the face, or through the star when nearly edge-on: solid rim, not a hole
          level = 1;
          shade = 0.4 - Math.abs(ny) * 0.8;
        } else if (r <= RIM) {
          continue; // see-through star, face-on
        }

        if (level < 0) continue;
        // Ordered dither between this level and its neighbour
        const value = level + shade;
        const lo = Math.floor(value);
        const frac = value - lo;
        const idx = Math.min(RAMP.length - 1, Math.max(0, frac > threshold ? lo + 1 : lo));
        ctx.fillStyle = RAMP[idx];
        ctx.fillRect(px, py, 1, 1);
      }
    }
  }
}
