import { workerEndpoint, readEventStream } from '../shared/worker-client.js';

/* ── Worker endpoints ─────────────────────────────────────────────────── */
const WORKER_URL     = 'https://travel-planner.chicagochat.workers.dev';
const DEV_WORKER_URL = 'http://127.0.0.1:8788';   // deploy.sh in worker/

const REQUEST_TIMEOUT_MS = 120_000;

const endpoint = () => workerEndpoint(WORKER_URL, DEV_WORKER_URL);

/* ── KV-backed DB (via Worker) ─────────────────────────────────────────
   All methods return promises. Reads are cached for this page load and
   invalidated on writes. Persistent data stays in the existing Worker KV. */

const _cache = { trips: null, prefs: null };

async function dbCall(op, extra = {}) {
    const res = await fetch(endpoint(), {
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

export const DB = {
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
    async completeTrip(id) {
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

/* ── Streaming helper (concierge chat) ────────────────────────────────── */
export async function streamConcierge(question, history, prefs, model, onChunk) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(endpoint(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'concierge', question, history, prefs, model }),
            signal: controller.signal
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        return await readEventStream(res, { onText: onChunk });
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error('Request timed out. Try a shorter question.');
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/* ── Non-streaming model call (itinerary generation) ──────────────────── */
export async function callWorkerJSON(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(endpoint(), {
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

