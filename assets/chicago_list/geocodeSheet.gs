/**
 * Fills the Lat/Lon columns of the Chicago TODO sheet.
 *
 * The map page reads those columns directly, so once a row has coordinates the site
 * needs no geocoder, no cache, and no pipeline run — a sheet edit is live on the next
 * page load. This script is the one thing that turns an address into coordinates.
 *
 * Install:
 *   1. Open the sheet -> Extensions -> Apps Script.
 *   2. Paste this file over Code.gs and Save.
 *   3. Reload the sheet. A "Chicago Map" menu appears next to Help.
 *   4. Chicago Map -> Geocode missing rows. Approve the permission prompt on first run
 *      (it needs access to this spreadsheet and to Google's geocoder).
 *
 * It only ever touches rows whose Lat or Lon is empty, so re-running it is cheap and
 * safe: nothing already resolved is overwritten or re-billed against the quota.
 *
 * Quota: Maps geocoding is 1,000 calls/day on a consumer account and 10,000/day on
 * Workspace. BATCH_LIMIT keeps one run well inside that; run it again for more.
 */

var SHEET_NAME   = '';     // '' uses the active sheet
var BATCH_LIMIT  = 400;    // max geocode calls in a single run
var LAT_HEADER   = 'Lat';
var LON_HEADER   = 'Lon';
var ADDR_HEADER  = 'Address';
var REGION       = 'us';   // biases ambiguous addresses to the United States

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Chicago Map')
    .addItem('Geocode missing rows', 'geocodeMissingRows')
    .addItem('Re-geocode selected rows', 'geocodeSelectedRows')
    .addToUi();
}

/** Geocode every row that has an address but no coordinates. */
function geocodeMissingRows() {
  run(null);
}

/** Force a re-lookup of the currently selected rows, even if they already have coords. */
function geocodeSelectedRows() {
  var range = SpreadsheetApp.getActiveRange();
  if (!range) {
    SpreadsheetApp.getUi().alert('Select the rows to re-geocode first.');
    return;
  }
  var rows = [];
  for (var r = range.getRow(); r < range.getRow() + range.getNumRows(); r++) rows.push(r);
  run(rows);
}

/**
 * @param {Array<number>|null} onlyRows 1-based sheet rows to force, or null for
 *     "every row that is missing coordinates".
 */
function run(onlyRows) {
  var sheet = SHEET_NAME
    ? SpreadsheetApp.getActive().getSheetByName(SHEET_NAME)
    : SpreadsheetApp.getActiveSheet();
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return;

  var header = values[0].map(function (h) { return String(h).trim(); });
  var addrCol = indexOfHeader(header, ADDR_HEADER);
  if (addrCol < 0) {
    SpreadsheetApp.getUi().alert('No "' + ADDR_HEADER + '" column found.');
    return;
  }

  // Append Lat/Lon columns the first time this runs.
  var latCol = indexOfHeader(header, LAT_HEADER);
  var lonCol = indexOfHeader(header, LON_HEADER);
  if (latCol < 0) { latCol = header.length; sheet.getRange(1, latCol + 1).setValue(LAT_HEADER); header.push(LAT_HEADER); }
  if (lonCol < 0) { lonCol = header.length; sheet.getRange(1, lonCol + 1).setValue(LON_HEADER); header.push(LON_HEADER); }

  var geocoder = Maps.newGeocoder().setRegion(REGION);
  var forced = onlyRows ? toSet(onlyRows) : null;
  var done = 0;
  var failed = [];
  var skipped = 0;

  for (var i = 1; i < values.length && done < BATCH_LIMIT; i++) {
    var sheetRow = i + 1;
    var address = String(values[i][addrCol] || '').trim();
    if (!address) continue;

    var hasCoords = values[i][latCol] !== '' && values[i][lonCol] !== '';
    if (forced ? !forced[sheetRow] : hasCoords) { skipped++; continue; }

    var point = geocode(geocoder, address);
    if (point) {
      // One setValues per row: slower than a bulk write, but a run that times out
      // mid-way still leaves every row it resolved saved.
      sheet.getRange(sheetRow, latCol + 1, 1, 2).setValues([[point.lat, point.lon]]);
      done++;
    } else {
      failed.push(sheetRow + ': ' + address);
    }
  }

  SpreadsheetApp.getActive().toast(
    'Geocoded ' + done + ' row(s). ' + skipped + ' already had coordinates. ' +
    failed.length + ' failed.', 'Chicago Map', 10);

  if (failed.length) {
    Logger.log('Could not geocode:\n' + failed.join('\n'));
  }
  if (done === BATCH_LIMIT) {
    SpreadsheetApp.getUi().alert(
      'Stopped at the ' + BATCH_LIMIT + '-row batch limit. Run it again to continue.');
  }
}

/** @return {{lat: number, lon: number}|null} */
function geocode(geocoder, address) {
  try {
    var res = geocoder.geocode(address);
    if (res.status !== 'OK' || !res.results || !res.results.length) return null;
    var loc = res.results[0].geometry.location;
    return { lat: loc.lat, lon: loc.lng };
  } catch (err) {
    Logger.log('geocode failed for "' + address + '": ' + err);
    return null;
  }
}

function indexOfHeader(header, name) {
  var wanted = name.toLowerCase();
  for (var i = 0; i < header.length; i++) {
    if (String(header[i]).trim().toLowerCase() === wanted) return i;
  }
  return -1;
}

function toSet(list) {
  var set = {};
  for (var i = 0; i < list.length; i++) set[list[i]] = true;
  return set;
}
