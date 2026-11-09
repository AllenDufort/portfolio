# Portfolio

Static HTML, CSS and native JavaScript modules. No frontend build or dependency installation is required. Keep the root HTML filenames unchanged so existing links continue to work.

## Structure

- `index.html` and the root project pages: page markup and navigation.
- `style.css`: shared typography, layout, footer and utilities.
- `animate.js`: the shared title animation.
- `assets/shared/`: model choices, assistant rendering and the Worker event-stream reader.
- `assets/chicago_list/`: Chicago map, assistant, stylesheet and sheet data. `sheet.js` owns the sheet URL, column aliases and CSV parsing used by both the browser and its Worker. See [the Chicago guide](assets/chicago_list/README.md) for data maintenance.
- `assets/travel/`: Travel Planner UI (`travel.js`), persistence and AI requests (`travel-api.js`), PDF printing (`travel-export.js`) and styles (`travel.css`).
- Each app's `worker/` directory: its existing Cloudflare backend and deployment configuration. API keys remain Worker secrets; Travel's trips and preferences remain in its existing KV namespace.

The HTML pages load their JavaScript entry points with `type="module"`; imports declare dependencies directly. Leaflet, MarkerCluster and Bootstrap still load from their existing CDNs. `window.TravelApp` is retained for the existing inline action buttons.

## Local development

From the repository root:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/chicagoMap.html` or `http://localhost:8000/travel.html`. Serve over HTTP; native modules cannot be loaded by double-clicking an HTML file.

To use AI features or Travel's database locally, start each Worker in a separate terminal, after configuring its local secrets:

```sh
cd assets/chicago_list/worker
npx wrangler dev --config wrangler.toml  # port 8787
```

```sh
cd assets/travel/worker
npx wrangler dev --config wrangler.toml  # port 8788
```

The Chicago assistant keeps its endpoint URLs in `chicagoChat.js`; Travel keeps them in `travel-api.js`. Localhost automatically selects the development endpoint. Deployment remains through the existing `deploy.sh` scripts.

## Checks

With Node.js 22.7 or newer, run the dependency-free regression checks:

```sh
node --test tests/*.test.mjs
```

These cover streamed replies, safe Markdown rendering, sheet parsing, coordinate-cache handling and the saved-map fallback. They use local fixtures and make no production requests.
