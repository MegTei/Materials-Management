// netlify/functions/send-confirmation.js
//
// Client-side code (materials_plan_v1.html / index.html) POSTs here with:
//   { to_name, to_email, code, action, type }   // type: 'plan' | 'forecast'
//
// This function holds NETLIFY_EMAILS_SECRET server-side (never exposed to the
// browser) and forwards a correctly-shaped request to Netlify's auto-generated
// `emails` function, which actually sends via the configured provider
// (NETLIFY_EMAILS_PROVIDER / NETLIFY_EMAILS_PROVIDER_API_KEY).

const DOC_TYPE_LABELS = {
  plan: 'Materials Management Plan',
  forecast: 'Forecast'
};

const FROM_ADDRESS = 'no-reply@tennis.com.au';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!event.body) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Payload required' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { to_name, to_email, code, action, type } = payload;
  if (!to_email || !code) {
    return { statusCode: 400, body: JSON.stringify({ error: 'to_email and code are required' }) };
  }

  const docType = DOC_TYPE_LABELS[type] || 'record';

  try {
    const res = await fetch(`${process.env.URL}/.netlify/functions/emails/confirmation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'netlify-emails-secret': process.env.NETLIFY_EMAILS_SECRET
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: to_email,
        subject: `AO27 ${docType} has been ${action || 'saved'}`,
        parameters: {
          name: to_name || 'there',
          docType: docType,
          action: action || 'saved',
          code: code
        }
      })
    });

    const text = await res.text();
    if (!res.ok) {
      console.error('emails function returned', res.status, text);
      return { statusCode: 502, body: JSON.stringify({ error: 'Email send failed', detail: text }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('send-confirmation error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
