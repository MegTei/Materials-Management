// netlify/functions/send-confirmation.js
//
// Sends the AO27 confirmation email for a plan or forecast.
//
// The browser sends only { type, code, action }. The recipient is looked up server-side
// from the stored record (Supabase function email_prepare, called with the secret key),
// which also applies the sending limits:
//   - "created": once per code, ever (it delivers the Plan ID / TA-ID)
//   - "updated": at most once per code per 24 hours
//   - a global hourly ceiling across the app
// So this endpoint cannot be used to send email to arbitrary addresses.
//
// Environment (Production context only, marked secret):
//   SUPABASE_URL, SUPABASE_SECRET_KEY   - project URL and secret key (server-side only)
//   SENDGRID_API_KEY                    - restricted key with Mail Send permission only
//   EMAIL_FROM                          - default no-reply@materials.tennis.com.au
//   EMAIL_ENABLED                       - "false" turns sending off without a deploy
//   ALLOWED_ORIGINS                     - optional extra origins (comma-separated); the site URL is always allowed

const DOC_TYPES = { plan: 'Materials Management Plan', forecast: 'Forecast' };
const CODE_FORMATS = {
  plan: /^AO27-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
  forecast: /^AO27-FC-[A-Z0-9]{4}(-[A-Z0-9]{4})?$/
};
const ACTIONS = ['created', 'updated'];
const DEFAULT_FROM = 'no-reply@materials.tennis.com.au';

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body)
});
const escapeHtml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const plain = (v) => String(v == null ? '' : v).replace(/[<>\r\n]/g, ' ').trim();

function header(event, name) {
  const h = event.headers || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name);
  return key ? String(h[key]) : '';
}

// Only the site itself may call this (browsers always send Origin on cross-origin POSTs).
function sameOrigin(event) {
  const allowed = [process.env.URL, ...(process.env.ALLOWED_ORIGINS || '').split(',')]
    .map((s) => String(s || '').trim().replace(/\/$/, '')).filter(Boolean);
  const origin = header(event, 'origin').replace(/\/$/, '');
  if (origin) return allowed.includes(origin);
  return header(event, 'sec-fetch-site') === 'same-origin';
}

function log(fields) {
  console.log(JSON.stringify({ fn: 'send-confirmation', at: new Date().toISOString(), ...fields }));
}

function buildEmail(type, code, action, name) {
  const docType = DOC_TYPES[type];
  const codeLabel = type === 'plan' ? 'Plan ID' : 'TA-ID';
  const site = (process.env.SITE_URL || process.env.URL || '').replace(/\/$/, '') + '/';
  const greeting = plain(name) || 'there';                      // plain-text part
  const greetingHtml = escapeHtml(String(name == null ? '' : name).trim() || 'there');  // shown as typed, safely
  const subject = `AO27 ${docType} has been ${action}`;
  const intro = `The AO27 ${docType} has been ${action}. Keep this reference code - treat it like a password, ` +
    'anyone with the code can load and update this record.';
  const text = `Hi ${greeting},\n\n${intro}\n\n${codeLabel}: ${code}\n\nView or update via TA Materials Plan: ${site}\n`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a2b3c;line-height:1.5">
<p>Hi ${greetingHtml},</p>
<p>${escapeHtml(intro)}</p>
<p style="font-size:13px;color:#555;margin-bottom:4px">${escapeHtml(codeLabel)}</p>
<p style="font-size:20px;font-weight:bold;letter-spacing:1px;margin-top:0">${escapeHtml(code)}</p>
<p>View or update via <a href="${escapeHtml(site)}">TA Materials Plan</a></p>
</div>`;
  return { subject, text, html };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  if (!/^application\/json\b/i.test(header(event, 'content-type'))) return reply(415, { error: 'JSON required' });
  if (!sameOrigin(event)) return reply(403, { error: 'Forbidden' });
  if (String(process.env.EMAIL_ENABLED || 'true').toLowerCase() === 'false') return reply(200, { ok: true, sent: false });

  let payload;
  try { payload = JSON.parse(event.body || ''); } catch (e) { return reply(400, { error: 'Invalid request' }); }
  const type = String(payload.type || '');
  const action = String(payload.action || '');
  const code = String(payload.code || '').replace(/\s/g, '').toUpperCase();
  if (!DOC_TYPES[type] || !ACTIONS.includes(action) || !CODE_FORMATS[type].test(code)) {
    return reply(400, { error: 'Invalid request' });
  }

  const { SUPABASE_URL, SUPABASE_SECRET_KEY, SENDGRID_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !SENDGRID_API_KEY) {
    log({ evt: 'not_configured' });
    return reply(500, { error: 'Email is not available' });
  }

  try {
    // Recipient + sending limits come from the database, never from the browser.
    const prep = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/email_prepare`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SECRET_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ p_type: type, p_code: code, p_kind: action })
    });
    if (!prep.ok) {
      log({ evt: 'prepare_failed', status: prep.status, type, code, action });
      return reply(502, { error: 'Email could not be sent' });
    }
    const rows = await prep.json();
    const target = Array.isArray(rows) ? rows[0] : null;
    if (!target || !target.email) {
      log({ evt: 'skipped', type, code, action });   // unknown code, no address, or a limit applied
      return reply(200, { ok: true, sent: false });
    }

    const mail = buildEmail(type, code, action, target.name);
    const send = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: target.email }] }],
        from: { email: process.env.EMAIL_FROM || DEFAULT_FROM, name: 'AO27 Materials Management' },
        subject: mail.subject,
        content: [{ type: 'text/plain', value: mail.text }, { type: 'text/html', value: mail.html }],
        tracking_settings: { click_tracking: { enable: false, enable_text: false } }
      })
    });
    if (!send.ok) {
      log({ evt: 'send_failed', status: send.status, type, code, action });
      return reply(502, { error: 'Email could not be sent' });
    }
    log({ evt: 'sent', type, code, action });
    return reply(200, { ok: true, sent: true });
  } catch (err) {
    log({ evt: 'error', message: String(err && err.message).slice(0, 200) });
    return reply(500, { error: 'Email could not be sent' });
  }
};
