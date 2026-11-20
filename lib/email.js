// Transactional email via Resend's HTTP API (no SDK needed).
const FROM = () => process.env.TOKENTRACK_EMAIL_FROM || 'tokentracker <onboarding@resend.dev>';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('email is not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM(), to: [to], subject, html, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`email send failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** The sign-in email: one button, plain-text fallback, no tracking. */
export function signInEmail({ link, purpose, handle, device }) {
  const action = purpose === 'signup' ? `create @${handle}` : purpose === 'web' ? 'open your settings' : 'sign in';
  const where = device ? ` on <b>${esc(device)}</b>` : '';
  const html = `<!doctype html><html><body style="margin:0;padding:32px;background:#121317;font-family:ui-monospace,Menlo,monospace;color:#ecece8">
  <div style="max-width:460px;margin:0 auto">
    <p style="font-size:14px;margin:0 0 20px"><span style="color:#f0c463">●</span> tokentracker</p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 24px">Click below to ${esc(action)}${where}.</p>
    <a href="${esc(link)}" style="display:inline-block;background:#6b9eff;color:#0b1020;padding:12px 20px;text-decoration:none;font-size:14px">Continue to tokentracker</a>
    <p style="font-size:12px;line-height:1.6;color:#8b8e97;margin:24px 0 0">This link expires in 15 minutes and works once. If you didn't request it, ignore this email.</p>
  </div></body></html>`;
  const text = `Click to ${action}${device ? ` on ${device}` : ''}:\n\n${link}\n\nThis link expires in 15 minutes and works once. If you didn't request it, ignore this email.`;
  return { subject: purpose === 'signup' ? `Create @${handle} on tokentracker` : 'Sign in to tokentracker', html, text };
}

/** Sent once when a machine that used to upload has gone quiet. */
export function staleEmail({ handle, device, lastSync, settingsUrl }) {
  const when = new Date(lastSync).toUTCString().slice(0, 16);
  const cmd = 'npx @bicrick/tokentracker init';
  const html = `<!doctype html><html><body style="margin:0;padding:32px;background:#121317;font-family:ui-monospace,Menlo,monospace;color:#ecece8">
  <div style="max-width:480px;margin:0 auto">
    <p style="font-size:14px;margin:0 0 20px"><span style="color:#f0c463">●</span> tokentracker</p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 16px"><b>${esc(device)}</b> hasn't uploaded token usage to @${esc(handle)} since ${esc(when)}.</p>
    <p style="font-size:13px;line-height:1.6;color:#b9bbc2;margin:0 0 12px">Usually Node.js was updated or removed, or the background job was turned off. On that machine, run:</p>
    <p style="font-size:13px;background:#1c1e24;padding:10px 12px;margin:0 0 20px">${cmd}</p>
    <p style="font-size:13px;line-height:1.6;color:#b9bbc2;margin:0 0 24px">It will recognise the machine and pick up where it left off, nothing is counted twice. If you've stopped using it, remove it in <a href="${esc(settingsUrl)}" style="color:#6b9eff">settings</a> and we won't email about it again.</p>
    <p style="font-size:12px;color:#8b8e97;margin:0">We send this once per machine each time it stops syncing.</p>
  </div></body></html>`;
  const text = `${device} hasn't uploaded token usage to @${handle} since ${when}.\n\nOn that machine, run:\n  ${cmd}\n\nIt recognises the machine, so nothing is counted twice. Not using it any more? Remove it at ${settingsUrl}\n\nWe send this once per machine each time it stops syncing.`;
  return { subject: `${device} stopped syncing to tokentracker`, html, text };
}
