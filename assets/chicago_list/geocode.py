"""
geocode.py — Convert real.kml into chicago_layers.geojson.

Pipeline:
  1. Parse real.kml and extract every Folder (layer) with its Placemarks.
  2. For placemarks that already carry inline <coordinates>, use those directly.
  3. For placemarks that only have a text <address>, geocode via Nominatim
     (OpenStreetMap's free geocoding API), caching results in geocode_cache.json
     so reruns skip already-resolved addresses.
  4. Emit a single JSON file (chicago_layers.geojson) shaped as:
       { "<LayerName>": { "type": "FeatureCollection", "features": [...] }, ... }
     This is the file loaded by chicagoMap.html at runtime.

Usage:
    python geocode.py

Requirements: Python 3.8+, no third-party packages.
"""

import xml.etree.ElementTree as ET
import json, os, time, urllib.parse, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))

# KML namespace prefix used for all element lookups
ns = {'k':'http://www.opengis.net/kml/2.2'}

# Persistent geocoding cache so we never re-hit Nominatim for known addresses
CACHE = os.path.join(BASE, 'geocode_cache.json')

# Parse real.kml and jump straight to the <Document> root element
doc = ET.parse(os.path.join(BASE, 'real.kml')).getroot().find('k:Document', ns)


# ── Phase 1: Parse KML into plain Python dicts ─────────────────────────────────

layers = {}   # { layerName: [ {name, address, description, inline}, ... ] }
addrs  = set()  # addresses that have no inline coords and must be geocoded

for f in doc.findall('k:Folder', ns):
    fname = f.find('k:name', ns).text   # folder name becomes the layer key
    items = []

    for pm in f.findall('k:Placemark', ns):
        nm = pm.find('k:name', ns)

        # Some placemarks embed coordinates directly in a <Point><coordinates> element;
        # use those when available to avoid an unnecessary geocoding round-trip.
        co = pm.find('.//k:coordinates', ns)
        inline = None
        if co is not None and co.text and co.text.strip():
            # KML coordinate order is lon,lat,alt — we only need lon and lat
            lon, lat, *_ = co.text.strip().split()[0].split(',')
            inline = [float(lon), float(lat)]

        # Read all relevant fields from ExtendedData, which holds clean structured values.
        # Google My Maps generates this block from the spreadsheet columns.
        address = None
        reviews = None
        ed = pm.find('k:ExtendedData', ns)
        if ed is not None:
            for d in ed.findall('k:Data', ns):
                n = d.get('name')
                v = d.find('k:value', ns)
                val = v.text.strip() if (v is not None and v.text) else None
                if n == 'Address':
                    address = val
                elif n == 'Reviews':
                    reviews = val
        # Fall back to <address> if ExtendedData.Address is absent
        if address is None:
            ad = pm.find('k:address', ns)
            address = ad.text.strip() if (ad is not None and ad.text) else None

        items.append({
            "name":    nm.text if nm is not None else "",
            "address": address,
            "reviews": reviews or "",
            "inline":  inline,
        })

        # Queue address for geocoding only when there are no inline coordinates
        if address and inline is None:
            addrs.add(address)

    layers[fname] = items

addrs = sorted(addrs)   # sorted for deterministic progress output
print(f"unique addresses to geocode: {len(addrs)}")


# ── Phase 2: Load the geocoding cache ──────────────────────────────────────────

cache = {}
if os.path.exists(CACHE):
    cache = json.load(open(CACHE))
    print(f"cache has {len(cache)} entries")


def geocode(addr):
    """
    Resolve a street address to [lon, lat] using the Nominatim search API.

    Returns a [lon, lat] list on success, or None if the address cannot be
    resolved or the request fails.  Nominatim's usage policy requires a
    descriptive User-Agent and a minimum 1-second delay between requests
    (enforced by the caller).
    """
    q   = urllib.parse.urlencode({"format": "json", "limit": "1", "q": addr})
    url = "https://nominatim.openstreetmap.org/search?" + q
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "chicago-todo-map/1.0 (portfolio demo)"}
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
        if data:
            return [float(data[0]["lon"]), float(data[0]["lat"])]
    except Exception as e:
        print("  err:", addr[:40], e)
    return None


# ── Phase 3: Geocode any addresses not already in the cache ────────────────────

for i, a in enumerate(addrs):
    if a in cache:
        continue   # already resolved — skip to avoid redundant API calls

    cache[a] = geocode(a)

    # Flush cache to disk every 25 requests so partial progress isn't lost
    if (i + 1) % 25 == 0:
        json.dump(cache, open(CACHE, 'w'))
        ok = sum(1 for v in cache.values() if v)
        print(f"  {i+1}/{len(addrs)} done, {ok} resolved")

    time.sleep(1.05)   # Nominatim rate limit: ≥1 request/second

# Final flush after the loop completes
json.dump(cache, open(CACHE, 'w'))
ok = sum(1 for v in cache.values() if v)
print(f"FINISHED geocoding: {ok}/{len(addrs)} resolved")


# ── Phase 4: Build per-layer GeoJSON and write the output file ─────────────────

out = {}
for fname, items in layers.items():
    feats = []
    for it in items:
        # Prefer inline coordinates; fall back to the geocoding cache
        coord = it["inline"] or (cache.get(it["address"]) if it["address"] else None)
        if not coord:
            continue   # skip placemarks we couldn't resolve

        feats.append({
            "type": "Feature",
            "geometry": {
                "type":        "Point",
                "coordinates": coord   # [lon, lat] — GeoJSON standard order
            },
            "properties": {
                "name":    it["name"],
                "address": it["address"] or "",
                "reviews": it["reviews"],
            }
        })

    # Each layer becomes a GeoJSON FeatureCollection keyed by its folder name
    out[fname] = {"type": "FeatureCollection", "features": feats}
    print(f"  layer {fname!r}: {len(feats)}/{len(items)} plotted")

json.dump(out, open(os.path.join(BASE, 'chicago_layers.geojson'), 'w'))
print("WROTE chicago_layers.geojson")
