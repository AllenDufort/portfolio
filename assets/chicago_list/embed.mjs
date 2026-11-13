#!/usr/bin/env node
/* Builds embeddings.json: one vector per place, for the Worker's semantic search.

     node assets/chicago_list/embed.mjs            # embed whatever is new or changed
     node assets/chicago_list/embed.mjs --force    # redo everything

   Reads GEMINI_API_KEY from the environment or the repo-root .env. Gemini's free tier rate-limits
   embeddings (~100/min), so a full build takes several minutes — which is why this runs offline
   and the result is committed, like geocode_cache.json, rather than being built per request.
   Re-runs only embed rows whose text changed, so it is cheap to repeat after editing the sheet. */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SHEET_URL, readSheetRows } from './sheet.js';
import { EMBED_DIMS, embedText, textKey, normalize } from './embed.js';

const here  = path.dirname(fileURLToPath(import.meta.url));
const OUT   = path.join(here, 'embeddings.json');
const MODEL = process.env.EMBED_MODEL || 'gemini-embedding-001';
const BATCH = 50;

let apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    try {
        apiKey = (await readFile(path.join(here, '../../.env'), 'utf8')).match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim();
    } catch { /* handled below */ }
}
if (!apiKey) { console.error('GEMINI_API_KEY is not set (environment or repo-root .env).'); process.exit(1); }

async function placeRows() {
    try {
        const res = await fetch(SHEET_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return readSheetRows(await res.text());
    } catch (err) {
        console.warn(`sheet unavailable (${err.message}); using chicago_layers.geojson`);
        const fc = JSON.parse(await readFile(path.join(here, 'chicago_layers.geojson'), 'utf8'));
        return fc.features.map(f => ({ ...f.properties, reviews: f.properties.reviews || f.properties.notes }));
    }
}

async function embed(texts) {
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents?key=${apiKey}`,
            {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requests: texts.map(text => ({
                    model: `models/${MODEL}`, content: { parts: [{ text }] },
                    taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: EMBED_DIMS
                })) })
            });
        if (res.status === 429 && attempt <= 8) {
            console.log(`  rate limited; waiting 30s (attempt ${attempt})`);
            await new Promise(r => setTimeout(r, 30000));
            continue;
        }
        if (!res.ok) throw new Error(`embedding HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return (await res.json()).embeddings.map(e => normalize(e.values));
    }
}

let existing = {};
if (!process.argv.includes('--force')) {
    try {
        const prior = JSON.parse(await readFile(OUT, 'utf8'));
        if (prior.model === MODEL && prior.dims === EMBED_DIMS) existing = prior.vectors;
    } catch { /* first run */ }
}

const texts = new Map();          // key -> text, deduplicated (the same place can be in the sheet twice)
(await placeRows()).forEach(row => { const t = embedText(row); texts.set(textKey(t), t); });

const vectors = {};
const todo = [];
for (const [key, text] of texts) (existing[key] ? (vectors[key] = existing[key]) : todo.push([key, text]));
console.log(`${texts.size} places, ${texts.size - todo.length} unchanged, ${todo.length} to embed`);

for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const out = await embed(batch.map(([, text]) => text));
    batch.forEach(([key], j) => { vectors[key] = out[j].map(x => +x.toFixed(4)); });
    console.log(`  embedded ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
    await writeFile(OUT, JSON.stringify({ model: MODEL, dims: EMBED_DIMS, vectors }) + '\n');   // resumable
}

await writeFile(OUT, JSON.stringify({ model: MODEL, dims: EMBED_DIMS, vectors }) + '\n');
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
