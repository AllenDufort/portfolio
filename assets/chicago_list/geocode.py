import xml.etree.ElementTree as ET, json, re, os, time, urllib.parse, urllib.request

BASE = '/external/portfolio/assets/chicago_list'
ns = {'k':'http://www.opengis.net/kml/2.2'}
CACHE = os.path.join(BASE, 'geocode_cache.json')

doc = ET.parse(os.path.join(BASE,'real.kml')).getroot().find('k:Document', ns)

def strip_html(s):
    return re.sub('<[^<]+?>', '', s or '').replace('&lt;','<').replace('&gt;','>').strip()

# Gather placemarks per layer with address + props
layers = {}
addrs = set()
for f in doc.findall('k:Folder', ns):
    fname = f.find('k:name', ns).text
    items = []
    for pm in f.findall('k:Placemark', ns):
        nm = pm.find('k:name', ns)
        ad = pm.find('k:address', ns)
        de = pm.find('k:description', ns)
        # try inline coords first
        co = pm.find('.//k:coordinates', ns)
        inline = None
        if co is not None and co.text and co.text.strip():
            lon,lat,*_ = co.text.strip().split()[0].split(',')
            inline = [float(lon), float(lat)]
        address = ad.text.strip() if (ad is not None and ad.text) else None
        items.append({
            "name": nm.text if nm is not None else "",
            "address": address,
            "description": strip_html(de.text) if de is not None else "",
            "inline": inline,
        })
        if address and inline is None:
            addrs.add(address)
    layers[fname] = items

addrs = sorted(addrs)
print(f"unique addresses to geocode: {len(addrs)}")

cache = {}
if os.path.exists(CACHE):
    cache = json.load(open(CACHE))
    print(f"cache has {len(cache)} entries")

def geocode(addr):
    q = urllib.parse.urlencode({"format":"json","limit":"1","q":addr})
    url = "https://nominatim.openstreetmap.org/search?"+q
    req = urllib.request.Request(url, headers={"User-Agent":"chicago-todo-map/1.0 (portfolio demo)"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
        if data:
            return [float(data[0]["lon"]), float(data[0]["lat"])]
    except Exception as e:
        print("  err:", addr[:40], e)
    return None

for i, a in enumerate(addrs):
    if a in cache:
        continue
    cache[a] = geocode(a)
    if (i+1) % 25 == 0:
        json.dump(cache, open(CACHE,'w'))
        ok = sum(1 for v in cache.values() if v)
        print(f"  {i+1}/{len(addrs)} done, {ok} resolved")
    time.sleep(1.05)  # respect Nominatim usage policy

json.dump(cache, open(CACHE,'w'))
ok = sum(1 for v in cache.values() if v)
print(f"FINISHED geocoding: {ok}/{len(addrs)} resolved")

# Build per-layer GeoJSON
out = {}
for fname, items in layers.items():
    feats = []
    for it in items:
        coord = it["inline"] or (cache.get(it["address"]) if it["address"] else None)
        if not coord:
            continue
        feats.append({
            "type":"Feature",
            "geometry":{"type":"Point","coordinates":coord},
            "properties":{"name":it["name"],"address":it["address"] or "","description":it["description"]}
        })
    out[fname] = {"type":"FeatureCollection","features":feats}
    print(f"  layer {fname!r}: {len(feats)}/{len(items)} plotted")

json.dump(out, open(os.path.join(BASE,'chicago_layers.geojson'),'w'))
print("WROTE chicago_layers.geojson")
