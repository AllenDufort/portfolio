// Sheet schema and CSV parsing used by the browser and the Chicago Worker.
const SHEET_ID  = '18rG-azfyKrziKuDm3WBHD2UyMeeD5T8BMugFG7j5fw4';
const SHEET_GID = '2011978534';
export const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&gid=${SHEET_GID}`;
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
    lat:            ['lat', 'latitude'],
    lon:            ['lon', 'lng', 'long', 'longitude']
};

export function readSheetRows(csv) {
    const table = parseCsv(csv);
    const header = table.shift() || [];
    const at = columnIndex(header);
    if (at.name == null) throw new Error('no Place column in sheet');

    return table
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
            lon:            number(cell(row, at.lon)),
            lat:            number(cell(row, at.lat))
        }))
        .filter(row => row.name);
}

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

export function number(text) {
    if (!text) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
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

