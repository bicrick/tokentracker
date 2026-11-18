import fs from 'node:fs';
import { expand, tildify } from '../fs-util.js';
import claude from './claude.js';
import codex from './codex.js';
import copilot from './copilot.js';
import gemini from './gemini.js';
import opencode from './opencode.js';
import { cline, kilo, roo } from './cline.js';

/** Every local connector, in display order. */
export const CONNECTORS = [claude, codex, opencode, gemini, copilot, cline, roo, kilo];

/** Server-side connectors (no local files). */
export const REMOTE = [
  { id: 'cursor', name: 'Cursor', hint: 'public cursor.com/@handle profile' },
];

export const byId = Object.fromEntries(CONNECTORS.map((c) => [c.id, c]));

/**
 * Resolve each connector's state from config + detection.
 * config.connections[id] = { enabled: true|false|'auto', paths?: string[] }
 * 'auto' (the default) means on when the tool is found on this machine.
 */
export function resolveConnections(config = {}) {
  const settings = config.connections || {};
  return CONNECTORS.map((connector) => {
    const s = settings[connector.id] || {};
    const detected = connector.detect();
    const custom = (s.paths || []).map(expand).filter((p) => fs.existsSync(p));
    const paths = [...new Set([...detected, ...custom])];
    const mode = s.enabled ?? 'auto';
    const enabled = mode === 'auto' ? paths.length > 0 : mode === true && paths.length > 0;
    return {
      id: connector.id,
      name: connector.name,
      connector,
      mode,
      detected: detected.length > 0,
      paths,
      displayPaths: paths.map(tildify),
      enabled,
    };
  });
}

/** Collect rows from every enabled connection. Returns per-connection reports. */
export async function collectAll(connections, rows) {
  const report = [];
  for (const conn of connections) {
    if (!conn.enabled) {
      report.push({ id: conn.id, name: conn.name, skipped: conn.paths.length ? 'off' : 'not found' });
      continue;
    }
    try {
      const messages = await conn.connector.collect(rows, conn.paths);
      report.push({ id: conn.id, name: conn.name, messages });
    } catch (err) {
      report.push({ id: conn.id, name: conn.name, error: err.message });
    }
  }
  return report;
}
