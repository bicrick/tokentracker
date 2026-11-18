import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { addRow, dayOf } from '../day.js';
import { exists, HOME, walk } from '../fs-util.js';

// DeepSeek Harness (dsh): ~/.dsh/sessions/<project>/<session>/session[.vN].jsonl[.zstd]
// One usage record per model call. Format docs: docs/research/deepseek.md
const KNOWN_VERSIONS = new Set([0, 1, 2, 3, 4]);
const FILE_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;

/**
 * Split a buffer of concatenated zstd frames. dsh appends one frame per write,
 * and Node's decompressor stops after the first, so walk the frame headers.
 * Returns complete frames only; a truncated final frame (session still being
 * written) is dropped and picked up on the next sync.
 */
export function zstdFrames(buf) {
  const frames = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const magic = buf.readUInt32LE(i);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      // Skippable frame: 4-byte magic + 4-byte size + payload
      if (i + 8 > buf.length) break;
      i += 8 + buf.readUInt32LE(i + 4);
      continue;
    }
    if (magic !== 0xfd2fb528) break;
    let p = i + 4;
    if (p >= buf.length) break;
    const fhd = buf[p];
    p += 1;
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!single) p += 1; // window descriptor
    p += [0, 1, 2, 4][dictFlag];
    p += [single ? 1 : 0, 2, 4, 8][fcsFlag];
    let last = 0;
    while (!last) {
      if (p + 3 > buf.length) return frames;
      const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      p += 3;
      last = header & 1;
      const type = (header >> 1) & 3;
      const size = header >> 3;
      p += type === 1 ? 1 : size; // RLE blocks store one byte
    }
    if (checksum) p += 4;
    if (p > buf.length) break;
    frames.push(buf.subarray(i, p));
    i = p;
  }
  return frames;
}

function readText(file) {
  const buf = fs.readFileSync(file);
  if (!file.endsWith('.zstd')) return buf.toString('utf8');
  if (typeof zlib.zstdDecompressSync !== 'function') return ''; // Node without zstd
  return zstdFrames(buf).map((f) => {
    try {
      return zlib.zstdDecompressSync(f).toString('utf8');
    } catch {
      return '';
    }
  }).join('');
}

/** Pick the current generation in each session directory (highest .vN). */
function sessionFiles(root) {
  const best = new Map();
  for (const file of walk(root, (n) => FILE_RE.test(n), 6)) {
    const m = FILE_RE.exec(path.basename(file));
    const gen = Number(m[1] || 0);
    const dir = path.dirname(file);
    const cur = best.get(dir);
    // Prefer the higher generation; within one, prefer the plain file (it's complete)
    if (!cur || gen > cur.gen || (gen === cur.gen && cur.zstd && !m[2])) best.set(dir, { file, gen, zstd: !!m[2] });
  }
  return [...best.values()].map((b) => b.file);
}

const usageFrom = (data) => {
  if (data?.usage) return data.usage;
  const chunks = (data?.stream || []).filter((s) => s?.type === 'chunk' && s.chunk?.type === 'usage');
  return chunks.at(-1)?.chunk?.usage || null;
};

export default {
  id: 'deepseek-harness',
  name: 'DeepSeek Harness',
  detect() {
    const root = process.env.DSH_HOME || path.join(HOME, '.dsh');
    return exists(root) ? [root] : [];
  },
  collect(rows, roots) {
    const seen = new Set();
    let count = 0;
    for (const root of roots) {
      for (const file of sessionFiles(root)) {
        let text;
        try {
          text = readText(file);
        } catch {
          continue;
        }
        const events = [];
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            events.push(JSON.parse(line));
          } catch {
            // partial line
          }
        }
        const header = events[0];
        if (header?.type !== 'session' || !KNOWN_VERSIONS.has(Number(header.version ?? 0))) continue;
        const sessionId = header.id;

        // Forked sessions copy the parent's log: skip everything inherited
        let startAt = 0;
        events.forEach((e, k) => {
          if (e.type === 'session/end-seed' && e.data?.inherited) startAt = k + 1;
        });

        let provider = 'deepseek';
        let model = 'unknown';
        for (let k = 1; k < events.length; k += 1) {
          const e = events[k];
          if (e.type === 'request/header' && e.data?.header?.config) {
            provider = e.data.header.config.provider || provider;
            model = e.data.header.config.model || model;
            continue;
          }
          if (e.type === 'request/context' && e.data?.model) {
            provider = e.data.provider || provider;
            model = e.data.model;
            continue;
          }
          if (k < startAt) continue;
          const isCall = e.type === 'assistant/message' || e.type === 'assistant/attempt';
          const isCompaction = e.type === 'compaction/summary';
          if (!isCall && !isCompaction) continue;
          const u = usageFrom(e.data);
          if (!u || !e.time) continue;
          const key = `${sessionId}:${e.seq}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const reasoning = Math.min(u.reasoningTokens || 0, u.outputTokens || 0);
          const useProvider = isCompaction ? e.data.provider || provider : provider;
          const useModel = isCompaction ? e.data.model || model : model;
          addRow(rows, {
            date: dayOf(e.time),
            source: 'deepseek-harness',
            model: `${useProvider}/${useModel}`,
            usage: {
              input: u.inputTokens || 0, // already uncached-only in dsh
              output: (u.outputTokens || 0) - reasoning,
              reasoning,
              cacheRead: u.cacheReadTokens || 0,
              cacheWrite: u.cacheWriteTokens || 0,
            },
          });
          count += 1;
        }
      }
    }
    return count;
  },
};
