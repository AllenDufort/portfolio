# chicago_list

Pipeline that converts a **Google My Maps export** into a GeoJSON file used by the Chicago map on the portfolio site.

## Files

### Pipeline

| File | Description |
|------|-------------|
| `real.kml` | Full KML fetched directly from Google Maps (see [Updating](#updating)). Source of truth for all placemark data. |
| `Chicago TODO Map.kml` | Stub exported from Google My Maps — contains only a `<NetworkLink>` pointing back to Google, no placemark data. |
| `geocode.py` | Main pipeline script. Reads `real.kml`, geocodes addresses via Nominatim, writes `chicago_layers.geojson`. |
| `geocode_cache.json` | Persistent cache mapping clean street addresses → `[lon, lat]`. Avoids redundant Nominatim API calls on reruns. |
| `chicago_layers.geojson` | **Output file** consumed by both front-end scripts at runtime. One GeoJSON FeatureCollection per layer. |
| `inspect.py` | Audit script — prints folder/layer structure and placemark counts from `real.kml`. Run before `geocode.py` to sanity-check a new KML fetch. |

### Front-end

| File | Description |
|------|-------------|
| `chicagoMap.js` | Initialises the Leaflet map, registers custom zoom/locate/search controls, fetches `chicago_layers.geojson`, builds marker clusters, and wires up the layer-toggle UI. Loaded by `chicagoMap.html` after the Leaflet and MarkerCluster CDN scripts. |
| `chicagoChat.js` | AI chat widget powered by the [Pollinations](https://pollinations.ai) text API — free, no API key, no visitor sign-in. On load it fetches `chicago_layers.geojson` and merges the overlapping layers into one place index. Each question is scored against that index and only the top matches are sent as context, so the request stays small. Falls back to local keyword answers whenever the API is throttled or slow. See [Chat assistant](#chat-assistant). |

## Chat assistant

`chicagoChat.js` talks to Pollinations' OpenAI-compatible endpoint. It was chosen because it is the
only provider that works from a purely static page with **no API key committed to the repo and no
sign-in prompt for visitors** — it sends `Access-Control-Allow-Origin: *`, so the browser can call it
directly. (The previous puter.js integration required each visitor to have a Puter account.)

```
POST https://text.pollinations.ai/openai
{ "model": "openai-fast", "referrer": "...", "messages": [...] }
```

The free anonymous tier is the constraint the widget is designed around:

| Limit | Handling |
|-------|----------|
| ~1 request per 15s per visitor IP (`402` / `429` when exceeded) | Requests are paced from the last one; if the remaining wait exceeds `MAX_WAIT_MS` the question is answered locally instead of stalling. A `402`/`429` starts a 60s cooldown during which the API is skipped entirely. |
| A small per-IP spend budget, on top of the rate limit — once spent, every request returns `402` with `"API key budget too low. This request costs ~0.0003 pollen"` until it replenishes | Cost scales with prompt size, so only `CONTEXT_PLACES` (10) places are sent per question and notes are truncated to `NOTE_CHARS`. A visitor arrives with their own budget; when it runs out the widget answers locally. |
| Overlapping requests are refused (`queue full`) | Only one request is ever in flight; the input is disabled while a reply is pending. |
| `stream: true` is not available anonymously | Replies are fetched in one shot, then revealed with a typewriter effect so the UX still feels live. |
| `openai-fast` is the only anonymous model (`GET /models`) | Pinned in `API_MODEL`. It is a reasoning model, so the `reasoning` field in the response is ignored and only `content` is used. |

Because none of that is guaranteed, **the widget never depends on the network to answer.** Every
question is also resolved locally against the place index, and that answer is shown — tagged with a
short note — whenever the API is throttled, slow, or returns nothing. Local answers cover place
counts, food/activity categories, `where is …` / `tell me about …` lookups, and general keyword
search. Keyword matching is anchored to word starts so `Aba` does not match `Kabab`.

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
