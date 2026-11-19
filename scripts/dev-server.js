// Local preview server for the static site: serves public/ with clean URLs and
// proxies /api/* to production so pages render with real data.
// Usage: node scripts/dev-server.js  (PORT and API_ORIGIN are overridable)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = Number(process.env.PORT) || 3200;
const API_ORIGIN = process.env.API_ORIGIN || 'https://tokentracker-nu.vercel.app';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

async function file(path) {
  try {
    const s = await stat(path);
    return s.isFile() ? path : null;
  } catch {
    return null;
  }
}

async function resolve(pathname) {
  if (pathname.startsWith('/u/')) pathname = '/u';
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const base = join(ROOT, safe);
  return (await file(base)) || (await file(`${base}.html`)) || (await file(join(base, 'index.html')));
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    try {
      const upstream = await fetch(API_ORIGIN + url.pathname + url.search, { headers: { accept: req.headers.accept || '*/*' } });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`API proxy failed: ${err.message}`);
    }
    return;
  }

  const path = await resolve(decodeURIComponent(url.pathname));
  if (!path) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(await readFile(path));
}).listen(PORT, () => {
  console.log(`tokentracker preview on http://localhost:${PORT} (api → ${API_ORIGIN})`);
});
