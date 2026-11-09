import test from 'node:test';
import assert from 'node:assert/strict';
import { readSheetRows } from '../assets/chicago_list/sheet.js';

test('sheet columns may be reordered and use aliases; quoted notes preserve commas, quotes and newlines', () => {
    const rows = readSheetRows('Longitude,Notes,Name,Latitude,Rating,Category\r\n-87.63,"Tea, \"\"coffee\"\"\nand cake",Cafe,41.88,4.6,Cafe\r\n');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reviews, 'Tea, "coffee"\nand cake');
    assert.equal(rows[0].name, 'Cafe');
    assert.equal(rows[0].type, 'Cafe');
    assert.equal(rows[0].lat, 41.88);
    assert.equal(rows[0].lon, -87.63);
    assert.equal(rows[0].ratingsAverage, 4.6);
});

test('missing fields and invalid numbers are retained without inventing coordinates', () => {
    const rows = readSheetRows('Place,Lat,Lon,Reviews\nCafe,unknown,,Hello\n,,,skip empty name');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lat, null);
    assert.equal(rows[0].lon, null);
    assert.equal(rows[0].address, '');
    assert.throws(() => readSheetRows('Type,Address\nCafe,Main St'), /no Place column/);
});

test('the map reuses one load, fills missing coordinates from cache and retains unmapped places', async t => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async url => {
        requests.push(url);
        if (url.includes('docs.google.com')) return new Response('Place,Address,Type,Lat,Lon\nCafe,Main St,Cafe,,\nPark,Park Ave,Park,41.9,-87.6\nUnmapped,,Cafe,,');
        return Response.json({'Main St':[-87.63,41.88]});
    });
    const {load} = await import('../assets/chicago_list/chicagoData.js?cached-load');
    assert.equal(load(), load());
    const {features, meta} = await load();
    assert.equal(requests.length, 2);
    assert.equal(meta.rows, 3);
    assert.equal(meta.placed, 2);
    assert.deepEqual(meta.unplaced, ['Unmapped']);
    assert.deepEqual(meta.types, {Cafe:2, Park:1});
    assert.deepEqual(features[0].geometry.coordinates, [-87.63,41.88]);
    assert.deepEqual(features[1].geometry.coordinates, [-87.6,41.9]);
    assert.equal(features[2].geometry, null);
});

test('an unavailable sheet falls back to the saved GeoJSON with its type filters', async t => {
    const fallback = {features:[{geometry:{type:'Point',coordinates:[-87.63,41.88]},properties:{name:'Saved cafe',type:'Cafe'}}]};
    t.mock.method(console, 'warn', () => {});
    t.mock.method(globalThis, 'fetch', async url => {
        if (url.includes('docs.google.com')) throw new Error('Sheet unavailable');
        return Response.json(fallback);
    });
    const {load} = await import('../assets/chicago_list/chicagoData.js?offline-load');
    const {features,meta} = await load();
    assert.deepEqual(features, fallback.features);
    assert.equal(meta.source, 'geojson');
    assert.deepEqual(meta.types, {Cafe:1});
});
