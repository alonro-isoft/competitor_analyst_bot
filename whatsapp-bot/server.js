require('dotenv').config();
const crypto = require('crypto');
const express = require('express');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const OPENWA_BASE_URL = (process.env.OPENWA_BASE_URL || 'http://openwa-api:2785').replace(/\/+$/, '');
const OPENWA_API_KEY = process.env.OPENWA_API_KEY || '';
const OPENWA_SESSION_ID = process.env.OPENWA_SESSION_ID || '';
const OPENWA_WEBHOOK_SECRET = process.env.OPENWA_WEBHOOK_SECRET || '';

if (!GEMINI_API_KEY) console.warn('[config] GEMINI_API_KEY is not set — analysis requests will fail.');
if (!OPENWA_API_KEY) console.warn('[config] OPENWA_API_KEY is not set — replies cannot be sent back.');
if (!OPENWA_SESSION_ID) console.warn('[config] OPENWA_SESSION_ID is not set — replies cannot be sent back.');
if (!OPENWA_WEBHOOK_SECRET) {
  console.warn('[config] OPENWA_WEBHOOK_SECRET is not set — webhook signature verification is DISABLED. Set it in production.');
}

const USAGE_TEXT_HE =
  'שלום! אני בוט לניתוח מתחרים 🤖\n\n' +
  'שלחו לי הודעה בפורמט הבא (כל שדה בשורה נפרדת):\n\n' +
  'שלי: <הפתרון שלכם>\n' +
  'מתחרה: <הפתרון המתחרה>\n' +
  'שאלה: <מה תרצו להשוות>\n\n' +
  'לדוגמה:\n' +
  'שלי: Google Docs\n' +
  'מתחרה: Microsoft Word\n' +
  'שאלה: השוואת יכולות שיתוף קבצים ומחיר';

const app = express();

// Raw body is required on the webhook route so the HMAC can be verified over
// the exact bytes OpenWA signed — a re-serialized JSON.parse().stringify() would not match.
app.use('/webhook', express.raw({ type: '*/*', limit: '2mb' }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/webhook', (req, res) => {
  const rawBody = req.body; // Buffer, thanks to express.raw() above
  const signatureHeader = req.get('X-OpenWA-Signature') || '';

  if (OPENWA_WEBHOOK_SECRET) {
    if (!verifySignature(rawBody, signatureHeader, OPENWA_WEBHOOK_SECRET)) {
      console.warn('[webhook] rejected: invalid or missing X-OpenWA-Signature');
      return res.status(401).json({ error: 'invalid signature' });
    }
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.warn('[webhook] rejected: body is not valid JSON', err.message);
    return res.status(400).json({ error: 'invalid json' });
  }

  // Acknowledge immediately — OpenWA retries on a slow/non-2xx response, and the
  // actual reply travels back to WhatsApp via a separate send-text call below,
  // not via this response body.
  res.status(200).json({ received: true });

  handleWebhookEvent(payload).catch((err) => {
    console.error('[webhook] unhandled error while processing event:', err);
  });
});

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleWebhookEvent(payload) {
  if (!payload || payload.event !== 'message.received') return;

  const data = payload.data || {};
  if (data.isGroup) return; // keep the bot to 1:1 chats for now
  if (data.hasMedia && !data.body) return; // nothing to analyze in a bare media message

  const chatId = data.from;
  const text = (data.body || '').trim();
  if (!chatId || !text) return;

  console.log(`[message] from=${chatId} body=${JSON.stringify(text).slice(0, 200)}`);

  const parsed = parseComparisonRequest(text);
  if (!parsed) {
    await sendWhatsAppText(chatId, USAGE_TEXT_HE);
    return;
  }

  try {
    const analysis = await fetchGeminiAnalysis(parsed.mySolution, parsed.competitorSolution, parsed.query);
    const reply = formatAnalysisForWhatsApp(analysis, parsed.mySolution, parsed.competitorSolution);
    await sendWhatsAppText(chatId, reply);
  } catch (err) {
    console.error('[analysis] failed:', err);
    await sendWhatsAppText(
      chatId,
      'אירעה שגיאה בעת ביצוע הניתוח. נסו שוב בעוד רגע, או נסחו מחדש את הבקשה.',
    );
  }
}

// Accepts Hebrew or English field labels, one per line, in any order.
function parseComparisonRequest(text) {
  const patterns = {
    mySolution: /^\s*(?:שלי|my solution|mine)\s*[:\-]\s*(.+)$/im,
    competitorSolution: /^\s*(?:מתחרה|competitor)\s*[:\-]\s*(.+)$/im,
    query: /^\s*(?:שאלה|question)\s*[:\-]\s*(.+)$/im,
  };

  const mySolution = text.match(patterns.mySolution)?.[1]?.trim();
  const competitorSolution = text.match(patterns.competitorSolution)?.[1]?.trim();
  const query = text.match(patterns.query)?.[1]?.trim();

  if (!mySolution || !competitorSolution || !query) return null;
  return { mySolution, competitorSolution, query };
}

async function fetchGeminiAnalysis(mySolution, competitorSolution, userQuery) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');

  const systemPrompt =
    `אתה אנליסט עסקי מומחה. בצע השוואה מקיפה בין ${mySolution} לבין ${competitorSolution} ` +
    `על בסיס מידע עדכני מהאינטרנט. ספק את התוצאה בפורמט JSON קריא, המכיל שני מערכים: ` +
    `capabilities ו-prosAndCons, וכן פיסקת סיכום. ` +
    `כל מערך יכיל אובייקטים עם תכונות משותפות (כמו 'feature' ו-'aspect' בהתאמה) ` +
    `ושמות הפתרונות כשדות נוספים. בכל שדה של פתרון, תאר את המצב הרלוונטי בקצרה ` +
    `(שורה או שתיים, מתאים להודעת WhatsApp). השב אך ורק ב-JSON.`;

  const payload = {
    contents: [{ parts: [{ text: `השאלה לניתוח: ${userQuery}` }] }],
    tools: [{ google_search: {} }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          summary: { type: 'STRING' },
          capabilities: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                feature: { type: 'STRING' },
                mySolution: { type: 'STRING' },
                competitorSolution: { type: 'STRING' },
              },
            },
          },
          prosAndCons: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                aspect: { type: 'STRING' },
                mySolution: { type: 'STRING' },
                competitorSolution: { type: 'STRING' },
              },
            },
          },
        },
      },
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Gemini API error: HTTP ${response.status}`);
  }

  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini API returned no content');

  return JSON.parse(text);
}

function formatAnalysisForWhatsApp(data, mySolution, competitorSolution) {
  const lines = [`*השוואה: ${mySolution} מול ${competitorSolution}*`, ''];

  if (data.summary) {
    lines.push('📋 *סיכום*', data.summary, '');
  }

  if (Array.isArray(data.capabilities) && data.capabilities.length > 0) {
    lines.push('🆚 *השוואת יכולות*');
    for (const item of data.capabilities) {
      lines.push(`• *${item.feature}*`, `  ${mySolution}: ${item.mySolution}`, `  ${competitorSolution}: ${item.competitorSolution}`);
    }
    lines.push('');
  }

  if (Array.isArray(data.prosAndCons) && data.prosAndCons.length > 0) {
    lines.push('⚖️ *יתרונות וחסרונות*');
    for (const item of data.prosAndCons) {
      lines.push(`• *${item.aspect}*`, `  ${mySolution}: ${item.mySolution}`, `  ${competitorSolution}: ${item.competitorSolution}`);
    }
  }

  return lines.join('\n').trim();
}

async function sendWhatsAppText(chatId, text) {
  if (!OPENWA_API_KEY || !OPENWA_SESSION_ID) {
    console.error('[send] cannot send reply — OPENWA_API_KEY/OPENWA_SESSION_ID missing');
    return;
  }

  const url = `${OPENWA_BASE_URL}/api/sessions/${encodeURIComponent(OPENWA_SESSION_ID)}/messages/send-text`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': OPENWA_API_KEY,
    },
    body: JSON.stringify({ chatId, text }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`[send] OpenWA send-text failed: HTTP ${response.status} ${body}`);
  }
}

app.listen(PORT, () => {
  console.log(`[whatsapp-bot] listening on port ${PORT}`);
});
