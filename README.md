# Stratford Maps

**Live site:** https://www.stratfordmaps.ca

Friendly, easy-to-use maps of Stratford, Prince Edward Island: walking trails, wards, parks, public art, housing and more. An independent project by Derek Kronemeyer, not affiliated with the Town of Stratford.

## How it works

```
uMap (self-hosted, private)       ← maps are edited here
      │ node fetch-umap.mjs       copies each map's layers and photos into src/static/data/
      ▼
src/  ── node build.mjs ──► dist/ ──► Cloudflare Workers (static files only)
                                        ├─ /                  all maps, grouped by category
                                        ├─ /walking, /wards   one full-screen page per map, drawn with MapLibre GL JS
                                        ├─ /about, /resources
                                        └─ /static/           css, js, map data, photos, MapLibre
```

- **No server code, no database.** `build.mjs` (plain Node, no dependencies) turns the files in `src/` into static pages in `dist/`.
- **Maps are edited in [uMap](https://umap-project.org/)**, running privately on my own server. `node fetch-umap.mjs` copies the maps into `src/static/data/`, and that data is committed, so the live site never depends on uMap being up.
- **Publishing is automatic.** The uMap server runs the fetch every night and commits and pushes any changes as "Map updates from uMap"; a "Publish to site" button on the uMap dashboard runs it on demand. Pull before changing code locally.
- **Photos:** any `{{image url}}` in a description is copied into `src/static/data/photos/` by the fetch, so the site never hotlinks.
- **Shareable links:** `/walking?layers=best,winter&feature=fullertons-creek-conservation-park` opens the Walking map with only those layers on and that place's popup open. Friendly layer names come from `layers` in `src/maps.json`; places are matched on their permanent `id` field.
- **On phones**, each map opens zoomed to fit what's switched on; on desktop it opens on the view set in uMap.

### Why uMap?

Alternatives considered: a custom editor (Cloudflare Workers + D1 + Access), Felt, embedding Google My Maps, and ArcGIS Online. uMap won on: free, open source, a real editor with layer history, custom backgrounds, and a clean GeoJSON API, with no editor code to maintain. The site only reads uMap's data, so the editor could be swapped without changing any page addresses.

## Working on it

```sh
node fetch-umap.mjs     # pull the latest maps from uMap (or one map: node fetch-umap.mjs walking)
node build.mjs          # build into dist/
npx wrangler dev        # preview at http://127.0.0.1:8787 (any static file server on dist/ works too)
```

`fetch-umap.mjs` needs the uMap address in a `.env` file, which is not committed:

```
UMAP_URL=https://your-umap-server
```

Pushing to `main` deploys automatically (Cloudflare Workers Builds: build `node build.mjs`, deploy `npx wrangler deploy`).

### Files

| Path | What it is |
|---|---|
| `src/maps.json` | the map list: categories, titles, card text, photos, uMap ids |
| `src/resources.json` | links on the Resources page, grouped |
| `src/site.json` | site name, address, tagline, contact links |
| `src/static/mapgl.js` | draws a map page: layers, pins, popups, Map key and Info panels |
| `src/static/style.css` | all styles (dark theme) |
| `src/static/data/` | map data and photos from uMap (made by `fetch-umap.mjs`) |
| `src/static/thumbs/` | card photos (640×360, also used for Facebook link previews) |

**Add a map:** make it in uMap, add an entry to `src/maps.json` with `"source": "umap"` and `"umap": "<name>_<id>"` (the end of the map's uMap address), then fetch and build. `layers` (`{ "friendly-name": "uMap layer id" }`) is optional, and `"oneLayer": true` makes the Map key show one layer at a time (used for Historical Aerial Photos, one year at a time). `"done": { "field": "Completed", "outline": "#43A047", "status": "{layer} priority" }` gives a map a done checkbox: ticked features get a green edge and a status line in the popup, and the Map key gets All / Planned / Completed (used by the AT Plan).

## Credits

- Maps drawn with [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause, `src/static/vendor/maplibre-gl/LICENSE.txt`) and edited in [uMap](https://umap-project.org/) (AGPL).
- Aerial imagery © Esri and its partners; street map © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
- Logo by Derek Kronemeyer; Town of Stratford emblem used with the Town's permission.
- Layout inspired by [Bike Ottawa Maps](https://maps.bikeottawa.ca) and [Seattle Atlas](https://seattleatlas.org).

## License

Code: MIT (see `LICENSE`). Map data and content: © Derek Kronemeyer unless noted.
