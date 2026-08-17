/* ── Chicago Assistant — LLM chat widget ──────────────────────────────────
   Every answer comes from a model. There is no local retrieval or fallback layer here:
   the widget collects a question, optionally the visitor's coordinates, and streams the
   reply back token by token.

   The model is reached through the Cloudflare Worker in ./worker, never directly. That
   is not indirection for its own sake — an OpenRouter key in a static page is a public
   key, so it stays a Worker secret. The Worker also builds the prompt (it fetches the
   same Google Sheet the map uses and sends the model all 552 places grouped by
   neighborhood), which is why this file needs no place data at all and does not wait on
   ChicagoData.load().

   Location questions ("what food spots are near me") are the one thing a prompt cannot
   answer alone, so NEAR_ME_RE spots them, the browser asks for permission, and the
   coordinates ride along with the question. The Worker turns them into real distances.
   Coordinates are rounded to ~11 m, sent only on those questions, and never stored. */
(function () {
    'use strict';

    /* Set this to your deployed Worker: `npx wrangler deploy` in ./worker prints the URL.
       Until it is set the widget says so instead of failing with a network error. */
    const WORKER_URL = 'https://chicago-chat.chicagochat.workers.dev';
    const DEV_WORKER_URL = 'http://127.0.0.1:8787';       // npx wrangler dev

    const REQUEST_TIMEOUT_MS = 90000;   // a 550B model on a free endpoint can be slow
    const SLOW_HINT_MS = 9000;          // when to admit it is taking a while
    const MAX_QUESTION_CHARS = 500;     // matches the Worker's own cap
    const HISTORY_TURNS = 6;            // messages kept so follow-ups make sense
    const LOCATION_TTL_MS = 5 * 60 * 1000;
    const GEO_TIMEOUT_MS = 12000;
    const COORD_PRECISION = 4;          // ~11 m — enough for "near me", not a doorstep

    /* The one hardcoded piece of language understanding left, and it only decides whether
       to ask the browser for coordinates before sending the question. Everything about
       what the answer says is the model's job. */
    const NEAR_ME_RE = /\b(?:near|around|close to|closest to|by)\s+(?:me|here|us|my\s+location)\b|\bnear\s?by\b|\bwalking distance\b|\bmy location\b|\baround here\b|\bclose by\b|\bwhere i am\b/i;

    const toggle   = document.getElementById('chat-toggle');
    const panel    = document.getElementById('chat-panel');
    const closeBtn = document.getElementById('chat-close');
    const msgs     = document.getElementById('chat-messages');
    const sugBox   = document.getElementById('chat-suggestions');
    const input    = document.getElementById('chat-input');
    const sendBtn  = document.getElementById('chat-send');

    const OPENING_CHIPS = [
        'What food spots are in South Loop?',
        'What food spots are near me?',
        'How many places are there?',
        'Show me museums',
        'Tell me about Aba'
    ];
    // Offered when a location question cannot be answered, so there is still a way forward.
    const NO_LOCATION_CHIPS = [
        'What food spots are in West Town?',
        'Clubs in River North',
        'Show me activities in the Loop'
    ];

    let busy = false;
    let history = [];          // [{role, content}] — the last HISTORY_TURNS messages
    let spot = null;           // {lat, lon, at} once the visitor has shared their location

    // Open and close the chat panel.
    toggle.addEventListener('click', () => {
        const isHidden = panel.hidden;
        panel.hidden = !isHidden;
        if (isHidden) {
            input.focus();
            if (msgs.children.length === 0) {
                addBot('Hi! I’m your Chicago assistant 🏙️ Ask me about food spots, activities, ' +
                    'a neighborhood, or what’s near you.');
                renderChips(OPENING_CHIPS);
            }
        }
    });
    closeBtn.addEventListener('click', () => { panel.hidden = true; });

    sendBtn.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) submit(); });

    function submit() {
        if (busy) return;
        const text = input.value.trim().slice(0, MAX_QUESTION_CHARS);
        if (!text) return;
        input.value = '';
        sugBox.innerHTML = '';
        addUser(text);
        ask(text);
    }

    /* One question: resolve location if it was asked for, stream the reply into a bubble,
       and keep the exchange in history. Failures are shown as themselves — with no local
       answer to fall back on, a quiet substitute would only look like a bad reply. */
    async function ask(question) {
        setBusy(true);

        const bubble = document.createElement('div');
        bubble.className = 'chat-msg bot';
        msgs.appendChild(bubble);
        setStatus(bubble, 'Thinking…');

        const slowHint = setTimeout(() => {
            if (!bubble.dataset.streaming) setStatus(bubble, 'Still thinking — the free model is slow…');
        }, SLOW_HINT_MS);

        try {
            if (!endpoint()) throw new ChatError(
                'The assistant isn’t connected yet: deploy the Worker in ' +
                'assets/chicago_list/worker and put its URL in WORKER_URL.');

            const coords = await coordsFor(question, bubble);
            const reply = await stream(question, coords, text => {
                bubble.dataset.streaming = '1';
                bubble.innerHTML = renderMarkdown(visible(text)) + '<span class="chat-cursor">▋</span>';
                msgs.scrollTop = msgs.scrollHeight;
            });

            const answer = visible(reply).trim();
            if (!answer) throw new ChatError('The model sent back an empty reply — try asking again.');
            bubble.innerHTML = renderMarkdown(answer);
            remember(question, answer);
        } catch (err) {
            bubble.innerHTML = renderMarkdown(err instanceof ChatError
                ? err.message
                : 'Something went wrong reaching the assistant — try again in a moment.');
            bubble.classList.add('chat-msg-error');
            if (err instanceof ChatError && err.chips) renderChips(err.chips);
        } finally {
            clearTimeout(slowHint);
            delete bubble.dataset.streaming;
            msgs.scrollTop = msgs.scrollHeight;
            setBusy(false);
        }
    }

    // Errors written for the visitor rather than for a console.
    class ChatError extends Error {
        constructor(message, chips) {
            super(message);
            this.chips = chips;
        }
    }

    function setBusy(state) {
        busy = state;
        sendBtn.disabled = state;
        input.disabled = state;
        if (!state) input.focus();
    }

    function remember(question, answer) {
        history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
        history = history.slice(-HISTORY_TURNS);
    }

    /* ── Talking to the Worker ───────────────────────────────────────────── */

    function endpoint() {
        if (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) return DEV_WORKER_URL;
        return WORKER_URL.indexOf('chicagochat') === -1 ? WORKER_URL : '';
    }

    /* Read the Worker's event stream. It normalises whatever OpenRouter sends into one
       shape — {"delta"} for text, {"error"} for a generation that failed halfway, and a
       trailing [DONE] — so this side only has to accumulate. */
    async function stream(question, coords, onText) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const res = await fetch(endpoint(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question, history, coords: coords || undefined }),
                signal: controller.signal
            });
            if (!res.ok) throw new ChatError(await failureMessage(res));

            // No streaming body (an old browser, or a proxy that buffered it): the SSE
            // text is all there at once, and the same parser handles it.
            if (!res.body || !res.body.getReader) {
                const whole = consume(await res.text(), '');
                onText(whole);
                return whole;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let text = '';

            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const blocks = buffer.split('\n\n');
                buffer = blocks.pop() || '';          // keep the unfinished block for later
                const next = consume(blocks.join('\n\n'), text);
                if (next !== text) {
                    text = next;
                    onText(text);
                }
            }
            return text;
        } catch (err) {
            if (err && err.name === 'AbortError') {
                throw new ChatError('That took too long, so I stopped waiting. Try a shorter question.');
            }
            if (err instanceof ChatError) throw err;
            throw new ChatError('I couldn’t reach the assistant — check your connection and try again.');
        } finally {
            clearTimeout(timer);
        }
    }

    // Fold SSE blocks onto the text so far, raising anything the Worker flagged.
    function consume(chunk, seed) {
        let text = seed;
        chunk.split('\n').forEach(rawLine => {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) return;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') return;

            let data;
            try { data = JSON.parse(payload); } catch (err) { return; }
            if (data.error) throw new ChatError(data.error);
            if (typeof data.delta === 'string') text += data.delta;
        });
        return text;
    }

    // The Worker answers failures with {"error": "..."} and a real status code.
    async function failureMessage(res) {
        try {
            const data = await res.json();
            if (data && data.error) return data.error;
        } catch (err) { /* fall through to the status */ }
        if (res.status === 429) return 'Too many questions at once — give it a minute.';
        return `The assistant returned an error (HTTP ${res.status}).`;
    }

    /* ── Location ────────────────────────────────────────────────────────── */

    /* Coordinates go out on a "near me" question, and on every question afterwards once
       they have been shared — so a follow-up like "any bars instead?" stays anchored
       where the visitor is standing. */
    async function coordsFor(question, bubble) {
        const known = fresh(spot);
        if (known || !NEAR_ME_RE.test(question)) return known;

        setStatus(bubble, 'Getting your location…');
        spot = await getPosition();
        return fresh(spot);
    }

    function fresh(saved) {
        if (!saved || Date.now() - saved.at > LOCATION_TTL_MS) return null;
        return { lat: saved.lat, lon: saved.lon };
    }

    function getPosition() {
        if (!navigator.geolocation || !window.isSecureContext) {
            throw new ChatError('This browser won’t share a location with the page, so I can’t do ' +
                '“near me”. Name a neighborhood and I’ll take it from there.', NO_LOCATION_CHIPS);
        }
        return new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(
                pos => resolve({
                    lat: round(pos.coords.latitude),
                    lon: round(pos.coords.longitude),
                    at: Date.now()
                }),
                err => reject(locationError(err)),
                { enableHighAccuracy: false, timeout: GEO_TIMEOUT_MS, maximumAge: LOCATION_TTL_MS }
            );
        });
    }

    function locationError(err) {
        if (err && err.code === 1) {
            return new ChatError('I need location access for “near me”, and the browser blocked it. ' +
                'You can allow it from the icon in the address bar, or just name a neighborhood.',
                NO_LOCATION_CHIPS);
        }
        return new ChatError('Your location didn’t come through. Try again, or name a neighborhood ' +
            'instead.', NO_LOCATION_CHIPS);
    }

    function round(value) {
        const factor = Math.pow(10, COORD_PRECISION);
        return Math.round(value * factor) / factor;
    }

    /* ── Rendering ───────────────────────────────────────────────────────── */

    function setStatus(el, label) {
        el.innerHTML = `<span class="chat-cursor">▋</span><span class="chat-note">${label}</span>`;
        msgs.scrollTop = msgs.scrollHeight;
    }

    /* The Worker asks OpenRouter to keep the reasoning out of the reply, but a reasoning
       model can still leak a <think> block. Drop closed ones, and hide an open one and
       everything after it until it closes, so a half-streamed thought never shows. */
    function visible(text) {
        return String(text)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<think>[\s\S]*$/i, '')
            .replace(/^\s+/, '');
    }

    // Escape first, then the small subset of markdown the model is asked to use.
    function renderMarkdown(text) {
        const escaped = String(text)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

        return escaped
            .split('\n')
            .map(line => /^\s*[-•*]\s+/.test(line)
                ? `<li>${line.replace(/^\s*[-•*]\s+/, '')}</li>`
                : line)
            .join('\n')
            // Consecutive list items become one list; ordinary lines keep their breaks.
            .replace(/(?:<li>.*?<\/li>\n?)+/g, run => `<ul>${run.replace(/\n/g, '')}</ul>`)
            .replace(/\n/g, '<br>');
    }

    function addBot(text) {
        const d = document.createElement('div');
        d.className = 'chat-msg bot';
        d.textContent = text;
        msgs.appendChild(d);
        msgs.scrollTop = msgs.scrollHeight;
    }

    function addUser(text) {
        const d = document.createElement('div');
        d.className = 'chat-msg user';
        d.textContent = text;
        msgs.appendChild(d);
        msgs.scrollTop = msgs.scrollHeight;
    }

    // Quick-action buttons under the input.
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
