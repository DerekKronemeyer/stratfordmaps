# Run nightly by stratfordmaps-sync after fetch-umap (moved here from the sandbox 2026-11-28).
# Street network for the Housing Density "Streets" view: Derek's Roads layer (Streets uMap map, read from the site's
# streets.json, Derek 2026-11-28; was the Province's road centrelines, old version in the sandbox, housing/build_streets_province.py.bak). Service Roads
# are left out (parking lots and lanes aren't streets people's trips are counted on). A shared point is added wherever two
# roads cross or a road ends within 6 m of another, each road keeping its street name. The browser treats points within
# ~1 m as the same junction and routes trips over the network.
# Writes stratfordmaps/src/static/data/housing-density-streets.json: {"names": [...], "edges": [[name index, [[lng,lat],...]], ...], "town": [[lng,lat],...]}.
import json, collections
from pathlib import Path
from shapely.geometry import shape, Point
from shapely.strtree import STRtree

HERE = Path(__file__).resolve().parent
SITE = HERE.parents[1] / 'src' / 'static' / 'data'
OUT = SITE / 'housing-density-streets.json'
AREA = shape(json.load(open(HERE / 'town_boundary.geojson'))).buffer(20 / 77000)  # Stratford only (Derek), ~20 m slack for roads along the edge
DEG = 1 / 77000

_s = json.load(open(SITE / 'streets.json', encoding='utf-8'))
ROADS = next(l for l in _s['layers'] + _s.get('dataOnly', []) if l['name'] == 'Roads')['features']
roads = []
for f in ROADS:
    g = shape(f['geometry']).intersection(AREA)
    for p in (g.geoms if hasattr(g, 'geoms') else [g]):
        if p.geom_type == 'LineString' and p.length > 0:
            roads.append([(f['properties'].get('name') or '').strip(), p])
lines = [p for _, p in roads]
tree = STRtree(lines)
inserts = collections.defaultdict(list)  # line index -> distances along it (degrees) to add a junction point
joins = []  # short unnamed links from a dead end to the road it nearly reaches
for i, p in enumerate(lines):
    for j in tree.query(p):
        if j <= i:
            continue
        x = p.intersection(lines[j])
        for q in (x.geoms if hasattr(x, 'geoms') else [x]):
            if q.geom_type == 'Point':
                inserts[i].append(p.project(q)); inserts[j].append(lines[j].project(q))
    for end in (Point(p.coords[0]), Point(p.coords[-1])):
        near = [j for j in tree.query(end.buffer(6 * DEG)) if j != i and lines[j].distance(end) < 6 * DEG]
        if near:
            j = min(near, key=lambda j: lines[j].distance(end))
            d = lines[j].project(end)
            inserts[j].append(d)
            q = lines[j].interpolate(d)
            if q.distance(end) > 0.01 * DEG:  # always join, even under a metre: nearby points can still round apart
                joins.append([[end.x, end.y], [q.x, q.y]])


def with_points(p, ds):
    coords = list(p.coords)
    acc, out = [0.0], [coords[0]]
    for a, b in zip(coords, coords[1:]):
        acc.append(acc[-1] + Point(a).distance(Point(b)))
    ds = sorted(d for d in ds if 0 < d < p.length)
    k = 0
    for n in range(1, len(coords)):
        while k < len(ds) and ds[k] < acc[n]:
            q = p.interpolate(ds[k]); out.append((q.x, q.y)); k += 1
        out.append(coords[n])
    return out


names, edges = [], []
for i, (name, p) in enumerate(roads):
    if name not in names:
        names.append(name)
    edges.append([names.index(name), [[round(x, 6), round(y, 6)] for x, y in with_points(p, inserts[i])]])
if '' not in names:
    names.append('')
edges += [[names.index(''), [[round(x, 6), round(y, 6)] for x, y in j]] for j in joins]
town = shape(json.load(open(HERE / 'town_boundary.geojson'))).simplify(5 / 77000)
town_ring = [[round(x, 5), round(y, 5)] for x, y in town.exterior.coords]  # for "that spot is outside Stratford"
OUT.write_text(json.dumps({'names': names, 'edges': edges, 'town': town_ring}, separators=(',', ':')), encoding='utf-8')

key = lambda c: (round(c[0], 5), round(c[1], 5))  # ~1 m, the same as the browser
adj = collections.defaultdict(set)
for _, cs in edges:
    for a, b in zip(cs, cs[1:]):
        adj[key(a)].add(key(b)); adj[key(b)].add(key(a))
seen, comps = set(), []
for n in adj:
    if n in seen:
        continue
    stack, size = [n], 0
    seen.add(n)
    while stack:
        x = stack.pop(); size += 1
        for y in adj[x]:
            if y not in seen:
                seen.add(y); stack.append(y)
    comps.append(size)
comps.sort(reverse=True)
print(f'{len(edges)} lines ({len(joins)} short joins), {len(adj)} points; network pieces: {comps[:6]} (+{len(comps) - 6} more); {OUT.stat().st_size / 1e3:.0f} KB')
