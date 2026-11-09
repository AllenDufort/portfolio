import { SHEET_URL, readSheetRows } from './sheet.js';

/* ── Chicago place data — built from the Google Sheet on every page load ──
   The sheet is the source of truth: edit a name, note, type, or neighborhood there and it
   shows up on the next page load, no pipeline run and no commit. Google's gviz endpoint
   serves it as CSV and echoes the requesting origin in Access-Control-Allow-Origin, so a
   static page can read it directly with no API key.

   Coordinates come from the sheet's own Lat/Lon columns, which geocodeSheet.gs fills in;
   rows still missing them fall back to the committed geocode_cache.json. Anything
   unresolved is kept without a marker rather than dropped — it stays searchable in the
   chat, and the map reports how many are waiting. If the sheet is unreachable, unshared,
   or empty, the committed chicago_layers.geojson loads instead, so the page always
   renders. chicagoMap.js imports the memoised load(); the assistant reads through its Worker. */

const FALLBACK_URL = 'assets/chicago_list/chicago_layers.geojson';
const COORDS_URL   = 'assets/chicago_list/geocode_cache.json';
const TIMEOUT_MS   = 8000;   // a slow sheet must not hold the map hostage

let pending = null;

export function load() {
    if (!pending) pending = build();
    return pending;
}

async function build() {
    try {
        const csv = await fetchText(SHEET_URL);
        const result = await fromSheet(csv);
        if (!result.meta.rows) throw new Error('sheet has no usable rows');
        return result;
    } catch (err) {
        return fromFallback(err);
    }
}

/* ── Sheet -> features ───────────────────────────────────────────────── */

async function fromSheet(csv) {
    const rows = readSheetRows(csv);

    // Only pay for the coordinate cache when the sheet has not been geocoded yet.
    const needCoords = rows.some(row => row.lon == null || row.lat == null);
    const coords = needCoords ? await loadCoords() : {};
    rows.forEach(row => {
        if (row.lon != null && row.lat != null) return;
        const hit = row.address && coords[row.address];
        if (hit && hit.length === 2) { row.lon = hit[0]; row.lat = hit[1]; }
    });

    const features = [];
    const meta = {
        source: 'sheet', rows: rows.length, placed: 0, unplaced: [],
        types: {}, coordsFrom: needCoords ? 'cache' : 'sheet'
    };

    rows.forEach(row => {
        const feature = toFeature(row);
        if (feature.geometry) meta.placed++;
        else meta.unplaced.push(row.name);
        if (row.type) meta.types[row.type] = (meta.types[row.type] || 0) + 1;
        features.push(feature);
    });

    return { features, meta };
}

/* A row without coordinates gets a null geometry rather than being dropped — the map
   skips it, the chat still finds it. Every sheet column is preserved so the worker can
   answer about ratings, websites, phone numbers. */
function toFeature(row) {
    return {
        type: 'Feature',
        geometry: row.lon != null && row.lat != null
            ? { type: 'Point', coordinates: [row.lon, row.lat] }
            : null,
        properties: {
            name:           row.name,
            address:        row.address,
            reviews:        row.reviews,
            description:    row.description,
            type:           row.type,
            neighborhood:   row.neighborhood,
            phone:          row.phone,
            website:        row.website,
            ratingsAverage: row.ratingsAverage,
            ratingsTotal:   row.ratingsTotal
        }
    };
}

async function loadCoords() {
    try {
        return JSON.parse(await fetchText(COORDS_URL)) || {};
    } catch (err) {
        return {};
    }
}

/* ── Committed GeoJSON fallback ──────────────────────────────────────── */

async function fromFallback(reason) {
    const message = reason && reason.message ? reason.message : String(reason);
    console.warn('Chicago map: falling back to the committed GeoJSON —', message);
    const fc = JSON.parse(await fetchText(FALLBACK_URL));
    const features = fc.features || [];
    const meta = {
        source: 'geojson', reason: message, rows: features.length,
        placed: features.filter(f => f.geometry).length, unplaced: [],
        types: {}, coordsFrom: 'geojson'
    };
    features.forEach(f => {
        const type = (f.properties || {}).type;
        if (type) meta.types[type] = (meta.types[type] || 0) + 1;
    });
    return { features, meta };
}

/* ── Plumbing ────────────────────────────────────────────────────────── */

async function fetchText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}
