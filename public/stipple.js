// Page backdrop: a stippled dot screen. One square dot per cell, switched on by
// an 8×8 ordered (Bayer) threshold against a soft noise field, the same dither
// as the coin and the hoard. Dense in the side gutters, nearly empty behind the
// text column. Static and anchored to the page.

const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
const bayer = (x, y) => (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64;

const CELL = 4;      // screen px per stipple cell (matches the hoard's pixel grid)
const DOT = 2;       // dot size inside a cell, so dense areas stay a screen, not a fill

// [dim, mid, accent] per scheme. Accent is gold, used only where the field peaks.
const SCHEMES = {
  dark: { dim: [0x2a, 0x2d, 0x36], mid: [0x24, 0x3a, 0x66], gold: [0x8a, 0x5f, 0x1c] },
  light: { dim: [0xdf, 0xe1, 0xe6], mid: [0xc6, 0xd6, 0xf5], gold: [0xe8, 0xc9, 0x86] },
};

// Smooth 2D value noise on a hashed lattice
function hash(x, y) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y) => noise(x, y) * 0.65 + noise(x * 2.1 + 17, y * 2.1 + 9) * 0.35;

export function mountStipple(canvas, { content } = {}) {
  const ctx = canvas.getContext('2d', { alpha: true });
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  let scheme = dark.matches ? SCHEMES.dark : SCHEMES.light;

  let W = 0;
  let H = 0;
  let img = null;
  let colFrom = 0;
  let colTo = 0;

  // Covers the whole page and scrolls with it. Drawn once per size: the pattern
  // never changes while scrolling, so nothing shimmers.
  const resize = () => {
    canvas.style.height = '0px'; // don't let our own height count toward the page's
    const pageH = document.documentElement.scrollHeight;
    canvas.style.height = `${pageH}px`;
    W = Math.ceil(document.documentElement.clientWidth / CELL);
    H = Math.ceil(pageH / CELL);
    canvas.width = W * DOT;
    canvas.height = H * DOT;
    img = ctx.createImageData(canvas.width, canvas.height);
    const r = content?.getBoundingClientRect();
    colFrom = r ? r.left / CELL : W;
    colTo = r ? r.right / CELL : W;
    draw();
  };

  // 0 inside the text column, easing up to 1 a little way into the gutters
  const gutter = (x) => {
    if (colTo <= colFrom) return 1;
    const d = x < colFrom ? colFrom - x : x > colTo ? x - colTo : -Math.min(x - colFrom, colTo - x);
    const t = Math.max(0, Math.min(1, (d + 6) / 28));
    return t * t * (3 - 2 * t);
  };

  const dot = (cx, cy, rgb) => {
    // One pixel in the top-left of a DOT×DOT cell; the rest stays empty
    const i = (cy * DOT * canvas.width + cx * DOT) * 4;
    img.data[i] = rgb[0];
    img.data[i + 1] = rgb[1];
    img.data[i + 2] = rgb[2];
    img.data[i + 3] = 255;
  };

  function draw() {
    img.data.fill(0);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const field = fbm(x / 46, y / 46);
        const g = gutter(x);
        const v = (field - 0.3) * 0.9 * (0.12 + 0.88 * g);
        if (v <= bayer(x, y)) continue;
        const rgb = v > 0.62 && field > 0.78 ? scheme.gold : v > 0.36 ? scheme.mid : scheme.dim;
        dot(x, y, rgb);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  let lastSize = '';
  const check = () => {
    const size = `${document.documentElement.clientWidth}x${document.documentElement.scrollHeight}`;
    if (size !== lastSize) {
      lastSize = size;
      resize();
    }
  };
  new ResizeObserver(check).observe(document.body);
  window.addEventListener('resize', check);
  dark.addEventListener?.('change', (e) => {
    scheme = e.matches ? SCHEMES.dark : SCHEMES.light;
    draw();
  });
  check();
}
