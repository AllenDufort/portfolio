# chicago_list

Pipeline that converts a **Google My Maps export** into a GeoJSON file used by the Chicago map on the portfolio site.

## Files

| File | Description |
|------|-------------|
| `real.kml` | Full KML fetched directly from Google Maps (see [Updating](#updating)). Source of truth for all placemark data. |
| `Chicago TODO Map.kml` | Stub exported from Google My Maps — contains only a `<NetworkLink>` pointing back to Google, no placemark data. |
| `geocode.py` | Main pipeline script. Reads `real.kml`, geocodes addresses via Nominatim, writes `chicago_layers.geojson`. |
| `geocode_cache.json` | Persistent cache mapping clean street addresses → `[lon, lat]`. Avoids redundant Nominatim API calls on reruns. |
| `chicago_layers.geojson` | **Output file** loaded by `chicagoMap.html` at runtime. One GeoJSON FeatureCollection per layer. |
| `inspect.py` | Audit script — prints folder/layer structure and placemark counts from `real.kml`. Run before `geocode.py` to sanity-check a new KML fetch. |

## Layers

| Layer | Placemarks |
|-------|-----------|
| Chicago Todo List | 539 |
| Food Spots | 449 |
| Activities | 133 |

## Output format

`chicago_layers.geojson` is a JSON object keyed by layer name, each value a GeoJSON FeatureCollection:

```json
{
  "Food Spots": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "geometry": { "type": "Point", "coordinates": [-87.6298, 41.8781] },
        "properties": {
          "name": "Aba",
          "address": "302 N Green St, Chicago, IL 60607",
          "reviews": "Mediterranean food"
        }
      }
    ]
  }
}
```

## Pipeline

`geocode.py` runs in four phases:

1. **Parse** — reads every `<Folder>` and `<Placemark>` from `real.kml`. Addresses are read from `ExtendedData/Data[@name="Address"]` (clean structured value) rather than the `<address>` field, which Google My Maps fills with a concatenation of name + notes + address.
2. **Load cache** — reads `geocode_cache.json` so already-resolved addresses skip the API.
3. **Geocode** — calls the [Nominatim](https://nominatim.openstreetmap.org) search API for any address not in the cache. Results are flushed to disk every 25 requests. Rate-limited to 1 request/second per Nominatim's usage policy.
4. **Emit** — writes `chicago_layers.geojson`.

```
python3 geocode.py
```

## Updating

When places are added or edited in Google My Maps, refresh `real.kml` then re-run the pipeline:

```sh
# 1. Fetch fresh KML (the URL comes from inside "Chicago TODO Map.kml")
curl -L "https://www.google.com/maps/d/u/0/kml?forcekml=1&mid=1NGC1j7IbHYH0yGikwPbCBJS6oAXp4RM" \
  -o assets/chicago_list/real.kml

# 2. Re-run the pipeline (cache is reused; only new addresses hit the API)
python3 assets/chicago_list/geocode.py
```

New addresses are geocoded automatically; existing cache entries are reused.
