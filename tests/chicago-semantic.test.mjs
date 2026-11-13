import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../assets/chicago_list/worker/worker.js';
import { embedText, textKey } from '../assets/chicago_list/embed.js';

const CSV = 'Place,Type,Neighborhood,Reviews,Address,Description\n' +
    'Loud Club,Club,Loop,thumping bass,1 A St,Night club\n' +
    'Lamp Lounge,Bar,Wicker Park,candlelit and cozy,2 B St,Cocktail bar\n' +
    'Sun Beach,Beach,Uptown,sand,3 C St,Beach\n';

// A toy embedding space: axis 0 is "cozy", axis 1 is "loud".
const toy = text => /cozy|candlelit/i.test(text) ? [1, 0.1] : /loud|thump/i.test(text) ? [0.1, 1] : [0.2, 0.2];

function mockUpstream(t, { onEmbed } = {}) {
    let groqCalls = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        url = String(url);
        if (url.includes('docs.google.com')) return new Response(CSV);
        if (url.includes('geocode_cache')) return Response.json({});
        if (url.includes('batchEmbedContents')) {
            const { requests } = JSON.parse(init.body);
            onEmbed?.(requests);
            return Response.json({ embeddings: requests.map(r => ({ values: toy(r.content.parts[0].text) })) });
        }
        if (url.includes('groq.com')) {
            groqCalls++;
            const message = groqCalls === 1
                ? { content: null, tool_calls: [{ id: 'c1', function: { name: 'search_places',
                    arguments: JSON.stringify({ vibe: 'somewhere cozy', limit: 2 }) } }] }
                : { content: 'Lamp Lounge.' };
            return Response.json({ choices: [{ message }] });
        }
        throw new Error(`unexpected fetch ${url}`);
    });
}

const ask = (env, extra = {}) => worker.fetch(new Request('http://w/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8000' },
    body: JSON.stringify({ question: 'somewhere cozy', model: 'openai/gpt-oss-120b', trace: true, ...extra })
}), { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k', ALLOWED_ORIGINS: 'http://localhost:8000', RATE_LIMIT_MAX: '999', ...env });

async function traceOf(res) {
    const text = await res.text();
    const frame = text.split('\n\n').map(b => b.replace(/^data: /, '')).find(b => b.startsWith('{"trace"'));
    return JSON.parse(frame).trace;
}

test('vibe search ranks by embedding similarity and embeds rows missing from embeddings.json live', async t => {
    const embedded = [];
    mockUpstream(t, { onEmbed: reqs => embedded.push(...reqs.map(r => r.taskType)) });

    const trace = await traceOf(await ask({}));
    assert.equal(trace[0].tool, 'search_places');
    assert.equal(trace[0].places[0], 'Lamp Lounge');          // nearest the "cozy" axis
    assert.ok(embedded.includes('RETRIEVAL_QUERY'));
    assert.equal(embedded.filter(x => x === 'RETRIEVAL_DOCUMENT').length, 3);   // no stored vectors yet
});

test('stored vectors are used as-is, so only the question is embedded', async t => {
    const embedded = [];
    mockUpstream(t, { onEmbed: reqs => embedded.push(...reqs.map(r => r.taskType)) });

    const place = { name: 'Lamp Lounge', type: 'Bar', neighborhood: 'Wicker Park', description: 'Cocktail bar', notes: 'candlelit and cozy' };
    const stored = { model: 'gemini-embedding-001', dims: 256, vectors: {
        [textKey(embedText(place))]: [1, 0.1],
        [textKey(embedText({ name: 'Loud Club', type: 'Club', neighborhood: 'Loop', description: 'Night club', notes: 'thumping bass' }))]: [0.1, 1],
        [textKey(embedText({ name: 'Sun Beach', type: 'Beach', neighborhood: 'Uptown', description: 'Beach', notes: 'sand' }))]: [0.2, 0.2]
    } };

    const trace = await traceOf(await ask({ EMBEDDINGS_JSON: JSON.stringify(stored) }));
    assert.equal(trace[0].places[0], 'Lamp Lounge');
    assert.deepEqual(embedded, ['RETRIEVAL_QUERY']);
});

test('without a Gemini key the vibe search degrades to keywords instead of failing', async t => {
    mockUpstream(t);
    const res = await ask({ GEMINI_API_KEY: '' }, { model: 'openai/gpt-oss-120b' });
    assert.equal(res.status, 200);
    assert.equal((await traceOf(res))[0].tool, 'search_places');
});
