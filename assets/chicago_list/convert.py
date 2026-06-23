import xml.etree.ElementTree as ET, json, re

ns = {'k':'http://www.opengis.net/kml/2.2'}
t = ET.parse('/external/portfolio/assets/chicago_list/real.kml')
doc = t.getroot().find('k:Document', ns)

def coords_of(pm):
    # find any <coordinates> descendant (Point, MultiGeometry, etc.)
    c = pm.find('.//k:coordinates', ns)
    if c is None or not c.text:
        return None
    parts = c.text.strip().split()
    if not parts:
        return None
    lon, lat, *_ = parts[0].split(',')
    return [float(lon), float(lat)]

def desc_of(pm):
    d = pm.find('k:description', ns)
    if d is None or not d.text:
        return ""
    txt = re.sub('<[^<]+?>', '', d.text)  # strip html tags
    return txt.strip()

out = {}
for f in doc.findall('k:Folder', ns):
    fname = f.find('k:name', ns).text
    feats = []
    skipped = 0
    for pm in f.findall('k:Placemark', ns):
        co = coords_of(pm)
        if co is None:
            skipped += 1
            continue
        nm = pm.find('k:name', ns)
        feats.append({
            "type":"Feature",
            "geometry":{"type":"Point","coordinates":co},
            "properties":{"name": nm.text if nm is not None else "", "description": desc_of(pm)}
        })
    out[fname] = {"type":"FeatureCollection","features":feats}
    print(f"{fname}: {len(feats)} features, {skipped} skipped (no coords)")

with open('/external/portfolio/assets/chicago_list/chicago_layers.geojson','w') as fp:
    json.dump(out, fp)
print("WROTE chicago_layers.geojson", )
