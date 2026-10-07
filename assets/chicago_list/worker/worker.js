/* ── Chicago Assistant API — Cloudflare Worker ─────────────────────────────
   A key shipped to a static GitHub Pages widget is public, so the Gemini and Groq keys live
   here as Worker secrets. The Worker builds the whole prompt itself and the page only sends a
   question, a little history and optional coordinates — so this can *only* answer questions
   about the Chicago map, not act as a general LLM relay, which is the main risk of putting a
   paid key behind a public URL. GET / returns a health summary for verifying a deploy.

   Deploy:  bash assets/chicago_list/worker/deploy.sh  (then set WORKER_URL in ../chicagoChat.js)
   Local:   cp .dev.vars.example .dev.vars && npx wrangler dev --config wrangler.toml
            — the --config flag matters, or wrangler picks up the repo-root wrangler.jsonc. */

/* Overridable in wrangler.toml [vars]. MODEL is the fallback when the page asks for nothing,
   or for something not on the allowlist below. */
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

/* The page names the model, so without an allowlist a scripted caller could spend the keys on
   anything. An unlisted id is discarded for DEFAULTS.MODEL, and everything here is flash-tier,
   Gemma, or a small Groq model — no pro models, which keeps a public URL on a paid key
   affordable. Keep in sync with <select id="chat-model"> in ../../../chicagoMap.html. */
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
    /* Gemma 4 — open weights, but served by the Gemini endpoint (see providerFor) and verified
       to accept systemInstruction and functionDeclarations, so the tool loop works unchanged. */
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
const MAX_HISTORY_TURNS  = 4;             // last N messages kept for follow-ups
const MAX_HISTORY_CHARS  = 280;
const MAX_RESULTS         = 12;             // most places to return in a list answer
const MAX_TOOL_LIMIT     = 12;            // hard cap on any tool's limit argument
const MAX_NOTES_CHARS    = 320;           // review text is unbounded in the sheet
const MAX_VOCAB_CHARS    = 1100;          // sub-category list, longest tail dropped

const RATE_LIMIT_MAX      = 12;           // requests per IP per window
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

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
    originalUrl:    ['originalurl', 'original_url'],
    lat:            ['lat', 'latitude'],
    lon:            ['lon', 'lng', 'long', 'longitude']
};

/* Module scope, so a warm isolate reuses the built catalog instead of refetching the sheet
   per question. A cold isolate pays one extra fetch — cheaper than wiring up a KV store. */
let catalogCache = null;
const rateLog = new Map();   // ip -> recent request timestamps

/* ── Providers ─────────────────────────────────────────────────────────────
   Two upstreams, chosen by model id. Both "gemini-*" and "gemma-*" take the Google path: on
   this key Gemma is served by the same endpoint, and matching only "gemini-" would route it to
   Groq, which does not serve it. Duplicated in ../../travel/worker/worker.js rather than shared
   — each worker deploys as one standalone file, and sharing would mean a build step. */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/* Hidden reasoning tokens bill against the same budget as the reply, so a bare 700-token cap
   can be spent entirely on thinking and return nothing. Both providers reason, and this is a
   ceiling rather than a reservation, so a model that does not think is unaffected. */
const REASONING_HEADROOM = 1024;

// Only Groq dials thinking effort; Gemma rejects thinkingConfig, so headroom is the only lever.
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

        // Requiring an allowed Origin keeps casual scripted abuse off the key, but it is not a
        // hard boundary — the rate limit and the fixed prompt shape are what contain it.
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

        /* Only where the visitor is, not what is near them: find_nearby answers that on demand,
           and 50 embedded ranked places outweighed the rest of the 8K prompt put together. */
        const point = coords(body && body.coords);
        const systemText = systemPrompt(catalog, point ? nearestHood(catalog, point) : '', Boolean(point));
        const historyTurns = history(body && body.history);

        // Provider-neutral transcript; converted to each API's shape only when a request is built.
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

/* Canonical tool schema in Gemini's functionDeclarations format; buildBody() maps it to Groq's
   OpenAI shape, so each JSON Schema is written once. Descriptions stay terse because the schema
   is re-sent every round — long-form guidance (stemming, Type synonyms) belongs in the system
   prompt, sent once. Built on first use: the descriptions interpolate THEME_NAMES. */
let toolDeclarationsCache = null;

function toolDeclarations() {
    if (!toolDeclarationsCache) toolDeclarationsCache = buildToolDeclarations();
    return toolDeclarationsCache;
}

function buildToolDeclarations() {
    return [
    {
        name: 'search_places',
        description: 'Find places by keyword, type, or neighborhood. Terms are OR-matched against name, ' +
            'type, sub-category and notes. Returns one line per place plus the total.',
        parameters: {
            type: 'object',
            properties: {
                query:        { type: 'string',  description: 'Comma-separated terms, OR-matched. Use stems ' +
                                                              '("argentin" covers Argentine/Argentinian). A region word ' +
                                                              `(${THEME_NAMES}) is expanded for you — pass it alone.` },
                type:         { type: 'string',  description: 'Type filter; everyday words work ("bookstore" → Books).' },
                neighborhood: { type: 'string',  description: 'Neighborhood filter.' },
                limit:        { type: 'integer', description: `Max results (default 10, max ${MAX_TOOL_LIMIT}).` }
            }
        }
    },
    {
        name: 'get_place_details',
        description: 'Details for one named place. Use for any question about a specific place — rating, ' +
            'address, description, phone, website, notes. Matches partial and misspelled names.',
        parameters: {
            type: 'object',
            required: ['name'],
            properties: {
                name:   { type: 'string', description: 'Place name, as the visitor said it.' },
                fields: {
                    type: 'array',
                    items: { type: 'string', enum: PLACE_FIELDS.map(f => f.key) },
                    description: 'Only the fields asked about, e.g. ["rating"]. Omit for everything.'
                }
            }
        }
    },
    {
        name: 'find_nearby',
        description: 'Saved places closest to the visitor, nearest first.',
        parameters: {
            type: 'object',
            properties: {
                type:         { type: 'string',  description: 'Optional type filter.' },
                radius_miles: { type: 'number',  description: 'Radius in miles (default 1).' },
                limit:        { type: 'integer', description: `Max results (default 10, max ${MAX_TOOL_LIMIT}).` }
            }
        }
    }
    ];
}

// Execute a tool call against the live catalog, returning plain text the model reads directly.
function executeTool(name, args, catalog, point) {
    const cap = n => Math.min(Math.max(1, n || 10), MAX_TOOL_LIMIT);

    if (name === 'search_places') {
        const { terms, themes } = keywords(args.query);
        const type  = String(args.type         || '').toLowerCase().trim();
        const hood  = String(args.neighborhood || '').toLowerCase().trim();
        const limit = cap(args.limit);

        /* An unrecognized type word ("barbecue", "speakeasy") narrows rather than filters, so a
           near-miss trims the result instead of emptying it. */
        const wanted   = type ? resolveTypes(type, catalog.types) : [];
        const typeWord = type && !wanted.length ? type : '';

        const hits = catalog.places.filter(p => {
            if (terms.length && !terms.some(term => haystack(p).includes(term))) return false;
            if (wanted.length && !wanted.includes(p.type)) return false;
            if (typeWord && !haystack(p).includes(typeWord)) return false;
            if (hood && !(p.neighborhood || '').toLowerCase().includes(hood)) return false;
            return true;
        });

        /* Stated ahead of the results so the model reports the search that actually ran —
           otherwise a widened search reads back as a narrow one. */
        const widened = themes.length
            ? `Read ${themes.map(t => `"${t}"`).join(' and ')} as the whole region and searched ` +
              `${terms.length} cuisines and dishes for it. Say so in your reply, and name a few of ` +
              'the cuisines that actually turned up.'
            : '';

        if (!hits.length) {
            // A theme search has already been widened as far as the list goes, so sending the
            // model back to try the countries one at a time only spends turns on the same miss.
            if (themes.length) {
                return `Searched all ${terms.length} cuisines and dishes under ` +
                    `${themes.map(t => `"${t}"`).join(' and ')} and nothing matched. That is the whole ` +
                    'region checked, not a narrow search, so tell the visitor the map has none rather ' +
                    'than retrying country by country.';
            }
            return 'No places found matching those criteria. Try more keywords, shorter stems, or ' +
                'drop the type or neighborhood filter before telling the visitor there are none.';
        }

        // The total matters even when the list is cut: "8 of 41" is the difference between
        // "here are a few" and a wrong "that is all the map has".
        const shown  = hits.slice(0, limit);
        const header = hits.length > shown.length
            ? `${hits.length} places match; showing the first ${shown.length}:`
            : `${hits.length} place${hits.length === 1 ? '' : 's'} match:`;
        // Single newlines: a place is one line now, so blank lines between them were buying
        // nothing but tokens in a window that re-sends this result on every later round.
        return [widened, header, ...shown.map(p => formatPlace(p))].filter(Boolean).join('\n');
    }

    /* Single-place questions. Names are matched loosely (a visitor types "the bean"; the sheet
       says "Cloud Gate"), and `fields` narrows the reply to what was actually asked. */
    if (name === 'get_place_details') {
        const fields  = Array.isArray(args.fields) ? args.fields : [];
        const matches = matchPlacesByName(args.name, catalog.places);

        if (!matches.length) {
            return `No place named "${args.name}" is on the map. Try search_places with part of ` +
                'the name or its type, in case it is saved under a different name.';
        }

        /* Several equally good matches is a question, not an answer — "the museum" hits a dozen.
           Returning the candidates lets the model ask which, not guess confidently wrong. */
        if (matches.length > 1) {
            return [
                `"${args.name}" matches ${matches.length} saved places. Ask the visitor which one they ` +
                'mean, listing these by name, and do not answer for any single one yet:',
                ...matches.slice(0, MAX_TOOL_LIMIT).map(p =>
                    `- ${p.name} (${p.type || 'Place'}, ${p.neighborhood || 'Chicago'})`)
            ].join('\n');
        }

        return formatPlaceDetails(matches[0], fields);
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

        const sorted = catalog.places
            .filter(p => p.lon != null)
            .filter(near)
            .map(p => ({ p, miles: haversineMiles(point.lon, point.lat, p.lon, p.lat) }))
            .sort((a, b) => a.miles - b.miles);
        const ranked = sorted.filter(hit => hit.miles <= radius).slice(0, limit);

        /* An empty radius means two different things: a quiet block in Chicago should widen,
           while a visitor in another state should be told they are too far rather than offered
           a 340-mile drive. Reporting the nearest distance is how the model tells them apart,
           and this result is the only place that signal exists. */
        if (!ranked.length) {
            if (!sorted.length) return `Nothing on the map matches type "${args.type}".`;
            const nearest = sorted[0];
            const away = Math.round(nearest.miles);
            if (nearest.miles > FAR_AWAY_MI) {
                return `Nothing within ${radius} mi. The visitor is about ${away} mi from the nearest ` +
                    `saved place (${nearest.p.name}), so they are too far from Chicago for a "near me" ` +
                    'answer — say so and offer a neighborhood instead.';
            }
            return `No places within ${radius} mi${type ? ` of type "${args.type}"` : ''}. The nearest is ` +
                `${nearest.p.name} at ${nearest.miles.toFixed(1)} mi — retry with a larger radius_miles.`;
        }

        return ranked.map(({ p, miles }) =>
            `${formatPlace(p)} | ${miles.toFixed(2)} mi`
        ).join('\n');
    }

    return `Unknown tool: ${name}`;
}

/* ── Matching the visitor's words to the sheet's words ─────────────────────
   The two rarely agree: Type says "Books" where people say "bookstores", and a cuisine is
   never a Type at all — "Colombian" lives in the description. Either gap reads back as "the
   map has none", so the query is ORed across keywords and the type is matched loosely. */

/* Regional themes the sheet has no single word for. Left to the model, "Caribbean food" goes
   out as the bare word "caribbean" and reports two places where the map holds twenty; expanding
   here makes it identical on every model and turn. Terms are substrings, so stems cover variants
   ("jamaic"), and dishes appear only where they identify one region ("jerk", not "curry"). */
const THEMES = {
    caribbean: {
        aliases: ['west indian', 'antillean', 'antilles'],
        terms: ['caribbean', 'west indian', 'antillean', 'antigua', 'barbud', 'bahamian', 'bahamas',
            'barbad', 'cuban', 'cubano', 'dominica', 'grenad', 'haitian', 'haiti', 'jamaic', 'kitts',
            'nevis', 'saint lucia', 'st lucia', 'vincentian', 'grenadines', 'trinidad', 'tobago',
            'puerto ric', 'boricua', 'virgin island', 'anguill', 'cayman', 'montserrat', 'turks',
            'caicos', 'guadeloup', 'martiniq', 'barth', 'saint martin', 'sint maarten', 'curacao',
            'curaçao', 'jerk', 'mofongo', 'ropa vieja', 'tostones', 'plantain', 'ackee', 'oxtail',
            'griot', 'pastelillo', 'lechon']
    },
    latin: {
        aliases: ['latino', 'latina', 'latinx', 'latin american', 'hispanic', 'south american',
            'central american'],
        terms: ['latin', 'mexican', 'cuban', 'puerto ric', 'peruvian', 'colombian', 'venezuel',
            'argentin', 'chilean', 'bolivi', 'ecuador', 'salvador', 'guatemal', 'honduran',
            'nicaragu', 'costa ric', 'panamanian', 'paraguay', 'uruguay', 'dominican', 'brazil',
            'taco', 'taqueria', 'arepa', 'empanada', 'birria', 'ceviche', 'mole', 'pupusa', 'tamale',
            'pozole', 'churro']
    },
    asian: {
        aliases: ['east asian', 'southeast asian', 'south asian', 'pan asian'],
        terms: ['asian', 'chinese', 'japanese', 'korean', 'thai', 'vietnamese', 'filipino',
            'malaysian', 'indonesian', 'singapore', 'burmese', 'laotian', 'cambodian', 'nepal',
            'tibetan', 'mongolian', 'taiwanese', 'indian', 'pakistani', 'bangladesh', 'sri lankan',
            'sushi', 'ramen', 'dumpling', 'hot pot', 'dim sum', 'bubble tea', 'boba', 'pho',
            'banh mi', 'bibimbap', 'noodle']
    },
    'middle eastern': {
        aliases: ['mideast', 'middle east', 'levantine', 'arab', 'arabic'],
        terms: ['middle eastern', 'lebanese', 'syrian', 'palestin', 'israeli', 'jordanian', 'iraqi',
            'iranian', 'persian', 'turkish', 'egyptian', 'yemeni', 'kurdish', 'armenian', 'afghan',
            'falafel', 'shawarma', 'hummus', 'kebab', 'kabob', 'mezze', 'kofta', 'baklava']
    },
    african: {
        aliases: ['west african', 'east african', 'north african'],
        terms: ['african', 'ethiopian', 'eritrean', 'nigerian', 'ghanaian', 'senegal', 'somali',
            'kenyan', 'tanzanian', 'moroccan', 'tunisian', 'algerian', 'sudanese', 'cameroon',
            'ivorian', 'injera', 'jollof', 'suya', 'tagine', 'berbere', 'doro wat']
    },
    mediterranean: {
        aliases: ['med'],
        terms: ['mediterranean', 'greek', 'italian', 'spanish', 'portuguese', 'turkish', 'lebanese',
            'israeli', 'moroccan', 'cypriot', 'sicilian', 'gyro', 'souvlaki', 'tapas', 'paella',
            'mezze', 'falafel', 'hummus']
    },
    european: {
        aliases: ['eastern european', 'western european', 'scandinavian', 'nordic'],
        terms: ['european', 'french', 'italian', 'spanish', 'german', 'polish', 'irish', 'british',
            'english', 'scottish', 'greek', 'portuguese', 'swedish', 'danish', 'norwegian',
            'finnish', 'dutch', 'belgian', 'swiss', 'austrian', 'hungarian', 'czech', 'slovak',
            'russian', 'ukrainian', 'romanian', 'serbian', 'croatian', 'lithuanian', 'scandinavian',
            'nordic', 'pierogi', 'schnitzel', 'crepe', 'brasserie', 'trattoria', 'osteria']
    }
};

/* Every word that can reach a theme, aliases included, in one flat lookup. */
const THEME_LOOKUP = Object.entries(THEMES).reduce((map, [name, theme]) => {
    map[name] = name;
    (theme.aliases || []).forEach(alias => { map[alias] = name; });
    return map;
}, Object.create(null));

// The region list as the prompt states it, derived from THEMES so one edit reaches the model.
const THEME_NAMES = Object.keys(THEMES).join(', ');

/* Words a visitor hangs off a theme that carry no search meaning. Dropping them lets
   "caribbean restaurants" and "asian eats" reach a theme; resolveTypes handles the Type. */
const THEME_NOISE = new Set(['food', 'foods', 'cuisine', 'cuisines', 'restaurant', 'restaurants',
    'place', 'places', 'spot', 'spots', 'eat', 'eats', 'dining', 'dish', 'dishes', 'bar', 'bars',
    'cafe', 'cafes', 'joint', 'joints', 'style']);

function themeName(term) {
    const words = term.split(/[^a-z\u00c0-\u024f]+/).filter(word => word && !THEME_NOISE.has(word));
    return THEME_LOOKUP[words.join(' ')] || null;
}

/* query is comma-separated and OR-matched, turning "latino restaurants" — a dozen cuisines with
   no single word for them — into one search instead of a dozen calls. Terms naming a THEMES
   region are replaced by its cuisines, and the expansion is returned alongside: a widened search
   the model cannot see gets described wrongly. */
function keywords(query) {
    const terms = [];
    const themes = [];

    String(query || '')
        .split(',')
        .map(term => term.trim().toLowerCase())
        .filter(Boolean)
        .forEach(term => {
            const name = themeName(term);
            if (name) {
                if (!themes.includes(name)) themes.push(name);
                terms.push(...THEMES[name].terms);
            } else {
                terms.push(term);
            }
        });

    return { terms: [...new Set(terms)], themes };
}

/* Keywords match the whole card, type and sub-category included, because that is where a cuisine
   actually is. Neighborhood is excluded — it has its own filter, and including it would make a
   search for "park" return everything in Lincoln Park. */
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

// Plural stripping: "bookstores" → "bookstore", "beaches" → "beach". Not a real stemmer.
function singular(word) {
    if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
    if (/(ch|sh|s|x|z)es$/.test(word)) return word.slice(0, -2);
    if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
}

/* Match a spoken place name to catalog rows — visitors drop articles, use nicknames, or name a
   category ("the Puerto Rican museum"). Tiers (exact, prefix, substring, all-words) are tried in
   order and only the best returns, so "Kasama" is not drowned out by places whose notes merely
   mention it. Several hits mean the question was ambiguous, and the caller asks which. */
function matchPlacesByName(asked, places) {
    const q = String(asked || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!q) return [];

    const norm  = p => p.name.toLowerCase().replace(/\s+/g, ' ').trim();
    const bare  = text => text.replace(/^(the|a|an)\s+/, '');
    const qBare = bare(q);

    const tiers = [
        places.filter(p => norm(p) === q || bare(norm(p)) === qBare),
        places.filter(p => bare(norm(p)).startsWith(qBare)),
        places.filter(p => norm(p).includes(q)),
        // Last resort: every word the visitor said appears in the name, in any order.
        (() => {
            const words = qBare.split(' ').filter(w => w.length > 2);
            if (!words.length) return [];
            return places.filter(p => words.every(w => norm(p).includes(w)));
        })()
    ];

    return tiers.find(tier => tier.length) || [];
}

/* Which Type values the visitor's word refers to, resolved against the whole vocabulary so a
   direct hit outranks an alias: "coffee shops" is Cafe, not every Retail place answering to
   "shop". Matching is word by word, never a bare substring — "barbecue" contains "bar", and
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

    /* In "coffee shop" or "book store" the modifier is the specific half, so keeping only the
       earliest match returns Cafe and Books, not every Retail place answering to "shop". */
    const earliest = Math.min(...viaAlias.map(hit => hit.at));
    return viaAlias.filter(hit => hit.at === earliest).map(hit => hit.label);
}

/* Every field a visitor can ask about: the label the model reads, and how to render it from a
   catalog row. The schema, both formatters and get_place_details all walk this table, so a new
   sheet column is one entry. `list` marks fields cheap enough to repeat on every row. */
const PLACE_FIELDS = [
    { key: 'type',         list: true,  label: 'type',         read: p => p.type || 'Place' },
    { key: 'neighborhood', list: true,  label: 'neighborhood', read: p => p.neighborhood || 'Chicago' },
    { key: 'address',      list: true,  label: 'address',      read: p => p.address },
    /* Review count is blank for most rows, and blank is a string rather than null here, so a
       `!= null` guard rendered "4.6★ ( reviews)". Both halves are checked for content. */
    { key: 'rating',       list: true,  label: 'rating',       read: p => {
        const avg = String(p.ratingsAverage ?? '').trim();
        if (!avg) return '';
        const total = String(p.ratingsTotal ?? '').trim();
        return `${avg}★${total ? ` (${total} reviews)` : ''}`;
    } },
    { key: 'category',     list: true,  label: 'category',     read: p => descriptionTag(p.description) },
    { key: 'description',  list: false, label: 'description',  read: p => p.description },
    { key: 'notes',        list: false, label: 'notes',        read: p => clip(p.notes, MAX_NOTES_CHARS) },
    { key: 'phone',        list: false, label: 'phone',        read: p => p.phone },
    { key: 'website',      list: false, label: 'website',      read: p => p.website }
];

const PLACE_FIELD_KEYS = PLACE_FIELDS.map(f => f.key).join(', ');

function clip(text, max) {
    const value = String(text || '').trim();
    return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/* One place as a single line. Printing every field made a 20-place answer 5.8K characters —
   bigger than the system prompt, in an 8K window, re-sent every round. Lists carry only the
   `list` fields; the rest is a get_place_details away. */
function formatPlace(p) {
    const parts = PLACE_FIELDS
        .filter(field => field.list && field.key !== 'type' && field.key !== 'neighborhood')
        .map(field => field.read(p))
        .filter(Boolean);
    return `${p.name} (${p.type || 'Place'}, ${p.neighborhood || 'Chicago'})` +
        (parts.length ? ` | ${parts.join(' | ')}` : '');
}

/* One place, in full or field by field. `fields` keeps "what's the rating for Kasama" to one line
   instead of a card the model over-volunteers from. An unknown field name falls back to the full
   card rather than erroring. */
function formatPlaceDetails(p, fields = []) {
    const asked = fields
        .map(name => String(name || '').toLowerCase().trim())
        .filter(Boolean);
    const wanted = asked.length
        ? PLACE_FIELDS.filter(field => asked.includes(field.key))
        : PLACE_FIELDS;
    const chosen = wanted.length ? wanted : PLACE_FIELDS;

    const lines = [`${p.name} (${p.type || 'Place'}) — ${p.neighborhood || 'Chicago'}`];
    chosen.forEach(field => {
        if (field.key === 'type' || field.key === 'neighborhood') return;
        const value = field.read(p);
        // "not listed" is said out loud rather than omitted: a missing field is an answer
        // to "what's the phone number", and silence invites the model to invent one.
        lines.push(`${field.label}: ${value || 'not listed'}`);
    });
    return lines.join('\n');
}

/* ── Provider adapters ─────────────────────────────────────────────────────
   The transcript and TOOL_DECLARATIONS are canonical; these translate them into whichever
   shape the provider speaks. Transcript turns are:
     {role:'user', text} / {role:'assistant', text, toolCalls:[{id,name,args,signature?}]}
     {role:'tool', results:[{id, name, result}]}
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
            tools: [{ functionDeclarations: toolDeclarations() }],
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
        tools: toolDeclarations().map(d => ({
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
            /* Thought parts dropped: on a tool round this text becomes the assistant turn,
               so keeping them feeds a model its own reasoning back as something it said. */
            text: parts.filter(p => !p.thought && typeof p.text === 'string')
                .map(p => p.text).join(''),
            toolCalls: parts.filter(p => p.functionCall).map((p, i) => ({
                // Gemini 3 sends an id; older models do not, so fall back to a stable one.
                id:   p.functionCall.id || `call_${i}`,
                name: p.functionCall.name,
                args: p.functionCall.args || {},
                /* Opaque to us, but Gemini 3 rejects the turn unless the signature it issued
                   with a functionCall comes back alongside it. Carried through untouched. */
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

/* Groq's free tier caps tokens per minute, so one multi-round question can 429 mid-loop and be
   fine seconds later. Wait once and retry, using the provider's own figure — Groq asks for ~12s,
   so a shorter fixed wait spends the retry too early. RETRY_BUDGET_MS is shared across rounds so
   repeated 429s cannot sleep past the 90s at which chicagoChat.js gives up. */
const RETRY_ATTEMPTS    = 2;       // the first try, plus one retry
const RETRY_WAIT_MS     = 5000;    // only for a 429 that carries no Retry-After
const RETRY_WAIT_MAX_MS = 20000;
const RETRY_BUDGET_MS   = 45000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* Retry-After is either seconds or an HTTP date; both land inside our own bounds. */
function retryDelay(res) {
    const header  = (res.headers.get('Retry-After') || '').trim();
    const seconds = Number(header);
    const ms = header && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(header) - Date.now();

    if (!Number.isFinite(ms) || ms <= 0) return RETRY_WAIT_MS;
    return Math.min(Math.max(ms, 1000), RETRY_WAIT_MAX_MS);
}

/* `announce` is what makes the wait worth having: a twelve-second pause nobody explained is
   indistinguishable from a hung widget, so the visitor is told before the sleep, not after. */
async function fetchRetrying429(url, init, retryUntil, announce) {
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(url, init);
        if (res.status !== 429 || attempt >= RETRY_ATTEMPTS) return res;

        const wait = retryDelay(res);
        if (Date.now() + wait > retryUntil) return res;

        // Nothing will read this one; let the connection go rather than leaving it dangling.
        try { await res.body?.cancel(); } catch (err) { /* already discarded */ }

        await announce(Math.round(wait / 1000));
        await sleep(wait);
    }
}

/* Agentic loop: call the model, run any tool calls, repeat until it writes plain text — which
   IS the answer, streamed from the buffer. Nothing streams from upstream, since a tool call has
   to be parsed out of a whole JSON body anyway. Do not re-request the turn with `stream: true`
   for real SSE: that is a fresh sample, so a model that answered once may call a tool instead
   and stream nothing (`tool_choice:'none'` only moved the failure). */
const MAX_TOOL_ROUNDS = 5;   // guard against a runaway loop

async function askModel(env, options) {
    const live = liveChannel(options.cors);

    /* Whichever finishes first wins: the loop completes and the answer goes out whole, or it hits
       a 429, says it is waiting, and commits to streaming. Only the second path forfeits the HTTP
       status on a later failure, so the common path keeps `!res.ok` intact. */
    const settled = runToolLoop(env, options, live).then(outcome => live.settle(outcome));
    return await Promise.race([live.response, settled]);
}

/* An SSE channel that stays shut unless something needs saying before the answer is ready.
   Shut is the normal case and the better one — a whole response can still carry a status code,
   so nothing is spent on the chance of a wait. */
function liveChannel(cors) {
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const frame  = obj => writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

    let open = false;
    let handOver;
    const response = new Promise(resolve => { handOver = resolve; });

    return {
        response,

        /* Say why the answer is late. The first call hands the page its response, so the note
           arrives during the wait rather than after it. */
        async notice(text) {
            if (!open) {
                open = true;
                handOver(sseResponse(readable, cors));
            }
            await frame({ notice: text });
        },

        /* Whole response if nothing has gone out yet, otherwise frames on the open stream. */
        async settle(outcome) {
            if (!open) {
                return outcome.answer
                    ? streamAnswer(outcome.answer, cors)
                    : fail(outcome.status, outcome.message, cors, outcome.retryAfter);
            }

            if (outcome.answer) {
                for (const chunk of chunkText(outcome.answer, STREAM_CHUNK_CHARS)) {
                    await frame({ delta: chunk });
                }
            } else {
                await frame({ error: outcome.message });
            }
            await writer.write(encoder.encode('data: [DONE]\n\n'));
            await writer.close();
            return response;          // already resolved; the race is long over
        }
    };
}

/* Returns what happened (`{ answer }`, or a status and a sentence) rather than a Response: by
   the time it finishes the caller may be mid-stream, and only the caller knows which shape is
   still available to it. */
async function runToolLoop(env, { model, provider, catalog, point, systemText, turns }, live) {
    const apiKey = apiKeyFor(provider, env);

    /* Shared by every round, so a question cannot spend the whole retry allowance twice. */
    const retryUntil = Date.now() + RETRY_BUDGET_MS;

    const announce = seconds => live.notice(
        `Hit the model's rate limit — waiting ${seconds}s and trying once more…`);

    const call = msgs => {
        const [url, init] = upstreamRequest(provider, { model, apiKey, systemText, turns: msgs });
        return fetchRetrying429(url, init, retryUntil, announce);
    };

    let msgs   = turns;
    let answer = '';

    /* One extra pass beyond MAX_TOOL_ROUNDS: the last reads the reply but runs no tools, so a
       full budget of searching still gets a turn to write the answer. */
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        let upstream;
        try {
            upstream = await call(msgs);
        } catch (err) {
            return { status: 502, message: 'I could not reach the model just now — try again shortly.' };
        }
        if (!upstream.ok) {
            return {
                status:     upstream.status || 502,
                message:    await upstreamMessage(upstream),
                retryAfter: upstream.headers.get('Retry-After')
            };
        }

        let data;
        try { data = await upstream.json(); } catch (err) {
            return { status: 502, message: 'Unexpected response from the model.' };
        }

        const { text, toolCalls } = parseTurn(provider, data);

        /* No tool calls — the model is answering, so this text IS the answer. finishReason is
           not consulted: Gemini reports "STOP" on the tool-call turn itself, so testing it meant
           tools never ran there. Tool-call presence is the reliable signal on both providers. */
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

    /* Only reachable if the model spent every round on tools and still wrote nothing. An empty
       200 reads as a broken widget, so say something a visitor can act on. */
    if (!answer.trim()) {
        return { status: 502, message: 'The model kept searching without answering — try a simpler question.' };
    }

    return { answer };
}

/* The reply is already complete, so this is the SSE envelope the page expects — same `{"delta"}`
   frames and `[DONE]` — rather than a relay of an upstream stream. Chunked on whitespace so a
   long answer paints in reading order, with no artificial delay to pace it out. */
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

    return sseResponse(stream, cors);
}

function sseResponse(body, cors) {
    return new Response(body, {
        headers: {
            ...cors,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        }
    });
}

// Whitespace rides along with the chunks, so rejoining reproduces the markdown exactly.
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

/* A provider error as something worth showing a visitor — both APIs nest it at error.message. */
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

/* With tools available the prompt carries no place data — only the sheet's vocabulary, counted
   in buildCatalog. Without it the model searches the visitor's words ("bookstores") instead of
   the sheet's ("Books") and reports an empty map where it holds dozens. Verbose where the tool
   schema is terse: this is sent once, the schema every round. */
function systemPrompt(catalog, visitorHood, hasPoint) {
    const lines = [
        `Chicago Assistant: guide to a personal map of ${catalog.places.length} saved Chicago places ` +
            `in ${catalog.hoods.length} neighborhoods.`,
        '',
        `TYPES (closed set): ${vocabLine(catalog.types)}`,
        `SUB-CATEGORIES (searchable): ${vocabLine(catalog.tags, MAX_VOCAB_CHARS)}`,
        '',
        'SEARCHING',
        '- Translate the ask into the words above; visitors do not use them. Books=bookstores, Cafe=coffee,',
        '  Brunch=breakfast, Retail/Market=shops, Bar/Club=nightlife, Snack=dessert, Landmark=sights.',
        `- Region words are auto-expanded to every country, cuisine and dish: ${THEME_NAMES}.`,
        '  Pass one alone as query; never list the countries yourself or narrow to one.',
        '- Other themes: expand yourself into ONE comma-separated query of stems ("argentin", "taco").',
        '- Query alone first. A cuisine spans Types (Cuban places are Bars and Cafes too); add type only',
        '  to narrow a long result, drop it if thin. A pure Type ask needs type only, no query.',
        '- Drop hits whose Type contradicts the ask: "puerto ric" matches a museum, which is not food.',
        '  Food = Restaurant, Bar, Brunch, Cafe, Snack, Market, Club only. Count survivors and report',
        '  that number, not the search total, and do not pad the wording to cover what you dropped.',
        '- Before saying the map has none: add keywords, shorten to stems, or drop type/neighborhood and',
        '  retry. Exception: a region above was already exhaustive, so empty means none.',
        '',
        'ANSWERING',
        '- Always call a tool first. Every fact comes from a tool result; never guess or invent one.',
        `- One place, one detail ("rating for X", "address of the museum", "what's the description"):`,
        `  get_place_details with name plus fields, e.g. fields:["rating"]. Fields: ${PLACE_FIELD_KEYS}.`,
        '  Answer just what was asked, quoted exactly. "not listed" means say it is not listed.',
        '  Omit fields for a full rundown. If it returns several matches, ask which one they meant.',
        '- A follow-up without a name ("what about its hours", "the rating?") means the place last named',
        '  in the conversation. Reuse that name; do not search again.',
        '- Hours are not in the map: say so and point to the website field.',
        '- "Near me": find_nearby. No location means ask them to allow it or name a neighborhood.',
        `- Lists: search_places, "- " bullets, at most ${MAX_RESULTS}, note the total when more match.`,
        '  Give Type and neighborhood for each; add the address when they are heading there.',
        '- Broad ask: open with one line on how you read it, naming only cuisines actually in the results.',
        '- Plain text, no markdown or tables. No preamble or pleasantries.'
    ];

    /* Where they are, not what is near them: find_nearby already returns distances, so one
       line of neighborhood is the only part a tool cannot supply. */
    if (!hasPoint) lines.push('- No visitor location shared; find_nearby is unavailable until they allow it.');
    else if (visitorHood) lines.push(`- The visitor is in or near ${visitorHood}.`);

    return lines.join('\n');
}

/* Which neighborhood the visitor is in, from the average coordinates of the places filed under
   each one — the sheet's rows define the areas, so no centroid table can drift out of date. */
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

/* The sheet has no Lat/Lon columns, so coordinates come from the committed geocode_cache.json
   keyed by street address — same order chicagoData.js uses (sheet columns first, cache
   second). A missing cache only costs "near me" distances, so it is swallowed rather than
   thrown: it must not knock the catalog back to the snapshot. */
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

/* The sub-category at the head of a description: "Colombian restaurant: Small, casual spot…" ->
   "Colombian restaurant". Some rows are a bare sentence, so anything too long to be a label is
   dropped rather than sent to the prompt as noise. */
const MAX_TAG_CHARS = 40;
const MAX_TAG_WORDS = 5;

function descriptionTag(description) {
    const head = String(description || '').split(':')[0].trim();
    if (!head || head.length > MAX_TAG_CHARS) return '';
    return head.split(/\s+/).length <= MAX_TAG_WORDS ? head : '';
}

/* A vocabulary as one prompt line, capped in characters. A count is printed only where it
   informs (> 1): on 300-odd mostly-unique sub-categories, " (1)" repeated 250 times cost
   2.8K characters of an 8K window. The cut tail is announced rather than hidden — an unseen
   label is still findable by keyword, but a model told the list is complete stops looking. */
function vocabLine(entries, maxChars = 0) {
    const part = entry => (entry.count > 1 ? `${entry.label} (${entry.count})` : entry.label);
    if (!maxChars) return entries.map(part).join(', ');

    const kept = [];
    let used = 0;
    for (const entry of entries) {
        const text = part(entry);
        if (used + text.length + 2 > maxChars) break;
        kept.push(text);
        used += text.length + 2;
    }
    const dropped = entries.length - kept.length;
    return kept.join(', ') + (dropped > 0 ? `, +${dropped} rarer ones not listed` : '');
}

/* Build the catalog the tools search, deduplicated by name + address (La Scarola is in the
   sheet twice). Neighborhoods are grouped so find_nearby can name the visitor's own area. */
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

    /* Two vocabularies for the system prompt, neither guessable from outside the sheet: Type
       is a small closed set its author chose ("Books", not "Bookstore"), and the description's
       Google-Maps-style sub-category ("Colombian restaurant") is the only place a cuisine is
       recorded. Counted rather than hardcoded, so a new Type reaches the prompt on refresh. */
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
            /* Coerced with number(), not typeof-checked: the snapshot stores these as strings
               ("4.6", "" where unrated), so a typeof check dropped every place's rating and
               "what's the rating for X" always answered "not listed". */
            ratingsAverage: number(props.ratingsAverage),
            ratingsTotal:   number(props.ratingsTotal),
            lon:            number(coords[0]),
            lat:            number(coords[1])
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

/* A real CSV scan, not a line split: some Reviews cells contain newlines and escaped quotes,
   so splitting on "\n" would shear rows apart. Same parser as chicagoData.js. */
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

// Only user/assistant turns, trimmed and capped, so history cannot smuggle in a system prompt
// or grow the request without bound.
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

// Fixed-window count per IP, held in the isolate. Not exact across isolates, but enough to keep
// one script from burning the day's free allowance.
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
            // The vocabularies the prompt is built from, so a deploy can be checked for the
            // Type list landing without spending a model call.
            types: catalog.types.map(t => `${t.label} (${t.count})`),
            subCategories: catalog.tags.length,
            // Each region's expansion size, so the region lists can be confirmed live without
            // asking the model about Caribbean food.
            themes: Object.fromEntries(Object.keys(THEMES).map(name =>
                [name, keywords(name).terms.length])),
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
