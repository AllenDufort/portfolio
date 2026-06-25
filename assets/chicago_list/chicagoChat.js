/* ── Chicago Assistant — powered by puter.js ─────────────────── */
(function () {
    'use strict';

    const toggle   = document.getElementById('chat-toggle');
    const panel    = document.getElementById('chat-panel');
    const closeBtn = document.getElementById('chat-close');
    const msgs     = document.getElementById('chat-messages');
    const sugBox   = document.getElementById('chat-suggestions');
    const input    = document.getElementById('chat-input');
    const sendBtn  = document.getElementById('chat-send');

    let systemPrompt = null;   // built once GeoJSON loads
    let busy         = false;

    // ── Build system prompt from GeoJSON ──────────────────────
    fetch('assets/chicago_list/chicago_layers.geojson')
        .then(r => r.json())
        .then(data => {
            const lines = [];
            const seen  = new Set();
            Object.keys(data).forEach(layer => {
                const features = (data[layer] && data[layer].features) || [];
                features.forEach(f => {
                    const p = f.properties || {};
                    const name = (p.name || '').trim();
                    if (!name || seen.has(name.toLowerCase())) return;
                    seen.add(name.toLowerCase());
                    const parts = [`• ${name} [${layer}]`];
                    if (p.address) parts.push(`  Address: ${p.address.trim()}`);
                    if (p.reviews) parts.push(`  Notes:   ${p.reviews.trim()}`);
                    lines.push(parts.join('\n'));
                });
            });
            systemPrompt =
`You are "Chicago Assistant", a friendly and knowledgeable guide for a personal Chicago TODO map.
The map has three layers: "Chicago Todo List" (general to-do places), "Food Spots", and "Activities".

Below is the complete list of every place on the map (name, layer, address, notes):

${lines.join('\n')}

Rules:
- Answer questions using ONLY the data above. Do not invent places or addresses.
- When listing places, format them as a short bullet list (max 10 items unless the user asks for more).
- If you don't know something, say so honestly.
- Keep answers concise and friendly.
- When asked about a neighborhood, match against addresses that contain that neighborhood name.`;
        })
        .catch(() => {
            systemPrompt = 'You are Chicago Assistant. Map data failed to load — tell the user.';
        });

    // ── Open / close ──────────────────────────────────────────
    toggle.addEventListener('click', () => {
        const isHidden = panel.hidden;
        panel.hidden = !isHidden;
        if (isHidden) {
            input.focus();
            if (msgs.children.length === 0) {
                addBot("Hi! I'm your Chicago assistant 🏙️ Ask me anything about the places on this map — food spots, activities, addresses, neighborhoods, and more.");
                renderChips([
                    'How many places are there?',
                    'Show me food spots',
                    'Show me activities',
                    'What\'s near Wicker Park?',
                    'Find pizza places',
                ]);
            }
        }
    });
    closeBtn.addEventListener('click', () => { panel.hidden = true; });

    // ── Send ──────────────────────────────────────────────────
    sendBtn.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) submit(); });

    async function submit() {
        if (busy) return;
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        sugBox.innerHTML = '';
        addUser(text);
        await ask(text);
    }

    // ── puter.ai call with streaming ──────────────────────────
    async function ask(userText) {
        if (!systemPrompt) {
            addBot('⏳ Still loading map data — please try again in a moment.');
            return;
        }
        busy = true;
        sendBtn.disabled = true;
        input.disabled   = true;

        const botDiv = document.createElement('div');
        botDiv.className = 'chat-msg bot';
        botDiv.innerHTML = '<span class="chat-cursor">▋</span>';
        msgs.appendChild(botDiv);
        msgs.scrollTop = msgs.scrollHeight;

        let fullText = '';
        try {
            const response = await puter.ai.chat(
                [
                    { role: 'system',    content: systemPrompt },
                    { role: 'user',      content: userText }
                ],
                { model: 'gpt-4o-mini', stream: true, driver_params: { silent: true } }
            );

            for await (const part of response) {
                const chunk = part?.text ?? part?.choices?.[0]?.delta?.content ?? '';
                if (chunk) {
                    fullText += chunk;
                    botDiv.innerHTML = renderMarkdown(fullText) + '<span class="chat-cursor">▋</span>';
                    msgs.scrollTop = msgs.scrollHeight;
                }
            }
        } catch (err) {
            const msg = err?.message
                || err?.error?.message
                || (typeof err === 'string' ? err : null)
                || JSON.stringify(err);
            fullText = `⚠️ Something went wrong: ${msg}`;
        }

        botDiv.innerHTML = renderMarkdown(fullText || '(no response)');
        msgs.scrollTop = msgs.scrollHeight;

        busy = false;
        sendBtn.disabled = false;
        input.disabled   = false;
        input.focus();
    }

    // ── Minimal Markdown → HTML (bold, italic, bullets) ───────
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

    // ── Message helpers ───────────────────────────────────────
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

    // ── Suggestion chips ──────────────────────────────────────
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
