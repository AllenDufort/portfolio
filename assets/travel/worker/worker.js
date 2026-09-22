/* ── Travel Planner API — Cloudflare Worker ─────────────────────────────────
   Holds the Anthropic API key as a server-side secret so the static page on
   GitHub Pages never exposes it. Two request types:

     type: "generate"   — build a full JSON itinerary (non-streaming)
     type: "concierge"  — open travel Q&A chat (SSE streaming)

   Deploy:
     bash assets/travel/worker/deploy.sh        # sets the secret and deploys
   Then put the deployed URL in WORKER_URL at the top of ../travel.js.

   Local development:
     cp .dev.vars.example .dev.vars             # paste your ANTHROPIC_API_KEY
     bash assets/travel/worker/deploy.sh        # serves http://127.0.0.1:8788

   GET / returns a health JSON (model, keyConfigured). */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const DEFAULTS = {
    MODEL: 'claude-haiku-4-5',
    ALLOWED_ORIGINS: [
        'https://allendufort.github.io',
        'http://localhost:8000', 'http://127.0.0.1:8000',
        'http://localhost:5500', 'http://127.0.0.1:5500'
    ].join(',')
};

const MAX_TOKENS_GENERATE  = 4096;   // itinerary JSON can be large
const MAX_TOKENS_CONCIERGE = 700;
const TEMPERATURE          = 0.4;

const RATE_LIMIT_MAX       = 15;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

const rateLog = new Map();

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';
        const cors   = corsHeaders(origin, env);

        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (request.method === 'GET')     return health(env, cors);
        if (request.method !== 'POST')    return fail(405, 'POST only.', cors);

        if (!cors['Access-Control-Allow-Origin']) {
            return fail(403, 'This endpoint only answers the Travel Planner page.', {});
        }

        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (!allowRequest(ip)) {
            return fail(429, 'Too many requests — give it a minute.', cors, 60);
        }

        if (!env.ANTHROPIC_API_KEY) {
            return fail(500, 'API key not configured. Run: bash deploy.sh', cors);
        }

        let body;
        try { body = await request.json(); }
        catch { return fail(400, 'Expected JSON body.', cors); }

        const type = String(body?.type || '');

        if (type === 'generate') return handleGenerate(body, env, cors);
        if (type === 'concierge') return handleConcierge(body, env, cors);
        return fail(400, 'Unknown request type. Use "generate" or "concierge".', cors);
    }
};

/* ── /generate — build a full vacation JSON ──────────────────────────────── */

async function handleGenerate(body, env, cors) {
    const model = env.MODEL || DEFAULTS.MODEL;

    const city       = String(body.city       || '').trim().slice(0, 100);
    const country    = String(body.country    || '').trim().slice(0, 100);
    const duration   = Math.min(30, Math.max(1, parseInt(body.duration, 10)  || 5));
    const pace       = ['relaxed', 'moderate', 'packed'].includes(body.pace) ? body.pace : 'moderate';
    const budgetLevel= ['budget', 'mid-range', 'luxury'].includes(body.budget_level) ? body.budget_level : 'mid-range';
    const activities = (Array.isArray(body.activities) ? body.activities : []).slice(0, 10).map(a => String(a).slice(0, 60));
    const climate    = String(body.climate    || '').slice(0, 100);
    const interests  = (Array.isArray(body.interests)  ? body.interests  : []).slice(0, 10).map(a => String(a).slice(0, 60));
    const dietary    = (Array.isArray(body.dietary)    ? body.dietary    : []).slice(0, 10).map(a => String(a).slice(0, 60));

    if (!city || !country) return fail(400, 'city and country are required.', cors);

    const actStr  = activities.join(', ')  || 'General sightseeing, dining, exploration';
    const intStr  = interests.join(', ')   || 'Sightseeing, local culture';
    const dietStr = dietary.join(', ')     || 'None';
    const days    = Math.min(duration, 7); // cap itinerary days at 7

    const prompt = `Generate a comprehensive travel proposal for a vacation to ${city}, ${country}.
Details:
- Duration: ${duration} days
- Pace: ${pace} (relaxed = 2 activities/day, moderate = 3/day, packed = 4+/day)
- Budget Level: ${budgetLevel}
- Primary Activities: ${actStr}
- Traveler Interests: ${intStr}
- Dietary restrictions: ${dietStr}
- Climate/Season: ${climate}

Output ONLY a JSON object (no markdown, no extra commentary) matching this schema:
{
  "destination_summary": "1-2 sentences capturing the vibe of ${city} for this traveler",
  "top_attractions": [
    {"name": "Attraction Name", "why_visit": "Why it fits", "estimated_cost": "$X or Free", "best_time": "Morning/Afternoon"}
  ],
  "dining_recommendations": [
    {"restaurant": "Name", "cuisine_or_specialty": "Cuisine", "price_range": "$ / $$ / $$$", "notes": "Tip"}
  ],
  "hidden_gems": [
    {"title": "Gem Name", "description": "Short description"}
  ],
  "cultural_etiquette_tips": ["Tip 1", "Tip 2", "Tip 3"],
  "daily_itinerary": [
    {
      "day": 1,
      "theme": "Theme for the day",
      "morning":   {"time": "9:00 AM - 12:00 PM", "activity": "Activity", "notes": "Tip"},
      "afternoon": {"time": "1:30 PM - 5:00 PM",  "activity": "Activity", "notes": "Tip"},
      "evening":   {"time": "6:30 PM - 9:30 PM",  "activity": "Activity", "notes": "Tip"},
      "meals": {"breakfast": "Idea", "lunch": "Idea", "dinner": "Idea"}
    }
  ]
}
Provide daily_itinerary with all ${days} days using real, specific locations in ${city}.`;

    let upstream;
    try {
        upstream = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
                'x-api-key':         env.ANTHROPIC_API_KEY,
                'anthropic-version': ANTHROPIC_VERSION,
                'Content-Type':      'application/json'
            },
            body: JSON.stringify({
                model,
                system: 'You are an expert travel concierge. Provide rich, specific, realistic, culturally tailored travel recommendations in valid JSON only.',
                messages: [{ role: 'user', content: prompt }],
                max_tokens:  MAX_TOKENS_GENERATE,
                temperature: TEMPERATURE
            })
        });
    } catch (err) {
        return fail(502, 'Could not reach the model — try again shortly.', cors);
    }

    if (!upstream.ok) return fail(upstream.status || 502, await upstreamMsg(upstream), cors);

    let data;
    try { data = await upstream.json(); } catch { return fail(502, 'Unexpected model response.', cors); }

    // Extract text content from Claude's response
    const raw = (data.content || []).find(b => b.type === 'text')?.text || '';

    // Strip any markdown fences Claude might have added
    let cleaned = raw.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```'))  cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch { return fail(502, 'Model returned malformed JSON. Try again.', cors); }

    return new Response(JSON.stringify(parsed), {
        headers: { ...cors, 'Content-Type': 'application/json' }
    });
}

/* ── /concierge — streaming travel chat ──────────────────────────────────── */

async function handleConcierge(body, env, cors) {
    // Accept a model override from the client dropdown; fall back to the server-pinned default.
    const model    = String(body?.model || env.MODEL || DEFAULTS.MODEL).slice(0, 80);
    const question = String(body?.question || '').trim().slice(0, 600);
    if (!question) return fail(400, 'question is required.', cors);

    const history = sanitizeHistory(body?.history);
    const prefs   = body?.prefs || {};

    const system = [
        'You are an expert travel consultant and concierge.',
        'Give helpful, specific, engaging travel advice.',
        prefs.interests?.length  ? `The traveler enjoys: ${prefs.interests.join(', ')}.`  : '',
        prefs.dietary?.length    ? `Dietary restrictions: ${prefs.dietary.join(', ')}.`    : '',
        prefs.pace               ? `Preferred pace: ${prefs.pace}.`                         : '',
        'Use bullet lists where helpful. Keep replies concise and practical.'
    ].filter(Boolean).join(' ');

    let upstream;
    try {
        upstream = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
                'x-api-key':         env.ANTHROPIC_API_KEY,
                'anthropic-version': ANTHROPIC_VERSION,
                'Content-Type':      'application/json'
            },
            body: JSON.stringify({
                model,
                system,
                messages: [...history, { role: 'user', content: question }],
                max_tokens:  MAX_TOKENS_CONCIERGE,
                temperature: TEMPERATURE,
                stream:      true
            })
        });
    } catch (err) {
        return fail(502, 'Could not reach the model — try again shortly.', cors);
    }

    if (!upstream.ok || !upstream.body) {
        return fail(upstream.status || 502, await upstreamMsg(upstream), cors);
    }

    return new Response(upstream.body.pipeThrough(claudeSseTransform()), {
        headers: {
            ...cors,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive'
        }
    });
}

/* ── Claude SSE passthrough ──────────────────────────────────────────────── */

function claudeSseTransform() {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';

    const send = (ctrl, payload) =>
        ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

    return new TransformStream({
        transform(chunk, ctrl) {
            buffer += decoder.decode(chunk, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() || '';

            blocks.forEach(block => {
                const dataLine = block.split('\n').find(l => l.startsWith('data:'));
                if (!dataLine) return;
                const payload = dataLine.slice(5).trim();
                if (!payload || payload === '[DONE]') return;
                let data;
                try { data = JSON.parse(payload); } catch { return; }

                if (data.type === 'content_block_delta' &&
                    data.delta?.type === 'text_delta' &&
                    typeof data.delta.text === 'string' && data.delta.text) {
                    send(ctrl, { delta: data.delta.text });
                }
                if (data.type === 'error') {
                    send(ctrl, { error: data.error?.message || 'Model error.' });
                }
            });
        },
        flush(ctrl) {
            if (buffer.trim()) {
                const dl = buffer.split('\n').find(l => l.startsWith('data:'));
                if (dl) {
                    try {
                        const d = JSON.parse(dl.slice(5).trim());
                        if (d.type === 'error') send(ctrl, { error: d.error?.message || 'Model error.' });
                    } catch { /* ignore */ }
                }
            }
            ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
    });
}

/* ── Error messages ──────────────────────────────────────────────────────── */

async function upstreamMsg(res) {
    let detail = '';
    try {
        const d = await res.json();
        detail = d?.error?.message || (typeof d?.error === 'string' ? d.error : '') || '';
    } catch { /* ignore */ }
    switch (res.status) {
        case 401: return 'API key rejected — it may need rotating.';
        case 429: return 'Rate limit hit — give it a minute.';
        case 408:
        case 504: return 'Model timed out. Try a shorter request.';
        default:  return detail || `Model error (HTTP ${res.status}).`;
    }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function sanitizeHistory(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-8)
        .map(m => ({ role: m.role, content: m.content.trim().slice(0, 800) }))
        .filter(m => m.content);
}

function allowRequest(ip) {
    const now    = Date.now();
    const recent = (rateLog.get(ip) || []).filter(at => now - at < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) { rateLog.set(ip, recent); return false; }
    recent.push(now);
    rateLog.set(ip, recent);
    if (rateLog.size > 5000) rateLog.clear();
    return true;
}

function corsHeaders(origin, env) {
    const allowed = String(env.ALLOWED_ORIGINS || DEFAULTS.ALLOWED_ORIGINS)
        .split(',').map(s => s.trim()).filter(Boolean);
    const headers = {
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
    };
    if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
    return headers;
}

async function health(env, cors) {
    return new Response(JSON.stringify({
        ok:            true,
        model:         env.MODEL || DEFAULTS.MODEL,
        keyConfigured: Boolean(env.ANTHROPIC_API_KEY)
    }, null, 2), {
        headers: { ...cors, 'Content-Type': 'application/json' }
    });
}

function fail(status, message, cors, retryAfter) {
    const headers = { ...cors, 'Content-Type': 'application/json' };
    if (retryAfter) headers['Retry-After'] = String(retryAfter);
    return new Response(JSON.stringify({ error: message }), { status, headers });
}
