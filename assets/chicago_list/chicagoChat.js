/* ── Chicago Assistant — free AI via Pollinations, local fallback ────────
   Pollinations' text API needs no API key and sends `Access-Control-Allow-Origin: *`,
   so it can be called straight from a static page. The anonymous tier allows roughly
   one request every 15s per visitor IP, so requests are paced, the prompt is kept small
   by sending only the places relevant to the question, and anything that fails or would
   stall falls back to the local rule-based answers below — the widget always replies. */
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

    // Load the map data once so the assistant can answer from the Chicago places list.
    fetch('assets/chicago_list/chicago_layers.geojson')
        .then(r => r.json())
        .then(data => {
            places = buildPlaceIndex(data);
            layerCounts = places.reduce((counts, place) => {
                place.layers.forEach(layer => { counts[layer] = (counts[layer] || 0) + 1; });
                return counts;
            }, {});
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

    // Pull the searchable words out of a question.
    function meaningfulTerms(userText) {
        const terms = userText.toLowerCase().match(/[a-z0-9']{3,}/g) || [];
        return terms.filter(term => !STOP_WORDS.has(term));
    }

    /* Score places against the question's words, best match first. Matching is
       anchored to word starts so "Aba" doesn't match "Kabab" and "pizza" still
       matches "pizzas". */
    function rankPlaces(userText) {
        const terms = meaningfulTerms(userText);
        if (!terms.length) return [];

        const patterns = terms.map(term => new RegExp('\\b' + escapeRegExp(term), 'i'));
        const scored = [];
        places.forEach(place => {
            let score = 0;
            patterns.forEach(re => {
                if (re.test(place.name)) score += 4;
                else if (place.notes && re.test(place.notes)) score += 2;
                else if (re.test(place.layer) || (place.address && re.test(place.address))) score += 1;
            });
            if (score) scored.push({ place, score });
        });

        // Ties break toward shorter names, which are usually the place actually asked about.
        scored.sort((a, b) => b.score - a.score || a.place.name.length - b.place.name.length);
        return scored.map(entry => entry.place);
    }

    function escapeRegExp(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /* Words stripped before matching. "eat" and "town" are here because they collide with
       real place names ("Eately", "Chinatown") and would outrank the actual search term. */
    const STOP_WORDS = new Set([
        'the', 'and', 'for', 'are', 'any', 'can', 'you', 'what', 'whats', 'where', 'which',
        'show', 'find', 'give', 'tell', 'near', 'about', 'there', 'have', 'has', 'some',
        'good', 'best', 'place', 'places', 'spot', 'spots', 'list', 'many', 'much', 'chicago',
        'this', 'that', 'with', 'from', 'into', 'they', 'them', 'would', 'should', 'could',
        'like', 'want', 'need', 'get', 'got', 'how', 'eat', 'eats', 'town', 'around', 'area',
        'recommend', 'anything', 'something', 'visit', 'try'
    ]);

    // Terms that describe a whole layer rather than a specific place.
    const CATEGORY_TERMS = {
        food: 'food', foods: 'food', restaurant: 'food', restaurants: 'food', dining: 'food',
        activity: 'activit', activities: 'activit', things: 'activit', explore: 'activit'
    };

    /* ── Local fallback answers ─────────────────────────────────────────── */

    // Match common user intents and return helpful responses based on the map data.
    function generateReply(userText) {
        const text = userText.toLowerCase().trim();
        const allPlaces = places;

        if (!allPlaces.length) {
            return 'Map data failed to load, so I can’t look anything up right now — try reloading the page.';
        }

        if (/(how many|count|total)/.test(text) && /(place|places|spots|locations|there)/.test(text)) {
            return `There are ${allPlaces.length} places on this Chicago map.`;
        }

        /* "What's near X" — the map only stores street addresses, so this only works
           when X appears in an address. Answered before keyword ranking, which would
           otherwise match "park" in Wicker Park against every place named "… Park". */
        const neighborhood = extractNeighborhood(text);
        if (neighborhood) {
            const nearby = allPlaces.filter(place => place.address.toLowerCase().includes(neighborhood));
            if (nearby.length) return formatPlaces(nearby, `places near ${neighborhood}`);
            return `I couldn’t find anything at an address containing “${neighborhood}”. The map stores street addresses rather than neighborhood names, so try a street name, a place name, or a cuisine instead.`;
        }

        // A specific place lookup — describe the single best match in full, but only
        // when the question really names a place on the map.
        const name = extractPlaceName(text);
        if (name) {
            const match = rankPlaces(name)[0];
            if (match && nameMatchesQuery(match, name)) {
                return `**${match.name}**\nLayer: ${match.layer}\nAddress: ${match.address || 'Not listed'}\nNotes: ${match.notes || 'No notes provided'}`;
            }
        }

        /* A pure category ask ("show me food spots") lists the layer. Anything with a real
           search term in it falls through to ranking, so "where can I eat ramen" answers
           with ramen rather than the entire Food Spots layer. */
        const terms = meaningfulTerms(text);
        if (terms.length && terms.every(term => CATEGORY_TERMS[term])) {
            const layerTerm = CATEGORY_TERMS[terms[0]];
            const label = layerTerm === 'food' ? 'food spots' : 'activities';
            return formatPlaces(filterPlaces(allPlaces, [layerTerm]), label);
        }

        const matches = rankPlaces(text);
        if (matches.length) {
            return formatPlaces(matches, `places matching “${terms.join(', ')}”`);
        }

        // Category asks whose wording never appears in the data itself.
        if (/\b(food|restaurant|eat|dining|snack|hungry)/.test(text)) {
            return formatPlaces(filterPlaces(allPlaces, ['food']), 'food spots');
        }
        if (/\b(activit|things? to do|explore|do)\b/.test(text)) {
            return formatPlaces(filterPlaces(allPlaces, ['activit']), 'activities');
        }

        return 'I can help with counts, food spots, activities, and place lookups from this map. Try asking things like “Show me food spots,” “Find pizza places,” or “Tell me about Aba.”';
    }

    /* Convert the GeoJSON into a searchable list. The layers overlap — a restaurant is
       usually in both "Chicago Todo List" and "Food Spots" — so entries are merged by
       name + address and remember every layer they belong to. */
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

                const existing = byKey.get(key);
                if (existing) {
                    if (existing.layers.indexOf(layer) === -1) existing.layers.push(layer);
                    if (!existing.notes) existing.notes = notes;
                    return;
                }
                byKey.set(key, { name, layers: [layer], address, notes });
            });
        });

        return Array.from(byKey.values()).map(place => {
            place.layer = place.layers.join(', ');
            place.text = [place.name, place.layer, place.address, place.notes].join(' ').toLowerCase();
            return place;
        });
    }

    // Filter the place list by one or more keywords.
    function filterPlaces(allPlaces, terms) {
        const normalizedTerms = terms.filter(Boolean).map(term => term.toLowerCase());
        return allPlaces.filter(place => {
            const text = place.text || '';
            return normalizedTerms.every(term => text.includes(term));
        });
    }

    // Extract an area mention like "near Wicker Park". Only the explicit "near"
    // form, so "best tacos in town" stays a keyword search.
    function extractNeighborhood(text) {
        const matches = text.match(/\bnear\s+(.+?)\s*\??$/);
        return matches ? matches[1].trim() : '';
    }

    // Pull a place name out of prompts such as "tell me about Aba".
    function extractPlaceName(text) {
        if (/\bnear\b/.test(text)) return '';   // "what's near X" is an area question, not a lookup
        const match = text.match(/(?:where is|location of|tell me about|info on)\s+(.+)/);
        if (!match) return '';
        return match[1].trim().replace(/\?$/, '').trim();
    }

    // True when the match earned its place because its *name* matches the question.
    function nameMatchesQuery(place, query) {
        return meaningfulTerms(query).some(term => new RegExp('\\b' + escapeRegExp(term), 'i').test(place.name));
    }

    // Format a list of matching places into a simple chat-friendly response.
    function formatPlaces(matches, label) {
        if (!matches.length) {
            return `I couldn’t find any ${label} in the current map data.`;
        }
        const items = matches.slice(0, 10).map(place => `• ${place.name}${place.address ? ` — ${place.address}` : ''}`);
        return `Here are a few ${label}:\n${items.join('\n')}`;
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
