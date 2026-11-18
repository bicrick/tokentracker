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
