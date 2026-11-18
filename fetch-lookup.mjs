// Builds src/static/data/lookup.json for the Address Lookup page: every Stratford civic address with its
// ward, provincial district, collection days, zoning, flood areas (at the house, or over 10% of the lot) and nearest bus stop, plus the nearest park and playground from the Parks map.
// Usage: `node fetch-lookup.mjs`. Needs read access to the PEI data hub database; the command that runs
// psql against it comes from HUB_PSQL in a local .env file (not committed), for example:
//   HUB_PSQL=ssh you@server docker exec -i db psql -U user -d datahub -At
// The output is committed, so building and deploying never depend on the hub being up.
// People and phone numbers are not here: they live in src/lookup.json and are kept by hand.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

try { process.loadEnvFile(); } catch { /* no .env file: HUB_PSQL may be set in the environment instead */ }
if (!process.env.HUB_PSQL) { console.error('Set HUB_PSQL in .env (see the top of this file).'); process.exit(1); }

const SQL = String.raw`
with addr as (
  select distinct on (no, street) no, street, geom from (
    select (attrs->>'STREET_NO')::int no, attrs->>'STREET_NM' street, geom, (attrs->>'OBJECTID')::int oid
    from canonical.feature where dataset_id = 'pei_civic_addresses' and attrs->>'COMM_NM' = 'STRATFORD' and attrs->>'STREET_NO' is not null
  ) a order by no, street, oid
),
stops as (
  select s.attrs->>'stop_name' name, s.geom,
    (select string_agg(distinct r.attrs->>'route_short_name' || ' ' || (r.attrs->>'route_long_name'), '|')
       from canonical.feature r where r.dataset_id = 'pei_transit_routes' and st_dwithin(r.geom::geography, s.geom::geography, 25)) routes
  from canonical.feature s where s.dataset_id = 'pei_transit_stops'
    and st_dwithin(s.geom::geography, st_setsrid(st_makepoint(-63.08, 46.22), 4326)::geography, 9000)
)
select json_build_object(
  'no', a.no, 'street', a.street,
  'lon', round(st_x(a.geom)::numeric, 5), 'lat', round(st_y(a.geom)::numeric, 5),
  'ward', (select w.attrs->>'DISTRICT' from canonical.feature w where w.dataset_id = 'pei_municipal_wards' and st_intersects(w.geom, a.geom) limit 1),
  'district', (select d.attrs->>'DISTRICT' from canonical.feature d where d.dataset_id = 'pei_provincial_districts' and st_intersects(d.geom, a.geom) limit 1),
  'cart', (select c.attrs->>'Cart_Coll' from canonical.feature c where c.dataset_id = 'pei_waste_collection' and st_intersects(c.geom, a.geom) limit 1),
  'bluebag', (select c.attrs->>'Blue_Bag' from canonical.feature c where c.dataset_id = 'pei_waste_collection' and st_intersects(c.geom, a.geom) limit 1),
  'zones', (select json_agg(distinct z.attrs->>'ZONE_CODE') from canonical.feature z where z.dataset_id = 'stratford_zoning' and st_intersects(z.geom, a.geom)),
  'flood', (select json_agg(distinct case when f.attrs->>'FloodType' = 'Coastal Flood' then 'coastal' else 'inland' end)
            from canonical.feature f where f.dataset_id = 'stratford_coastal_flood' and st_intersects(f.geom, a.geom)),
  'lotflood', (select json_agg(t) from (
      select case when f.attrs->>'FloodType' = 'Coastal Flood' then 'coastal' else 'inland' end t,
        st_area(st_intersection(lot.geom, st_union(f.geom))::geography) / nullif(st_area(lot.geom::geography), 0) share
      from canonical.feature f
      where f.dataset_id = 'stratford_coastal_flood' and st_intersects(f.geom, lot.geom)
      group by 1) x where share >= 0.1),
  'stop', (select json_build_object('name', s.name, 'm', round(st_distance(s.geom::geography, a.geom::geography)), 'routes', s.routes)
           from stops s order by s.geom <-> a.geom limit 1)
) from addr a
left join lateral (select l.geom from canonical.feature l where l.dataset_id = 'pei_parcels' and st_intersects(l.geom, a.geom) limit 1) lot on true
order by a.street, a.no;
`;

const rows = execSync(process.env.HUB_PSQL, { input: SQL, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })
  .split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
if (rows.length < 4000) throw new Error(`Only ${rows.length} addresses came back; expected about 4,400.`);

// Repeated text (ward names, collection days, stop names) is stored once in a list, and each address points
// at it by number, which keeps the file small.
const lists = {};
const ref = (list, value) => {
  if (value == null) return null;
  const key = JSON.stringify(value);
  const items = (lists[list] ||= { items: [], index: new Map() });
  if (!items.index.has(key)) { items.index.set(key, items.items.length); items.items.push(value); }
  return items.index.get(key);
};

// Nearest park and playground come from the site's own Parks map (src/static/data/parks.json, from uMap),
// so run `node fetch-umap.mjs parks` first when the Parks map has changed.
const parksMap = JSON.parse(readFileSync(join('src', 'static', 'data', 'parks.json'), 'utf8'));
const named = (layer) => parksMap.layers.find((l) => l.name === layer).features
  .map((f) => ({ name: (f.properties.name || '').split('\n')[0].replace(/\s*\+\s*$/, '').trim(), geometry: f.geometry }))
  .filter((f) => f.name);
const parks = named('Parks'), playgrounds = named('Playgrounds');

// Flat metres around Stratford, close enough for distances of a few kilometres.
const toXY = ([lon, lat]) => [lon * 111320 * Math.cos((46.22 * Math.PI) / 180), lat * 110574];
const segDist = (p, a, b) => {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const inRing = (p, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = [ring[i], ring[j]];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
};
// Distance from a point to a feature: 0 inside a polygon, otherwise to its nearest edge.
const distanceTo = (p, g) => {
  if (g.type === 'Point') return Math.hypot(...toXY(g.coordinates).map((v, i) => v - p[i]));
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  let best = Infinity;
  for (const rings of polys) {
    const xy = rings.map((r) => r.map(toXY));
    if (inRing(p, xy[0]) && !xy.slice(1).some((h) => inRing(p, h))) return 0;
    for (const r of xy) for (let i = 1; i < r.length; i++) best = Math.min(best, segDist(p, r[i - 1], r[i]));
  }
  return best;
};
const nearest = (list, lon, lat) => {
  const p = toXY([lon, lat]);
  let best = null;
  for (const f of list) { const m = distanceTo(p, f.geometry); if (!best || m < best.m) best = { name: f.name, m }; }
  return best && [best.name, Math.round(best.m)];
};

// Street names come in capitals with short endings ("SAULS PRIDE CR"): spell them out the way people write them.
const ENDINGS = { AV: 'Avenue', BL: 'Boulevard', CL: 'Close', CR: 'Crescent', CRT: 'Court', DR: 'Drive', GT: 'Gate', HT: 'Heights', HTS: 'Heights', HWY: 'Highway', LG: 'Landing', LN: 'Lane', PL: 'Place', RD: 'Road', RW: 'Row', ST: 'Street', TERR: 'Terrace', WY: 'Way' };
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, a, b) => a + b.toUpperCase()).replace(/\bMc([a-z])/g, (_, c) => 'Mc' + c.toUpperCase()).replace(/\bMac([a-z])(?=[a-z]{3})/g, (_, c) => 'Mac' + c.toUpperCase());
const streetName = (s) => {
  const words = s.trim().split(/\s+/);
  const end = ENDINGS[words.at(-1)];
  return titleCase(end ? words.slice(0, -1).join(' ') : words.join(' ')) + (end ? ' ' + end : '');
};

const addresses = rows.map((r) => [
  r.no, ref('streets', streetName(r.street)), r.lon, r.lat,
  ref('wards', r.ward), ref('districts', r.district), ref('collection', r.cart && { cart: r.cart, bluebag: r.bluebag }),
  ref('zones', r.zones?.sort() ?? null),
  // The house point being in a flood area is the stronger warning; otherwise the lot counts if at least 10% of it is.
  ref('flood', r.flood ? { where: 'house', types: r.flood.sort() } : r.lotflood ? { where: 'lot', types: r.lotflood.sort() } : null),
  r.stop && [ref('stops', { name: r.stop.name, routes: r.stop.routes ? r.stop.routes.split('|') : [] }), r.stop.m],
  ...[parks, playgrounds].map((list, i) => {
    const n = nearest(list, r.lon, r.lat);
    return n && [ref(i ? 'playgrounds' : 'parks', n[0]), n[1]];
  }),
]);

const out = {
  updated: new Date().toISOString().slice(0, 10),
  fields: ['no', 'street', 'lon', 'lat', 'ward', 'district', 'collection', 'zones', 'flood', 'stop', 'park', 'playground'],
  ...Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.items])),
  addresses,
};
writeFileSync(join('src', 'static', 'data', 'lookup.json'), JSON.stringify(out));
console.log(`${addresses.length} addresses written to src/static/data/lookup.json`);
for (const [k, v] of Object.entries(lists)) console.log(`  ${k}: ${v.items.length}`);
