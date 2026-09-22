/* ── AI Travel Planner — browser app ──────────────────────────────────────
   All data lives in localStorage (no server needed for the data layer).
   AI calls go to the Cloudflare Worker in ./worker, which holds the
   Gemini API key as a server-side secret. The Worker streams the reply
   back as SSE and this side renders it token by token.

   Five pages:
     dashboard  — stats, current/past trips, ideas
     plan       — form → Gemini → day-by-day itinerary + budget + packing + timeline
     concierge  — open chat backed by Gemini, primed with saved preferences
     budget     — expense logger + per-trip spending tracker
     profile    — preferences, bucket list, previously visited destinations     */

(function () {
    'use strict';

    /* ── Worker endpoints ─────────────────────────────────────────────────── */
    const WORKER_URL     = 'https://travel-planner.chicagochat.workers.dev';
    const DEV_WORKER_URL = 'http://127.0.0.1:8788';   // deploy.sh in worker/

    const REQUEST_TIMEOUT_MS = 120_000;
    const SLOW_HINT_MS       = 10_000;
    const HISTORY_TURNS      = 8;

    function workerEndpoint() {
        return /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
            ? DEV_WORKER_URL
            : WORKER_URL;
    }

    /* ── KV-backed DB (via Worker) ─────────────────────────────────────────
       Every method returns a Promise. Callers that previously used sync DB.*
       calls now await them. A lightweight in-memory cache avoids redundant
       round-trips within a single page-load; it is invalidated on every write.  */

    const _cache = { trips: null, prefs: null };

    async function dbCall(op, extra = {}) {
        const res = await fetch(workerEndpoint(), {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ type: 'db', op, ...extra })
        });
        if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error || `DB error (HTTP ${res.status})`);
        }
        const json = await res.json();
        return json.data;          // Worker always wraps in { ok, data }
    }

    const DB = {
        /* ── Preferences ───────────────────────────────────────────────── */
        async prefs() {
            if (_cache.prefs) return _cache.prefs;
            _cache.prefs = await dbCall('get_prefs');
            return _cache.prefs;
        },
        async savePrefs(p) {
            _cache.prefs = null;
            return dbCall('save_prefs', { data: p });
        },

        /* ── Trips ─────────────────────────────────────────────────────── */
        async trips() {
            if (_cache.trips) return _cache.trips;
            _cache.trips = await dbCall('get_trips');
            return _cache.trips;
        },
        async addTrip(trip, status) {
            _cache.trips = null;
            const result = await dbCall('add_trip', { trip, status });
            return result.id;
        },
        async updateTrip(id, updates) {
            _cache.trips = null;
            return dbCall('update_trip', { id, updates });
        },
        async getTrip(id) {
            const t = await DB.trips();
            for (const list of [t.current_trips, t.past_trips, t.trip_ideas]) {
                const trip = list.find(x => x.id === id);
                if (trip) return trip;
            }
            return null;
        },
        async deleteTrip(id) {
            _cache.trips = null;
            return dbCall('delete_trip', { id });
        },
        async completeTip(id) {
            _cache.trips = null;
            return dbCall('complete_trip', { id });
        },
        async addExpense(tripId, exp) {
            _cache.trips = null;
            return dbCall('add_expense', { trip_id: tripId, expense: exp });
        },
        async stats() {
            return dbCall('stats');
        },

        /* ── Bucket list & visited ─────────────────────────────────────── */
        async addBucket(destination, notes) {
            _cache.prefs = null;
            return dbCall('add_bucket', { destination, notes });
        },
        async removeBucket(destination) {
            _cache.prefs = null;
            return dbCall('remove_bucket', { destination });
        },
        async addVisited(destination) {
            _cache.prefs = null;
            return dbCall('add_visited', { destination });
        },
        async removeVisited(destination) {
            _cache.prefs = null;
            return dbCall('remove_visited', { destination });
        }
    };

    /* ── Budget helpers ────────────────────────────────────────────────────── */
    function calcBudgetBreakdown(total, days, level = 'mid-range') {
        const allocs = {
            budget:    { accommodation: 0.40, food: 0.25, activities: 0.20, transportation: 0.10, miscellaneous: 0.05 },
            'mid-range':{ accommodation: 0.35, food: 0.25, activities: 0.25, transportation: 0.10, miscellaneous: 0.05 },
            luxury:    { accommodation: 0.45, food: 0.20, activities: 0.20, transportation: 0.10, miscellaneous: 0.05 }
        };
        const alloc = allocs[level] || allocs['mid-range'];
        const breakdown = {};
        for (const [cat, pct] of Object.entries(alloc)) {
            const amt = total * pct;
            breakdown[cat] = { total: +amt.toFixed(2), per_day: +(amt / days).toFixed(2), percentage: pct * 100 };
        }
        return { total_budget: total, duration_days: days, breakdown, daily_average: +(total / days).toFixed(2) };
    }

    function fallbackPacking(climate, days, activities) {
        const cl = (climate || '').toLowerCase();
        let clothing;
        if (cl.includes('warm') || cl.includes('tropical')) {
            clothing = ['Lightweight clothes', 'Shorts & t-shirts', 'Swimsuit', 'Sun hat', 'Sunglasses', 'Sandals'];
        } else if (cl.includes('cold') || cl.includes('winter')) {
            clothing = ['Warm jacket', 'Sweaters', 'Thermal underwear', 'Gloves & scarf', 'Winter boots'];
        } else {
            clothing = ['Light layers', 'T-shirts & long sleeves', 'Pants & shorts', 'Light jacket', 'Walking shoes'];
        }
        return {
            essentials: ['Passport', 'Travel insurance', 'Flight tickets', 'Credit cards', 'Phone & charger', 'Medications'],
            clothing,
            toiletries: ['Toothbrush & toothpaste', 'Shampoo', 'Deodorant', 'Sunscreen'],
            technology: ['Charger', 'Power bank', 'Headphones']
        };
    }

    function fallbackTimeline(country, depDate) {
        let dep;
        try { dep = new Date(depDate); } catch { dep = new Date(Date.now() + 30 * 86400000); }
        const days = Math.max(0, Math.round((dep - Date.now()) / 86400000));
        const list = [];
        if (days >= 60) list.push({ timeline: '2 months before', tasks: ['Book flights', 'Book accommodation', 'Check visa requirements', 'Buy travel insurance'] });
        if (days >= 30) list.push({ timeline: '1 month before', tasks: ['Book major activities', 'Notify bank', 'Set up international phone plan', 'Make restaurant reservations'] });
        if (days >= 14) list.push({ timeline: '2 weeks before', tasks: ['Confirm all reservations', 'Exchange currency', 'Print important documents'] });
        if (days >= 7)  list.push({ timeline: '1 week before', tasks: ['Pack luggage', 'Download offline maps', 'Charge all devices'] });
        list.push({ timeline: 'Day before', tasks: ['Re-check flight time', 'Prepare carry-on', 'Set multiple alarms'] });
        return list;
    }

    /* ── Claude streaming helper (concierge chat) ─────────────────────────── */
    async function streamConcierge(question, history, prefs, model, onChunk) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(workerEndpoint(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'concierge', question, history, prefs, model }),
                signal: controller.signal
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            if (!res.body?.getReader) {
                return consumeSSE(await res.text(), onChunk, '');
            }
            const reader  = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '', text = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const blocks = buffer.split('\n\n');
                buffer = blocks.pop() || '';
                const next = consumeSSE(blocks.join('\n\n'), onChunk, text);
                if (next !== text) { text = next; }
            }
            return text;
        } catch (err) {
            if (err?.name === 'AbortError') throw new Error('Request timed out. Try a shorter question.');
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    /* ── Non-streaming Claude call (itinerary generation) ─────────────────── */
    async function callWorkerJSON(payload) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(workerEndpoint(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            return res.json();
        } finally {
            clearTimeout(timer);
        }
    }

    function consumeSSE(chunk, onChunk, seed) {
        let text = seed;
        chunk.split('\n').forEach(raw => {
            const line = raw.trim();
            if (!line.startsWith('data:')) return;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') return;
            let data;
            try { data = JSON.parse(payload); } catch { return; }
            if (data.error) throw new Error(data.error);
            if (typeof data.delta === 'string') { text += data.delta; onChunk(text); }
        });
        return text;
    }

    /* ── Page routing ──────────────────────────────────────────────────────── */
    let activePage = 'dashboard';

    function showPage(id) {
        document.querySelectorAll('.tp-page').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.tp-nav').forEach(a => a.classList.remove('active'));
        document.getElementById(`page-${id}`)?.classList.add('active');
        document.querySelectorAll(`[data-page="${id}"]`).forEach(a => a.classList.add('active'));
        activePage = id;
        window.scrollTo(0, 0);
        if (id === 'dashboard') renderDashboard();
        if (id === 'budget')    renderBudgetPage();
        if (id === 'profile')   renderProfilePage();
    }

    /* Wire up all nav links */
    document.querySelectorAll('[data-page]').forEach(el => {
        el.addEventListener('click', e => {
            e.preventDefault();
            showPage(el.dataset.page);
        });
    });

    /* ── Utility ───────────────────────────────────────────────────────────── */
    function esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function fmt$(n) { return `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

    function setVisible(el, show) { if (show) el.removeAttribute('hidden'); else el.setAttribute('hidden', ''); }

    function showMsg(el, msg, type = 'loading') {
        el.className = `tp-status-msg ${type}`;
        el.textContent = msg;
        setVisible(el, true);
    }

    function hideMsg(el) { setVisible(el, false); }

    /* ── Dashboard ─────────────────────────────────────────────────────────── */
    async function renderDashboard() {
        const [s, t] = await Promise.all([DB.stats(), DB.trips()]);
        document.getElementById('stat-trips').textContent     = s.total_trips;
        document.getElementById('stat-active').textContent    = s.current_trips;
        document.getElementById('stat-countries').textContent = s.countries_visited;
        document.getElementById('stat-days').textContent      = s.total_days_traveled;
        document.getElementById('stat-spent').textContent     = fmt$(s.total_spent);

        renderTripList('current-trips-list', t.current_trips, 'current');
        renderTripList('past-trips-list',    t.past_trips,    'past');
        renderTripList('ideas-list',         t.trip_ideas,    'idea');
    }

    function renderTripList(containerId, trips, kind) {
        const el = document.getElementById(containerId);
        if (!trips?.length) {
            el.innerHTML = '<p class="tp-empty">None yet.</p>';
            return;
        }
        el.innerHTML = trips.map(trip => {
            const dest = trip.destination || {};
            const name = [dest.city, dest.country].filter(Boolean).join(', ') || 'Unknown destination';
            const dates = trip.departure_date
                ? `${trip.departure_date} → ${trip.return_date || '?'}`
                : `${trip.duration_days || '?'} days`;
            const budget = trip.budget || {};
            const spent  = budget.spent || 0;
            const total  = budget.total || 0;
            const pct    = total > 0 ? Math.min(100, (spent / total) * 100) : 0;
            const barCls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';

            return `<div class="tp-trip-card">
  <h4>${esc(name)}</h4>
  <div class="tp-trip-meta">
    <span>📅 ${esc(dates)}</span>
    ${total ? `&ensp;·&ensp;<span>💰 ${fmt$(spent)} / ${fmt$(total)}</span>` : ''}
    ${trip.activities?.length ? `&ensp;·&ensp;<span>${trip.activities.slice(0,3).map(esc).join(', ')}</span>` : ''}
  </div>
  ${total ? `<div class="tp-progress-wrap"><div class="tp-progress-bar ${barCls}" style="width:${pct.toFixed(1)}%"></div></div>` : ''}
  <div class="tp-trip-actions">
    ${kind === 'current' ? `<button class="tp-btn tp-btn-secondary" onclick="TravelApp.viewPlan('${trip.id}')">View Plan</button>` : ''}
    ${kind === 'current' ? `<button class="tp-btn tp-btn-ghost" onclick="TravelApp.completeTrip('${trip.id}')">✅ Complete</button>` : ''}
    <button class="tp-btn tp-btn-danger" onclick="TravelApp.deleteTrip('${trip.id}')">🗑 Delete</button>
  </div>
</div>`;
        }).join('');
    }

    /* ── Plan New Trip ─────────────────────────────────────────────────────── */

    // Set default departure date to 30 days from now
    const depInput = document.getElementById('plan-dep');
    const def = new Date(); def.setDate(def.getDate() + 30);
    depInput.value = def.toISOString().slice(0, 10);

    // Load prefs into form
    async function loadPrefsIntoForm() {
        const p = await DB.prefs();
        const si = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
        si('plan-budget-tier', p.budget_level);
        si('plan-pace',        p.pace_preference);
        si('pref-style',       p.travel_style);
        si('pref-budget',      p.budget_level);
        si('pref-pace',        p.pace_preference);
        si('pref-companions',  p.travel_companions);
        si('pref-interests',   Array.isArray(p.interests) ? p.interests.join(', ') : p.interests);
        si('pref-dietary',     Array.isArray(p.dietary_restrictions) ? p.dietary_restrictions.join(', ') : (p.dietary_restrictions || 'None'));
        si('pref-languages',   Array.isArray(p.language_skills) ? p.language_skills.join(', ') : (p.language_skills || 'English'));
    }
    loadPrefsIntoForm();

    // Tab switching inside plan results
    document.querySelectorAll('#plan-tabs .tp-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#plan-tabs .tp-tab').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tp-tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add('active');
        });
    });

    let lastGeneratedTripId = null;

    document.getElementById('plan-generate-btn').addEventListener('click', async () => {
        const city       = document.getElementById('plan-city').value.trim();
        const country    = document.getElementById('plan-country').value.trim();
        const duration   = parseInt(document.getElementById('plan-duration').value, 10) || 5;
        const climate    = document.getElementById('plan-climate').value;
        const budgetTier = document.getElementById('plan-budget-tier').value;
        const totalBudget= parseFloat(document.getElementById('plan-budget').value) || 2500;
        const pace       = document.getElementById('plan-pace').value;
        const depDate    = document.getElementById('plan-dep').value;
        const retDate    = (() => { const d = new Date(depDate); d.setDate(d.getDate() + duration); return d.toISOString().slice(0, 10); })();
        const activities = [...document.querySelectorAll('#activity-checkboxes input:checked')].map(i => i.value);
        const status     = document.querySelector('[name="plan-status"]:checked').value;
        const model      = document.getElementById('model-select').value;

        if (!city || !country) { showMsg(document.getElementById('plan-status-msg'), 'Please enter a city and country.', 'error'); return; }

        const prefs = await DB.prefs();
        const statusMsg = document.getElementById('plan-status-msg');
        const btn = document.getElementById('plan-generate-btn');
        btn.disabled = true;
        showMsg(statusMsg, `Generating AI plan for ${city}, ${country} — this takes ~15–30 seconds…`, 'loading');
        setVisible(document.getElementById('plan-results'), false);

        const slowHint = setTimeout(() => {
            if (btn.disabled) showMsg(statusMsg, 'Still thinking — Claude is building your full itinerary…', 'loading');
        }, SLOW_HINT_MS);

        try {
            const result = await callWorkerJSON({
                type: 'generate',
                city, country, duration, pace, budget_level: budgetTier,
                activities, climate,
                interests:  prefs.interests || [],
                dietary:    prefs.dietary_restrictions || [],
                model
            });

            clearTimeout(slowHint);

            // Save trip to DB
            const tripData = {
                destination:   { city, country },
                departure_date: depDate,
                return_date:   retDate,
                duration_days: duration,
                climate:       climate.toLowerCase(),
                activities,
                budget:        { total: totalBudget, spent: 0 },
                expenses:      []
            };
            const tripId = await DB.addTrip(tripData, status);
            lastGeneratedTripId = tripId;

            // Persist AI results into the trip
            const aiRec = {
                summary:    result.destination_summary || '',
                attractions:result.top_attractions || [],
                dining:     result.dining_recommendations || [],
                hidden_gems:result.hidden_gems || [],
                etiquette:  result.cultural_etiquette_tips || []
            };
            const fallbackBudget  = calcBudgetBreakdown(totalBudget, duration, budgetTier);
            const fallbackPack    = fallbackPacking(climate, duration, activities);
            const fallbackTime    = fallbackTimeline(country, depDate);

            await DB.updateTrip(tripId, {
                itinerary:         result.daily_itinerary || [],
                ai_recommendations:aiRec,
                budget_breakdown:  fallbackBudget,
                packing_checklist: fallbackPack,
                pre_trip_checklist:fallbackTime
            });

            renderPlanResults(tripId);
            showMsg(statusMsg, `✅ Plan saved! Showing results below.`, 'success');
        } catch (err) {
            clearTimeout(slowHint);
            showMsg(statusMsg, `Error: ${err.message}`, 'error');
        } finally {
            btn.disabled = false;
        }
    });

    async function renderPlanResults(tripId) {
        const trip = await DB.getTrip(tripId);
        if (!trip) return;
        const ai  = trip.ai_recommendations || {};

        // Summary
        const summaryEl = document.getElementById('plan-ai-summary');
        if (ai.summary) { summaryEl.textContent = `💡 ${ai.summary}`; setVisible(summaryEl, true); }
        else             { setVisible(summaryEl, false); }

        // Attractions
        document.getElementById('res-attractions').innerHTML = (ai.attractions || []).length
            ? ai.attractions.map(a => `<div class="tp-result-item">
  <strong>${esc(a.name)}</strong> <span class="tp-meta">${esc(a.estimated_cost || '')}</span>
  <div class="tp-meta">${esc(a.why_visit || '')} · Best: ${esc(a.best_time || 'Anytime')}</div>
</div>`).join('')
            : '<p class="tp-empty">No attraction data.</p>';

        // Dining
        document.getElementById('res-dining').innerHTML = (ai.dining || []).length
            ? ai.dining.map(d => `<div class="tp-result-item">
  <strong>${esc(d.restaurant)}</strong> <span class="tp-meta">${esc(d.price_range || '')}</span>
  <div class="tp-meta">${esc(d.cuisine_or_specialty || '')}${d.notes ? ' · ' + esc(d.notes) : ''}</div>
</div>`).join('')
            : '<p class="tp-empty">No dining data.</p>';

        // Hidden gems
        document.getElementById('res-gems').innerHTML = (ai.hidden_gems || []).length
            ? ai.hidden_gems.map(g => `<div class="tp-result-item">
  <strong>${esc(g.title)}</strong>
  <div class="tp-meta">${esc(g.description || '')}</div>
</div>`).join('')
            : '<p class="tp-empty">No gems data.</p>';

        // Etiquette
        document.getElementById('res-etiquette').innerHTML = (ai.etiquette || []).length
            ? `<ul style="padding-left:1.1rem;margin:0">${ai.etiquette.map(t => `<li style="font-size:0.85rem;color:rgba(255,255,255,0.75);margin-bottom:0.3rem">${esc(t)}</li>`).join('')}</ul>`
            : '<p class="tp-empty">No tips data.</p>';

        // Itinerary
        const itin = trip.itinerary || [];
        document.getElementById('res-itinerary').innerHTML = itin.length
            ? itin.map(day => {
                const m = day.morning   || {};
                const a = day.afternoon || {};
                const e = day.evening   || {};
                const meals = day.meals || {};
                return `<div class="tp-day-card">
  <button class="tp-day-header" onclick="this.nextElementSibling.classList.toggle('open');this.querySelector('.tp-chevron').style.transform=this.nextElementSibling.classList.contains('open')?'rotate(90deg)':''">
    <span>Day ${esc(day.day)}${day.theme ? ` — ${esc(day.theme)}` : ''}</span>
    <span class="tp-chevron" style="transition:transform 150ms">▶</span>
  </button>
  <div class="tp-day-body">
    <div class="tp-day-slots">
      <div><div class="tp-slot-label">🌅 Morning${m.time ? ` (${esc(m.time)})` : ''}</div>
           <div class="tp-slot-activity">${esc(m.activity || '—')}</div>
           ${m.notes ? `<div class="tp-slot-note">💡 ${esc(m.notes)}</div>` : ''}</div>
      <div><div class="tp-slot-label">☀️ Afternoon${a.time ? ` (${esc(a.time)})` : ''}</div>
           <div class="tp-slot-activity">${esc(a.activity || '—')}</div>
           ${a.notes ? `<div class="tp-slot-note">💡 ${esc(a.notes)}</div>` : ''}</div>
      <div><div class="tp-slot-label">🌙 Evening${e.time ? ` (${esc(e.time)})` : ''}</div>
           <div class="tp-slot-activity">${esc(e.activity || '—')}</div>
           ${e.notes ? `<div class="tp-slot-note">💡 ${esc(e.notes)}</div>` : ''}</div>
    </div>
    ${Object.keys(meals).length ? `<div class="tp-meals-row">🍴 Breakfast: <em>${esc(meals.breakfast || '—')}</em> &ensp;·&ensp; Lunch: <em>${esc(meals.lunch || '—')}</em> &ensp;·&ensp; Dinner: <em>${esc(meals.dinner || '—')}</em></div>` : ''}
  </div>
</div>`;
            }).join('')
            : '<p class="tp-empty">No itinerary generated.</p>';

        // Budget breakdown
        const bb = trip.budget_breakdown || {};
        const cats = bb.breakdown || {};
        document.getElementById('res-budget').innerHTML = Object.keys(cats).length
            ? `<table class="tp-table">
  <thead><tr><th>Category</th><th>Total</th><th>Per Day</th><th>Share</th></tr></thead>
  <tbody>${Object.entries(cats).map(([c, v]) => `
  <tr><td>${esc(c.charAt(0).toUpperCase() + c.slice(1))}</td>
      <td>${fmt$(v.total)}</td>
      <td>${fmt$(v.per_day)}</td>
      <td>${v.percentage?.toFixed(1)}%</td></tr>`).join('')}
  </tbody>
</table>
<p style="font-size:0.85rem;margin-top:0.75rem;color:rgba(255,255,255,0.5)">Daily target average: <strong style="color:#4fc3f7">${fmt$(bb.daily_average)}</strong></p>`
            : '<p class="tp-empty">No budget data.</p>';

        // Packing
        const pack = trip.packing_checklist || {};
        document.getElementById('res-packing').innerHTML = Object.keys(pack).length
            ? Object.entries(pack).filter(([, v]) => v?.length).map(([cat, items]) => `
<div class="tp-pack-section">
  <h4>${esc(cat)}</h4>
  <div class="tp-pack-grid">
    ${items.map((item, i) => `<label class="tp-pack-item"><input type="checkbox"> ${esc(item)}</label>`).join('')}
  </div>
</div>`).join('')
            : '<p class="tp-empty">No packing list generated.</p>';

        // Pre-trip timeline
        const timeline = trip.pre_trip_checklist || [];
        document.getElementById('res-timeline').innerHTML = timeline.length
            ? timeline.map(sec => `
<div class="tp-timeline-section">
  <div class="tp-timeline-label">⏳ ${esc(sec.timeline)}</div>
  ${(sec.tasks || []).map((t, i) => `<label class="tp-pack-item" style="margin-bottom:0.25rem"><input type="checkbox"> ${esc(t)}</label>`).join('')}
</div>`).join('')
            : '<p class="tp-empty">No timeline generated.</p>';

        setVisible(document.getElementById('plan-results'), true);

        // Reset tabs to first
        document.querySelectorAll('#plan-tabs .tp-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tp-tab-panel').forEach(p => p.classList.remove('active'));
        document.querySelector('#plan-tabs .tp-tab[data-tab="suggestions"]').classList.add('active');
        document.getElementById('tab-suggestions').classList.add('active');
    }

    /* ── AI Concierge ──────────────────────────────────────────────────────── */
    let conciergeHistory = [];
    const CHIPS = [
        'What to pack for a week in Tokyo?',
        'Best time to visit Patagonia?',
        'Vegetarian restaurants in Barcelona?',
        'Visa tips for Southeast Asia?',
        'Day trips from Rome?'
    ];

    function renderConciergeMsg(role, text, isError = false) {
        const msgs = document.getElementById('concierge-messages');
        const d = document.createElement('div');
        d.className = `tp-chat-msg ${role}${isError ? ' error' : ''}`;
        d.innerHTML = renderMarkdown(text);
        msgs.appendChild(d);
        msgs.scrollTop = msgs.scrollHeight;
        return d;
    }

    function renderConciergeChips(chips) {
        const box = document.getElementById('concierge-suggestions');
        box.innerHTML = '';
        chips.forEach(chip => {
            const btn = document.createElement('button');
            btn.className = 'tp-chat-chip';
            btn.textContent = chip;
            btn.addEventListener('click', () => sendConcierge(chip));
            box.appendChild(btn);
        });
    }

    async function sendConcierge(text) {
        text = text.trim();
        if (!text) return;
        const input = document.getElementById('concierge-input');
        const send  = document.getElementById('concierge-send');
        input.value = '';
        document.getElementById('concierge-suggestions').innerHTML = '';
        renderConciergeMsg('user', text);
        send.disabled = true; input.disabled = true;

        const bubble = document.createElement('div');
        bubble.className = 'tp-chat-msg bot';
        bubble.innerHTML = '<span class="tp-chat-cursor">▋</span><span style="font-size:0.78rem;color:rgba(255,255,255,0.35)"> Thinking…</span>';
        document.getElementById('concierge-messages').appendChild(bubble);
        document.getElementById('concierge-messages').scrollTop = 9999;

        const slowHint = setTimeout(() => {
            if (!bubble.dataset.streaming) bubble.innerHTML = '<span class="tp-chat-cursor">▋</span><span style="font-size:0.78rem;color:rgba(255,255,255,0.35)"> Still thinking…</span>';
        }, SLOW_HINT_MS);

        const model  = document.getElementById('model-select').value;
        const prefs  = await DB.prefs();
        const hist   = conciergeHistory.slice(-HISTORY_TURNS);

        try {
            const reply = await streamConcierge(text, hist, {
                interests: prefs.interests,
                dietary:   prefs.dietary_restrictions,
                pace:      prefs.pace_preference
            }, model, delta => {
                bubble.dataset.streaming = '1';
                bubble.innerHTML = renderMarkdown(delta) + '<span class="tp-chat-cursor">▋</span>';
                document.getElementById('concierge-messages').scrollTop = 9999;
            });
            bubble.innerHTML = renderMarkdown(reply.trim() || '(empty reply)');
            conciergeHistory.push({ role: 'user', content: text }, { role: 'assistant', content: reply.trim() });
        } catch (err) {
            bubble.innerHTML = renderMarkdown(`Error: ${err.message}`);
            bubble.classList.add('error');
        } finally {
            clearTimeout(slowHint);
            delete bubble.dataset.streaming;
            send.disabled = false; input.disabled = false;
            input.focus();
        }
    }

    document.getElementById('concierge-send').addEventListener('click', () => sendConcierge(document.getElementById('concierge-input').value));
    document.getElementById('concierge-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendConcierge(document.getElementById('concierge-input').value); } });
    document.getElementById('concierge-clear').addEventListener('click', () => {
        conciergeHistory = [];
        document.getElementById('concierge-messages').innerHTML = '';
        document.getElementById('concierge-suggestions').innerHTML = '';
        initConcierge();
    });

    function initConcierge() {
        const msgs = document.getElementById('concierge-messages');
        if (msgs.children.length === 0) {
            renderConciergeMsg('bot', 'Hi! ✈️ I\'m your AI travel concierge. Ask me about destinations, packing, visas, restaurants, day trips — anything travel-related.');
            renderConciergeChips(CHIPS);
        }
    }

    /* ── Budget Tracker ────────────────────────────────────────────────────── */
    async function renderBudgetPage() {
        const t   = await DB.trips();
        const all = [...(t.current_trips || []), ...(t.past_trips || [])];
        const sel = document.getElementById('budget-trip-select');
        sel.innerHTML = all.length
            ? all.map(trip => {
                const d = trip.destination || {};
                const name = [d.city, d.country].filter(Boolean).join(', ') || 'Trip';
                return `<option value="${trip.id}">${esc(name)} (${trip.departure_date || 'no date'})</option>`;
              }).join('')
            : '<option value="">No trips yet — create one in Plan Trip</option>';

        sel.onchange = () => renderBudgetSummary(sel.value);
        if (all.length) renderBudgetSummary(all[0].id);
        else document.getElementById('budget-summary').innerHTML = '';
    }

    async function renderBudgetSummary(tripId) {
        const trip = await DB.getTrip(tripId);
        if (!trip) return;
        const expenses  = trip.expenses || [];
        const total     = trip.budget?.total || 0;
        const spent     = expenses.reduce((s, e) => s + (e.amount || 0), 0);
        const remaining = total - spent;
        const pct       = total > 0 ? Math.min(100, (spent / total) * 100) : 0;
        const barCls    = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';

        document.getElementById('budget-summary').innerHTML = `
<div class="tp-stat-card"><div class="tp-stat-value">${fmt$(total)}</div><div class="tp-stat-label">Total Budget</div></div>
<div class="tp-stat-card"><div class="tp-stat-value">${fmt$(spent)}</div><div class="tp-stat-label">Spent</div></div>
<div class="tp-stat-card"><div class="tp-stat-value" style="color:${pct>=100?'#f87171':'#6ee7b7'}">${fmt$(remaining)}</div><div class="tp-stat-label">Remaining</div></div>
<div class="tp-stat-card" style="flex:2 1 180px">
  <div style="font-size:0.78rem;color:rgba(255,255,255,0.4);margin-bottom:0.4rem">${pct.toFixed(1)}% used</div>
  <div class="tp-progress-wrap"><div class="tp-progress-bar ${barCls}" style="width:${pct.toFixed(1)}%"></div></div>
</div>`;

        renderExpenseList(tripId, expenses);
    }

    function renderExpenseList(tripId, expenses) {
        const el = document.getElementById('expense-list');
        if (!expenses.length) { el.innerHTML = '<p class="tp-empty">No expenses logged yet.</p>'; return; }
        el.innerHTML = `<table class="tp-table">
<thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Amount</th></tr></thead>
<tbody>${expenses.slice().reverse().map(e => `
<tr><td>${esc(e.date || '—')}</td><td>${esc(e.description || '')}</td><td>${esc(e.category || '')}</td><td>${fmt$(e.amount)}</td></tr>`).join('')}
</tbody></table>`;
    }

    // Set default expense date to today
    document.getElementById('exp-date').value = new Date().toISOString().slice(0, 10);

    document.getElementById('exp-add-btn').addEventListener('click', async () => {
        const tripId = document.getElementById('budget-trip-select').value;
        if (!tripId) { alert('No trip selected.'); return; }
        const exp = {
            description: document.getElementById('exp-desc').value.trim() || 'Expense',
            amount:      parseFloat(document.getElementById('exp-amount').value) || 0,
            category:    document.getElementById('exp-category').value,
            date:        document.getElementById('exp-date').value
        };
        await DB.addExpense(tripId, exp);
        renderBudgetSummary(tripId);
        // Reset amount
        document.getElementById('exp-amount').value = '35';
    });

    /* ── Profile / Preferences ─────────────────────────────────────────────── */
    async function renderProfilePage() {
        await loadPrefsIntoForm();
        const p = await DB.prefs();
        renderBucketList(p.bucket_list || []);
        renderPrevDest(p.previous_destinations || []);
    }

    document.getElementById('pref-save-btn').addEventListener('click', async () => {
        const csv = s => s.split(',').map(x => x.trim()).filter(Boolean);
        const existing = await DB.prefs();
        await DB.savePrefs({
            ...existing,
            travel_style:         document.getElementById('pref-style').value,
            budget_level:         document.getElementById('pref-budget').value,
            pace_preference:      document.getElementById('pref-pace').value,
            travel_companions:    document.getElementById('pref-companions').value,
            interests:            csv(document.getElementById('pref-interests').value),
            dietary_restrictions: csv(document.getElementById('pref-dietary').value),
            language_skills:      csv(document.getElementById('pref-languages').value)
        });
        const msg = document.getElementById('pref-saved-msg');
        showMsg(msg, '✅ Preferences saved!', 'success');
        setTimeout(() => hideMsg(msg), 3000);
    });

    function renderBucketList(list) {
        const el = document.getElementById('bucket-list');
        el.innerHTML = list.length
            ? list.map(b => `<div class="tp-result-item" style="display:flex;align-items:center;justify-content:space-between">
  <span><strong>${esc(b.destination)}</strong>${b.notes ? `<span class="tp-meta"> — ${esc(b.notes)}</span>` : ''}</span>
  <button class="tp-btn tp-btn-danger" onclick="TravelApp.removeBucket('${esc(b.destination)}')">✕</button>
</div>`).join('')
            : '<p class="tp-empty">No destinations yet.</p>';
    }

    function renderPrevDest(list) {
        const el = document.getElementById('prev-dest-list');
        el.innerHTML = list.length
            ? list.map(d => `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.35rem">
  <span style="font-size:0.85rem;color:rgba(255,255,255,0.75)">- ${esc(d)}</span>
  <button class="tp-btn tp-btn-danger" onclick="TravelApp.removePrevDest('${esc(d)}')">✕</button>
</div>`).join('')
            : '<p class="tp-empty">No visited places logged.</p>';
    }

    document.getElementById('bucket-add-btn').addEventListener('click', async () => {
        const dest  = document.getElementById('bucket-dest').value.trim();
        const notes = document.getElementById('bucket-notes').value.trim();
        if (!dest) return;
        const list = await DB.addBucket(dest, notes);
        renderBucketList(list);
    });

    document.getElementById('prev-dest-add-btn').addEventListener('click', async () => {
        const dest = document.getElementById('prev-dest-input').value.trim();
        if (!dest) return;
        const list = await DB.addVisited(dest);
        renderPrevDest(list);
        document.getElementById('prev-dest-input').value = '';
    });

    /* ── Markdown renderer (subset) ────────────────────────────────────────── */
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
            .replace(/(?:<li>.*?<\/li>\n?)+/g, run => `<ul>${run.replace(/\n/g, '')}</ul>`)
            .replace(/\n/g, '<br>');
    }

    /* ── Global callbacks (called from inline onclick in rendered HTML) ─────── */
    window.TravelApp = {
        async deleteTrip(id) {
            if (!confirm('Delete this trip?')) return;
            await DB.deleteTrip(id);
            renderDashboard();
        },
        async completeTrip(id) {
            await DB.completeTip(id);
            renderDashboard();
        },
        viewPlan(id) {
            lastGeneratedTripId = id;
            showPage('plan');
            renderPlanResults(id);
        },
        async removeBucket(dest) {
            const list = await DB.removeBucket(dest);
            renderBucketList(list);
        },
        async removePrevDest(dest) {
            const list = await DB.removeVisited(dest);
            renderPrevDest(list);
        }
    };

    /* ── Init ──────────────────────────────────────────────────────────────── */
    renderDashboard();
    initConcierge();

})();
