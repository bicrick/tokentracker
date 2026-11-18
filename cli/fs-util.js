import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const PLATFORM = process.platform;

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Expand a leading ~ and env vars like $HOME / %APPDATA%. */
export function expand(p) {
  return p
    .replace(/^~(?=$|[\\/])/, HOME)
    .replace(/\$([A-Z_][A-Z0-9_]*)|%([A-Z_][A-Z0-9_]*)%/gi, (_, a, b) => process.env[a || b] ?? '');
}

export function tildify(p) {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

export const xdgData = () => process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
export const xdgConfig = () => process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');

/** Per-OS app-data root that Electron/VS Code-family editors use for userData. */
export function appDataRoot() {
  if (PLATFORM === 'darwin') return path.join(HOME, 'Library', 'Application Support');
  if (PLATFORM === 'win32') return process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  return xdgConfig();
}

export const EDITORS = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium', 'Kiro', 'Trae'];

/** globalStorage folders for an extension id across every installed VS Code-family editor. */
export function extensionStorageDirs(extId) {
  const roots = EDITORS.map((app) => path.join(appDataRoot(), app, 'User', 'globalStorage', extId));
  for (const server of ['.vscode-server', '.cursor-server', '.windsurf-server']) {
    roots.push(path.join(HOME, server, 'data', 'User', 'globalStorage', extId));
  }
  return roots.filter(exists);
}

/** Recursively yield files under dir whose names pass the filter. Skips unreadable dirs. */
export function* walk(dir, filter, depth = 8) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) yield* walk(full, filter, depth - 1);
    } else if (filter(entry.name, full)) {
      yield full;
    }
  }
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Yield parsed JSON objects from a JSONL file, skipping malformed lines. */
export function* readJsonl(file, mustInclude) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (!line || (mustInclude && !line.includes(mustInclude))) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // partial line from a file being written
    }
  }
}

export function unique(list) {
  return [...new Set(list)];
}
