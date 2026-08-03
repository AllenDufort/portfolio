/* ── Chicago Assistant — works locally, no login required ─────── */
(function () {
    'use strict';

    const toggle   = document.getElementById('chat-toggle');
    const panel    = document.getElementById('chat-panel');
    const closeBtn = document.getElementById('chat-close');
    const msgs     = document.getElementById('chat-messages');
    const sugBox   = document.getElementById('chat-suggestions');
    const input    = document.getElementById('chat-input');
    const sendBtn  = document.getElementById('chat-send');

    // Local state for the chatbot's knowledge base and busy status.
    let systemPrompt = null;
    let places = [];
    let busy = false;

    // Load the map data once so the assistant can answer from the Chicago places list.
    fetch('assets/chicago_list/chicago_layers.geojson')
        .then(r => r.json())
        .then(data => {
            places = buildPlaceIndex(data);
            const lines = places.slice(0, 80).map(place => {
                const parts = [`• ${place.name} [${place.layer}]`];
                if (place.address) parts.push(`  Address: ${place.address}`);
                if (place.notes) parts.push(`  Notes: ${place.notes}`);
                return parts.join('\n');
            });
            systemPrompt = `You are Chicago Assistant for a personal Chicago TODO map. Use only the places below. Keep replies short, friendly, and based on the map data.\n\n${lines.join('\n')}`;
        })
        .catch(() => {
            systemPrompt = 'You are Chicago Assistant. Map data failed to load — say so clearly.';
        });

    // Open and close the chat panel without requiring any external service.
    toggle.addEventListener('click', () => {
        const isHidden = panel.hidden;
        panel.hidden = !isHidden;
        if (isHidden) {
            input.focus();
            if (msgs.children.length === 0) {
                addBot("Hi! I’m your Chicago assistant 🏙️ I work right here in the browser, so there’s no login needed. Ask me about food spots, activities, neighborhoods, or specific places.");
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

    sendBtn.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) submit(); });

    // Send a user message and route it to the local response generator.
    async function submit() {
        if (busy) return;
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        sugBox.innerHTML = '';
        addUser(text);
        await ask(text);
    }

    // Build a reply locally from the loaded place data.
    async function ask(userText) {
        if (!systemPrompt && !places.length) {
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

        const fullText = generateReply(userText);
        await new Promise(resolve => setTimeout(resolve, 180));
        botDiv.innerHTML = renderMarkdown(fullText);
        msgs.scrollTop = msgs.scrollHeight;

        busy = false;
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
    }

    // Match common user intents and return helpful responses based on the map data.
    function generateReply(userText) {
        const text = userText.toLowerCase().trim();
        const allPlaces = places;

        if (/(how many|count|total)/.test(text) && /(place|places|spots|locations|there)/.test(text)) {
            return `There are ${allPlaces.length} places on this Chicago map.`;
        }

        if (/food|restaurant|eat|dining|snack/.test(text) && /(show|list|find|give|tell)/.test(text)) {
            return formatPlaces(filterPlaces(allPlaces, ['food', 'restaurant', 'eat', 'dining', 'snack']), 'food spots');
        }

        if (/activity|activities|thing to do|things to do|explore|visit/.test(text) && /(show|list|find|give|tell)/.test(text)) {
            return formatPlaces(filterPlaces(allPlaces, ['activity', 'activities', 'museum', 'park', 'tour', 'explore', 'visit']), 'activities');
        }

        const neighborhood = extractNeighborhood(text);
        if (neighborhood) {
            const matches = filterPlaces(allPlaces, [neighborhood]);
            if (matches.length) {
                return formatPlaces(matches, `places near ${neighborhood}`);
            }
        }

        const keyword = extractKeyword(text);
        if (keyword) {
            const matches = filterPlaces(allPlaces, [keyword]);
            if (matches.length) {
                return formatPlaces(matches, `places matching “${keyword}”`);
            }
        }

        if (/(where is|location of|tell me about|what is|what's)/.test(text)) {
            const name = extractPlaceName(text);
            if (name) {
                const matches = filterPlaces(allPlaces, [name]);
                if (matches.length) {
                    const place = matches[0];
                    return `**${place.name}**\nLayer: ${place.layer}\nAddress: ${place.address || 'Not listed'}\nNotes: ${place.notes || 'No notes provided'}`;
                }
            }
        }

        return 'I can help with counts, food spots, activities, neighborhoods, and place lookups from this map. Try asking things like “Show me food spots,” “Find pizza places,” or “What\'s near Wicker Park?”';
    }

    // Convert the GeoJSON data into a simple searchable list of places.
    function buildPlaceIndex(data) {
        const places = [];
        Object.keys(data || {}).forEach(layer => {
            const features = (data[layer] && data[layer].features) || [];
            features.forEach(feature => {
                const props = feature.properties || {};
                const name = (props.name || '').trim();
                if (!name) return;
                places.push({
                    name,
                    layer,
                    address: (props.address || '').trim(),
                    notes: (props.reviews || props.notes || '').trim(),
                    text: [name, layer, props.address || '', props.reviews || props.notes || ''].join(' ').toLowerCase()
                });
            });
        });
        return places;
    }

    // Filter the place list by one or more keywords.
    function filterPlaces(allPlaces, terms) {
        const normalizedTerms = terms.filter(Boolean).map(term => term.toLowerCase());
        return allPlaces.filter(place => {
            const text = place.text || '';
            return normalizedTerms.every(term => text.includes(term));
        });
    }

    // Extract a neighborhood mention like "near Wicker Park".
    function extractNeighborhood(text) {
        const matches = text.match(/near (.+?)(?:\b|$)/);
        if (matches && matches[1]) return matches[1].trim();
        const neighborhoodMatch = text.match(/in ([a-z0-9 .'/-]+)$/);
        return neighborhoodMatch ? neighborhoodMatch[1].trim() : '';
    }

    // Extract a search term from prompts such as "find pizza places".
    function extractKeyword(text) {
        const match = text.match(/(?:find|search|show me|show|look for|looking for)\s+(?:a|an|the)?\s+([a-z0-9 .'/-]{2,})/);
        if (!match) return '';
        let keyword = match[1].trim();
        keyword = keyword.replace(/\bspots\b|\bplaces\b|\bfor\b|\bme\b/g, '').trim();
        return keyword;
    }

    function extractPlaceName(text) {
        const match = text.match(/(?:where is|location of|tell me about|what is|what's)\s+(.+)/);
        if (!match) return '';
        return match[1].trim().replace(/\?$/, '').trim();
    }

    // Format a list of matching places into a simple chat-friendly response.
    function formatPlaces(matches, label) {
        if (!matches.length) {
            return `I couldn’t find any ${label} in the current map data.`;
        }
        const items = matches.slice(0, 10).map(place => `• ${place.name}${place.address ? ` — ${place.address}` : ''}`);
        return `Here are a few ${label}:\n${items.join('\n')}`;
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
