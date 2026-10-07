"""
geocode.py — Refresh chicago_layers.geojson from the Google Sheet.

The map page reads the sheet directly on every load (see chicagoData.js), so this script
is not needed to show current data. What it maintains is the *fallback* snapshot the page
uses when the sheet is unreachable or unshared, plus the address -> [lon, lat] cache that
covers rows whose Lat/Lon columns are still empty.

Pipeline:
  1. Fetch the sheet as CSV from Google's gviz endpoint (no API key, no auth).
  2. Prefer the sheet's own Lat/Lon columns, which geocodeSheet.gs fills in.
  3. Geocode whatever is left via Nominatim (OpenStreetMap's free API), caching results
     in geocode_cache.json so reruns skip anything already resolved.
  4. Emit chicago_layers.geojson as one flat FeatureCollection; places that still have no
     coordinates are omitted, since the snapshot only carries what can be drawn.

Usage:
    python3 geocode.py            # refresh the snapshot
    python3 geocode.py --no-api   # snapshot only, never call Nominatim

Requirements: Python 3.8+, no third-party packages.
"""

import csv, io, json, os, sys, time, urllib.parse, urllib.request

BASE  = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(BASE, 'geocode_cache.json')
OUT   = os.path.join(BASE, 'chicago_layers.geojson')

SHEET_ID  = '18rG-azfyKrziKuDm3WBHD2UyMeeD5T8BMugFG7j5fw4'
SHEET_GID = '2011978534'
SHEET_URL = (f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq'
             f'?tqx=out:csv&gid={SHEET_GID}')

# Header aliases, matched case-insensitively, mirroring COLUMNS in chicagoData.js.
COLUMNS = {
    'name':           ['place', 'name'],
    'type':           ['type', 'category'],
    'neighborhood':   ['neighborhood', 'neighbourhood', 'area'],
    'reviews':        ['reviews', 'notes', 'review'],
    'description':    ['description'],
    'address':        ['address'],
    'phone':          ['phone'],
    'website':        ['website'],
    'ratingsAverage': ['ratingsaverage', 'rating', 'ratingaverage'],
    'ratingsTotal':   ['ratingstotal', 'ratingcount', 'ratingtotal'],
    'plusCode':       ['pluscode', 'plus_code'],
    'originalUrl':    ['originalurl', 'original_url'],
    'lat':            ['lat', 'latitude'],
    'lon':            ['lon', 'lng', 'long', 'longitude'],
}

USE_API = '--no-api' not in sys.argv


# ── Phase 1: Fetch and parse the sheet ─────────────────────────────────────────

def fetch_sheet(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'chicago-todo-map/2.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8')


def column_index(header):
    normalized = [h.strip().lower() for h in header]
    at = {}
    for field, aliases in COLUMNS.items():
        at[field] = next((normalized.index(a) for a in aliases if a in normalized), None)
    return at


def cell(row, i):
    return row[i].strip() if (i is not None and i < len(row) and row[i]) else ''


def as_float(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


print(f"fetching sheet {SHEET_GID}…")
table = list(csv.reader(io.StringIO(fetch_sheet(SHEET_URL))))
header, table = table[0], table[1:]
at = column_index(header)
if at['name'] is None:
    raise SystemExit('no Place column in the sheet')

rows = []
for row in table:
    name = cell(row, at['name'])
    if not name:
        continue
    lon, lat = as_float(cell(row, at['lon'])), as_float(cell(row, at['lat']))
    rows.append({
        'name':           name,
        'type':           cell(row, at['type']),
        'neighborhood':   cell(row, at['neighborhood']),
        'reviews':        cell(row, at['reviews']),
        'description':    cell(row, at['description']),
        'address':        cell(row, at['address']),
        'phone':          cell(row, at['phone']),
        'website':        cell(row, at['website']),
        'ratingsAverage': cell(row, at['ratingsAverage']),
        'ratingsTotal':   cell(row, at['ratingsTotal']),
        'plusCode':       cell(row, at['plusCode']),
        'originalUrl':    cell(row, at['originalUrl']),
        'coord':          [lon, lat] if (lon is not None and lat is not None) else None,
    })

from_sheet = sum(1 for r in rows if r['coord'])
print(f"{len(rows)} rows, {from_sheet} with Lat/Lon in the sheet")


# ── Phase 2: Load the geocoding cache ──────────────────────────────────────────

cache = {}
if os.path.exists(CACHE):
    cache = json.load(open(CACHE))
    print(f"cache has {len(cache)} entries")

needed = sorted({r['address'] for r in rows if not r['coord'] and r['address']})
missing = [a for a in needed if not cache.get(a)]
print(f"{len(needed)} rows need the cache; {len(missing)} of those are unresolved")


# ── Phase 3: Geocode whatever is left ──────────────────────────────────────────

def geocode(addr):
    """
    Resolve a street address to [lon, lat] via Nominatim, or None if it fails.

    Nominatim's usage policy requires a descriptive User-Agent and a minimum 1-second
    delay between requests (the delay is enforced by the caller).
    """
    q   = urllib.parse.urlencode({"format": "json", "limit": "1", "q": addr})
    url = "https://nominatim.openstreetmap.org/search?" + q
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "chicago-todo-map/2.0 (portfolio demo)"}
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
        if data:
            return [float(data[0]["lon"]), float(data[0]["lat"])]
    except Exception as e:
        print("  err:", addr[:40], e)
    return None


if missing and not USE_API:
    print(f"--no-api: leaving {len(missing)} addresses unresolved")
elif missing:
    print(f"geocoding {len(missing)} addresses at 1/sec…")
    for i, a in enumerate(missing):
        cache[a] = geocode(a)

        # Flush every 25 requests so an interrupted run keeps its progress.
        if (i + 1) % 25 == 0:
            json.dump(cache, open(CACHE, 'w'), indent=4)
            ok = sum(1 for v in cache.values() if v)
            print(f"  {i+1}/{len(missing)} done, {ok} resolved in cache")

        time.sleep(1.05)   # Nominatim rate limit: ≥1 request/second

    json.dump(cache, open(CACHE, 'w'))
    ok = sum(1 for v in cache.values() if v)
    print(f"FINISHED geocoding: {ok}/{len(cache)} entries resolved")


# ── Phase 4: Build the GeoJSON snapshot ───────────────────────────────────────

out = {"type": "FeatureCollection", "features": []}
unplaced, unknown_types = [], set()

for r in rows:
    coord = r['coord'] or (cache.get(r['address']) if r['address'] else None)
    if not coord:
        unplaced.append(r['name'])
        continue   # the snapshot only carries places that can be drawn

    feature = {
        "type": "Feature",
        "geometry": {
            "type":        "Point",
            "coordinates": coord   # [lon, lat] — GeoJSON standard order
        },
        "properties": {
            "name":           r['name'],
            "type":           r['type'],
            "neighborhood":   r['neighborhood'],
            "address":        r['address'],
            "reviews":        r['reviews'],
            "description":    r['description'],
            "phone":          r['phone'],
            "website":        r['website'],
            "ratingsAverage": r['ratingsAverage'],
            "ratingsTotal":   r['ratingsTotal'],
            "plusCode":       r['plusCode'],
            "originalUrl":    r['originalUrl'],
        }
    }

    out['features'].append(feature)

print(f"{len(out['features'])} entries")

if unplaced:
    print(f"  {len(unplaced)} without coordinates (omitted): {', '.join(unplaced[:5])}"
          f"{'…' if len(unplaced) > 5 else ''}")
if unknown_types:
    print(f"  Types with no layer mapping: {', '.join(sorted(unknown_types))}")

# Indented to match the committed formatting, so a regenerated snapshot produces a
# reviewable diff rather than one 500KB line.
json.dump(out, open(OUT, 'w'), indent=4)
print("WROTE chicago_layers.geojson")
