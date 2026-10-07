/**
 * Chicago Map — Google Apps Script
 *
 * Two jobs live here:
 *
 *  1. MENU: "Chicago Map → Geocode missing rows / Re-geocode selected rows"
 *     Uses Maps.newGeocoder() (free, no API key) to fill the Lat/Lon columns.
 *     Works the same as before — run it after adding a row to give it a pin.
 *
 *  2. WEB APP: doGet(e) — called by chicagoData.js on every page load.
 *     Checks every row for empty cells in the enrichment columns, fills them
 *     from free public sources (Nominatim/OSM for coords + richer details),
 *     then returns a JSON summary.  The page fires this as a fire-and-forget
 *     request so it never blocks rendering.
 *
 * Install:
 *   1. Open the sheet → Extensions → Apps Script.
 *   2. Paste this file over Code.gs and Save.
 *   3. Reload the sheet.  A "Chicago Map" menu appears next to Help.
 *   4. Chicago Map → Geocode missing rows.  Approve the permission prompt on
 *      first run (it needs this spreadsheet and Google's geocoder).
 *
 * Deploy as a Web App (needed for the page-load enrichment):
 *   1. In the Apps Script editor: Deploy → New deployment.
 *   2. Type: Web app.
 *   3. Execute as: Me.
 *   4. Who has access: Anyone.
 *   5. Copy the /exec URL.
 *   6. Set ENRICH_URL at the top of chicagoData.js to that URL.
 *
 * After the first deploy, re-deploying ("Manage deployments → Edit → New
 * version") picks up any changes to this file.  The /exec URL never changes.
 *
 * Free-tier notes:
 *   • Maps.newGeocoder() is free up to 1 000 calls/day (consumer) / 10 000 (Workspace).
 *   • Nominatim (openstreetmap.org) is free; usage policy requires ≤1 req/sec and a
 *     descriptive User-Agent — both enforced below.
 *   • No Google Places API key or billing account is required.
 */

var SHEET_NAME  = '';       // '' = active sheet
var BATCH_LIMIT = 400;      // max geocode calls per manual run
var LAT_HEADER  = 'Lat';
var LON_HEADER  = 'Lon';
var ADDR_HEADER = 'Address';
var NAME_HEADER = 'Place';
var REGION      = 'us';

// Columns enriched by doGet from Nominatim place-details.
// Key = sheet header (matched case-insensitively).
// Value = Nominatim extratags / address / top-level key to read.
var ENRICH_FIELDS = {
  'Description':    'description',        // extratags.description
  'Phone':          'phone',              // extratags.phone  (or address["contact:phone"])
  'Website':        'website',            // extratags.website
  'RatingsAverage': null,                 // not available from OSM — left blank
  'RatingsTotal':   null,                 // not available from OSM — left blank
  'PlusCode':       null,                 // computed from lat/lon below
  'OriginalUrl':    'nominatim_url',      // synthetic: the Nominatim place page URL
};

// ── Menu ──────────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Chicago Map')
    .addItem('Geocode missing rows',     'geocodeMissingRows')
    .addItem('Re-geocode selected rows', 'geocodeSelectedRows')
    .addSeparator()
    .addItem('Enrich missing fields now','enrichMissingFieldsMenu')
    .addToUi();
}

// ── Manual geocoding (unchanged) ──────────────────────────────────────────────

function geocodeMissingRows()  { run(null); }

function geocodeSelectedRows() {
  var range = SpreadsheetApp.getActiveRange();
  if (!range) { SpreadsheetApp.getUi().alert('Select the rows to re-geocode first.'); return; }
  var rows = [];
  for (var r = range.getRow(); r < range.getRow() + range.getNumRows(); r++) rows.push(r);
  run(rows);
}

function run(onlyRows) {
  var sheet = getSheet_();
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return;

  var header = values[0].map(function(h){ return String(h).trim(); });
  var addrCol = indexOfHeader_(header, ADDR_HEADER);
  if (addrCol < 0) { SpreadsheetApp.getUi().alert('No "' + ADDR_HEADER + '" column found.'); return; }

  var latCol = indexOfHeader_(header, LAT_HEADER);
  var lonCol = indexOfHeader_(header, LON_HEADER);
  if (latCol < 0) { latCol = header.length; sheet.getRange(1, latCol + 1).setValue(LAT_HEADER); header.push(LAT_HEADER); }
  if (lonCol < 0) { lonCol = header.length; sheet.getRange(1, lonCol + 1).setValue(LON_HEADER); header.push(LON_HEADER); }

  var geocoder = Maps.newGeocoder().setRegion(REGION);
  var forced   = onlyRows ? toSet_(onlyRows) : null;
  var done = 0, skipped = 0, failed = [];

  for (var i = 1; i < values.length && done < BATCH_LIMIT; i++) {
    var sheetRow = i + 1;
    var address  = String(values[i][addrCol] || '').trim();
    if (!address) continue;

    var hasCoords = values[i][latCol] !== '' && values[i][lonCol] !== '';
    if (forced ? !forced[sheetRow] : hasCoords) { skipped++; continue; }

    var pt = geocodeMaps_(geocoder, address);
    if (pt) {
      sheet.getRange(sheetRow, latCol + 1, 1, 2).setValues([[pt.lat, pt.lon]]);
      done++;
    } else {
      failed.push(sheetRow + ': ' + address);
    }
  }

  SpreadsheetApp.getActive().toast(
    'Geocoded ' + done + ' row(s). ' + skipped + ' already had coordinates. ' +
    failed.length + ' failed.', 'Chicago Map', 10);
  if (failed.length) Logger.log('Could not geocode:\n' + failed.join('\n'));
  if (done === BATCH_LIMIT) SpreadsheetApp.getUi().alert('Stopped at the ' + BATCH_LIMIT + '-row batch limit. Run it again to continue.');
}

/** Menu shortcut so the user can trigger enrichment manually too. */
function enrichMissingFieldsMenu() {
  var result = enrichMissingFields_();
  SpreadsheetApp.getActive().toast(
    'Enriched ' + result.enriched + ' row(s). ' + result.skipped + ' already complete. ' +
    result.failed + ' failed.', 'Chicago Map', 10);
}

// ── Web App entry point ───────────────────────────────────────────────────────

/**
 * Called by chicagoData.js on every page load via a fire-and-forget fetch.
 * Runs enrichment and returns a JSON summary so the caller can log progress.
 * Returns early (empty result) when everything is already complete — the
 * response arrives in milliseconds and the page never blocks on it.
 */
function doGet(e) {
  var result = enrichMissingFields_();
  var output = ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ── Core enrichment logic ─────────────────────────────────────────────────────

/**
 * For every row that is missing at least one enrichment column, look the place
 * up via Nominatim (free OpenStreetMap API) and fill in whatever is still blank.
 * Also fills Lat/Lon via Maps.newGeocoder() when they are empty.
 * Never overwrites a cell that already has a value.
 *
 * @return {{ enriched: number, skipped: number, failed: number }}
 */
function enrichMissingFields_() {
  var sheet  = getSheet_();
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return { enriched: 0, skipped: 0, failed: 0 };

  var header  = values[0].map(function(h){ return String(h).trim(); });
  var nameCol = indexOfHeader_(header, NAME_HEADER);
  if (nameCol < 0) nameCol = indexOfHeader_(header, 'Name');
  if (nameCol < 0) return { enriched: 0, skipped: 0, failed: 0, error: 'no Place column' };

  var addrCol = indexOfHeader_(header, ADDR_HEADER);
  var latCol  = indexOfHeader_(header, LAT_HEADER);
  var lonCol  = indexOfHeader_(header, LON_HEADER);

  // Ensure all enrichment columns exist; append any that are missing.
  var fieldCols = {};
  for (var fn in ENRICH_FIELDS) {
    fieldCols[fn] = indexOfHeader_(header, fn);
    if (fieldCols[fn] < 0) {
      fieldCols[fn] = header.length;
      sheet.getRange(1, fieldCols[fn] + 1).setValue(fn);
      header.push(fn);
    }
  }
  if (latCol < 0) { latCol = header.length; sheet.getRange(1, latCol + 1).setValue(LAT_HEADER); header.push(LAT_HEADER); }
  if (lonCol < 0) { lonCol = header.length; sheet.getRange(1, lonCol + 1).setValue(LON_HEADER); header.push(LON_HEADER); }

  var geocoder = Maps.newGeocoder().setRegion(REGION);
  var enriched = 0, skipped = 0, failed = 0;

  for (var i = 1; i < values.length; i++) {
    var row       = values[i];
    var placeName = String(row[nameCol] || '').trim();
    if (!placeName) continue;

    // Check whether anything is missing.
    var missingFields = [];
    for (var f in fieldCols) {
      var ci = fieldCols[f];
      if (isEmpty_(row[ci])) missingFields.push(f);
    }
    var needsCoords = isEmpty_(row[latCol]) || isEmpty_(row[lonCol]);
    if (!missingFields.length && !needsCoords) { skipped++; continue; }

    var address = addrCol >= 0 ? String(row[addrCol] || '').trim() : '';
    var writes  = [];   // [[colIndex, value], ...]

    // ── Lat / Lon via Maps.newGeocoder (free) ──
    var lat = isEmpty_(row[latCol]) ? null : row[latCol];
    var lon = isEmpty_(row[lonCol]) ? null : row[lonCol];
    if (needsCoords) {
      var pt = geocodeMaps_(geocoder, address || placeName + ', Chicago, IL');
      if (pt) {
        lat = pt.lat;
        lon = pt.lon;
        writes.push([latCol, lat]);
        writes.push([lonCol, lon]);
      }
    }

    // ── Richer fields via Nominatim (free, OSM) ──
    if (missingFields.length) {
      var query = placeName + (address ? ', ' + address : ', Chicago, IL');
      var nom   = nominatimSearch_(query);
      if (nom) {
        var extratags = nom.extratags || {};
        var tags      = nom.tags      || {};   // some results use top-level "tags"
        var allTags   = mergeObjects_(extratags, tags);

        for (var fi = 0; fi < missingFields.length; fi++) {
          var fieldName = missingFields[fi];
          var col       = fieldCols[fieldName];
          var osmKey    = ENRICH_FIELDS[fieldName];
          if (!osmKey) continue;   // null = not available from OSM (ratings etc.)

          var val = null;
          if (osmKey === 'nominatim_url') {
            // Construct the OpenStreetMap place URL as the "original URL".
            var osmType = nom.osm_type;  // 'node', 'way', 'relation'
            var osmId   = nom.osm_id;
            if (osmType && osmId) {
              val = 'https://www.openstreetmap.org/' + osmType + '/' + osmId;
            }
          } else if (osmKey === 'description') {
            val = allTags['description'] || allTags['note'] || null;
          } else if (osmKey === 'phone') {
            val = allTags['phone'] || allTags['contact:phone'] || allTags['telephone'] || null;
          } else if (osmKey === 'website') {
            val = allTags['website'] || allTags['contact:website'] || allTags['url'] || null;
          } else {
            val = allTags[osmKey] || null;
          }

          if (val && !isEmpty_(val)) writes.push([col, val]);
        }

        // PlusCode: derive from lat/lon if we have them (Open Location Code algorithm).
        var pcCol = fieldCols['PlusCode'];
        if (pcCol !== undefined && isEmpty_(row[pcCol])) {
          var resLat = lat !== null ? lat : (nom.lat ? parseFloat(nom.lat) : null);
          var resLon = lon !== null ? lon : (nom.lon ? parseFloat(nom.lon) : null);
          if (resLat !== null && resLon !== null) {
            var plusCode = encodePlusCode_(resLat, resLon);
            if (plusCode) writes.push([pcCol, plusCode]);
          }
        }

        // Fill Lat/Lon from Nominatim if Maps.newGeocoder didn't resolve them.
        if (isEmpty_(row[latCol]) && nom.lat && isEmpty_(writes, latCol)) {
          var nLat = parseFloat(nom.lat);
          var nLon = parseFloat(nom.lon);
          if (!isNaN(nLat) && !isNaN(nLon)) {
            writes.push([latCol, nLat]);
            writes.push([lonCol, nLon]);
          }
        }

        Utilities.sleep(1100);   // Nominatim policy: ≤1 request/second
      }
    }

    // Write all resolved values for this row.
    for (var w = 0; w < writes.length; w++) {
      sheet.getRange(i + 1, writes[w][0] + 1).setValue(writes[w][1]);
    }
    if (writes.length > 0) enriched++;
    else failed++;
  }

  Logger.log('enrichMissingFields_: enriched=' + enriched + ' skipped=' + skipped + ' failed=' + failed);
  return { enriched: enriched, skipped: skipped, failed: failed };
}

// ── Geocoding helpers ─────────────────────────────────────────────────────────

function geocodeMaps_(geocoder, address) {
  try {
    var res = geocoder.geocode(address);
    if (res.status !== 'OK' || !res.results || !res.results.length) return null;
    var loc = res.results[0].geometry.location;
    return { lat: loc.lat, lon: loc.lng };
  } catch (e) {
    Logger.log('geocodeMaps_ error for "' + address + '": ' + e);
    return null;
  }
}

/**
 * Nominatim place search.
 * Returns the first result object (with extratags), or null.
 * https://nominatim.org/release-docs/latest/api/Search/
 */
function nominatimSearch_(query) {
  var params = {
    q:            query,
    format:       'json',
    limit:        '1',
    extratags:    '1',
    addressdetails: '1',
    countrycodes: 'us',
  };
  var qs  = Object.keys(params).map(function(k){ return k + '=' + encodeURIComponent(params[k]); }).join('&');
  var url = 'https://nominatim.openstreetmap.org/search?' + qs;
  var options = {
    method:    'get',
    headers:   { 'User-Agent': 'chicago-todo-map/2.0 (portfolio demo)' },
    muteHttpExceptions: true,
  };
  try {
    var resp = UrlFetchApp.fetch(url, options);
    if (resp.getResponseCode() !== 200) {
      Logger.log('Nominatim HTTP ' + resp.getResponseCode() + ' for: ' + query);
      return null;
    }
    var data = JSON.parse(resp.getContentText());
    return (data && data.length) ? data[0] : null;
  } catch (e) {
    Logger.log('nominatimSearch_ error: ' + e);
    return null;
  }
}

// ── Plus Code encoder ─────────────────────────────────────────────────────────

/**
 * Encodes a lat/lon pair to a full 10-digit Open Location Code (Plus Code).
 * Implements the OLC spec: https://github.com/google/open-location-code/blob/main/docs/olc_definition.adoc
 * Pure Apps Script — no external API call, no key.
 */
function encodePlusCode_(lat, lon) {
  var ALPHABET = '23456789CFGHJMPQRVWX';

  // Shift to positive ranges and clamp.
  var la  = Math.min(180, lat + 90);
  var lo  = (lon + 180) % 360;

  var digits  = '';
  var divisor = 20;   // each pair shrinks the cell by 1/20 in both axes

  for (var i = 0; i < 5; i++) {
    var ld  = Math.floor(la  / divisor);
    var lod = Math.floor(lo  / divisor);
    la     -= ld  * divisor;
    lo     -= lod * divisor;
    digits += ALPHABET[ld] + ALPHABET[lod];
    divisor /= 20;
  }

  // OLC format: XXXXXXXX+XX
  return digits.slice(0, 8) + '+' + digits.slice(8);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function getSheet_() {
  return SHEET_NAME
    ? SpreadsheetApp.getActive().getSheetByName(SHEET_NAME)
    : SpreadsheetApp.getActiveSheet();
}

function indexOfHeader_(header, name) {
  var w = name.toLowerCase();
  for (var i = 0; i < header.length; i++) {
    if (String(header[i]).trim().toLowerCase() === w) return i;
  }
  return -1;
}

function isEmpty_(v) {
  return v === '' || v === null || v === undefined;
}

/** Check whether a pending writes array already has an entry for colIndex. */
function writesHas_(writes, colIndex) {
  for (var i = 0; i < writes.length; i++) if (writes[i][0] === colIndex) return true;
  return false;
}

function mergeObjects_(a, b) {
  var out = {};
  for (var k in a) out[k] = a[k];
  for (var k in b) if (!(k in out)) out[k] = b[k];
  return out;
}

function toSet_(list) {
  var s = {};
  for (var i = 0; i < list.length; i++) s[list[i]] = true;
  return s;
}
