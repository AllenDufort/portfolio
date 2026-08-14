/* ── Chicago Assistant — free AI via Pollinations, local NLP fallback ────
   Pollinations' text API needs no API key and sends `Access-Control-Allow-Origin: *`,
   so it can be called straight from a static page. The anonymous tier allows roughly
   one request every 15s per visitor IP, so requests are paced, the prompt is kept small
   by sending only the places relevant to the question, and anything that fails or would
   stall falls back to the local answers below — the widget always replies.

   The fallback is a small classical NLP stack, so an offline answer is a real answer
   rather than a keyword dump: a light Porter stemmer, BM25 ranking over the place
   index, trigram fuzzy matching for typos, a naive-Bayes intent classifier, and
   haversine distance for "what's near X". No dependencies and no network — everything
   is built from the GeoJSON at load. */
(function () {
    'use strict';

    const API_URL   = 'https://text.pollinations.ai/openai';
    const API_MODEL = 'openai-fast';   // the only model on the anonymous tier — see /models
    const REFERRER  = 'allendufort.github.io';
    const MIN_GAP_MS   = 15000;        // anonymous tier: ~1 request / 15s per IP
    const MAX_WAIT_MS  = 6000;         // longest we'll sit on the rate limit before answering locally
    const TIMEOUT_MS   = 12000;        // hard cap on one request, so the chat never feels stuck
    const COOLDOWN_MS  = 60000;        // skip the API this long after a 402/429
    const ERR_COOLDOWN_MS = 15000;     // shorter cooldown for timeouts and network errors
    const CONTEXT_PLACES = 10;         // places sent per question — see the note on cost below
    const NOTE_CHARS = 70;             // notes are truncated; they are the longest field

    /* Retrieval tuning. k1 and b are BM25's usual defaults; the field weights keep a
       name hit ahead of a note hit, which is what the old hand-tuned scorer did by
       hand. Synonyms score low enough that a literal match always wins. */
    const BM25_K1 = 1.5;
    const BM25_B  = 0.75;
    const FIELD_WEIGHTS  = { name: 3, notes: 2, address: 1, layer: 1 };
    const SYNONYM_WEIGHT = 0.45;
    const MAX_SYNONYM_DF = 0.08;       // expansions in more than 8% of entries are too vague
    const FUZZY_NAME_MIN = 0.42;       // trigram Dice floor for "abba" -> "Aba"
    const FUZZY_TERM_MIN = 0.58;       // higher floor for spelling suggestions
    const INTENT_MARGIN  = 0.35;       // per-token log-odds gap before we trust the classifier
    const NEAR_RADII_MI  = [0.5, 1, 2];
    const MAX_RESULTS    = 10;

    const toggle   = document.getElementById('chat-toggle');
    const panel    = document.getElementById('chat-panel');
    const closeBtn = document.getElementById('chat-close');
    const msgs     = document.getElementById('chat-messages');
    const sugBox   = document.getElementById('chat-suggestions');
    const input    = document.getElementById('chat-input');
    const sendBtn  = document.getElementById('chat-send');

    // Local state for the chatbot's knowledge base and busy status.
    let places = [];
    let layerCounts = {};
    let dataReady = false;
    let busy = false;
    let lastFinishedAt = 0;   // when the last API request settled, for rate-limit pacing
    let cooldownUntil = 0;    // skip the API entirely until this time

    // Derived at load from the place index: BM25 statistics, corpus vocabulary,
    // corpus-filtered synonyms, and the trained intent classifier.
    let corpus = null;
    let vocab = new Set();
    let displayTerms = new Map();   // stem -> one real spelling, for "did you mean"
    let synonyms = new Map();
    let intentModel = null;

    // Load the map data once so the assistant can answer from the Chicago places list.
    fetch('assets/chicago_list/chicago_layers.geojson')
        .then(r => r.json())
        .then(data => {
            places = buildPlaceIndex(data);
            layerCounts = places.reduce((counts, place) => {
                place.layers.forEach(layer => { counts[layer] = (counts[layer] || 0) + 1; });
                return counts;
            }, {});
            buildCorpus();
            trainIntentModel();
            dataReady = true;
        })
        .catch(() => { dataReady = true; });

    // Open and close the chat panel.
    toggle.addEventListener('click', () => {
        const isHidden = panel.hidden;
        panel.hidden = !isHidden;
        if (isHidden) {
            input.focus();
            if (msgs.children.length === 0) {
                addBot("Hi! I’m your Chicago assistant 🏙️ Ask me about food spots, activities, a cuisine, or any specific place on this map.");
                renderChips([
                    'How many places are there?',
                    'Show me food spots',
                    'Show me activities',
                    'Find pizza places',
                    'What\'s near Clark St?',
                ]);
            }
        }
    });
    closeBtn.addEventListener('click', () => { panel.hidden = true; });

    sendBtn.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) submit(); });

    // Send a user message and route it to the assistant.
    async function submit() {
        if (busy) return;
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        sugBox.innerHTML = '';
        addUser(text);
        await ask(text);
    }

    // Ask the free AI API, falling back to local answers if it is unavailable.
    async function ask(userText) {
        if (!dataReady) {
            addBot('⏳ Still loading map data — please try again in a moment.');
            return;
        }

        busy = true;
        sendBtn.disabled = true;
        input.disabled = true;

        const botDiv = document.createElement('div');
        botDiv.className = 'chat-msg bot';
        botDiv.innerHTML = '<span class="chat-cursor">▋</span>';
        msgs.appendChild(botDiv);
        msgs.scrollTop = msgs.scrollHeight;

        // The free tier can make us queue, so explain the wait instead of showing a bare cursor.
        const hints = [
            setTimeout(() => setPending(botDiv, 'Thinking…'), 2000),
            setTimeout(() => setPending(botDiv, 'Still waiting on the free AI tier…'), 7000)
        ];

        const local = generateReply(userText);
        let text = '';
        let offline = false;

        try {
            text = await remoteReply(userText);
        } catch (err) {
            text = local;
            offline = true;
        }
        if (!text) { text = local; offline = true; }

        hints.forEach(clearTimeout);

        await typeOut(botDiv, text);
        if (offline) {
            botDiv.innerHTML = renderMarkdown(text) +
                '<div class="chat-note"><em>Answered straight from the map — the free AI tier was busy.</em></div>';
        }
        msgs.scrollTop = msgs.scrollHeight;

        busy = false;
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
    }

    /* ── Free AI API (Pollinations, no key required) ─────────────────────── */

    /* Three anonymous-tier limits shape this: ~1 request per 15s per IP, overlapping
       requests are refused ("queue full"), and each IP has a small spend budget that
       returns 402 once exhausted. So: never send inside the window, only one request in
       flight (the input is disabled while busy), and give up fast — a local answer beats
       a long stall, and a 402 puts the API to sleep rather than hammering it. */
    async function remoteReply(userText) {
        const now = Date.now();
        if (now < cooldownUntil) throw new Error('cooling down');

        // Sit on the rate-limit window only if the wait is short; otherwise answer locally.
        const gap = lastFinishedAt ? Math.max(0, MIN_GAP_MS - (now - lastFinishedAt)) : 0;
        if (gap > MAX_WAIT_MS) throw new Error('rate limited');
        if (gap) await delay(gap);

        const body = {
            model: API_MODEL,
            referrer: REFERRER,
            messages: [
                { role: 'system', content: buildSystemPrompt(userText) },
                { role: 'user', content: userText }
            ]
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            // 402 and 429 both mean "anonymous quota busy" — back off for a while.
            if (res.status === 402 || res.status === 429) {
                cooldownUntil = Date.now() + COOLDOWN_MS;
                throw new Error(`HTTP ${res.status}`);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const reply = extractContent(await res.json());
            if (!reply) throw new Error('empty reply');
            return reply;
        } catch (err) {
            if (!cooldownUntil || cooldownUntil < Date.now()) {
                cooldownUntil = Date.now() + ERR_COOLDOWN_MS;
            }
            throw err;
        } finally {
            clearTimeout(timer);
            lastFinishedAt = Date.now();
        }
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Pull the assistant text out of the OpenAI-shaped response, ignoring
    // the reasoning field this model also returns.
    function extractContent(data) {
        const message = data && data.choices && data.choices[0] && data.choices[0].message;
        let content = message && message.content;
        if (Array.isArray(content)) {
            content = content.map(part => (typeof part === 'string' ? part : part && part.text) || '').join('');
        }
        if (typeof content !== 'string') return '';
        return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    }

    /* Send only the places relevant to this question. This is not just a latency win:
       the anonymous tier bills a small per-request budget that scales with prompt size
       ("this request costs ~0.0003 pollen"), so a lean prompt buys a visitor more
       questions before they get 402'd. */
    function buildSystemPrompt(userText) {
        const relevant = contextPlaces(userText);
        const lines = relevant.map(place => {
            // "Chicago Todo List" holds every place, so naming it on each line is noise.
            const tags = place.layers.filter(layer => !/todo/i.test(layer));
            const bits = [`- ${place.name}${tags.length ? ` [${tags.join(', ')}]` : ''}`];
            if (place.address) bits.push(place.address);
            if (place.notes) bits.push(place.notes.slice(0, NOTE_CHARS));
            return bits.join(' | ');
        });
        const counts = Object.keys(layerCounts)
            .map(layer => `${layer}: ${layerCounts[layer]}`)
            .join(', ');

        return [
            'You are Chicago Assistant, a helper for a personal Chicago TODO map of saved places.',
            `The map has ${places.length} places total (${counts}).`,
            'Answer ONLY using the places listed below. Never invent a place, address, or detail.',
            'If the list does not cover the question, say so and suggest a different search.',
            'Keep replies under 90 words, friendly, and plain text with "- " bullets.',
            '',
            lines.length ? `Relevant places:\n${lines.join('\n')}` : 'No places matched this question.'
        ].join('\n');
    }

    // Places to show the model: the relevant ones, or a sample when nothing matches.
    function contextPlaces(userText) {
        const ranked = rankPlaces(userText);
        return (ranked.length ? ranked : places).slice(0, CONTEXT_PLACES);
    }

    // Retrieval shared by the remote prompt and the local answers, best match first.
    function rankPlaces(userText) {
        return search(indexTokens(userText)).map(hit => hit.place);
    }

    /* ── Tokenizing and stemming ─────────────────────────────────────────── */

    /* Function and framing words only. The old list also carried domain words like
       "eat" and "town", because prefix matching made them collide with "Eately" and
       "Chinatown". BM25 scores whole stemmed tokens and weighs them by rarity, so
       words that appear in hundreds of entries ("chicago", "bar", "street") sink on
       their own and no longer need blacklisting. */
    const STOP_WORDS = new Set([
        'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'at', 'by', 'to', 'in', 'on',
        'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'doe', 'did',
        'have', 'ha', 'had', 'can', 'could', 'will', 'would', 'shall', 'should', 'may',
        'might', 'must', 'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'it', 'its',
        'they', 'them', 'their', 'there', 'here', 'this', 'that', 'these', 'those',
        'what', 'which', 'who', 'where', 'when', 'why', 'how', 'any', 'some', 'all',
        'more', 'most', 'other', 'than', 'then', 'too', 'very', 'just', 'onli', 'also',
        'about', 'with', 'from', 'into', 'for', 'not', 'no', 'yes', 'ani',
        'show', 'find', 'tell', 'give', 'list', 'get', 'got', 'go', 'want', 'need',
        'like', 'know', 'see', 'look', 'pleas', 'recommend', 'suggest', 'good', 'best',
        'great', 'top', 'nice', 'cool', 'awesom', 'favorit', 'place', 'spot', 'thing',
        'chicago', 'map', 'let', 'grab', 'try', 'tri', 'visit', 'check', 'take',
        'somewhere', 'anywhere', 'someth', 'something', 'anything', 'someon',
        'near', 'nearbi', 'around', 'area', 'close', 'walk', 'today', 'tonight'
    ]);

    function normalize(text) {
        return String(text || '').toLowerCase().replace(/[’']/g, '');
    }

    function words(text) {
        return normalize(text).match(/[a-z0-9]+/g) || [];
    }

    // Document and query tokens for retrieval: content words, stemmed.
    function indexTokens(text) {
        return words(text)
            .map(stem)
            .filter(token => token.length > 1 && !STOP_WORDS.has(token));
    }

    /* Classifier tokens keep the function words on purpose: "how many", "near", and
       "tell me about" are exactly the signal an intent model learns from, so running
       the retrieval tokenizer here would throw away the features that matter. */
    function intentTokens(text) {
        return words(text).map(stem);
    }

    /* Light Porter stemmer — steps 1a to 1c, the plural and past/participle endings.
       Porter's later steps ("relational" -> "relat") are aggressive enough to blur
       distinct place names, while the endings that actually matter in this corpus are
       plurals and gerunds: pizzas/pizza, activities/activity, dining/dine. */
    function stem(word) {
        if (word.length < 4) return word;
        let s = word;

        // Step 1a — plurals.
        if (/sses$/.test(s)) s = s.slice(0, -2);
        else if (/ies$/.test(s)) s = s.slice(0, -2);
        else if (/ss$/.test(s)) { /* keep: "glass" is not a plural */ }
        else if (/s$/.test(s)) s = s.slice(0, -1);

        // Step 1b — past tense and gerunds.
        if (/eed$/.test(s)) {
            if (measure(s.slice(0, -3)) > 0) s = s.slice(0, -1);      // agreed -> agree, feed -> feed
        } else if (/(ed|ing)$/.test(s)) {
            const stripped = s.replace(/(ed|ing)$/, '');
            if (containsVowel(stripped)) {
                s = stripped;
                if (/(at|bl|iz)$/.test(s)) s += 'e';                  // conflated -> conflate
                else if (endsDoubleConsonant(s) && !/[lsz]$/.test(s)) s = s.slice(0, -1);
                else if (measure(s) === 1 && endsCVC(s)) s += 'e';    // dining -> dine
            }
        }

        // Step 1c — trailing y to i, so "activity" and "activities" agree.
        if (/y$/.test(s) && containsVowel(s.slice(0, -1))) s = s.slice(0, -1) + 'i';

        return s;
    }

    // Porter treats y as a vowel only when the letter before it is a consonant.
    function isVowel(word, i) {
        const ch = word[i];
        if ('aeiou'.indexOf(ch) !== -1) return true;
        return ch === 'y' && i > 0 && 'aeiou'.indexOf(word[i - 1]) === -1;
    }

    function containsVowel(word) {
        for (let i = 0; i < word.length; i++) if (isVowel(word, i)) return true;
        return false;
    }

    // Porter's m: how many vowel-group -> consonant-group transitions a stem has.
    function measure(word) {
        let shape = '';
        for (let i = 0; i < word.length; i++) shape += isVowel(word, i) ? 'V' : 'C';
        return (shape.match(/VC/g) || []).length;
    }

    function endsDoubleConsonant(word) {
        const n = word.length;
        return n > 1 && word[n - 1] === word[n - 2] && !isVowel(word, n - 1);
    }

    function endsCVC(word) {
        const n = word.length;
        if (n < 3) return false;
        return !isVowel(word, n - 3) && isVowel(word, n - 2) && !isVowel(word, n - 1) &&
            'wxy'.indexOf(word[n - 1]) === -1;
    }

    /* ── BM25 retrieval ──────────────────────────────────────────────────── */

    /* One pass over the places builds everything the language layer needs: per-place
       term frequencies (with the field weights folded in), document frequencies for
       IDF, the trigram sets used for fuzzy name matching, and the corpus vocabulary
       that keeps synonym expansion and spelling suggestions honest. */
    function buildCorpus() {
        const df = new Map();
        let totalLen = 0;

        places.forEach(place => {
            const tf = new Map();
            Object.keys(FIELD_WEIGHTS).forEach(field => {
                const weight = FIELD_WEIGHTS[field];
                indexTokens(place[field]).forEach(token => {
                    tf.set(token, (tf.get(token) || 0) + weight);
                });
            });
            place.tf = tf;
            place.len = Array.from(tf.values()).reduce((sum, n) => sum + n, 0);
            place.nameStems = indexTokens(place.name);
            place.grams = trigrams(place.name);
            totalLen += place.len;

            // Keep one real spelling per stem so a suggestion reads as a word
            // ("brewery") rather than as the stem the index actually stores ("breweri").
            words(`${place.name} ${place.notes} ${place.layer} ${place.address}`).forEach(word => {
                const token = stem(word);
                if (!displayTerms.has(token)) displayTerms.set(token, word);
            });

            tf.forEach((_, token) => {
                df.set(token, (df.get(token) || 0) + 1);
                vocab.add(token);
            });
        });

        corpus = { df, count: places.length, avgLen: totalLen / (places.length || 1) };

        /* Keep only expansions the corpus actually uses, so an expanded query can never
           chase a word that appears nowhere in the notes — and drop the ones that are
           too common to mean anything, which is what stops a term like "bars" from
           quietly matching every entry that mentions one. */
        const dfCeiling = Math.max(4, places.length * MAX_SYNONYM_DF);
        Object.keys(SYNONYM_SOURCE).forEach(word => {
            const key = stem(normalize(word));
            const alts = SYNONYM_SOURCE[word]
                .reduce((tokens, phrase) => tokens.concat(indexTokens(phrase)), [])
                .filter(token => token !== key && vocab.has(token) && df.get(token) <= dfCeiling);
            if (alts.length) synonyms.set(key, Array.from(new Set(alts)));
        });
    }

    /* Standard BM25 over the weighted term frequencies. IDF is what replaced the old
       hand-picked +4/+2/+1 scoring: a term that shows up in 400 of 1,100 entries is
       worth almost nothing, a term in three of them dominates. */
    function search(stems) {
        if (!corpus || !stems.length) return [];
        const terms = expandTerms(stems);
        const hits = [];

        places.forEach(place => {
            let score = 0;
            const matched = [];
            terms.forEach(term => {
                const freq = place.tf.get(term.token);
                if (!freq) return;
                const docs = corpus.df.get(term.token) || 0;
                const idf = Math.log(1 + (corpus.count - docs + 0.5) / (docs + 0.5));
                const norm = freq + BM25_K1 * (1 - BM25_B + BM25_B * place.len / corpus.avgLen);
                score += term.weight * idf * (freq * (BM25_K1 + 1)) / norm;
                matched.push(term.token);
            });
            if (score > 0) hits.push({ place, score, matched });
        });

        // Ties break toward shorter names, which are usually the place actually asked about.
        hits.sort((a, b) => b.score - a.score || a.place.name.length - b.place.name.length);
        return hits;
    }

    // Query expansion: the literal stems at full weight, known synonyms behind them.
    function expandTerms(stems) {
        const terms = [];
        const seen = new Set();
        stems.forEach(token => {
            if (seen.has(token)) return;
            seen.add(token);
            terms.push({ token, weight: 1 });
        });
        stems.forEach(token => (synonyms.get(token) || []).forEach(alt => {
            if (seen.has(alt)) return;
            seen.add(alt);
            terms.push({ token: alt, weight: SYNONYM_WEIGHT });
        }));
        return terms;
    }

    /* Hand-written query expansion. Each phrase is folded through the same tokenizer
       as the documents and dropped when the corpus never uses it, so "ramen" can pull
       in the noodle shops whose notes never say "ramen" without inventing vocabulary. */
    const SYNONYM_SOURCE = {
        ramen: ['noodles', 'japanese', 'udon'],
        noodles: ['ramen', 'pho', 'udon', 'thai'],
        sushi: ['japanese', 'sashimi', 'omakase', 'nigiri'],
        tacos: ['mexican', 'taqueria', 'birria'],
        pizza: ['pizzeria', 'deep dish', 'slice'],
        burger: ['burgers', 'diner', 'smash'],
        bbq: ['barbecue', 'smokehouse', 'ribs', 'brisket'],
        coffee: ['cafe', 'espresso', 'roasters', 'latte'],
        drinks: ['bar', 'cocktails', 'lounge', 'speakeasy'],
        beer: ['brewery', 'brewing', 'taproom', 'ale'],
        wine: ['wine bar', 'natural wine'],
        brunch: ['breakfast', 'pancakes', 'eggs', 'diner'],
        dessert: ['ice cream', 'bakery', 'pastry', 'donuts', 'cake'],
        // The notes spell it "vegatarian", and the corpus filter below means the
        // misspelling is the entry that survives — which is the point of the filter.
        vegan: ['vegetarian', 'vegatarian', 'veg', 'plant based'],
        seafood: ['oysters', 'fish', 'crab', 'shrimp'],
        steak: ['steakhouse', 'chophouse'],
        sandwich: ['sandwiches', 'deli', 'sub', 'italian beef'],
        museum: ['gallery', 'exhibit', 'art'],
        park: ['garden', 'trail', 'beach', 'lakefront'],
        // "blues" is deliberately absent: it stems to "blue" and would match every
        // Blue Bottle, Blue Door, and Blue Sushi on the map.
        music: ['jazz', 'live music', 'concert', 'venue'],
        theater: ['theatre', 'comedy', 'improv', 'show'],
        outdoors: ['patio', 'rooftop', 'outdoor', 'beach'],
        cheap: ['casual', 'quick', 'counter'],
        fancy: ['upscale', 'tasting menu', 'michelin', 'fine dining'],
        date: ['romantic', 'cozy', 'intimate', 'wine'],
        rooftop: ['patio', 'outdoor', 'views', 'skyline']
    };

    /* ── Fuzzy matching ──────────────────────────────────────────────────── */

    // Padded character trigrams — cheap, order-aware, and forgiving of typos.
    function trigrams(text) {
        const padded = `  ${normalize(text)} `;
        const grams = new Set();
        for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
        return grams;
    }

    function dice(a, b) {
        if (!a.size || !b.size) return 0;
        let shared = 0;
        a.forEach(gram => { if (b.has(gram)) shared++; });
        return (2 * shared) / (a.size + b.size);
    }

    // Closest place names to a query, for when the lexical pass finds nothing.
    function fuzzyNames(query, limit) {
        const grams = trigrams(query);
        return places
            .map(place => ({ place, score: dice(grams, place.grams) }))
            .filter(hit => hit.score >= FUZZY_NAME_MIN)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit || MAX_RESULTS);
    }

    // "Did you mean" for query words the corpus has never seen.
    function suggestTerms(stems) {
        const unknown = stems.filter(token => !vocab.has(token));
        if (!unknown.length || unknown.length !== stems.length) return [];
        return unknown.map(token => {
            const grams = trigrams(token);
            let best = null;
            vocab.forEach(candidate => {
                const score = dice(grams, trigrams(candidate));
                if (score >= FUZZY_TERM_MIN && (!best || score > best.score)) {
                    best = { candidate, score };
                }
            });
            return best && (displayTerms.get(best.candidate) || best.candidate);
        }).filter(Boolean);
    }

    /* ── Intent classification ───────────────────────────────────────────── */

    /* Multinomial naive Bayes over a handful of labelled utterances. The regex rules
       in classifyIntent stay because they are high precision; the classifier is what
       covers the phrasings nobody wrote a pattern for ("somewhere for dinner"), and
       it abstains to plain search whenever the top two classes are close. */
    const INTENT_EXAMPLES = [
        ['count', 'how many places are there'],
        ['count', 'how many food spots do you have'],
        ['count', 'what is the total number of places'],
        ['count', 'count the activities for me'],
        ['count', 'how many entries are on this map'],
        ['count', 'give me the total count'],
        ['count', 'number of places on the map'],
        ['count', 'how many are there in total'],

        ['category', 'show me food spots'],
        ['category', 'show me activities'],
        ['category', 'what are the food options'],
        ['category', 'list the restaurants'],
        ['category', 'what activities are on the map'],
        ['category', 'things to do'],
        ['category', 'where can i eat'],
        ['category', 'i am hungry'],
        ['category', 'somewhere for dinner'],
        ['category', 'what should i do today'],

        ['nearby', 'what is near clark street'],
        ['nearby', 'anything close to the loop'],
        ['nearby', 'places near wicker park'],
        ['nearby', 'what is around lincoln park'],
        ['nearby', 'food near the west loop'],
        ['nearby', 'anything nearby'],
        ['nearby', 'what is close by'],
        ['nearby', 'places within walking distance'],

        ['lookup', 'tell me about that place'],
        ['lookup', 'what do you know about it'],
        ['lookup', 'where is it located'],
        ['lookup', 'info on the spot'],
        ['lookup', 'give me the address'],
        ['lookup', 'what is the address'],
        ['lookup', 'details on that one'],
        ['lookup', 'is it any good'],

        ['search', 'pizza'],
        ['search', 'find pizza places'],
        ['search', 'best tacos'],
        ['search', 'sushi options'],
        ['search', 'coffee shops'],
        ['search', 'rooftop bars'],
        ['search', 'somewhere with live music'],
        ['search', 'vegan spots'],
        ['search', 'deep dish'],
        ['search', 'ramen'],

        ['greeting', 'hi'],
        ['greeting', 'hello'],
        ['greeting', 'hey there'],
        ['greeting', 'thanks'],
        ['greeting', 'thank you'],
        ['greeting', 'good morning'],
        ['greeting', 'what can you do'],
        ['greeting', 'help me out']
    ];

    function trainIntentModel() {
        const classes = {};
        const features = new Set();
        let docs = 0;

        INTENT_EXAMPLES.forEach(example => {
            const intent = example[0];
            const cls = classes[intent] || (classes[intent] = { docs: 0, total: 0, counts: new Map() });
            cls.docs++;
            docs++;
            intentTokens(example[1]).forEach(token => {
                cls.counts.set(token, (cls.counts.get(token) || 0) + 1);
                cls.total++;
                features.add(token);
            });
        });

        intentModel = { classes, docs, features };
    }

    // Laplace-smoothed log posteriors. Unseen words are skipped rather than smoothed
    // against, so one unknown cuisine name cannot drown the words that carry intent.
    function classify(text) {
        if (!intentModel) return { intent: 'search', margin: 0 };
        const tokens = intentTokens(text).filter(token => intentModel.features.has(token));
        if (!tokens.length) return { intent: 'search', margin: 0 };

        const vocabSize = intentModel.features.size;
        const scored = Object.keys(intentModel.classes).map(intent => {
            const cls = intentModel.classes[intent];
            let logp = Math.log(cls.docs / intentModel.docs);
            tokens.forEach(token => {
                logp += Math.log(((cls.counts.get(token) || 0) + 1) / (cls.total + vocabSize));
            });
            return { intent, logp };
        }).sort((a, b) => b.logp - a.logp);

        // Per-token margin, so a long question is not confident just for being long.
        return { intent: scored[0].intent, margin: (scored[0].logp - scored[1].logp) / tokens.length };
    }

    // Rules first for the phrasings we can recognise exactly, classifier for the rest.
    function classifyIntent(text) {
        if (/^(hi|hey|hello|yo|sup|howdy|thanks|thank you|thx|help)\b/.test(text)) return 'greeting';
        if (/\b(how many|how much|number of|total)\b/.test(text)) return 'count';
        // With a target we can answer; without one ("what's nearby") we ask for one,
        // which still beats falling through to a keyword search for "nearby".
        if (nearTarget(text) || /\b(nearby|near me|close by|around here|walking distance)\b/.test(text)) {
            return 'nearby';
        }
        if (/\b(tell me about|know about|what is|whats|where is|wheres|info on|information on|details on|details for|location of|address (of|for))\b/.test(text)) {
            return 'lookup';
        }
        const guess = classify(text);
        return guess.margin >= INTENT_MARGIN ? guess.intent : 'search';
    }

    /* ── Geography ───────────────────────────────────────────────────────── */

    /* Approximate neighbourhood centroids, hand-entered. They are precise enough to
       rank "what's near Wicker Park" by real distance — the map stores street
       addresses, so before this the only option was substring-matching the address
       and apologising when a neighbourhood name never appeared in one. */
    const NEIGHBORHOODS = {
        'the loop': [-87.6270, 41.8827], 'downtown': [-87.6270, 41.8827],
        'loop': [-87.6270, 41.8827], 'south loop': [-87.6270, 41.8670],
        'west loop': [-87.6500, 41.8820], 'fulton market': [-87.6480, 41.8860],
        'river north': [-87.6340, 41.8925], 'streeterville': [-87.6200, 41.8925],
        'magnificent mile': [-87.6240, 41.8950], 'navy pier': [-87.6050, 41.8917],
        'millennium park': [-87.6233, 41.8826], 'museum campus': [-87.6170, 41.8660],
        'gold coast': [-87.6270, 41.9050], 'old town': [-87.6370, 41.9080],
        'lincoln park': [-87.6470, 41.9214], 'lakeview': [-87.6530, 41.9400],
        'wrigleyville': [-87.6560, 41.9480], 'wrigley field': [-87.6553, 41.9484],
        'boystown': [-87.6490, 41.9430], 'uptown': [-87.6550, 41.9660],
        'andersonville': [-87.6690, 41.9770], 'edgewater': [-87.6600, 41.9870],
        'rogers park': [-87.6690, 42.0100], 'lincoln square': [-87.6890, 41.9680],
        'ravenswood': [-87.6840, 41.9690], 'north center': [-87.6790, 41.9530],
        'roscoe village': [-87.6790, 41.9420], 'avondale': [-87.7110, 41.9390],
        'logan square': [-87.7070, 41.9270], 'bucktown': [-87.6790, 41.9210],
        'wicker park': [-87.6770, 41.9088], 'ukrainian village': [-87.6860, 41.8990],
        'humboldt park': [-87.7010, 41.9020], 'west town': [-87.6720, 41.8960],
        'river west': [-87.6570, 41.8930], 'united center': [-87.6742, 41.8807],
        'pilsen': [-87.6560, 41.8570], 'little italy': [-87.6560, 41.8690],
        'chinatown': [-87.6320, 41.8530], 'bridgeport': [-87.6500, 41.8380],
        'bronzeville': [-87.6180, 41.8180], 'hyde park': [-87.5907, 41.7943],
        'albany park': [-87.7240, 41.9680], 'irving park': [-87.7160, 41.9530],
        'portage park': [-87.7660, 41.9540], 'jefferson park': [-87.7620, 41.9700],
        'garfield park': [-87.7170, 41.8800], 'south shore': [-87.5760, 41.7620],
        'beverly': [-87.6680, 41.7180], 'ohare': [-87.9048, 41.9786],
        'midway': [-87.7522, 41.7868]
    };

    const STREET_WORDS = new Set([
        'st', 'street', 'ave', 'avenu', 'avenue', 'rd', 'road', 'blvd', 'boulevard',
        'dr', 'drive', 'pkwy', 'parkway', 'way', 'ln', 'lane', 'ct', 'court', 'pl',
        'sq', 'squar', 'square', 'ter', 'terrac', 'hwy', 'highway'
    ]);

    const EARTH_MILES = 3958.8;

    function haversineMiles(lonA, latA, lonB, latB) {
        const toRad = deg => deg * Math.PI / 180;
        const dLat = toRad(latB - latA);
        const dLon = toRad(lonB - lonA);
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLon / 2) ** 2;
        return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    // The thing a "near X" question is anchored to, or '' when there is no anchor.
    function nearTarget(text) {
        const match = text.match(/\b(?:near(?:by)?|close to|next to|around|within walking distance of)\s+(?:the\s+)?(.+?)\s*[?.!]*$/);
        if (!match) return '';
        const target = match[1].trim();
        return /^(me|here|there|us|it|now|home|my (place|hotel))$/.test(target) ? '' : target;
    }

    /* Resolve an anchor to either a point (neighbourhood or saved place) or, for a
       street, the places on it. Streets get a filter rather than a radius because
       Clark St runs the length of the city, so a centroid would be meaningless. */
    function resolveLocation(target) {
        const clean = normalize(target).replace(/[?.!,]+$/, '').trim();

        const hood = matchNeighborhood(clean);
        if (hood) return { kind: 'point', label: hood.label, lon: hood.point[0], lat: hood.point[1] };

        const stems = indexTokens(clean);
        const looksLikeStreet = stems.some(token => STREET_WORDS.has(token));
        if (looksLikeStreet) {
            const onStreet = streetMatches(stems);
            if (onStreet.length) return { kind: 'street', label: titleCase(clean), matches: onStreet };
        }

        const named = namesContainingAll(stems);
        const place = named.length ? named[0] : (fuzzyNames(clean, 1)[0] || {}).place;
        if (place && place.lon != null) {
            return { kind: 'point', label: place.name, lon: place.lon, lat: place.lat, key: place.key };
        }

        const onStreet = streetMatches(stems);
        if (onStreet.length) return { kind: 'street', label: titleCase(clean), matches: onStreet };

        return null;
    }

    // Longest neighbourhood name mentioned in the anchor wins, so "west loop" beats "loop".
    function matchNeighborhood(clean) {
        let best = null;
        Object.keys(NEIGHBORHOODS).forEach(name => {
            if (clean.indexOf(name) === -1) return;
            if (!best || name.length > best.label.length) best = { label: titleCase(name), point: NEIGHBORHOODS[name] };
        });
        return best;
    }

    function streetMatches(stems) {
        const tokens = stems.filter(token => !STREET_WORDS.has(token));
        if (!tokens.length) return [];
        return places.filter(place => {
            const addressStems = indexTokens(place.address);
            return tokens.every(token => addressStems.indexOf(token) !== -1);
        });
    }

    // Places within a radius of a point, nearest first, excluding the anchor itself.
    function placesWithin(anchor, radiusMiles) {
        return places
            .filter(place => place.lon != null && place.key !== anchor.key)
            .map(place => ({ place, miles: haversineMiles(anchor.lon, anchor.lat, place.lon, place.lat) }))
            .filter(hit => hit.miles <= radiusMiles)
            .sort((a, b) => a.miles - b.miles);
    }

    /* ── Local answers ───────────────────────────────────────────────────── */

    const HELP_TEXT = 'I can answer from this map: counts, food spots and activities, ' +
        'searches by cuisine or vibe, single-place lookups, and what is near a neighborhood, ' +
        'street, or saved place. Try “find pizza”, “tell me about Aba”, or “what’s near Wicker Park”.';

    // Classify the question, then answer it from the place index.
    function generateReply(userText) {
        if (!places.length) {
            return 'Map data failed to load, so I can’t look anything up right now — try reloading the page.';
        }

        const text = normalize(userText);
        switch (classifyIntent(text)) {
            case 'greeting': return HELP_TEXT;
            case 'count':    return answerCount();
            case 'nearby':   return answerNearby(text);
            // Lookups and category asks hand back to search when they do not resolve,
            // so "what is the best pizza" lists pizza instead of dead-ending.
            case 'lookup':   return answerLookup(text) || answerSearch(text);
            case 'category': return answerCategory(text) || answerSearch(text);
            default:         return answerSearch(text);
        }
    }

    function answerCount() {
        const breakdown = Object.keys(layerCounts)
            .map(layer => `- ${layer}: ${layerCounts[layer]}`)
            .join('\n');
        return `There are ${places.length} places on this Chicago map.\n${breakdown}`;
    }

    // Terms that describe a whole layer rather than a specific place, keyed by stem.
    const CATEGORY_TERMS = {
        food: 'food', restaurant: 'food', dine: 'food', dinner: 'food', lunch: 'food',
        breakfast: 'food', brunch: 'food', eat: 'food', hungri: 'food', cuisin: 'food',
        meal: 'food', activiti: 'activit', explor: 'activit', fun: 'activit',
        entertain: 'activit', sightse: 'activit'
    };

    function answerCategory(text) {
        const stems = indexTokens(text);
        const fragments = stems.map(token => CATEGORY_TERMS[token]).filter(Boolean);
        if (!fragments.length) return '';

        /* A bare category ask lists the layer, but anything carrying a real search
           term ("vegan food", "where can I eat ramen") falls through to ranking so
           the answer is about the term rather than the whole layer. */
        if (stems.some(token => !CATEGORY_TERMS[token])) return '';

        return listCategory(fragments[0]);
    }

    // Every place in a layer, matched on the layer name rather than the text, so
    // "food" does not also sweep in every note that happens to mention food.
    function listCategory(fragment) {
        const matches = places.filter(place =>
            place.layers.some(layer => layer.toLowerCase().indexOf(fragment) !== -1));
        return formatPlaces(matches, fragment === 'food' ? 'in Food Spots' : 'in Activities');
    }

    function answerLookup(text) {
        const match = text.match(/\b(?:tell me about|know about|what is|whats|where is|wheres|info on|information on|details on|details for|location of|address (?:of|for))\s+(.+)$/);
        const target = (match ? match[1] : text).replace(/[?.!]+$/, '').trim();
        const stems = indexTokens(target);
        if (!stems.length) return '';

        const named = namesContainingAll(stems);
        if (named.length === 1) return describePlace(named[0]);
        if (named.length > 1) return '';                 // ambiguous — a list reads better

        // Typo tolerance, the one case where lexical matching cannot help at all.
        const fuzzy = fuzzyNames(target, 1);
        return fuzzy.length ? describePlace(fuzzy[0].place) : '';
    }

    function answerNearby(text) {
        const target = nearTarget(text);
        if (!target) {
            return 'Tell me what to search around — a neighborhood (“near Wicker Park”), ' +
                'a street (“near Clark St”), or a place on the map (“near Aba”).';
        }

        const anchor = resolveLocation(target);
        if (!anchor) {
            return `I couldn’t place “${target}”. I know Chicago neighborhoods, street names ` +
                'from the saved addresses, and any place on the map — try one of those.';
        }
        if (anchor.kind === 'street') {
            return formatPlaces(anchor.matches, `on ${anchor.label}`);
        }

        let hits = [];
        for (let i = 0; i < NEAR_RADII_MI.length; i++) {
            hits = placesWithin(anchor, NEAR_RADII_MI[i]);
            if (hits.length >= 3) break;
        }
        if (!hits.length) {
            const widest = NEAR_RADII_MI[NEAR_RADII_MI.length - 1];
            return `Nothing on the map is within ${widest} miles of ${anchor.label}.`;
        }
        return formatNearby(hits, anchor.label);
    }

    function answerSearch(text) {
        const stems = indexTokens(text);
        const content = stems.filter(token => !CATEGORY_TERMS[token]);

        /* Category words are intent, not content. Searching for "food" would match the
           Food Spots layer on all 444 restaurants and drown the term the visitor
           actually cares about, so "vegan food" searches for vegan — and a question
           with nothing left after the category word ("somewhere for dinner") is really
           just a category ask. */
        if (!content.length) {
            const category = stems.map(token => CATEGORY_TERMS[token]).filter(Boolean)[0];
            if (category) return listCategory(category);
        }

        const terms = content.length ? content : stems;
        const hits = search(terms);
        if (hits.length) {
            return formatPlaces(hits.map(hit => hit.place), `matching “${terms.join(', ')}”`);
        }

        // Nothing lexical: try the names fuzzily, then offer a spelling correction.
        const fuzzy = fuzzyNames(text, 3);
        if (fuzzy.length) {
            return formatPlaces(fuzzy.map(hit => hit.place), 'with a similar name');
        }

        const suggestions = suggestTerms(terms);
        if (suggestions.length) {
            const quoted = suggestions.map(term => `“${term}”`).join(' or ');
            return `I don’t have anything for “${terms.join(', ')}”. Did you mean ${quoted}?`;
        }
        return HELP_TEXT;
    }

    // Places whose name contains every content word of the query.
    function namesContainingAll(stems) {
        if (!stems.length) return [];
        return places.filter(place => stems.every(token => place.nameStems.indexOf(token) !== -1));
    }

    /* ── Place index ─────────────────────────────────────────────────────── */

    /* Convert the GeoJSON into a searchable list. The layers overlap — a restaurant is
       usually in both "Chicago Todo List" and "Food Spots" — so entries are merged by
       name + address and remember every layer they belong to. Coordinates come along
       for the distance search. */
    function buildPlaceIndex(data) {
        const byKey = new Map();
        Object.keys(data || {}).forEach(layer => {
            const features = (data[layer] && data[layer].features) || [];
            features.forEach(feature => {
                const props = feature.properties || {};
                const name = (props.name || '').trim();
                if (!name) return;
                const address = (props.address || '').trim();
                const notes = (props.reviews || props.notes || '').trim();
                const key = `${name.toLowerCase()}|${address.toLowerCase()}`;
                const coords = (feature.geometry && feature.geometry.coordinates) || [];
                const lon = typeof coords[0] === 'number' ? coords[0] : null;
                const lat = typeof coords[1] === 'number' ? coords[1] : null;

                const existing = byKey.get(key);
                if (existing) {
                    if (existing.layers.indexOf(layer) === -1) existing.layers.push(layer);
                    if (!existing.notes) existing.notes = notes;
                    if (existing.lon == null && lon != null) { existing.lon = lon; existing.lat = lat; }
                    return;
                }
                byKey.set(key, { key, name, layers: [layer], address, notes, lon, lat });
            });
        });

        return Array.from(byKey.values()).map(place => {
            place.layer = place.layers.join(', ');
            return place;
        });
    }

    /* ── Formatting ──────────────────────────────────────────────────────── */

    function describePlace(place) {
        return [
            `**${place.name}**`,
            `Layer: ${place.layer}`,
            `Address: ${place.address || 'Not listed'}`,
            `Notes: ${place.notes || 'No notes provided'}`
        ].join('\n');
    }

    /* Format a list of matching places. The label is a trailing phrase ("matching
       “pizza”", "on Clark St") rather than a full noun, so one function can get the
       singular and plural forms right. */
    function formatPlaces(matches, label) {
        if (!matches.length) {
            return `I couldn’t find any places ${label} in the current map data.`;
        }
        const items = matches.slice(0, MAX_RESULTS)
            .map(place => `• ${place.name}${place.address ? ` — ${place.address}` : ''}`);
        return `${countLine(matches.length, label)}\n${items.join('\n')}`;
    }

    // Same, with the distance that earned each place its spot in the list.
    function formatNearby(hits, label) {
        const items = hits.slice(0, MAX_RESULTS)
            .map(hit => `• ${hit.place.name} — ${hit.miles.toFixed(1)} mi${hit.place.address ? ` — ${hit.place.address}` : ''}`);
        return `${countLine(hits.length, `near ${label}`)}\n${items.join('\n')}`;
    }

    // Say when the list is truncated, so 10 of 40 does not read as all of them.
    function countLine(total, label) {
        const noun = total === 1 ? 'place' : 'places';
        return total > MAX_RESULTS
            ? `Here are ${MAX_RESULTS} of ${total} ${noun} ${label}:`
            : `Here ${total === 1 ? 'is' : 'are'} ${total} ${noun} ${label}:`;
    }

    function titleCase(text) {
        return text.replace(/\b[a-z]/g, ch => ch.toUpperCase());
    }

    /* ── Rendering helpers ──────────────────────────────────────────────── */

    // Show a waiting status next to the blinking cursor.
    function setPending(el, label) {
        el.innerHTML = `<span class="chat-cursor">▋</span><span class="chat-note">${label}</span>`;
        msgs.scrollTop = msgs.scrollHeight;
    }

    // Reveal the reply progressively so it reads like a live response.
    function typeOut(el, text) {
        return new Promise(resolve => {
            const step = Math.max(2, Math.ceil(text.length / 90));
            let i = 0;
            (function tick() {
                i = Math.min(text.length, i + step);
                el.innerHTML = renderMarkdown(text.slice(0, i)) +
                    (i < text.length ? '<span class="chat-cursor">▋</span>' : '');
                msgs.scrollTop = msgs.scrollHeight;
                if (i < text.length) setTimeout(tick, 16);
                else resolve();
            })();
        });
    }

    // Render simple markdown-like formatting for chat messages.
    function renderMarkdown(text) {
        return text
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/^•\s+(.+)$/gm, '<li>$1</li>')
            .replace(/^-\s+(.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
            .replace(/\n/g, '<br>');
    }

    // Add a bot message to the chat window.
    function addBot(text) {
        const d = document.createElement('div');
        d.className = 'chat-msg bot';
        d.textContent = text;
        msgs.appendChild(d);
        msgs.scrollTop = msgs.scrollHeight;
    }

    // Add a user message to the chat window.
    function addUser(text) {
        const d = document.createElement('div');
        d.className = 'chat-msg user';
        d.textContent = text;
        msgs.appendChild(d);
        msgs.scrollTop = msgs.scrollHeight;
    }

    // Create the quick-action suggestion buttons under the chat input.
    function renderChips(chips) {
        sugBox.innerHTML = '';
        chips.forEach(chip => {
            const btn = document.createElement('button');
            btn.className = 'chat-chip';
            btn.textContent = chip;
            btn.addEventListener('click', () => {
                if (busy) return;
                input.value = chip;
                submit();
            });
            sugBox.appendChild(btn);
        });
    }
})();
