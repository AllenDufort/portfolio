/* ── Chicago Assistant API — Cloudflare Worker ─────────────────────────────
   The chat widget on a static GitHub Pages site cannot hold an Ollama Cloud key: any
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
     npx wrangler secret put OLLAMA_API_KEY         # from ollama.com — never commit it
     npx wrangler deploy
   Then put the deployed URL in WORKER_URL at the top of ../chicagoChat.js.

   Local development:
     cp .dev.vars.example .dev.vars                 # paste the key into .dev.vars
     npx wrangler dev                               # serves http://127.0.0.1:8787

   GET / returns a health summary (place count, neighborhoods, data source, model), so
   a deployment can be verified without spending a model call. */

const OLLAMA_CLOUD_URL = 'https://ollama.com/api/chat';

/* Overridable in wrangler.toml [vars]. The model is pinned server-side on purpose:
   the browser never chooses it, so nobody can swap in a paid model on this key. */
const DEFAULTS = {
    MODEL: 'gemma4:31b',
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
const SHEET_GID = '2011978534';
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

// Sheet headers are matched by name, so columns can be reordered or added freely.
const COLUMNS = {
    name:           ['place', 'name'],
    type:           ['type', 'category'],
    neighborhood:   ['neighborhood', 'neighbourhood', 'area'],
    notes:          ['reviews', 'notes', 'review'],
    description:    ['description'],
    address:        ['address'],
    phone:          ['phone'],
    website:        ['website'],
    ratingsAverage: ['ratingsaverage', 'rating', 'ratingaverage'],
    ratingsTotal:   ['ratingstotal', 'ratingcount', 'ratingtotal'],
    googleUrl:      ['googleurl', 'google_url'],
    originalUrl:    ['originalurl', 'original_url'],
    lat:            ['lat', 'latitude'],
    lon:            ['lon', 'lng', 'long', 'longitude']
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

        if (!env.OLLAMA_API_KEY) {
            return fail(500, 'The assistant is missing its API key. Run: wrangler secret put OLLAMA_API_KEY', cors);
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

        return askModel(env, catalog, point, messages, cors);
    }
};

/* ── Ollama Cloud — tools + agentic loop ─────────────────────────────────── */

/* Tools the model may call. The Worker executes every call against the in-memory
   catalog and feeds the results back before asking for the final reply, so the model
   never has to guess at details it can look up precisely. */
const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'search_places',
            description: 'Search saved places by name, type, or neighborhood. Returns matching places with all their details.',
            parameters: {
                type: 'object',
                properties: {
                    query:        { type: 'string',  description: 'Name, partial name, or keyword to search for.' },
                    type:         { type: 'string',  description: 'Filter by place type, e.g. Restaurant, Bar, Museum.' },
                    neighborhood: { type: 'string',  description: 'Filter by neighborhood name.' },
                    limit:        { type: 'integer', description: 'Max results to return (default 10, max 20).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_place_details',
            description: 'Get full details for a specific place by exact name: address, rating, review count, description, notes, phone, website.',
            parameters: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: { type: 'string', description: 'Exact or near-exact name of the place.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'find_nearby',
            description: 'Find saved places nearest to the visitor\'s current location, sorted by distance.',
            parameters: {
                type: 'object',
                properties: {
                    type:         { type: 'string',  description: 'Optional: filter by place type.' },
                    radius_miles: { type: 'number',  description: 'Search radius in miles (default 1).' },
                    limit:        { type: 'integer', description: 'Max results (default 10, max 20).' }
                }
            }
        }
    }
];

/* Execute a tool call against the live catalog. Returns a plain-text result string
   the model can read directly. All filtering is case-insensitive. */
function executeTool(name, args, catalog, point) {
    const cap = n => Math.min(Math.max(1, n || 10), 20);

    if (name === 'search_places') {
        const q     = String(args.query        || '').toLowerCase();
        const type  = String(args.type         || '').toLowerCase();
        const hood  = String(args.neighborhood || '').toLowerCase();
        const limit = cap(args.limit);

        const hits = catalog.places.filter(p => {
            if (q    && !p.name.toLowerCase().includes(q) &&
                        !(p.notes       || '').toLowerCase().includes(q) &&
                        !(p.description || '').toLowerCase().includes(q)) return false;
            if (type && !(p.type         || '').toLowerCase().includes(type)) return false;
            if (hood && !(p.neighborhood || '').toLowerCase().includes(hood)) return false;
            return true;
        }).slice(0, limit);

        if (!hits.length) return 'No places found matching those criteria.';
        return hits.map(p => formatPlace(p)).join('\n\n');
    }

    if (name === 'get_place_details') {
        const q = String(args.name || '').toLowerCase();
        const exact = catalog.places.find(p => p.name.toLowerCase() === q);
        const match = exact || catalog.places.find(p => p.name.toLowerCase().includes(q));
        if (!match) return `No place named "${args.name}" found in the catalog.`;
        return formatPlace(match, true);
    }

    if (name === 'find_nearby') {
        if (!point) return 'No visitor location available. Ask the visitor to share their location.';
        const type   = String(args.type || '').toLowerCase();
        const radius = args.radius_miles || 1;
        const limit  = cap(args.limit);

        const ranked = catalog.places
            .filter(p => p.lon != null)
            .filter(p => !type || (p.type || '').toLowerCase().includes(type))
            .map(p => ({ p, miles: haversineMiles(point.lon, point.lat, p.lon, p.lat) }))
            .filter(hit => hit.miles <= radius)
            .sort((a, b) => a.miles - b.miles)
            .slice(0, limit);

        if (!ranked.length) return `No places within ${radius} miles${type ? ` of type "${args.type}"` : ''}.`;
        return ranked.map(({ p, miles }) =>
            `${formatPlace(p)} | distance: ${miles.toFixed(2)} mi`
        ).join('\n\n');
    }

    return `Unknown tool: ${name}`;
}

/* Format a single place as a readable block for tool results. */
function formatPlace(p, full = false) {
    const lines = [`${p.name} (${p.type || 'Place'}) — ${p.neighborhood || 'Chicago'}`];
    if (p.address)        lines.push(`address: ${p.address}`);
    if (p.ratingsAverage != null) {
        const rev = p.ratingsTotal != null ? ` (${p.ratingsTotal} reviews)` : '';
        lines.push(`rating: ${p.ratingsAverage}★${rev}`);
    }
    if (p.description)    lines.push(`description: ${p.description}`);
    if (p.notes)          lines.push(`notes: ${p.notes}`);
    if (full || p.phone)  lines.push(`phone: ${p.phone || 'not listed'}`);
    if (full || p.website)lines.push(`website: ${p.website || 'not listed'}`);
    return lines.join('\n');
}

/* Agentic loop: call the model, handle any tool calls it makes, then call again
   until it produces a plain text reply. Tool calls are not streamed by Ollama —
   only the final text turn is, so we buffer the intermediate rounds and stream
   just the last one back to the browser. */
const MAX_TOOL_ROUNDS = 5;   // guard against a runaway loop

async function askModel(env, catalog, point, messages, cors) {
    const model = env.MODEL || DEFAULTS.MODEL;

    const callOllama = async (msgs, stream) => {
        const res = await fetch(OLLAMA_CLOUD_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.OLLAMA_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model,
                messages: msgs,
                tools: TOOLS,
                stream,
                options: { temperature: MODEL_TEMPERATURE, num_predict: MODEL_MAX_TOKENS }
            })
        });
        return res;
    };

    let msgs = messages;

    // Tool-call rounds (not streamed — we need the full JSON to parse tool calls).
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let upstream;
        try {
            upstream = await callOllama(msgs, false);
        } catch (err) {
            return fail(502, 'I could not reach the model just now — try again shortly.', cors);
        }
        if (!upstream.ok) {
            return fail(upstream.status || 502, await upstreamMessage(upstream), cors,
                upstream.headers.get('Retry-After'));
        }

        let data;
        try { data = await upstream.json(); } catch (err) {
            return fail(502, 'Unexpected response from the model.', cors);
        }

        const msg = data.message || {};
        const toolCalls = msg.tool_calls;

        // No tool calls — this is the final answer. Re-request with streaming.
        if (!toolCalls || !toolCalls.length) {
            msgs = [...msgs, { role: 'assistant', content: msg.content || '' }];
            break;
        }

        // Execute each tool call and add results to the message list.
        msgs = [...msgs, { role: 'assistant', content: msg.content || '', tool_calls: toolCalls }];
        for (const call of toolCalls) {
            const fn   = call.function || {};
            const name = fn.name || '';
            let fnArgs = {};
            try { fnArgs = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments || {}); }
            catch (err) { /* use empty args */ }

            const result = executeTool(name, fnArgs, catalog, point);
            msgs = [...msgs, { role: 'tool', content: result }];
        }
    }

    // Stream the final assistant reply back to the browser.
    let upstream;
    try {
        upstream = await callOllama(msgs, true);
    } catch (err) {
        return fail(502, 'I could not reach the model just now — try again shortly.', cors);
    }
    if (!upstream.ok || !upstream.body) {
        return fail(upstream.status || 502, await upstreamMessage(upstream), cors,
            upstream.headers.get('Retry-After'));
    }

    return new Response(upstream.body.pipeThrough(ndjsonTransform()), {
        headers: {
            ...cors,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        }
    });
}

/* Turn an Ollama Cloud status into something worth showing a visitor. */
async function upstreamMessage(res) {
    let detail = '';
    try {
        const data = await res.json();
        detail = (data && typeof data.error === 'string' ? data.error : '') ||
                 (data && data.error && data.error.message) || '';
    } catch (err) { /* an HTML error page — the status is all we have */ }

    switch (res.status) {
        case 401: return 'The assistant\'s API key was rejected. It may need to be rotated.';
        case 403: return detail || 'The model refused that request.';
        case 408:
        case 504: return 'The model took too long. Try a shorter question.';
        case 429: return 'Too many requests — give it a minute.';
        case 502: return 'The model is down at the moment. Try again shortly.';
        case 503: return 'The model is temporarily unavailable. Try again shortly.';
        default:  return detail || `The model returned an error (HTTP ${res.status}).`;
    }
}

/* Upstream NDJSON -> our SSE.
   Ollama /api/chat streams one JSON object per line:
     {"message":{"role":"assistant","content":"Hello"},"done":false}
     {"message":{"role":"assistant","content":""},"done":true}
   We forward message.content tokens, then emit [DONE]. */
function ndjsonTransform() {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';

    const send = (controller, payload) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

    return new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            lines.forEach(rawLine => {
                const line = rawLine.trim();
                if (!line) return;
                let data;
                try { data = JSON.parse(line); } catch (err) { return; }
                if (data.error) {
                    send(controller, { error: typeof data.error === 'string'
                        ? data.error : 'The model stopped early.' });
                    return;
                }
                const text = data.message && data.message.content;
                if (typeof text === 'string' && text) send(controller, { delta: text });
            });
        },
        flush(controller) {
            if (buffer.trim()) {
                try {
                    const data = JSON.parse(buffer.trim());
                    if (data.error) send(controller, { error: typeof data.error === 'string'
                        ? data.error : 'The model stopped early.' });
                } catch (err) { /* ignore */ }
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
    });
}

/* ── Prompt ──────────────────────────────────────────────────────────────── */

/* With tools available, the model no longer needs the whole catalog in the prompt.
   The system message tells it what it is, what tools it has, and how to behave.
   Actual place data comes back through tool results, which are precise and complete. */
function systemPrompt(catalog, _near, hasPoint) {
    const lines = [
        'You are Chicago Assistant, a guide to a personal Chicago TODO map of saved places.',
        `The map holds ${catalog.places.length} saved places across ${catalog.hoods.length} neighborhoods.`,
        '',
        'You have three tools:',
        '- search_places: find places by name, type, or neighborhood.',
        '- get_place_details: get every available field for one specific place (address, rating, review count, description, notes, phone, website).',
        '- find_nearby: find places closest to the visitor\'s current location, sorted by distance.',
        '',
        'Rules:',
        '- Always call a tool before answering. Never invent or guess any detail — all facts come from tool results.',
        '- For a specific place question (phone, rating, address, website, description), call get_place_details and quote the result exactly. If a field is absent in the result, say it is not listed.',
        '- For "near me" questions, call find_nearby. If no location is available, tell the visitor to allow location access or name a neighborhood.',
        '- For list questions, call search_places. Use "- " bullets, at most 8 results, note the total when there are more.',
        '- Always include Type and neighborhood in your reply. Add the address when the visitor is heading somewhere.',
        '- Plain text only, no markdown headings or tables. Skip preamble and pleasantries.'
    ];

    if (!hasPoint) {
        lines.push('', '- The visitor has not shared their location. find_nearby is unavailable until they do.');
    }

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
    const rating = place.ratingsAverage != null
        ? ` | ${place.ratingsAverage}★${place.ratingsTotal != null ? ` (${place.ratingsTotal})` : ''}`
        : '';
    const address = place.address ? ` | ${place.address}` : '';
    return `- ${place.name} (${place.type || 'Place'}) | ${hit.miles.toFixed(decimals)} mi | ` +
        `${place.neighborhood || 'Chicago'}${rating}${address}`;
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
            name:           row.name,
            type:           row.type,
            neighborhood:   row.neighborhood,
            address:        shortAddress(row.address),
            notes:          row.notes.replace(/\s+/g, ' ').trim(),
            description:    (row.description || '').replace(/\s+/g, ' ').trim(),
            phone:          row.phone || '',
            website:        row.website || '',
            ratingsAverage: row.ratingsAverage,
            ratingsTotal:   row.ratingsTotal,
            lon:            row.lon,
            lat:            row.lat
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

    const lines = [
        'CATALOG — every saved place, grouped by neighborhood.',
        'Each entry lists every available field. Fields that are absent are not shown.',
        'Format per line: Name (Type) | neighborhood | [address: …] | [rating: …★ (N reviews)] | [description: …] | [notes: …] | [phone: …] | [website: …]'
    ];
    hoods.forEach(hood => {
        lines.push('', `## ${hood.label} (${hood.count})`);
        groups.get(hood.label)
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(place => {
                const parts = [`- ${place.name} (${place.type || 'Place'}) | ${place.neighborhood || 'Chicago'}`];
                if (place.address)        parts.push(`address: ${place.address}`);
                if (place.ratingsAverage != null) {
                    const rev = place.ratingsTotal != null ? ` (${place.ratingsTotal} reviews)` : '';
                    parts.push(`rating: ${place.ratingsAverage}★${rev}`);
                }
                if (place.description)    parts.push(`description: ${place.description}`);
                if (place.notes)          parts.push(`notes: ${place.notes}`);
                if (place.phone)          parts.push(`phone: ${place.phone}`);
                if (place.website)        parts.push(`website: ${place.website}`);
                lines.push(parts.join(' | '));
            });
    });

    return { places, hoods, text: lines.join('\n'), source, builtAt: Date.now() };
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
            name:           cell(row, at.name),
            type:           cell(row, at.type),
            neighborhood:   cell(row, at.neighborhood),
            notes:          cell(row, at.notes),
            description:    cell(row, at.description),
            address:        cell(row, at.address),
            phone:          cell(row, at.phone),
            website:        cell(row, at.website),
            ratingsAverage: number(cell(row, at.ratingsAverage)),
            ratingsTotal:   number(cell(row, at.ratingsTotal)),
            lon:            number(cell(row, at.lon)),
            lat:            number(cell(row, at.lat))
        }))
        .filter(row => row.name);
}

function fromSnapshot(json) {
    const fc = JSON.parse(json);
    const features = fc.features || [];
    return features.map(feature => {
        const props = feature.properties || {};
        const coords = (feature.geometry && feature.geometry.coordinates) || [];
        return {
            name:           String(props.name || '').trim(),
            type:           String(props.type || '').trim(),
            neighborhood:   String(props.neighborhood || '').trim(),
            notes:          String(props.reviews || props.notes || '').trim(),
            description:    String(props.description || '').trim(),
            address:        String(props.address || '').trim(),
            phone:          String(props.phone || '').trim(),
            website:        String(props.website || '').trim(),
            ratingsAverage: typeof props.ratingsAverage === 'number' ? props.ratingsAverage : null,
            ratingsTotal:   typeof props.ratingsTotal === 'number' ? props.ratingsTotal : null,
            lon:            typeof coords[0] === 'number' ? coords[0] : null,
            lat:            typeof coords[1] === 'number' ? coords[1] : null
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
            keyConfigured: Boolean(env.OLLAMA_API_KEY)
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
