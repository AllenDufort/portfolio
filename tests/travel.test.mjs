import test from 'node:test';
import assert from 'node:assert/strict';

function setGlobal(t, key, value) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {configurable:true, writable:true, value});
    t.after(() => previous ? Object.defineProperty(globalThis,key,previous) : delete globalThis[key]);
}

test('Travel reads are cached and expense/completion writes invalidate trip data', async t => {
    setGlobal(t, 'location', {hostname:'localhost'});
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const body = JSON.parse(options.body);
        requests.push({url, ...body});
        return Response.json({ok:true, data: {current_trips:[],past_trips:[],trip_ideas:[]}});
    });
    const {DB} = await import('../assets/travel/travel-api.js?cache-test');
    await DB.trips();
    await DB.trips();
    assert.equal(requests.length, 1);
    const expense = {description:'Lunch', amount:25};
    await DB.addExpense('trip-1', expense);
    await DB.trips();
    await DB.completeTrip('trip-1');
    await DB.trips();
    assert.deepEqual(requests.map(request => request.op), ['get_trips','add_expense','get_trips','complete_trip','get_trips']);
    assert.equal(requests[1].trip_id, 'trip-1');
    assert.deepEqual(requests[1].expense, expense);
    assert.ok(requests.every(request => request.url === 'http://127.0.0.1:8788' && request.type === 'db'));
});

test('Travel concierge keeps the chosen model, conversation and preferences in its request', async t => {
    setGlobal(t, 'location', {hostname:'allendufort.github.io'});
    let sent;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        sent = {url, ...JSON.parse(options.body)};
        return new Response('data: {"delta":"Visit the museum."}\n\ndata: [DONE]\n\n');
    });
    const {streamConcierge} = await import('../assets/travel/travel-api.js?request-test');
    const history = [{role:'user',content:'I like art.'}];
    const prefs = {interests:['art'],dietary:[],pace:'relaxed'};
    assert.equal(await streamConcierge('What next?',history,prefs,'claude-haiku-5-5',() => {}), 'Visit the museum.');
    assert.equal(sent.url, 'https://travel-planner.chicagochat.workers.dev');
    assert.deepEqual({...sent,url:undefined}, {url:undefined,type:'concierge',question:'What next?',history,prefs,model:'claude-haiku-5-5'});
});

test('PDF export keeps the selected panel, destination heading and print styles', async t => {
    setGlobal(t, 'location', {hostname:'localhost'});
    t.mock.method(globalThis, 'fetch', async () => Response.json({ok:true,data:{
        current_trips:[{id:'trip-1',destination:{city:'Rome',country:'Italy'}}],past_trips:[],trip_ideas:[]
    }}));
    const panel = {innerHTML:'<p>Morning at the Colosseum.</p>'};
    setGlobal(t, 'document', {getElementById:id => id === 'tab-itinerary' ? panel : null});
    let printed = '';
    let closed = false;
    const printWindow = {document:{write:html => {printed = html;},close:() => {closed = true;}}};
    setGlobal(t, 'window', {open:() => printWindow});
    t.mock.method(globalThis, 'setTimeout', () => 0);
    const {exportSection} = await import('../assets/travel/travel-export.js');
    await exportSection('itinerary','trip-1');
    assert.match(printed, /<h1>Day-by-Day Itinerary — Rome, Italy<\/h1>/);
    assert.ok(printed.includes(panel.innerHTML));
    assert.match(printed, /@media print/);
    assert.equal(closed, true);
    assert.equal(typeof printWindow.onload, 'function');
});
