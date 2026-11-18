// Tiny zero-dependency terminal UI: colors, spinners, prompts, boxes.
import readline from 'node:readline';

const out = process.stdout;
export const isTTY = !!(out.isTTY && process.stdin.isTTY);
const useColor = out.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  under: wrap(4, 24),
  blue: wrap('38;5;69', 39),
  sky: wrap('38;5;111', 39),
  green: wrap('38;5;78', 39),
  red: wrap('38;5;203', 39),
  amber: wrap('38;5;179', 39),
  gray: wrap('38;5;245', 39),
};

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const width = (s) => [...strip(s)].length;

// Exit quietly when piped into something that closes early (e.g. `| head`)
out.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

let cursorHidden = false;
function hideCursor() {
  if (isTTY && !cursorHidden) {
    out.write(HIDE);
    cursorHidden = true;
  }
}
function showCursor() {
  if (cursorHidden) {
    out.write(SHOW);
    cursorHidden = false;
  }
}
process.on('exit', showCursor);
process.on('SIGINT', () => {
  showCursor();
  out.write('\n');
  process.exit(130);
});

export const sym = {
  ok: c.green('✓'),
  fail: c.red('✗'),
  dot: c.gray('·'),
  arrow: c.blue('❯'),
  star: c.blue('✻'),
  skip: c.gray('○'),
};

export function line(s = '') {
  out.write(`${s}\n`);
}

/** Small block heatmap used as the logo. */
export function logo() {
  const shades = [c.gray('▪'), c.sky('▪'), c.blue('▪'), c.blue('■')];
  const rows = ['0120310231', '1031202312', '2310133021'];
  return rows.map((r) => [...r].map((d) => shades[Number(d)]).join(' '));
}

export function box(lines, { pad = 1, color = c.gray } = {}) {
  const inner = Math.max(...lines.map(width)) + pad * 2;
  const space = ' '.repeat(pad);
  line(color(`╭${'─'.repeat(inner)}╮`));
  for (const l of lines) {
    line(`${color('│')}${space}${l}${' '.repeat(inner - pad * 2 - width(l))}${space}${color('│')}`);
  }
  line(color(`╰${'─'.repeat(inner)}╯`));
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinner(text) {
  let i = 0;
  let current = text;
  let timer = null;
  const render = () => {
    out.write(`\r\x1b[2K  ${c.blue(FRAMES[i % FRAMES.length])} ${current}`);
    i += 1;
  };
  if (isTTY) {
    hideCursor();
    render();
    timer = setInterval(render, 80);
  }
  const stop = (symbol, msg) => {
    if (timer) clearInterval(timer);
    if (isTTY) out.write('\r\x1b[2K');
    line(`  ${symbol} ${msg ?? current}`);
    showCursor();
  };
  return {
    update(msg) { current = msg; },
    succeed(msg) { stop(sym.ok, msg); },
    fail(msg) { stop(sym.fail, msg); },
    skip(msg) { stop(sym.skip, c.gray(msg ?? current)); },
  };
}

/** Run an async task behind a spinner. */
export async function task(text, fn, done) {
  const s = spinner(text);
  try {
    const result = await fn(s);
    s.succeed(typeof done === 'function' ? done(result) : done ?? text);
    return result;
  } catch (err) {
    s.fail(`${text} ${c.red(err.message)}`);
    throw err;
  }
}

function readLine(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: out });
    let answered = false;
    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    // stdin ended (no terminal, nothing piped): fail clearly instead of hanging
    rl.on('close', () => {
      if (answered) return;
      line();
      line(`  ${c.red('No input available.')} Run this in a terminal, or pass flags, e.g.`);
      line(`  ${c.gray('init --yes --device <name> --hosted --handle <handle> --email <you@example.com>')}`);
      process.exit(1);
    });
  });
}

/** Free-text input with an optional default and validator returning an error string. */
export async function input(question, { initial = '', placeholder = '', validate } = {}) {
  for (;;) {
    const hint = initial ? c.gray(` (${initial})`) : placeholder ? c.gray(` ${placeholder}`) : '';
    line(`  ${c.bold(question)}${hint}`);
    const raw = (await readLine(`  ${sym.arrow} `)).trim();
    const value = raw || initial;
    const error = validate ? await validate(value) : null;
    if (!error) {
      if (isTTY) {
        // Collapse the prompt into a one-line answer
        out.write('\x1b[2A\r\x1b[J');
        line(`  ${sym.ok} ${question} ${c.blue(value || c.gray('skipped'))}`);
      }
      return value;
    }
    line(`    ${c.red(error)}`);
  }
}

/** Arrow-key select. Falls back to numbered input without a TTY. */
export async function select(question, options, { initial = 0 } = {}) {
  if (!isTTY) {
    line(question);
    options.forEach((o, i) => line(`  ${i + 1}) ${o.label}`));
    const raw = (await readLine(`Choose 1-${options.length} (${initial + 1}): `)).trim();
    const n = Number(raw || initial + 1) - 1;
    return options[Math.min(Math.max(n, 0), options.length - 1)].value;
  }

  return new Promise((resolve) => {
    let index = initial;
    let drawn = 0;
    const render = () => {
      if (drawn) out.write(`\x1b[${drawn}A\r\x1b[J`);
      const lines = [`  ${c.bold(question)}`];
      options.forEach((o, i) => {
        const active = i === index;
        lines.push(`  ${active ? sym.arrow : ' '} ${active ? c.blue(o.label) : o.label}`);
        if (o.hint) lines.push(`      ${c.gray(o.hint)}`);
      });
      lines.push(c.gray('    ↑/↓ to move · enter to select'));
      out.write(`${lines.join('\n')}\n`);
      drawn = lines.length;
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    hideCursor();
    render();

    const onKey = (_, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        showCursor();
        out.write('\n');
        process.exit(130);
      }
      if (key.name === 'up' || key.name === 'k') index = (index - 1 + options.length) % options.length;
      else if (key.name === 'down' || key.name === 'j') index = (index + 1) % options.length;
      else if (key.name === 'return') {
        process.stdin.off('keypress', onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        out.write(`\x1b[${drawn}A\r\x1b[J`);
        line(`  ${sym.ok} ${question} ${c.blue(options[index].label)}`);
        showCursor();
        resolve(options[index].value);
        return;
      } else return;
      render();
    };
    process.stdin.on('keypress', onKey);
  });
}

/**
 * Checklist: ↑/↓ to move, space to toggle, enter to confirm.
 * options: [{ value, label, hint, checked, disabled }]. Returns checked values.
 */
export async function multiselect(question, options) {
  const state = options.map((o) => !!o.checked);
  if (!isTTY) return options.filter((_, i) => state[i]).map((o) => o.value);

  return new Promise((resolve) => {
    let index = Math.max(0, options.findIndex((o) => !o.disabled));
    let drawn = 0;
    const render = () => {
      if (drawn) out.write(`\x1b[${drawn}A\r\x1b[J`);
      const lines = [`  ${c.bold(question)}`];
      options.forEach((o, i) => {
        const active = i === index;
        const box = o.disabled ? c.gray('·') : state[i] ? c.green('◼') : c.gray('◻');
        const label = o.disabled ? c.gray(o.label) : active ? c.blue(o.label) : o.label;
        lines.push(`  ${active ? sym.arrow : ' '} ${box} ${label}${o.hint ? `  ${c.gray(o.hint)}` : ''}`);
      });
      lines.push(c.gray('    ↑/↓ move · space toggle · enter confirm'));
      out.write(`${lines.join('\n')}\n`);
      drawn = lines.length;
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    hideCursor();
    render();

    const move = (step) => {
      for (let n = 0; n < options.length; n += 1) {
        index = (index + step + options.length) % options.length;
        if (!options[index].disabled) break;
      }
    };

    const onKey = (_, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        showCursor();
        out.write('\n');
        process.exit(130);
      }
      if (key.name === 'up' || key.name === 'k') move(-1);
      else if (key.name === 'down' || key.name === 'j') move(1);
      else if (key.name === 'space' && !options[index].disabled) state[index] = !state[index];
      else if (key.name === 'return') {
        process.stdin.off('keypress', onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        out.write(`\x1b[${drawn}A\r\x1b[J`);
        const picked = options.filter((_, i) => state[i]);
        line(`  ${sym.ok} ${question} ${c.blue(picked.map((o) => o.label).join(', ') || 'none')}`);
        showCursor();
        resolve(picked.map((o) => o.value));
        return;
      } else return;
      render();
    };
    process.stdin.on('keypress', onKey);
  });
}

export function formatTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}
