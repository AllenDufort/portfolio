#!/usr/bin/env node
/* Evaluation harness for the Chicago assistant.

   Each case in cases.json is a question plus what a good run looks like: the tools the model
   should call, the places the answer should name (or a pool to draw `min` from), places it must
   not name, and regexes the text must match. Every allowlisted model is scored on tool choice and
   answer accuracy. Re-run after any prompt, tool-schema or sheet change and diff against a saved
   baseline.

     node assets/chicago_list/eval/run.mjs                        # all models, in-process
     node ... --model openai/gpt-oss-120b --model claude-haiku-5-5
     node ... --case vibe-rainy --case kw-jazz                    # subset
     node ... --url http://127.0.0.1:8787                         # a running wrangler dev / deployed Worker
     node ... --save eval/baseline.json                           # write results
     node ... --baseline eval/baseline.json                       # print regressions vs a saved run

   In-process mode imports the Worker and reads keys from worker/.dev.vars (or the environment),
   so no server is needed. It sets RATE_LIMIT_MAX high; the production limit is not exercised. */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ALLOWED_MODELS } from '../../shared/models.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : null;
const all  = name => args.flatMap((a, i) => a === `--${name}` ? [args[i + 1]] : []);

const url       = flag('url');
const models    = all('model').length ? all('model') : ALLOWED_MODELS;
const onlyCases = all('case');
const savePath  = flag('save');
const basePath  = flag('baseline');
const PASS_RECALL = 1;     // fraction of required places that must appear

const cases = JSON.parse(await readFile(path.join(here, 'cases.json'), 'utf8'))
    .filter(c => !onlyCases.length || onlyCases.includes(c.id));

/* ── Calling the Worker ───────────────────────────────────────────────────── */

let worker, env;
if (!url) {
    worker = (await import('../worker/worker.js')).default;
    env = { ALLOWED_ORIGINS: 'http://localhost:8000', RATE_LIMIT_MAX: '100000', ...process.env };
    // Local vectors, so the eval scores this checkout rather than whatever is deployed.
    env.EMBEDDINGS_JSON = await readFile(path.join(here, '../embeddings.json'), 'utf8');
    try {
        for (const line of (await readFile(path.join(here, '../worker/.dev.vars'), 'utf8')).split('\n')) {
            const m = line.match(/^([A-Z_]+)=(.*)$/);
            if (m && !env[m[1]]) env[m[1]] = m[2].trim();
        }
    } catch { /* keys may come from the environment instead */ }
}

async function ask(c, model) {
    const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8000' },
        body: JSON.stringify({ question: c.question, history: c.history, coords: c.coords, model, trace: true })
    };
    const res = url ? await fetch(url, init) : await worker.fetch(new Request('http://worker.test/', init), env);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);

    let answer = '', trace = [], error = '';
    for (const block of (await res.text()).split(/\n\n/)) {
        const line = block.split('\n').find(l => l.startsWith('data:'));
        if (!line || line.includes('[DONE]')) continue;
        const frame = JSON.parse(line.slice(5));
        if (frame.delta) answer += frame.delta;
        if (frame.trace) trace = frame.trace;
        if (frame.error) error = frame.error;
    }
    if (error) throw new Error(error);
    return { answer, trace };
}

/* Provider rate limits (Groq's tokens-per-minute especially) are about the eval's pace, not the
   assistant's quality, so a 429 is waited out rather than scored as a failure. */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function askPatiently(c, model) {
    for (let attempt = 1; ; attempt++) {
        try { return await ask(c, model); }
        catch (err) {
            if (attempt >= 4 || !/too many requests|rate limit|HTTP 429/i.test(err.message)) throw err;
            await sleep(20000);
        }
    }
}

/* ── Scoring ──────────────────────────────────────────────────────────────── */

const norm = s => String(s).toLowerCase().replace(/[’‘]/g, "'");
const names = (answer, list) => list.filter(p => norm(answer).includes(norm(p)));

function score(c, { answer, trace }) {
    const called = trace.map(t => t.tool);
    const toolOk = (c.tools || []).every(t => called.includes(t));
    const vibeOk = !c.vibe || trace.some(t => t.tool === 'search_places' && String(t.args.vibe || '').trim());

    const required  = c.places || [];
    const pool      = c.anyOf  || [];
    const min       = c.min || (pool.length ? 1 : 0);
    const gotReq    = names(answer, required).length;
    const gotPool   = names(answer, pool).length;
    const recall    = required.length ? gotReq / required.length : 1;
    const poolOk    = gotPool >= min;
    const forbidden = names(answer, c.forbid || []);
    const regexOk   = (c.answerHas || []).every(re => new RegExp(re, 'i').test(answer));

    const accurate = recall >= PASS_RECALL && poolOk && !forbidden.length && regexOk;
    return {
        toolOk: toolOk && vibeOk, accurate, pass: toolOk && vibeOk && accurate,
        why: [
            !toolOk && `tools ${JSON.stringify(called)} missing ${(c.tools || []).filter(t => !called.includes(t))}`,
            !vibeOk && 'no vibe argument',
            recall < PASS_RECALL && `named ${gotReq}/${required.length} required`,
            !poolOk && `named ${gotPool}/${min} of pool`,
            forbidden.length && `named forbidden ${forbidden}`,
            !regexOk && 'answer text did not match'
        ].filter(Boolean).join('; ')
    };
}

/* ── Run ──────────────────────────────────────────────────────────────────── */

const results = {};
for (const model of models) {
    results[model] = {};
    console.log(`\n${model}`);
    for (const c of cases) {
        let r;
        try {
            r = { ...score(c, await askPatiently(c, model)) };
        } catch (err) {
            r = { toolOk: false, accurate: false, pass: false, why: `error: ${err.message}` };
        }
        results[model][c.id] = r;
        await sleep(1500);
        console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${c.id}${r.pass ? '' : `  — ${r.why}`}`);
    }
}

const pct = (n, d) => d ? `${Math.round(100 * n / d)}%` : '-';
console.log('\n' + 'model'.padEnd(28) + 'tool choice'.padEnd(14) + 'accuracy'.padEnd(12) + 'pass');
for (const model of models) {
    const rs = Object.values(results[model]);
    const n  = rs.length;
    console.log(model.padEnd(28) +
        pct(rs.filter(r => r.toolOk).length, n).padEnd(14) +
        pct(rs.filter(r => r.accurate).length, n).padEnd(12) +
        `${rs.filter(r => r.pass).length}/${n}`);
}

if (basePath) {
    const base = JSON.parse(await readFile(basePath, 'utf8'));
    console.log('\nvs baseline:');
    let changed = 0;
    for (const model of models) for (const c of cases) {
        const was = base[model]?.[c.id]?.pass, now = results[model][c.id].pass;
        if (was !== undefined && was !== now) {
            changed++;
            console.log(`  ${now ? 'FIXED     ' : 'REGRESSED '} ${model}  ${c.id}`);
        }
    }
    if (!changed) console.log('  no changes');
}

if (savePath) {
    await writeFile(savePath, JSON.stringify(results, null, 2) + '\n');
    console.log(`\nsaved ${savePath}`);
}
process.exit(Object.values(results).some(m => Object.values(m).some(r => !r.pass)) ? 1 : 0);
