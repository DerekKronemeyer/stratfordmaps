// Builds src/static/data/lookup.json for the Address Lookup page: every Stratford civic address with its
// ward, provincial district, collection days, zoning, flood areas and nearest bus stop, park and playground.
// Usage: `node fetch-lookup.mjs`. Needs read access to the PEI data hub database; the command that runs
// psql against it comes from HUB_PSQL in a local .env file (not committed), for example:
//   HUB_PSQL=ssh you@server docker exec -i db psql -U user -d datahub -At
// The output is committed, so building and deploying never depend on the hub being up.
// People and phone numbers are not here: they live in src/lookup.json and are kept by hand.
import { writeFileSync } from 'node:fs';
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
  'stop', (select json_build_object('name', s.name, 'm', round(st_distance(s.geom::geography, a.geom::geography)), 'routes', s.routes)
           from stops s order by s.geom <-> a.geom limit 1),
  'park', (select json_build_object('name', p.attrs->>'Name', 'm', round(st_distance(p.geom::geography, a.geom::geography)))
           from canonical.feature p where p.dataset_id = 'stratford_parks_open_space' and p.attrs->>'Name' ~* '\mpark\M' and p.attrs->>'Name' !~* '^open space|dog park|skate park|business park'
           order by p.geom <-> a.geom limit 1),
  'playground', (select json_build_object('name', p.attrs->>'name', 'm', round(st_distance(p.geom::geography, a.geom::geography)))
           from canonical.feature p where p.dataset_id = 'pei_recreation_facilities' and p.attrs->>'type' = 'Park Playground'
           order by p.geom <-> a.geom limit 1)
) from addr a order by a.street, a.no;
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

// A few playground names in the Province's data are misspelled; these match the Town's park names.
const FIX = {
  "Fullterton's Creek Conservation Park": 'Fullertons Creek Conservation Park', 'Patridge Park': 'Partridge Lane Park', 'Bunbary Park': 'Bunbury Park',
  'Willliams Gate Park': 'Williams Gate Park', 'Ponside Park': 'Pondside Park', 'Kinloch Park': 'Kinlock Park',
};
const fix = (name) => FIX[name.trim()] ?? name.trim();

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
  ref('zones', r.zones?.sort() ?? null), ref('flood', r.flood?.sort() ?? null),
  r.stop && [ref('stops', { name: r.stop.name, routes: r.stop.routes ? r.stop.routes.split('|') : [] }), r.stop.m],
  r.park && [ref('parks', fix(r.park.name)), r.park.m],
  r.playground && [ref('playgrounds', fix(r.playground.name)), r.playground.m],
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
