/* ── Chicago Assistant API — Cloudflare Worker ─────────────────────────────
   The chat widget on a static GitHub Pages site cannot hold a model API key: any
   key shipped to the browser is public. So the keys live here as Worker secrets and
   the page talks to this endpoint instead.

   Answers can come from Gemini or from Groq. The page picks a model and the provider
   follows from its id — but only ids in ALLOWED_MODELS are honoured, see below.

   This Worker does more than forward requests. It builds the entire prompt itself —
   fetching the Google Sheet, counting out the vocabulary the model has to translate the
   visitor's words into, running the searches it asks for, and computing real distances
   when the visitor shares their location. The page only ever sends a question, a little
   chat history, and optional coordinates, which means this endpoint can *only* answer
   questions about the Chicago map. It is not a general LLM relay somebody can point at
   their own prompts, which is the main risk of putting a paid key behind a public URL.

   Deploy:
     bash assets/chicago_list/worker/deploy.sh      # sets the API key secrets and deploys
   Then put the deployed URL in WORKER_URL at the top of ../chicagoChat.js.

   Local development:
     cp .dev.vars.example .dev.vars                 # paste your API keys into .dev.vars
     npx wrangler dev --config wrangler.toml        # serves http://127.0.0.1:8787
                                                    # (the flag matters: without it
                                                    #  wrangler finds the repo-root
                                                    #  wrangler.jsonc instead)

   GET / returns a health summary (place count, neighborhoods, data source, the counted
   Type vocabulary the prompt is built from, the default model and allowlist, which keys
   are set), so a deployment can be verified without spending a model call. */

/* Overridable in wrangler.toml [vars]. MODEL is the default the page gets when it asks
   for nothing, or asks for something not on the allowlist below. */
const DEFAULTS = {
    MODEL: 'openai/gpt-oss-120b',
    ALLOWED_ORIGINS: [
        'https://allendufort.github.io',
        'http://localhost:8000', 'http://127.0.0.1:8000',
        'http://localhost:5500', 'http://127.0.0.1:5500'
    ].join(','),
    SNAPSHOT_URL: 'https://allendufort.github.io/portfolio/assets/chicago_list/chicago_layers.geojson',
    COORDS_URL: 'https://allendufort.github.io/portfolio/assets/chicago_list/geocode_cache.json'
};

/* The page chooses a model, so this endpoint would otherwise be a way to spend the keys
   on whatever model a scripted caller names. It is not: an id that is not on this list
   is discarded and DEFAULTS.MODEL is used instead, so the worst a caller can do is pick
   another cheap model. Everything here is flash-tier, Gemma, or a small Groq model — no
   pro models, which is what keeps a public URL on a paid key affordable.

   Keep in sync with the <select id="chat-model"> options in ../../../chicagoMap.html. */
const ALLOWED_MODELS = [
    // Groq
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b',
    // Gemini (flash tier only)
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    /* Gemma 4 — Google's open-weights family, served by the Gemini endpoint (see
       providerFor). Verified against the live API to accept systemInstruction, call
       functionDeclarations, and stream, so the tool loop works here unchanged. */
    'gemma-4-31b-it',
    'gemma-4-26b-a4b-it'
];

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

/* ── Providers ─────────────────────────────────────────────────────────────
   Two upstreams, chosen by model id: every Groq id is namespaced ("openai/…",
   "qwen/…") or bare, and Groq serves none of Google's models, so the prefix decides.

   Both "gemini-*" and "gemma-*" are Google's — Gemma is an open-weights family, but on
   this key it is served by the same generativelanguage.googleapis.com endpoint, speaks
   the same request shape, and is billed the same way, so it is simply a Gemini-path
   model here. Matching only "gemini-" would route it to Groq, which does not serve it.

   These few helpers are deliberately duplicated in ../../travel/worker/worker.js
   rather than shared: each worker deploys as one standalone file with no bundler,
   and a shared module would mean a build step for ~40 lines. */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/* Reasoning models think before answering and those hidden tokens are billed against the
   same budget as the reply, so a bare 700-token cap can be spent entirely on thinking and
   return nothing at all. Every request gets extra room on top of the cap.

   Both providers need this: Groq's gpt-oss and qwen models reason, and so does Gemma on the
   Gemini path. The headroom is a ceiling, not a reservation, so a model that does not think
   is unaffected. */
const REASONING_HEADROOM = 1024;

/* Groq alone exposes a dial for how much thinking to do; Gemma rejects thinkingConfig
   ("Thinking budget is not supported for this model"), so on the Gemini path the headroom
   above is the only lever. */
const GROQ_REASONING_EFFORT = 'low';

function providerFor(model) {
    const id = String(model);
    return (id.startsWith('gemini-') || id.startsWith('gemma-')) ? 'gemini' : 'groq';
}

function apiKeyFor(provider, env) {
    return provider === 'gemini' ? env.GEMINI_API_KEY : env.GROQ_API_KEY;
}

/* Only an allowlisted id is honoured; anything else falls back to the default. */
function resolveModel(requested, env) {
    const asked = String(requested || '').trim();
    if (ALLOWED_MODELS.includes(asked)) return asked;
    return env.MODEL || DEFAULTS.MODEL;
}

/* Always the non-streaming endpoint: the reply is buffered here so the tool calls can be
   parsed out of it, and streamAnswer re-frames the finished text as SSE for the browser. */
function geminiUrl(model, apiKey) {
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}

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

        let body;
        try {
            body = await request.json();
        } catch (err) {
            return fail(400, 'Expected a JSON body.', cors);
        }

        const question = String(body && body.question || '').trim().slice(0, MAX_QUESTION_CHARS);
        if (!question) return fail(400, 'Ask a question first.', cors);

        // The page may ask for a model, but only an allowlisted one is honoured.
        const model    = resolveModel(body && body.model, env);
        const provider = providerFor(model);
        if (!apiKeyFor(provider, env)) {
            const keyName = provider === 'gemini' ? 'GEMINI_API_KEY' : 'GROQ_API_KEY';
            return fail(500, `The assistant is missing its ${keyName}. Run: bash deploy.sh`, cors);
        }

        let catalog;
        try {
            catalog = await loadCatalog(env);
        } catch (err) {
            return fail(503, 'I could not reach the place list just now — try again shortly.', cors);
        }

        const point = coords(body && body.coords);
        const near = nearbyBlock(catalog, point);
        const systemText = systemPrompt(catalog, near, Boolean(point));
        const historyTurns = history(body && body.history);

        /* Provider-neutral transcript — converted into each API's own shape only when a
           request is built, so the tool loop below stays single-threaded. */
        const turns = [
            ...historyTurns.map(m => ({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                text: m.content
            })),
            { role: 'user', text: question }
        ];

        return askModel(env, { model, provider, catalog, point, systemText, turns, cors });
    }
};

/* ── Function calling + agentic loop ─────────────────────────────────────── */

/* The canonical tool schema, written in Gemini's functionDeclarations format. Groq's
   OpenAI-style declarations are mapped from this in buildBody(), so the JSON Schema for
   each tool is written once here and never duplicated per provider. */
const TOOL_DECLARATIONS = [
    {
        name: 'search_places',
        description: 'Search saved places by keyword, type, or neighborhood. Keywords are matched against ' +
            'each place\'s name, type, sub-category, and notes, so one call can cover a whole theme. ' +
            'Returns matching places with all their details, and the total when there are more than shown.',
        parameters: {
            type: 'object',
            properties: {
                query:        { type: 'string',  description: 'One keyword, or a comma-separated list matched as OR — ' +
                                                              'a place is returned if it matches ANY term. Use stems so one ' +
                                                              'term covers variants ("argentin" catches Argentine and Argentinian). ' +
                                                              'Example: "mexican, cuban, peruvian, colombian, taco, arepa".' },
                type:         { type: 'string',  description: 'Filter by place type from the Type list in your instructions. ' +
                                                              'Everyday words are accepted ("bookstore" finds Books).' },
                neighborhood: { type: 'string',  description: 'Filter by neighborhood name.' },
                limit:        { type: 'integer', description: 'Max results to return (default 10, max 20).' }
            }
        }
    },
    {
        name: 'get_place_details',
        description: 'Get full details for a specific place by exact name: address, rating, review count, description, notes, phone, website.',
        parameters: {
            type: 'object',
            required: ['name'],
            properties: {
                name: { type: 'string', description: 'Exact or near-exact name of the place.' }
            }
        }
    },
    {
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
];

/* Execute a tool call against the live catalog. Returns a plain-text result string
   the model can read directly. All filtering is case-insensitive. */
function executeTool(name, args, catalog, point) {
    const cap = n => Math.min(Math.max(1, n || 10), 20);

    if (name === 'search_places') {
        const terms = keywords(args.query);
        const type  = String(args.type         || '').toLowerCase().trim();
        const hood  = String(args.neighborhood || '').toLowerCase().trim();
        const limit = cap(args.limit);

        /* A type word that is not in the vocabulary at all ("barbecue", "speakeasy") is
           narrowed with instead of filtered on, so a near-miss trims the result rather
           than emptying it — "barbecue" then finds the barbecue sub-category. */
        const wanted   = type ? resolveTypes(type, catalog.types) : [];
        const typeWord = type && !wanted.length ? type : '';

        const hits = catalog.places.filter(p => {
            if (terms.length && !terms.some(term => haystack(p).includes(term))) return false;
            if (wanted.length && !wanted.includes(p.type)) return false;
            if (typeWord && !haystack(p).includes(typeWord)) return false;
            if (hood && !(p.neighborhood || '').toLowerCase().includes(hood)) return false;
            return true;
        });

        if (!hits.length) {
            return 'No places found matching those criteria. Try more keywords, shorter stems, or ' +
                'drop the type or neighborhood filter before telling the visitor there are none.';
        }

        // The total matters even when the list is cut: "8 of 41" is the difference between
        // "here are a few" and a wrong "that is all the map has".
        const shown  = hits.slice(0, limit);
        const header = hits.length > shown.length
            ? `${hits.length} places match; showing the first ${shown.length}:`
            : `${hits.length} place${hits.length === 1 ? '' : 's'} match:`;
        return [header, ...shown.map(p => formatPlace(p))].join('\n\n');
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
        const type   = String(args.type || '').toLowerCase().trim();
        const radius = args.radius_miles || 1;
        const limit  = cap(args.limit);

        // Resolved the same way as in search_places, so "bookstores near me" reaches Books.
        const wanted = type ? resolveTypes(type, catalog.types) : [];
        const near   = place => {
            if (!type) return true;
            return wanted.length ? wanted.includes(place.type) : haystack(place).includes(type);
        };

        const ranked = catalog.places
            .filter(p => p.lon != null)
            .filter(near)
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

/* ── Matching the visitor's words to the sheet's words ─────────────────────
   The two rarely agree. The Type column says "Books" where people say "bookstores",
   and a cuisine is never a Type at all — "Colombian" lives in the description, under
   whatever Google called the place. Both gaps used to read back as "the map has none",
   so the query is ORed across keywords and the type is matched loosely. */

/* query is a comma-separated list matched as OR: "mexican, peruvian, taco" returns a
   place matching any one term. A theme like "latino restaurants" has no single word to
   search for — it is a list of cuisines — so ORing turns what would be a dozen one-term
   calls, or one call that finds nothing, into a single search. */
function keywords(query) {
    return String(query || '')
        .split(',')
        .map(term => term.trim().toLowerCase())
        .filter(Boolean);
}

/* Keywords are matched against the whole card, type and sub-category included, because
   that is where a cuisine actually is: "Colombian" is in the description, not the name.
   Neighborhood is left out on purpose — it has its own filter, and including it would
   make a search for "park" return everything in Lincoln Park. */
function haystack(place) {
    return [place.name, place.type, place.description, place.notes]
        .join(' ')
        .toLowerCase();
}

/* Everyday words for each Type value, kept singular. Only aliases that no amount of
   stemming would reach belong here: "bookstore" never becomes "Books" on its own. */
const TYPE_SYNONYMS = {
    books:      ['book', 'bookstore', 'bookshop', 'comic', 'library', 'reading'],
    cafe:       ['coffee', 'coffeeshop', 'espresso', 'tea', 'latte'],
    brunch:     ['breakfast', 'pancake', 'diner', 'morning'],
    restaurant: ['food', 'eatery', 'dining', 'dinner', 'lunch', 'cuisine', 'place to eat'],
    snack:      ['dessert', 'sweet', 'treat', 'bakery', 'donut', 'doughnut', 'ice cream'],
    bar:        ['pub', 'tavern', 'cocktail', 'drink', 'brewery', 'brewpub', 'lounge', 'wine'],
    club:       ['nightclub', 'nightlife', 'dancing', 'dance', 'live music'],
    retail:     ['shop', 'shopping', 'store', 'clothing', 'thrift', 'vintage', 'boutique'],
    market:     ['grocery', 'grocerie', 'farmer market', 'food hall'],
    museum:     ['gallery', 'exhibit', 'art', 'aquarium', 'planetarium', 'zoo'],
    landmark:   ['sight', 'attraction', 'monument', 'tourist', 'architecture'],
    park:       ['garden', 'green space', 'outdoor'],
    beach:      ['lake', 'lakefront', 'shore', 'swim'],
    activity:   ['thing to do', 'entertainment', 'fun', 'game']
};

/* Plural stripping, enough to let "bookstores" reach "bookstore", "beaches" reach
   "beach", and "Restaurant" answer to "restaurants". Not a real stemmer, and does not
   need to be. */
function singular(word) {
    if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
    if (/(ch|sh|s|x|z)es$/.test(word)) return word.slice(0, -2);
    if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
}

/* Which Type values the visitor's word refers to, resolved against the vocabulary as a
   whole rather than one place at a time — that is what lets a direct hit outrank an
   alias. "coffee shops" is Cafe, and without the preference the Retail alias "shop"
   would drag in every clothing store alongside it.

   Matching is word by word, never a bare substring: "barbecue" contains "bar", and
   substring matching would hand back all 96 bars. */
function resolveTypes(asked, types) {
    const words  = asked.split(/[^a-z]+/).filter(Boolean).map(singular);
    const phrase = words.join(' ');
    const direct = [];
    const viaAlias = [];   // { label, at } — which word in the phrase the alias matched

    types.forEach(({ label }) => {
        const key = label.toLowerCase();
        if (key === asked || words.includes(singular(key))) {
            direct.push(label);
            return;
        }
        // Multi-word aliases ("ice cream") are not in the word list, so they are matched
        // against the singularized phrase and scored by their first word.
        let at = -1;
        (TYPE_SYNONYMS[key] || []).forEach(alias => {
            const found = alias.includes(' ')
                ? (phrase.includes(alias) ? words.indexOf(alias.split(' ')[0]) : -1)
                : words.indexOf(alias);
            if (found !== -1 && (at === -1 || found < at)) at = found;
        });
        if (at !== -1) viaAlias.push({ label, at });
    });

    if (direct.length)   return direct;
    if (!viaAlias.length) return [];

    /* In a compound like "coffee shop" or "book store" the modifier is the specific half.
       Keeping only the earliest match returns Cafe and Books, rather than adding every
       Retail place that also answers to "shop" and "store". */
    const earliest = Math.min(...viaAlias.map(hit => hit.at));
    return viaAlias.filter(hit => hit.at === earliest).map(hit => hit.label);
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

/* ── Provider adapters ─────────────────────────────────────────────────────
   The transcript and TOOL_DECLARATIONS are the canonical forms; these translate them
   into whichever shape the provider speaks. Transcript turns are:

     {role:'user',      text}
     {role:'assistant', text, toolCalls:[{id, name, args, signature?}]}
     {role:'tool',      results:[{id, name, result}]}

   `signature` is provider-opaque and only Gemini sets it; see parseTurn().           */

function buildBody(provider, { model, systemText, turns }) {
    if (provider === 'gemini') {
        const contents = [];
        turns.forEach(turn => {
            if (turn.role === 'tool') {
                // Gemini takes all results as one "user" turn and ignores call ids.
                contents.push({
                    role: 'user',
                    parts: turn.results.map(r => ({
                        functionResponse: { name: r.name, response: { result: r.result } }
                    }))
                });
                return;
            }
            const parts = [];
            if (turn.text) parts.push({ text: turn.text });
            (turn.toolCalls || []).forEach(c => parts.push({
                functionCall: { name: c.name, args: c.args },
                ...(c.signature ? { thoughtSignature: c.signature } : {})
            }));
            contents.push({ role: turn.role === 'assistant' ? 'model' : 'user', parts });
        });

        return JSON.stringify({
            systemInstruction: { parts: [{ text: systemText }] },
            contents,
            tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
            generationConfig: {
                maxOutputTokens: MODEL_MAX_TOKENS + REASONING_HEADROOM,
                temperature:     MODEL_TEMPERATURE
            }
        });
    }

    const messages = [{ role: 'system', content: systemText }];
    turns.forEach(turn => {
        if (turn.role === 'tool') {
            // Groq wants one message per result, each tied back by tool_call_id.
            turn.results.forEach(r => messages.push({
                role: 'tool', tool_call_id: r.id, content: r.result
            }));
            return;
        }
        if (turn.role === 'assistant') {
            const msg = { role: 'assistant', content: turn.text || null };
            if (turn.toolCalls?.length) {
                msg.tool_calls = turn.toolCalls.map(c => ({
                    id:   c.id,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
                }));
            }
            messages.push(msg);
            return;
        }
        messages.push({ role: 'user', content: turn.text });
    });

    return JSON.stringify({
        model,
        messages,
        tools: TOOL_DECLARATIONS.map(d => ({
            type: 'function',
            function: { name: d.name, description: d.description, parameters: d.parameters }
        })),
        max_completion_tokens: MODEL_MAX_TOKENS + REASONING_HEADROOM,
        temperature:           MODEL_TEMPERATURE,
        reasoning_effort:      GROQ_REASONING_EFFORT
    });
}

/* Normalise one non-streaming response to {text, toolCalls}.

   Gemini:  candidates[0].content.parts[] — each part is {text} or {functionCall:{name,args}}
   Groq:    choices[0].message — {content, tool_calls:[{id,function:{name,arguments}}]}   */
function parseTurn(provider, data) {
    if (provider === 'gemini') {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        return {
            /* Thought parts dropped. On a tool round this text
               becomes the assistant turn in the transcript, so keeping them would feed a
               thinking model's own reasoning back to it as something it had said. */
            text: parts.filter(p => !p.thought && typeof p.text === 'string')
                .map(p => p.text).join(''),
            toolCalls: parts.filter(p => p.functionCall).map((p, i) => ({
                // Gemini 3 sends an id; older models do not, so fall back to a stable one.
                id:   p.functionCall.id || `call_${i}`,
                name: p.functionCall.name,
                args: p.functionCall.args || {},
                /* Opaque to us, but Gemini 3 requires the signature it issued with a
                   functionCall to come back alongside that call in the next request, or it
                   rejects the turn. Carried through the neutral transcript untouched. */
                signature: p.thoughtSignature
            }))
        };
    }

    const message = data?.choices?.[0]?.message || {};
    return {
        text: message.content || '',
        toolCalls: (message.tool_calls || []).map(c => {
            // Groq sends arguments as a JSON string, where Gemini sends a real object.
            let args = {};
            try { args = JSON.parse(c.function?.arguments || '{}'); }
            catch (err) { /* malformed — run the tool with no arguments */ }
            return { id: c.id, name: c.function?.name, args };
        })
    };
}

function upstreamRequest(provider, { model, apiKey, systemText, turns }) {
    const body = buildBody(provider, { model, systemText, turns });
    if (provider === 'gemini') {
        return [geminiUrl(model, apiKey), {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body
        }];
    }
    return [GROQ_URL, {
        method: 'POST',
        headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body
    }];
}

/* Agentic loop: call the model, run any tool calls it makes, then call again until it
   produces a plain text reply — which is also the answer the visitor gets, streamed back
   from the buffer rather than re-requested. No round is streamed from upstream: a tool
   call has to be parsed out of a whole JSON body, and by the time the model stops calling
   tools it has already written the reply.

   It used to throw that reply away and ask the same turn again with `stream: true`, purely
   to get SSE out of the provider. That cost an extra call per question and was the source
   of the empty-reply bug: the re-request is a fresh sample, and a model that answered the
   first time sometimes calls a tool the second time, streaming no text at all. Forbidding
   the call (`tool_choice: 'none'`) only moved the failure — Groq's gpt-oss called a tool
   anyway and the API rejected the request with "Tool choice is none, but model called a
   tool". Keeping the text the model already produced fixes it outright, and saves a
   full-prompt call per question, which matters against a per-minute token budget. */
const MAX_TOOL_ROUNDS = 5;   // guard against a runaway loop

async function askModel(env, { model, provider, catalog, point, systemText, turns, cors }) {
    const apiKey = apiKeyFor(provider, env);

    const call = msgs => {
        const [url, init] = upstreamRequest(provider, { model, apiKey, systemText, turns: msgs });
        return fetch(url, init);
    };

    let msgs   = turns;
    let answer = '';

    /* One extra pass beyond MAX_TOOL_ROUNDS: the last one reads the model's reply but
       runs no tools, so five rounds of searching still get a turn to write an answer. */
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        let upstream;
        try {
            upstream = await call(msgs);
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

        const { text, toolCalls } = parseTurn(provider, data);

        /* No tool calls — the model is answering, so this text IS the answer.

           finishReason deliberately plays no part in this test. Gemini reports "STOP" on
           the tool-call turn itself (verified against the live API), so the older
           `|| finishReason === 'STOP'` check here meant a tool was never actually run on
           the Gemini path. Groq is unambiguous — it reports "tool_calls" — but the tool
           calls themselves are the reliable signal for both. */
        if (!toolCalls.length || round === MAX_TOOL_ROUNDS) {
            answer = text;
            break;
        }

        msgs = [
            ...msgs,
            { role: 'assistant', text, toolCalls },
            {
                role: 'tool',
                results: toolCalls.map(c => ({
                    id:     c.id,
                    name:   c.name,
                    result: executeTool(c.name, c.args || {}, catalog, point)
                }))
            }
        ];
    }

    /* Only reachable if the model spent every round on tools and still wrote nothing.
       An empty 200 reads as a broken widget, so say something a visitor can act on. */
    if (!answer.trim()) {
        return fail(502, 'The model kept searching without answering — try a simpler question.', cors);
    }

    return streamAnswer(answer, cors);
}

/* The reply is already complete, so this is the SSE envelope the page expects rather than
   a relay of an upstream stream: same `{"delta"}` frames and `[DONE]`, emitted in one pass.
   Chunked on whitespace so a long answer paints in reading order instead of one block, and
   with no artificial delay — the text is in hand, and pacing it out would only add latency. */
const STREAM_CHUNK_CHARS = 90;

function streamAnswer(text, cors) {
    const encoder = new TextEncoder();
    const stream  = new ReadableStream({
        start(controller) {
            const send = obj => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            for (const chunk of chunkText(text, STREAM_CHUNK_CHARS)) send({ delta: chunk });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        }
    });

    return new Response(stream, {
        headers: {
            ...cors,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        }
    });
}

/* Split on whitespace runs, keeping the whitespace, so joining the chunks reproduces the
   text exactly — newlines and blank lines included, which the widget renders as markdown. */
function chunkText(text, size) {
    const chunks = [];
    let current  = '';
    for (const piece of String(text).split(/(\s+)/)) {
        if (current && current.length + piece.length > size) {
            chunks.push(current);
            current = '';
        }
        current += piece;
    }
    if (current) chunks.push(current);
    return chunks;
}

/* Turn a provider API error response into something worth showing a visitor.
   Gemini and Groq both nest the human-readable text at error.message. */
async function upstreamMessage(res) {
    let detail = '';
    try {
        const data = await res.json();
        detail = (data && data.error && data.error.message) ||
                 (data && typeof data.error === 'string' ? data.error : '') || '';
    } catch (err) { /* an HTML error page — the status is all we have */ }

    switch (res.status) {
        case 400: return detail || 'Bad request to model API.';
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

/* ── Prompt ──────────────────────────────────────────────────────────────── */

/* With tools available, the model no longer needs the whole catalog in the prompt. What
   it does need is the sheet's vocabulary — the Type values and the description
   sub-categories, both counted in buildCatalog. Without them the model searches for the
   words a visitor used ("bookstores", "latino") rather than the words the sheet uses
   ("Books", "Colombian restaurant"), finds nothing, and reports that the map is empty on
   a subject where it holds dozens of places. Actual place data still comes back only
   through tool results, which are precise and complete. */
function systemPrompt(catalog, _near, hasPoint) {
    const lines = [
        'You are Chicago Assistant, a guide to a personal Chicago TODO map of saved places.',
        `The map holds ${catalog.places.length} saved places across ${catalog.hoods.length} neighborhoods.`,
        '',
        'Tools:',
        '- search_places: find places by keyword, type, or neighborhood. query takes a comma-separated list and matches ANY term against a place\'s name, type, sub-category, and notes, so one call can cover a whole theme.',
        '- get_place_details: every available field for one specific place (address, rating, review count, description, notes, phone, website).',
        '- find_nearby: places closest to the visitor\'s current location, sorted by distance.',
        '',
        'TYPE is a closed set. These are the only values in the map, with counts:',
        vocabLine(catalog.types),
        '',
        'Most places also carry a finer sub-category, which search_places matches. Those present:',
        vocabLine(catalog.tags),
        '',
        'Reading the question — do this before calling anything:',
        '- Decide whether the ask names a Type, a sub-category, or a theme spanning several, then translate it into the vocabulary above. The visitor will not use the sheet\'s words.',
        '- Everyday words for a Type: bookstores are Books, coffee is Cafe, breakfast is Brunch, shops are Retail or Market, nightlife is Bar and Club, desserts and ice cream are Snack, sights are Landmark.',
        '- A theme is not a search term. Expand it into every sub-category, country, and dish that belongs to it and send them as ONE comma-separated query. Use stems so a term covers variants — "argentin" catches Argentine and Argentinian, "taco" catches tacos and taqueria.',
        '  "latino restaurants" or "hispanic food" — every Latin American country counts, not just Mexican: query "mexican, latin, cuban, puerto ric, peruvian, colombian, venezuel, argentin, chilean, bolivi, ecuador, salvador, guatemal, honduran, nicaragu, dominican, brazil, taco, taqueria, arepa, empanada, birria, ceviche, mole".',
        '  "asian food": query "chinese, japanese, korean, thai, vietnamese, filipino, malaysian, nepalese, asian, sushi, ramen, dumpling, hot pot, bubble tea, dim sum".',
        '  "bookstores": type "Books" — no query needed, the Type already is the answer.',
        '- A cuisine is not confined to one Type: Cuban, Mexican and Peruvian places are filed under Bar, Brunch and Cafe as well as Restaurant. Send the query on its own first; add a type only to narrow a long result, and drop it again if that comes back thin.',
        '- Then read the Type of every hit and drop the ones that do not fit the ask. A keyword match is not a guarantee — the National Museum of Puerto Rican Arts & Culture matches "puerto ric" and is not a restaurant.',
        '  Asked about eating or drinking, keep only Restaurant, Bar, Brunch, Cafe, Snack, Market and Club. Museum, Landmark, Park, Books, Retail, Activity and Beach are never food, whatever they matched on.',
        '  Then count what is left and report that number. Do not quote the search total as if every hit survived, and do not widen the wording to cover what you dropped — no "and related venues".',
        '- Never say the map has nothing after one narrow attempt. Add keywords, shorten them to stems, or drop the type or neighborhood, and search again before reporting none.',
        '',
        'Answering:',
        '- Always call a tool before answering. Never invent or guess any detail — all facts come from tool results.',
        '- For a specific place question (phone, rating, address, website, description), call get_place_details and quote the result exactly. If a field is absent in the result, say it is not listed.',
        '- For "near me" questions, call find_nearby. If no location is available, tell the visitor to allow location access or name a neighborhood.',
        '- For list questions, call search_places. Use "- " bullets, at most 8 results, note the total when there are more.',
        '- Always include Type and neighborhood in your reply. Add the address when the visitor is heading somewhere.',
        '- After interpreting a broad ask, open with one short line saying what you took it to mean, e.g. "Latin American spots on the map — Mexican, Cuban, Peruvian and Colombian:".',
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

/* Distinct labels with their counts, most common first, blanks dropped. */
function tally(labels) {
    const counts = new Map();
    labels.forEach(label => {
        const key = String(label || '').trim();
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });
    return Array.from(counts, ([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/* The sub-category at the head of a description: "Colombian restaurant: Small, casual
   spot…" -> "Colombian restaurant". A few rows are a bare sentence with no category at
   all, so anything too long to be a label is dropped rather than sent to the prompt as
   noise. */
const MAX_TAG_CHARS = 40;
const MAX_TAG_WORDS = 5;

function descriptionTag(description) {
    const head = String(description || '').split(':')[0].trim();
    if (!head || head.length > MAX_TAG_CHARS) return '';
    return head.split(/\s+/).length <= MAX_TAG_WORDS ? head : '';
}

/* A vocabulary as one prompt line. Counts are included because they tell the model what
   to expect: "Colombian restaurant (1)" makes a single hit a complete answer, not a
   failed search worth retrying. */
function vocabLine(entries) {
    return entries.map(entry => `${entry.label} (${entry.count})`).join(', ');
}

/* Build the catalog the tools search. Entries are deduplicated by name + address
   (La Scarola is in the sheet twice); the neighborhood grouping survives because
   find_nearby names the visitor's own area from these averaged centroids. */
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

    /* Two vocabularies, counted from the rows themselves and handed to the model in the
       system prompt. Neither is guessable from outside the sheet: the Type column is a
       small closed set its author chose ("Books", not "Bookstore"), and the description
       column carries a Google-Maps-style sub-category ("Colombian restaurant", "Comic
       book store") that is the only place a cuisine is recorded. Telling the model what
       the words actually are is what lets it turn "bookstores" into type Books, and
       "latino restaurants" into the cuisines the map really holds. Counted rather than
       hardcoded so a new Type in the sheet reaches the prompt with the next refresh. */
    const types = tally(places.map(place => place.type));
    const tags  = tally(places.map(place => descriptionTag(place.description)));

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

    return { places, hoods, types, tags, source, builtAt: Date.now() };
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
            // The vocabularies the prompt is built from, so a deploy can be checked for
            // the Type list actually landing without spending a model call.
            types: catalog.types.map(t => `${t.label} (${t.count})`),
            subCategories: catalog.tags.length,
            promptChars: systemPrompt(catalog, '', false).length,
            defaultModel: env.MODEL || DEFAULTS.MODEL,
            allowedModels: ALLOWED_MODELS,
            keyConfigured: {
                gemini: Boolean(env.GEMINI_API_KEY),
                groq:   Boolean(env.GROQ_API_KEY)
            }
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
