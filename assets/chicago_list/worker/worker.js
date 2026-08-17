/* ── Chicago Assistant API — Cloudflare Worker ─────────────────────────────
   The chat widget on a static GitHub Pages site cannot hold an OpenRouter key: any
   key shipped to the browser is public. So the key lives here as a Worker secret and
   the page talks to this endpoint instead.

   This Worker does more than forward requests. It builds the entire prompt itself —
   fetching the Google Sheet, grouping every saved place by neighborhood, and computing
   real distances when the visitor shares their location. The page only ever sends a
   question, a little chat history, and optional coordinates, which means this endpoint
   can *only* answer questions about the Chicago map. It is not a general LLM relay
   somebody can point at their own prompts, which is the main risk of putting a paid
   key behind a public URL.

   Deploy:
     cd assets/chicago_list/worker
     npx wrangler secret put OPENROUTER_API_KEY     # from .env — never commit it
     npx wrangler deploy
   Then put the deployed URL in WORKER_URL at the top of ../chicagoChat.js.

   Local development:
     cp .dev.vars.example .dev.vars                 # paste the key into .dev.vars
     npx wrangler dev                               # serves http://127.0.0.1:8787

   GET / returns a health summary (place count, neighborhoods, data source, model), so
   a deployment can be verified without spending a model call. */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/* Overridable in wrangler.toml [vars]. The model is pinned server-side on purpose:
   the browser never chooses it, so nobody can swap in a paid model on this key. */
const DEFAULTS = {
    MODEL: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    ALLOWED_ORIGINS: [
        'https://allendufort.github.io',
        'http://localhost:8000', 'http://127.0.0.1:8000',
        'http://localhost:5500', 'http://127.0.0.1:5500'
    ].join(','),
    SNAPSHOT_URL: 'https://allendufort.github.io/portfolio/assets/chicago_list/chicago_layers.geojson',
    COORDS_URL: 'https://allendufort.github.io/portfolio/assets/chicago_list/geocode_cache.json'
};

// Same sheet chicagoData.js reads, so the chat and the map never disagree.
const SHEET_ID  = '18rG-azfyKrziKuDm3WBHD2UyMeeD5T8BMugFG7j5fw4';
const SHEET_GID = '337826956';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&gid=${SHEET_GID}`;

const SHEET_TIMEOUT_MS = 8000;
const CATALOG_TTL_MS   = 5 * 60 * 1000;   // rebuild the prompt from the sheet this often

const MAX_QUESTION_CHARS = 500;
const MAX_HISTORY_TURNS  = 6;             // last N messages kept for follow-ups
const MAX_HISTORY_CHARS  = 600;

const RATE_LIMIT_MAX      = 12;           // requests per IP per window
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

const NEAR_RADII_MI = [0.5, 1, 2];        // widen until at least NEAR_MIN places match
const NEAR_MIN      = 5;
const NEAR_MAX      = 50;                 // most "near you" lines to put in the prompt
const FAR_AWAY_MI   = 25;                 // past this, tell the model the visitor is out of town

const MODEL_MAX_TOKENS = 700;
const MODEL_TEMPERATURE = 0.3;

/* The Type -> layer mapping, mirroring TYPE_LAYERS in chicagoData.js (and geocode.py).
   Keep the three in sync; a Type missing here still appears in the catalog, it just
   belongs to no layer. */
const TYPE_LAYERS = {
    restaurant: ['Food Spots'], bar: ['Food Spots'], cafe: ['Food Spots'],
    brunch: ['Food Spots'], snack: ['Food Spots'], market: ['Food Spots'],
    club: ['Food Spots', 'Activities'],
    museum: ['Activities'], landmark: ['Activities'], books: ['Activities'],
    park: ['Activities'], retail: ['Activities'], activity: ['Activities'],
    beach: ['Activities']
};
const LAYER_ORDER = ['Food Spots', 'Activities'];

// Sheet headers are matched by name, so columns can be reordered or added freely.
const COLUMNS = {
    name: ['place', 'name'],
    type: ['type', 'category'],
    neighborhood: ['neighborhood', 'neighbourhood', 'area'],
    notes: ['reviews', 'notes', 'review'],
    address: ['address'],
    lat: ['lat', 'latitude'],
    lon: ['lon', 'lng', 'long', 'longitude']
};

/* Module scope, so a warm isolate reuses the built catalog and the sheet is fetched
   once every CATALOG_TTL_MS rather than once per question. A cold isolate pays one
   extra fetch, which is cheaper than any cross-request store worth wiring up here. */
let catalogCache = null;
const rateLog = new Map();   // ip -> recent request timestamps

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';
        const cors = corsHeaders(origin, env);

        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (request.method === 'GET') return health(env, cors);
        if (request.method !== 'POST') return fail(405, 'Send a POST request.', cors);

        // A browser always sends Origin on a cross-origin POST, so requiring an allowed
        // one keeps casual scripted abuse off the key. It is not a hard boundary — the
        // rate limit below and the fixed prompt shape are what actually contain it.
        if (!cors['Access-Control-Allow-Origin']) {
            return fail(403, 'This endpoint only answers the Chicago map page.', {});
        }

        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (!allowRequest(ip)) {
            return fail(429, 'That is a lot of questions at once — give it a minute.', cors, 60);
        }

        if (!env.OPENROUTER_API_KEY) {
            return fail(500, 'The assistant is missing its API key. Run: wrangler secret put OPENROUTER_API_KEY', cors);
        }

        let body;
        try {
            body = await request.json();
        } catch (err) {
            return fail(400, 'Expected a JSON body.', cors);
        }

        const question = String(body && body.question || '').trim().slice(0, MAX_QUESTION_CHARS);
        if (!question) return fail(400, 'Ask a question first.', cors);

        let catalog;
        try {
            catalog = await loadCatalog(env);
        } catch (err) {
            return fail(503, 'I could not reach the place list just now — try again shortly.', cors);
        }

        const point = coords(body && body.coords);
        const near = nearbyBlock(catalog, point);
        const messages = [
            { role: 'system', content: systemPrompt(catalog, near, Boolean(point)) },
            ...history(body && body.history),
            { role: 'user', content: question }
        ];

        return askModel(env, messages, cors);
    }
};

/* ── OpenRouter ──────────────────────────────────────────────────────────── */

/* The reply is streamed, because a 550B model on a free endpoint can take a while to
   finish a sentence and a visitor should see the first words immediately. The upstream
   SSE is normalised here into one small event shape — {"delta"} / {"error"} / [DONE] —
   so the page never has to know what a provider chunk looks like. */
async function askModel(env, messages, cors) {
    const model = env.MODEL || DEFAULTS.MODEL;
    let upstream;
    try {
        upstream = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                // Attribution headers OpenRouter shows on the account's activity page.
                'HTTP-Referer': 'https://allendufort.github.io/portfolio/chicagoMap.html',
                'X-Title': 'Chicago TODO Map Assistant'
            },
            body: JSON.stringify({
                model,
                messages,
                stream: true,
                temperature: MODEL_TEMPERATURE,
                max_tokens: MODEL_MAX_TOKENS,
                // A reasoning model: think a little, but keep the chain out of the reply.
                reasoning: { effort: 'low', exclude: true }
            })
        });
    } catch (err) {
        return fail(502, 'I could not reach the model just now — try again shortly.', cors);
    }

    if (!upstream.ok || !upstream.body) {
        return fail(upstream.status || 502, await upstreamMessage(upstream), cors,
            upstream.headers.get('Retry-After'));
    }

    return new Response(upstream.body.pipeThrough(sseTransform()), {
        headers: {
            ...cors,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        }
    });
}

/* Turn an OpenRouter status into something worth showing a visitor. The free tier's
   daily cap and a cold provider are by far the most likely failures here, and both are
   temporary — so say that rather than printing a status code. */
async function upstreamMessage(res) {
    let detail = '';
    try {
        const data = await res.json();
        detail = (data && data.error && data.error.message) || '';
    } catch (err) { /* an HTML error page — the status is all we have */ }

    switch (res.status) {
        case 401: return 'The assistant’s API key was rejected. It may need to be rotated.';
        case 402: return 'The free model’s allowance is used up for now. It resets — try later.';
        case 403: return detail || 'The model refused that request.';
        case 408:
        case 504: return 'The model took too long. Try a shorter question.';
        case 429: return 'The free model is rate limited right now. Give it a minute.';
        case 502: return 'The model is down at the moment. Try again shortly.';
        case 503: return 'No provider is free for this model right now. Try again shortly.';
        default:  return detail || `The model returned an error (HTTP ${res.status}).`;
    }
}

/* Upstream SSE -> our SSE. Comment lines (": OPENROUTER PROCESSING" keep-alives) and
   the reasoning field are dropped; only assistant content is forwarded. */
function sseTransform() {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';

    const send = (controller, payload) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

    return new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() || '';

            blocks.forEach(block => block.split('\n').forEach(rawLine => {
                const line = rawLine.trim();
                if (!line.startsWith('data:')) return;
                const payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') return;

                let data;
                try { data = JSON.parse(payload); } catch (err) { return; }

                // A generation can fail mid-stream, in which case the error arrives here.
                if (data.error) {
                    send(controller, { error: data.error.message || 'The model stopped early.' });
                    return;
                }
                const choice = data.choices && data.choices[0];
                const text = choice && choice.delta && choice.delta.content;
                if (typeof text === 'string' && text) send(controller, { delta: text });
            }));
        },
        flush(controller) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
    });
}

/* ── Prompt ──────────────────────────────────────────────────────────────── */

/* Every question gets the whole map. All 552 places with their notes come to ~34 KB
   (~8.5k tokens) against a 1M-token context, so there is no reason to pre-select
   places and risk hiding the one the visitor asked about. Grouping by neighborhood is
   what makes "what food spots are in South Loop?" reliable: the answer is one
   contiguous, counted block rather than 552 rows to filter. */
function systemPrompt(catalog, near, hasPoint) {
    const lines = [
        'You are Chicago Assistant, the guide to a personal Chicago TODO map of saved places.',
        `The map holds ${catalog.places.length} saved places across ${catalog.hoods.length} neighborhoods.`,
        'Layers group them by Type:',
        ...catalog.layerLines,
        '',
        'Rules:',
        '- Answer only from the CATALOG below. Never invent a place, address, note, or detail, and never add well-known Chicago spots that are not listed.',
        '- The catalog is one person\'s saved list, not all of Chicago. If nothing fits, say so and name a neighborhood or type that does.',
        '- Neighborhood headings carry exact counts. Use them when asked how many, and count only inside the layer or Type asked about.',
        '- Keep replies under 120 words. Use "- " bullets for lists, at most 8 places per reply, and say the total when there are more.',
        '- Give each place\'s Type and neighborhood; add the address when the visitor is heading there.',
        '- Plain text only, no markdown headings or tables. Skip preamble and pleasantries.'
    ];

    if (near) {
        lines.push(
            '- NEAR THE VISITOR lists the closest saved places with real distances, computed from ' +
            'the location they just shared. Use it for "near me" questions and quote those ' +
            'distances verbatim. Never estimate a distance yourself.'
        );
    } else if (hasPoint) {
        // Location shared, but no place in the catalog has coordinates to measure against.
        lines.push(
            '- The visitor shared their location, but no distances are available right now. Say so ' +
            'and ask which neighborhood they are in.'
        );
    } else {
        lines.push(
            '- You have no location for the visitor. If they ask what is near them, tell them to ' +
            'allow location access in the browser, or to name a neighborhood instead.'
        );
    }

    lines.push('', catalog.text);
    if (near) lines.push('', near);
    return lines.join('\n');
}

/* Places sorted by real distance from the visitor, so the model never has to do
   geometry — it only has to read a list that is already in the right order. */
function nearbyBlock(catalog, point) {
    if (!point) return '';

    const ranked = catalog.places
        .filter(place => place.lon != null)
        .map(place => ({ place, miles: haversineMiles(point.lon, point.lat, place.lon, place.lat) }))
        .sort((a, b) => a.miles - b.miles);
    if (!ranked.length) return '';

    // Out-of-town visitor: three nearest for context, and a heading that tells the
    // model to say so rather than presenting a 340-mile drive as "nearby".
    if (ranked[0].miles > FAR_AWAY_MI) {
        return [
            `NEAR THE VISITOR: nothing is close. They are ${Math.round(ranked[0].miles)} miles from the ` +
            'nearest saved place, so tell them they are too far from Chicago for a "near me" answer ' +
            'and offer a neighborhood instead. The closest few, for reference:',
            ...ranked.slice(0, 3).map(hit => nearLine(hit, 0))
        ].join('\n');
    }

    // Widen the radius until enough places qualify, so a quiet block still gets a list.
    const widest = NEAR_RADII_MI[NEAR_RADII_MI.length - 1];
    const radius = NEAR_RADII_MI.find(mi => ranked.filter(hit => hit.miles <= mi).length >= NEAR_MIN) || widest;
    const within = ranked.filter(hit => hit.miles <= radius);
    const shown = (within.length ? within : ranked).slice(0, NEAR_MAX);
    const area = nearestHood(catalog, point);

    return [
        `NEAR THE VISITOR (straight-line miles from where they are${area ? `, which is in ${area}` : ''}, ` +
        `nearest first, ${shown.length} shown):`,
        ...shown.map(hit => nearLine(hit, 1))
    ].join('\n');
}

function nearLine(hit, decimals) {
    const place = hit.place;
    return `- ${place.name} (${place.type || 'Place'}) | ${hit.miles.toFixed(decimals)} mi | ` +
        `${place.neighborhood || 'Chicago'}`;
}

/* Which neighborhood the visitor is standing in, from the average coordinates of the
   places filed under each one. The sheet's own rows define the areas, so there is no
   hand-entered centroid table to drift out of date. */
function nearestHood(catalog, point) {
    let best = null;
    catalog.hoods.forEach(hood => {
        if (!hood.lon) return;
        const miles = haversineMiles(point.lon, point.lat, hood.lon, hood.lat);
        if (!best || miles < best.miles) best = { label: hood.label, miles };
    });
    return best && best.miles <= 2.5 ? best.label : '';
}

const EARTH_MILES = 3958.8;

function haversineMiles(lonA, latA, lonB, latB) {
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(latB - latA);
    const dLon = toRad(lonB - lonA);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* ── Catalog ─────────────────────────────────────────────────────────────── */

async function loadCatalog(env) {
    if (catalogCache && Date.now() - catalogCache.builtAt < CATALOG_TTL_MS) return catalogCache;

    let rows = [];
    let source = 'sheet';
    try {
        rows = fromSheet(await fetchText(SHEET_URL));
        if (!rows.length) throw new Error('sheet has no usable rows');
        await addCoords(rows, env);
    } catch (err) {
        // The committed snapshot is the same fallback chicagoData.js uses in the browser.
        rows = fromSnapshot(await fetchText(env.SNAPSHOT_URL || DEFAULTS.SNAPSHOT_URL));
        source = 'snapshot';
        if (!rows.length) throw new Error('no place data available');
    }

    catalogCache = buildCatalog(rows, source);
    return catalogCache;
}

/* The sheet has no Lat/Lon columns of its own right now, so coordinates come from the
   committed geocode_cache.json keyed by street address — the same order chicagoData.js
   uses in the browser (sheet columns first, cache second). Without them "near me" has
   no distances to report, but every other question still works, so a missing cache is
   swallowed rather than thrown: it must not knock the catalog back to the snapshot. */
async function addCoords(rows, env) {
    if (!rows.some(row => row.lon == null || row.lat == null)) return;
    let cache = {};
    try {
        cache = JSON.parse(await fetchText(env.COORDS_URL || DEFAULTS.COORDS_URL)) || {};
    } catch (err) {
        return;
    }
    rows.forEach(row => {
        if (row.lon != null && row.lat != null) return;
        const hit = row.address && cache[row.address];
        if (Array.isArray(hit) && hit.length === 2) {
            row.lon = hit[0];
            row.lat = hit[1];
        }
    });
}

/* Merge the sheet rows into the catalog text the model reads. Entries are deduplicated
   by name + address (La Scarola is in the sheet twice) and grouped by neighborhood,
   each heading carrying the count the model quotes back for "how many" questions. */
function buildCatalog(rows, source) {
    const byKey = new Map();
    rows.forEach(row => {
        const key = `${row.name.toLowerCase()}|${row.address.toLowerCase()}`;
        if (byKey.has(key)) return;
        byKey.set(key, {
            name: row.name,
            type: row.type,
            neighborhood: row.neighborhood,
            address: shortAddress(row.address),
            notes: row.notes.replace(/\s+/g, ' ').trim(),
            lon: row.lon,
            lat: row.lat,
            layers: TYPE_LAYERS[row.type.toLowerCase()] || []
        });
    });
    const places = Array.from(byKey.values());

    // Group by the sheet's own Neighborhood text; anything blank lands in one bucket.
    const groups = new Map();
    places.forEach(place => {
        const label = place.neighborhood || 'Neighborhood not recorded';
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(place);
    });

    const hoods = Array.from(groups.keys()).sort().map(label => {
        const list = groups.get(label);
        const placed = list.filter(place => place.lon != null);
        return {
            label,
            count: list.length,
            lon: placed.length ? placed.reduce((sum, p) => sum + p.lon, 0) / placed.length : null,
            lat: placed.length ? placed.reduce((sum, p) => sum + p.lat, 0) / placed.length : null
        };
    });

    const lines = ['CATALOG — every saved place, grouped by neighborhood.',
        'Format: Name (Type) | address | notes'];
    hoods.forEach(hood => {
        lines.push('', `## ${hood.label} (${hood.count})`);
        groups.get(hood.label)
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(place => {
                const bits = [`- ${place.name} (${place.type || 'Place'})`];
                if (place.address) bits.push(place.address);
                if (place.notes) bits.push(place.notes);
                lines.push(bits.join(' | '));
            });
    });

    const layerLines = LAYER_ORDER.map(layer => {
        const types = Object.keys(TYPE_LAYERS)
            .filter(type => TYPE_LAYERS[type].indexOf(layer) !== -1)
            .map(titleCase);
        const count = places.filter(place => place.layers.indexOf(layer) !== -1).length;
        return `- ${layer} (${count} places): Types ${types.join(', ')}`;
    });

    return { places, hoods, layerLines, text: lines.join('\n'), source, builtAt: Date.now() };
}

// "5025 N Clark St, Chicago, IL 60640" -> "5025 N Clark St", but suburbs keep their city.
function shortAddress(address) {
    return String(address || '')
        .replace(/,\s*Chicago,\s*IL\s*\d*\s*$/i, '')
        .replace(/,\s*IL\s*\d*\s*$/i, '')
        .trim();
}

function titleCase(text) {
    return text.replace(/\b[a-z]/g, ch => ch.toUpperCase());
}

/* ── Sheet parsing ───────────────────────────────────────────────────────── */

function fromSheet(csv) {
    const table = parseCsv(csv);
    const header = table.shift() || [];
    const at = columnIndex(header);
    if (at.name == null) throw new Error('no Place column in sheet');

    return table
        .map(row => ({
            name: cell(row, at.name),
            type: cell(row, at.type),
            neighborhood: cell(row, at.neighborhood),
            notes: cell(row, at.notes),
            address: cell(row, at.address),
            lon: number(cell(row, at.lon)),
            lat: number(cell(row, at.lat))
        }))
        .filter(row => row.name);
}

function fromSnapshot(json) {
    const layers = JSON.parse(json);
    const features = (layers['Chicago Todo List'] && layers['Chicago Todo List'].features) || [];
    return features.map(feature => {
        const props = feature.properties || {};
        const coords = (feature.geometry && feature.geometry.coordinates) || [];
        return {
            name: String(props.name || '').trim(),
            type: String(props.type || '').trim(),
            neighborhood: String(props.neighborhood || '').trim(),
            notes: String(props.reviews || props.notes || '').trim(),
            address: String(props.address || '').trim(),
            lon: typeof coords[0] === 'number' ? coords[0] : null,
            lat: typeof coords[1] === 'number' ? coords[1] : null
        };
    }).filter(row => row.name);
}

// Map each known column name to its position in this sheet's header row.
function columnIndex(header) {
    const normalized = header.map(h => String(h || '').trim().toLowerCase());
    const at = {};
    Object.keys(COLUMNS).forEach(field => {
        at[field] = null;
        COLUMNS[field].some(alias => {
            const i = normalized.indexOf(alias);
            if (i === -1) return false;
            at[field] = i;
            return true;
        });
    });
    return at;
}

function cell(row, i) {
    return i == null ? '' : String(row[i] == null ? '' : row[i]).trim();
}

function number(text) {
    if (!text) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
}

/* A real CSV scan rather than a line split: some Reviews cells contain newlines and
   escaped quotes, so splitting on "\n" would shear rows apart. Same parser as
   chicagoData.js. */
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch !== '"') { field += ch; continue; }
            if (text[i + 1] === '"') { field += '"'; i++; continue; }
            quoted = false;
        } else if (ch === '"') {
            quoted = true;
        } else if (ch === ',') {
            row.push(field);
            field = '';
        } else if (ch === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else if (ch !== '\r') {
            field += ch;
        }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

async function fetchText(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(SHEET_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
}

/* ── Request plumbing ────────────────────────────────────────────────────── */

// Only user/assistant turns, trimmed and capped, so history cannot smuggle in a
// system prompt or grow the request without bound.
function history(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(msg => msg && (msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string')
        .slice(-MAX_HISTORY_TURNS)
        .map(msg => ({ role: msg.role, content: msg.content.trim().slice(0, MAX_HISTORY_CHARS) }))
        .filter(msg => msg.content);
}

function coords(raw) {
    if (!raw) return null;
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
}

// Fixed-window count per IP, held in the isolate. Not exact across isolates, but
// enough to keep one script from burning the day's free allowance.
function allowRequest(ip) {
    const now = Date.now();
    const recent = (rateLog.get(ip) || []).filter(at => now - at < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) {
        rateLog.set(ip, recent);
        return false;
    }
    recent.push(now);
    rateLog.set(ip, recent);
    if (rateLog.size > 5000) rateLog.clear();   // crude bound on isolate memory
    return true;
}

function corsHeaders(origin, env) {
    const allowed = String(env.ALLOWED_ORIGINS || DEFAULTS.ALLOWED_ORIGINS)
        .split(',').map(entry => entry.trim()).filter(Boolean);
    const headers = {
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
    };
    if (origin && allowed.indexOf(origin) !== -1) headers['Access-Control-Allow-Origin'] = origin;
    return headers;
}

async function health(env, cors) {
    let info = { ok: false };
    try {
        const catalog = await loadCatalog(env);
        info = {
            ok: true,
            places: catalog.places.length,
            neighborhoods: catalog.hoods.length,
            source: catalog.source,
            promptChars: catalog.text.length,
            model: env.MODEL || DEFAULTS.MODEL,
            keyConfigured: Boolean(env.OPENROUTER_API_KEY)
        };
    } catch (err) {
        info = { ok: false, error: 'could not load place data' };
    }
    return new Response(JSON.stringify(info, null, 2), {
        status: info.ok ? 200 : 503,
        headers: { ...cors, 'Content-Type': 'application/json' }
    });
}

function fail(status, message, cors, retryAfter) {
    const headers = { ...cors, 'Content-Type': 'application/json' };
    if (retryAfter) headers['Retry-After'] = String(retryAfter);
    return new Response(JSON.stringify({ error: message }), { status, headers });
}
