import xml.etree.ElementTree as ET
ns = {'k':'http://www.opengis.net/kml/2.2'}
t = ET.parse('/external/portfolio/assets/chicago_list/real.kml')
r = t.getroot()
doc = r.find('k:Document', ns)
print("DOC NAME:", doc.find('k:name', ns).text)
for f in doc.findall('k:Folder', ns):
    name = f.find('k:name', ns)
    pms = f.findall('k:Placemark', ns)
    # geometry types
    pts = sum(1 for p in pms if p.find('.//k:Point', ns) is not None)
    lines = sum(1 for p in pms if p.find('.//k:LineString', ns) is not None)
    polys = sum(1 for p in pms if p.find('.//k:Polygon', ns) is not None)
    print(f"FOLDER: {name.text!r} | placemarks={len(pms)} pts={pts} lines={lines} polys={polys}")
    for p in pms[:3]:
        pn = p.find('k:name', ns)
        print("    e.g.:", pn.text if pn is not None else "(no name)")
