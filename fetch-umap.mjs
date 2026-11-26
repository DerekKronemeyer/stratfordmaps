// Copies maps from uMap into src/static/data/<slug>.json, which the map pages draw from. No dependencies.
// Usage: `node fetch-umap.mjs` (every map) or `node fetch-umap.mjs walking` (one map).
// The uMap server address comes from UMAP_URL, set in a local .env file (not committed):
//   UMAP_URL=https://your-umap-server
// The data is committed, so building and deploying never depend on uMap being up.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPalettes, splitLayer } from './split-layers.mjs';

try { process.loadEnvFile(); } catch { /* no .env file: UMAP_URL may be set in the environment instead */ }
const UMAP_URL = process.env.UMAP_URL?.replace(/\/$/, '');
if (!UMAP_URL) { console.error('Set UMAP_URL in .env (see the top of this file).'); process.exit(1); }

const DATA = join('src', 'static', 'data');
const PHOTOS = join(DATA, 'photos');
const { maps } = JSON.parse(readFileSync(join('src', 'maps.json'), 'utf8'));
const only = process.argv.slice(2);
const targets = maps.filter((m) => m.source === 'umap' && (!only.length || only.includes(m.slug)));
if (!targets.length) { console.error('No matching uMap maps.'); process.exit(1); }

const download = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'stratfordmaps-build' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
};
const getJson = async (url) => (await download(url)).json();

const slugify = (text) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layer';

// Six decimals is about 10 cm, plenty for a town map, and keeps the files small.
const round = (c) => (typeof c === 'number' ? Math.round(c * 1e6) / 1e6 : c.map(round));

// Photos ({{url}} in any text) are copied into src/static/data/photos/ so the site never hotlinks.
// Photos kept on the uMap server (/uploads/photos/<map>/<file>) keep their path; others get a hashed name.
const localPhoto = async (url) => {
  // iNaturalist's open-data photos stay as links: thousands of sightings would bloat the site, and that bucket is meant for reuse.
  if (/^https:\/\/inaturalist-open-data\.s3\.amazonaws\.com\//.test(url)) return url;
  const own = url.match(/\/uploads\/photos\/(.+)$/);
  const ext = (url.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i) || [, 'jpg'])[1].toLowerCase();
  const name = own ? decodeURIComponent(own[1]) : `ext/${createHash('md5').update(url).digest('hex').slice(0, 12)}.${ext}`;
  const file = join(PHOTOS, name);
  if (!existsSync(file)) {
    try {
      const res = await download(url);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      console.warn(`  photo not copied (${err.message}), keeping the original link`);
      return url;
    }
  }
  return `/static/data/photos/${name}`;
};
const localizePhotos = async (props) => {
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== 'string' || !value.includes('{{')) continue;
    let text = value;
    for (const [, url] of value.matchAll(/\{\{(https?:\/\/[^}\s]+)\}\}/g)) text = text.replace(url, await localPhoto(url));
    props[key] = text;
  }
};

// uMap keeps per-feature styles in a nested _umap_options object; MapLibre can only read flat
// properties, so they become _color, _weight and so on.
const STYLE_KEYS = ['color', 'weight', 'opacity', 'fillColor', 'fillOpacity', 'iconUrl'];
const flattenFeature = (f) => {
  const { _umap_options: style = {}, ...props } = f.properties || {};
  for (const k of STYLE_KEYS) if (style[k] != null) props[`_${k}`] = style[k];
  return { type: 'Feature', properties: props, geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) } };
};

let palettes; // uMap's colour palettes, loaded when a map needs them (`split`)
for (const m of targets) {
  const id = m.umap.match(/_(\d+)$/)[1]; // "walking_2" → 2
  const map = (await getJson(`${UMAP_URL}/en/map/${id}/geojson/`)).properties;

  // Layer keys are used in shareable links (?layers=best,winter). Friendly names come from `layers`
  // in maps.json; any other layer gets a key made from its name.
  const keyFor = Object.fromEntries(Object.entries(m.layers || {}).map(([key, uuid]) => [uuid, key]));
  const usedKeys = new Set();
  const layers = [], dataOnly = [];
  // `skipLayers` in maps.json names uMap layers to leave off the site (kept in uMap for reference).
  // `dataOnlyLayers` are fetched into the data file under `dataOnly` but not drawn on the site (Navigation reads them).
  for (const dl of map.datalayers) {
    if ((m.skipLayers || []).includes(dl.properties?.name ?? dl.name)) continue;
    const fc = await getJson(`${UMAP_URL}/en/datalayer/${id}/${dl.id}/`);
    if ((m.dataOnlyLayers || []).includes(dl.properties?.name ?? dl.name)) { dataOnly.push({ name: dl.properties?.name ?? dl.name, features: fc.features.map(flattenFeature) }); continue; }
    const o = { ...(dl.properties || {}), ...(fc._umap_options || {}) };
    // `split` (Housing Density): this one uMap layer becomes several site layers by a number field.
    if (m.split && o.name === m.split.layer) {
      const whole = { name: o.name, color: o.color || 'DarkBlue', weight: o.weight ?? 3, opacity: o.opacity ?? map.opacity ?? 1, fillColor: o.fillColor || null,
        fillOpacity: o.fillOpacity ?? 0.3, iconClass: o.iconClass || null, iconUrl: o.iconUrl || null, show: o.displayOnLoad !== false, showLabel: !!o.showLabel,
        fields: (o.fields || []).map((f) => f.key), features: fc.features.map(flattenFeature) };
      palettes ??= await loadPalettes(UMAP_URL, download);
      for (const part of splitLayer(whole, o.choropleth, palettes, m.split, slugify)) { usedKeys.add(part.key); layers.push(part); }
      continue;
    }
    let key = keyFor[dl.id] || slugify(o.name || 'layer');
    for (let i = 2; usedKeys.has(key); i++) key = `${slugify(o.name || 'layer')}-${i}`;
    usedKeys.add(key);
    layers.push({
      key,
      name: o.name,
      color: (m.layerColors || {})[o.name] || o.color || 'DarkBlue', // `layerColors` in maps.json: site colour that differs from uMap's
      weight: o.weight ?? 3,
      opacity: o.opacity ?? map.opacity ?? 1,
      fillColor: o.fillColor || null,
      fillOpacity: o.fillOpacity ?? 0.3,
      iconClass: o.iconClass || null,
      iconUrl: o.iconUrl || null,
      show: o.displayOnLoad !== false,
      showLabel: !!o.showLabel,
      fields: (o.fields || []).map((f) => f.key),
      features: fc.features.map(flattenFeature),
    });
  }
  for (const layer of layers) for (const f of layer.features) await localizePhotos(f.properties);

  // Every named feature needs its own id for shareable links (?feature=). A line split in uMap copies
  // its id, and new features have none, so those get the next free number: f14, f14-2, f14-3...
  // The first feature with an id keeps it, so existing links keep working.
  const usedIds = new Set();
  for (const layer of layers) for (const f of layer.features) {
    const p = f.properties;
    if (!p.name) continue;
    if (p.id && !usedIds.has(p.id)) { usedIds.add(p.id); continue; }
    const base = (p.id || slugify(p.name.split(':')[0])).replace(/-\d+$/, '');
    let n = 1, id = base;
    while (usedIds.has(id)) id = `${base}-${++n}`;
    p.id = id;
    usedIds.add(id);
  }

  const t = map.tilelayer;
  const out = {
    name: map.name,
    // Shown in the map's Info panel; uMap text formatting works, e.g. [[https://...|link text]].
    description: map.description || '',
    center: map.center ? [map.center[0], map.center[1]] : null,
    zoom: map.zoom ?? 14,
    // Last edit in uMap: the newest of the map's own save time and each layer's version (a save timestamp in ms).
    updated: new Date(Math.max(Date.parse(map.modified_at) || 0, ...map.datalayers.map((dl) => Number(dl.referenceVersion) || 0))).toISOString(),
    basemap: t ? { name: t.name, url: t.url_template, attribution: t.attribution, maxzoom: t.maxNativeZoom || t.maxZoom || 19 } : null,
    layers,
    ...(dataOnly.length ? { dataOnly } : {}),
  };
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, `${m.slug}.json`), JSON.stringify(out));
  console.log(`${m.slug}: ${layers.map((l) => `${l.name} (${l.features.length})`).join(', ')}${dataOnly.length ? `; data only: ${dataOnly.map((l) => `${l.name} (${l.features.length})`).join(', ')}` : ''}`);
}
