/* The AI companion's one job: hold the OpenAI key so the app never has to.
 *
 * WHAT IT IS FOR: OpenAI's Realtime API lets a client stream audio straight to
 * OpenAI over WebRTC once it holds a short-lived "ephemeral" credential - but
 * minting that credential needs the real, permanent API key, and a permanent
 * key inside an APK is a key anyone can pull out of the file with a zip
 * extractor. This is the smallest thing that can stand between the two: it
 * holds the real key, hands out credentials that expire in minutes, and never
 * touches the audio itself. The call after that (client <-> OpenAI) does not
 * pass through here at all - that would make this server the bottleneck and
 * the cost centre for every word the companion hears or says, for no benefit.
 *
 * DELIBERATELY SMALL, matching server/index.js's own reasoning:
 *
 *   No dependencies. Node's own http/https and nothing else, so `node
 *   server/ai-relay.js` runs it on any machine with Node 18+.
 *
 *   No accounts, no per-user anything. This mints a credential; it does not
 *   know or store who asked for one, same as server/index.js knows nothing
 *   about who filed a report.
 *
 *   No conversation ever passes through or is stored here. Audio goes
 *   client <-> OpenAI directly once the credential is issued.
 *
 * WHAT IT DOES ABOUT ABUSE:
 *   - one credential request per IP per RATE_WINDOW_MS
 *   - refuses to start at all with a clear log line if OPENAI_API_KEY is
 *     unset, rather than silently minting nothing and leaving the app to
 *     guess why every request 503s
 *   - a body over MAX_BODY bytes is dropped unread
 *
 * WHAT THIS FILE DOES NOT DO: decide the AI's personality. /ai-config below
 * returns operator-set DEFAULTS (env vars, so the wording can change without
 * an app rebuild - see js/ai/personality.js for why this matters), but the
 * actual prompt is assembled on the client, from state the driver chose in
 * Settings. If this server is unreachable the client falls back to its own
 * built-in defaults; nothing about the companion depends on this endpoint
 * beyond "kinder defaults if the operator bothered to set them".
 */

'use strict';

const http = require('http');

const PORT = Number(process.env.AI_RELAY_PORT || process.env.PORT || 8788);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
/* The realtime model this relay asks OpenAI for. An env var, not a constant,
   so a model rename on OpenAI's side is a restart here, not a rebuild of the
   app - see the /ai-config reasoning above. */
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1-mini';
const DEFAULT_VOICE = process.env.AI_DEFAULT_VOICE || 'ash';

const MAX_BODY = 2048;
const RATE_WINDOW_MS = 3000;

/* ------------------------------------------------------------- serving --- */

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    /* Same reasoning as server/index.js: the app runs from a file:// WebView
       and from localhost in development, so the origin cannot be pinned. */
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------------------------------------------------------- rate limit --- */

const lastRequest = new Map();

function tooSoon(ip, now) {
  const prev = lastRequest.get(ip) || 0;
  if (now - prev < RATE_WINDOW_MS) return true;
  lastRequest.set(ip, now);
  if (lastRequest.size > 5000) {
    for (const [k, t] of lastRequest) {
      if (now - t > RATE_WINDOW_MS * 20) lastRequest.delete(k);
    }
  }
  return false;
}

/* -------------------------------------------------------------- OpenAI --- */

/**
 * Asks OpenAI for a short-lived credential the client can use to open a
 * Realtime WebRTC session directly, without ever seeing the real key.
 *
 * The exact endpoint path and response shape are OpenAI's, and that API has
 * changed shape before this file was written - if OpenAI's docs have moved
 * this by the time this runs for real, the fix is here, in one function, not
 * anywhere in the app.
 */
async function mintClientSecret({ voice }) {
  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: REALTIME_MODEL,
        audio: { output: { voice: voice || DEFAULT_VOICE } }
      }
    })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    const msg = (data && data.error && data.error.message) || `OpenAI ${res.status}`;
    throw new Error(msg);
  }
  /* Both shapes have existed on this endpoint at different times; take
     whichever is present rather than betting on one. */
  const secret = data.value || (data.client_secret && data.client_secret.value);
  const expiresAt = data.expires_at || (data.client_secret && data.client_secret.expires_at) || null;
  if (!secret) throw new Error('OpenAI cevabinda client secret yok');
  return { value: secret, expiresAt, model: REALTIME_MODEL };
}

async function postSession(req, res, ip) {
  const now = Date.now();
  if (tooSoon(ip, now)) return send(res, 429, { error: 'cok sik' });
  if (!OPENAI_API_KEY) {
    return send(res, 503, {
      error: 'not_configured',
      message: 'OPENAI_API_KEY sunucuda tanimli degil - AI Sesli Arkadas su an kullanilamiyor.'
    });
  }

  let body = {};
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { return send(res, 400, { error: 'gecersiz govde' }); }

  try {
    const session = await mintClientSecret({ voice: body.voice });
    return send(res, 200, session);
  } catch (err) {
    console.error('[ai-relay] OpenAI oturumu alinamadi:', err.message);
    return send(res, 502, { error: 'openai_unreachable', message: err.message });
  }
}

/* -------------------------------------------------------- operator defaults
 *
 * Changeable without a rebuild: an operator who wants a gentler default
 * personality, or a different voice, edits an env var and restarts this
 * process. The client always has its own hardcoded fallback (see
 * js/ai/config.js) for when this server is unreachable entirely.
 */
function getAiConfig() {
  return {
    model: REALTIME_MODEL,
    defaultVoice: DEFAULT_VOICE,
    defaultPersonality: process.env.AI_DEFAULT_PERSONALITY || 'normal',
    defaultLanguage: process.env.AI_DEFAULT_LANGUAGE || 'auto',
    maxResponseWords: Number(process.env.AI_MAX_RESPONSE_WORDS || 40),
    /* Appended to the client's own base persona, never replacing it - see
       js/ai/personality.js buildSystemPrompt(). Lets an operator add a house
       rule ("mention the Kadikoy festival this weekend") without shipping
       code. Empty by default. */
    systemPromptExtra: process.env.AI_SYSTEM_PROMPT_EXTRA || ''
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';

  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (url.pathname === '/health') {
    return send(res, 200, { ok: true, configured: !!OPENAI_API_KEY });
  }
  if (url.pathname === '/ai-config' && req.method === 'GET') {
    return send(res, 200, getAiConfig());
  }
  if (url.pathname === '/session' && req.method === 'POST') {
    return postSession(req, res, ip);
  }
  send(res, 404, { error: 'yok' });
});

if (!OPENAI_API_KEY) {
  console.warn('[ai-relay] UYARI: OPENAI_API_KEY tanimli degil - /session 503 donecek.');
  console.warn('[ai-relay] Ayarlamak icin: OPENAI_API_KEY=sk-... node server/ai-relay.js');
}

server.listen(PORT, () => {
  console.log(`[ai-relay] http://localhost:${PORT} dinliyor`);
  console.log(`[ai-relay] model=${REALTIME_MODEL} configured=${!!OPENAI_API_KEY}`);
});

module.exports = server;
