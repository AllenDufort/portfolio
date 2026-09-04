/* ── Chicago place data — built from the Google Sheet on every page load ──
   The sheet is the source of truth: edit a name, note, type, or neighborhood there and
   it shows up on the next page load with no pipeline run and no commit. Google's gviz
   endpoint serves the sheet as CSV and echoes the requesting origin in
   Access-Control-Allow-Origin, so a static page can read it directly with no API key.

   Coordinates come from the sheet's own Lat/Lon columns, which the Apps Script in
   geocodeSheet.gs fills in. Rows that have no coordinates yet fall back to the
   committed geocode_cache.json (fetched only when it is actually needed), and anything
   still unresolved is kept without a marker rather than dropped — it stays searchable
   in the chat, and the map reports how many are waiting.

   If the sheet is unreachable, unshared, or empty, the committed chicago_layers.geojson
   is loaded instead, so the page always renders. Both consumers — chicagoMap.js and
   chicagoChat.js — share one memoised load(), so the data is fetched once per visit. */
(function () {
    'use strict';

    const SHEET_ID  = '18rG-azfyKrziKuDm3WBHD2UyMeeD5T8BMugFG7j5fw4';
    const SHEET_GID = '2011978534';
    const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
        `?tqx=out:csv&gid=${SHEET_GID}`;
    const FALLBACK_URL = 'assets/chicago_list/chicago_layers.geojson';
    const COORDS_URL   = 'assets/chicago_list/geocode_cache.json';
    const TIMEOUT_MS   = 8000;   // a slow sheet must not hold the map hostage

    // Sheet headers are matched by name, so columns can be reordered or added freely.
    const COLUMNS = {
        name:           ['place', 'name'],
        type:           ['type', 'category'],
        neighborhood:   ['neighborhood', 'neighbourhood', 'area'],
        reviews:        ['reviews', 'notes', 'review'],
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

    let pending = null;

    // One fetch per visit, shared by the map and the chat.
    function load() {
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
        const table = parseCsv(csv);
        const header = table.shift() || [];
        const at = columnIndex(header);
        if (at.name == null) throw new Error('no Place column in sheet');

        const rows = table
            .map(row => ({
                name:           cell(row, at.name),
                type:           cell(row, at.type),
                neighborhood:   cell(row, at.neighborhood),
                reviews:        cell(row, at.reviews),
                description:    cell(row, at.description),
                address:        cell(row, at.address),
                phone:          cell(row, at.phone),
                website:        cell(row, at.website),
                ratingsAverage: number(cell(row, at.ratingsAverage)),
                ratingsTotal:   number(cell(row, at.ratingsTotal)),
                googleUrl:      cell(row, at.googleUrl),
                originalUrl:    cell(row, at.originalUrl),
                lon:            number(cell(row, at.lon)),
                lat:            number(cell(row, at.lat))
            }))
            .filter(row => row.name);

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

    /* A row without coordinates gets a null geometry rather than being dropped —
       the map skips it, the chat still finds it. All sheet columns are preserved so
       the chat worker can answer questions about ratings, websites, phone numbers, etc. */
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
                ratingsTotal:   row.ratingsTotal,
                googleUrl:      row.googleUrl,
                originalUrl:    row.originalUrl
            }
        };
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

    /* A real CSV scan rather than a line split: some Reviews cells contain newlines and
       escaped quotes, so splitting on "\n" would shear rows apart. */
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

    window.ChicagoData = { load, SHEET_URL };
})();
