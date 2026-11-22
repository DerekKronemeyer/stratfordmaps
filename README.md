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
- **Navigation (Walking map):** a Map key tab that finds walking routes between two points (typed addresses, taps or My location), with two settings: Quiet streets and Sidewalks and trails, each Any / Prefer / Only. Routing runs in the browser (`src/static/route.js`, Dijkstra) over a prebuilt network, `src/static/data/walking-network.json`: the Walking Routes from uMap joined to the Province's road centrelines, every piece tagged busy / sidewalk / trail / road crossing. A crosswalk is wherever a Walking Routes line crosses a road. The network is built by `jobs/walking_network/build.py` (Python + shapely), which the nightly sync runs right after the fetch; it skips itself when Walking Routes haven't changed. Links: `/walking?view=navigation&from=12+Keppoch+Road&to=46.22140,-63.08900&quiet=only` (settings left at Prefer are not written).
- **On phones**, each map opens zoomed to fit what's switched on; on desktop it opens on the view set in uMap.
- **Backgrounds** (top-right button): the Town of Stratford's 2025 aerial photos (the default), the Town's more detailed 2018 photos, and OpenStreetMap streets. Esri aerial fills in around the Town's photos but is not offered on its own. The Town's photos are served from a Cloudflare R2 bucket (`stratfordmaps-tiles`, at `tiles.stratfordmaps.ca/aerial-2018/` and `/aerial-2025b/`, as `{z}/{x}/{y}.webp`): the Town's tiles converted to WebP, with empty tiles dropped and the black fill outside the photo area made transparent so Esri shows through.

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
| `src/static/route.js` | Navigation on the Walking map: address search, routing, the result panel |
| `jobs/walking_network/` | builds the walking network (`build.py`; busy streets, distances and underpasses are set at the top) from Walking Routes + `roads.geojson` (Province road centrelines near town) |
| `src/static/style.css` | all styles (dark theme) |
| `src/static/data/` | map data and photos from uMap (made by `fetch-umap.mjs`) |
| `src/static/thumbs/` | card photos (640×360, also used for Facebook link previews) |

**Add a map:** make it in uMap, add an entry to `src/maps.json` with `"source": "umap"` and `"umap": "<name>_<id>"` (the end of the map's uMap address), then fetch and build. `layers` (`{ "friendly-name": "uMap layer id" }`) is optional, and `"oneLayer": true` makes the Map key show one layer at a time (used for Historical Aerial Photos, one year at a time). `"done": { "field": "Completed", "outline": "#43A047", "status": "{layer} priority" }` gives a map a done checkbox: ticked features get a green edge and a status line in the popup, and the Map key gets All / Planned / Completed (used by the AT Plan). `"components": { "label": "Network components" }` adds a second Map key view listing every feature group (features sharing a name, keyed by the text before ":", e.g. F14) with checkboxes and zoom; links can pick some with `?components=f2,f14`.

## Credits

- Maps drawn with [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause, `src/static/vendor/maplibre-gl/LICENSE.txt`) and edited in [uMap](https://umap-project.org/) (AGPL).
- Road centrelines and civic addresses © Province of Prince Edward Island; ground elevation from Natural Resources Canada (HRDEM).
- Aerial imagery © Esri and its partners, and 2018 and 2025 aerial photos © Town of Stratford (2025 from the Province of PEI); street map © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
- Logo by Derek Kronemeyer; Town of Stratford emblem used with the Town's permission.
- Layout inspired by [Bike Ottawa Maps](https://maps.bikeottawa.ca) and [Seattle Atlas](https://seattleatlas.org).

## License

Code: MIT (see `LICENSE`). Map data and content: © Derek Kronemeyer unless noted.
