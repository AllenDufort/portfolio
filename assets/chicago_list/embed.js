// What gets embedded for a place, and the key its vector is stored under. Shared by
// embed.mjs (builds embeddings.json offline) and worker/worker.js (reads it), so the two
// can never disagree about the text — a changed note changes the key and the vector is redone.
export const EMBED_DIMS = 256;

const MAX_EMBED_CHARS = 500;
const squash = text => String(text || '').replace(/\s+/g, ' ').trim();

/* The words a visitor's mood might touch — name, type, neighborhood, sub-category and notes —
   not the address or phone. Accepts a sheet row or a catalog place. */
export function embedText(place) {
    const text = [place.name, place.type, place.neighborhood, place.description, place.notes ?? place.reviews]
        .map(squash).filter(Boolean).join('. ');
    return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS - 1).trimEnd() + '…' : text;
}

// FNV-1a: short, stable, and good enough to tell one place's text from another's.
export function textKey(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
}

export function normalize(vec) {
    const norm = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0)) || 1;
    return vec.map(x => x / norm);
}
