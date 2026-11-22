# Walking network for Directions on the Walking map (src/static/route.js): the Walking map's Walking Routes + the
# Province road centrelines (roads.geojson), joined into one network, with every piece tagged for the three toggles
# (quiet streets, sidewalks and trails) and for road crossings. Crosswalks = wherever a Walking Routes line crosses a road
# (Derek 2026-11-22: the separate Crosswalks layer was dropped).
# Reads src/static/data/walking.json (from `node fetch-umap.mjs`) and writes src/static/data/walking-network.json.
# Runs in elsa's nightly stratfordmaps-sync right after the uMap fetch (Python venv ~/stratfordmaps-venv with shapely).
# It only rebuilds when its inputs changed (Walking Routes, this script, roads, town): their
# fingerprint is stored in the output as "src". `--force` rebuilds anyway; `--review DIR` also writes review GeoJSON.
# Local: python jobs/walking_network/build.py
import json, math, collections, hashlib, sys
from pathlib import Path
from shapely.geometry import shape, Point, LineString
from shapely.strtree import STRtree
import shapely

HERE = Path(__file__).resolve().parent
SITE = HERE.parents[1] / 'src' / 'static' / 'data'
OUT = SITE / 'walking-network.json'
REVIEW = Path(sys.argv[sys.argv.index('--review') + 1]) if '--review' in sys.argv else None

# Local metres (equirectangular around Stratford; error well under 1% across the town).
LAT0 = 46.22
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110574
to_m = lambda g: shapely.transform(g, lambda c: c * (KX, KY))
to_ll = lambda x, y: [round(x / KX, 6), round(y / KY, 6)]

# Rules (Derek, 2026-11-21)
BUSY = {'TRANS CANADA HWY', 'TRANS CANADA HWY - RTE 1', 'RAMP', 'STRATFORD RD', 'BUNBURY RD', 'BUNBURY RD - RTE 21',
        'KEPPOCH RD', 'KINLOCK RD', 'GEORGETOWN RD', 'HOPETON RD', 'JUBILEE RD'}  # Hopeton + Jubilee added by Derek 2026-11-23
TCH = {'TRANS CANADA HWY', 'TRANS CANADA HWY - RTE 1', 'RAMP'}  # crossed only where a walking route crosses it (crosswalks, underpass)
BESIDE_M, BESIDE_DEG = 25, 35  # a route piece this close to a busy road and this parallel to it = beside it (busy)
SIDEWALK_M = 15                 # a walking route this close to a road centreline and parallel to it is a sidewalk; otherwise a trail
# (2026-11-23: a 12 m limit was tried and dropped: it misclassed paths beside wide roads; Derek prefers the simpler rule)
HALF_M = 6                     # length of each half of a crossing (either side of the busy road's centreline)
JOIN_ROUTE_M = 5               # route end this close to another route: joined
JOIN_ROAD_M = 15               # route end this close to a road (and no route within JOIN_ROUTE_M): joined to the road
GAP_REVIEW_M = 30              # route end with another route 5-30 m away: listed for review
JOIN_ROADROAD_M = 6            # road end this close to another road: joined (same as Housing Density)
# Walking route crossings that go UNDER or OVER the road (not a crosswalk; steps say "Go under"): (lat, lng, note)
UNDERPASSES = [(46.22773, -63.09759, 'TCH underpass, route-012 (Derek, 2026-11-21)')]
NO_LANES_M = 30                 # walking IN the lanes of a busy road is never allowed within this of a walking route (sidewalk, crosswalk line)
SIDE_M, SIDE_DEG = 20, 35        # a road stretch with a walking route this close and this parallel has a sidewalk alongside
STEP_M = 5                     # pieces are judged every 5 m for beside-busy

# Flags per network piece
INFRA, BUSYF, SIDE, CROSS, CROSS_OK, NOGO, XBUSY, UNDER, WALK = 1, 2, 4, 8, 16, 32, 64, 128, 256  # WALK: a walking route that is a sidewalk (beside a road), not a trail; SIDE: sidewalk/trail alongside; CROSS_OK: at a crosswalk; XBUSY: crossing of a busy road; UNDER: underpass

# Province street names (ALL CAPS, abbreviated) -> "Billy MacMillan Drive" (same as the Housing Density scripts)
WORDS = {'RD': 'Road', 'DR': 'Drive', 'ST': 'Street', 'AVE': 'Avenue', 'AV': 'Avenue', 'LN': 'Lane', 'CRES': 'Crescent', 'CR': 'Crescent',
         'CRT': 'Court', 'CT': 'Court', 'WY': 'Way', 'HTS': 'Heights', 'HT': 'Heights', 'TERR': 'Terrace', 'TER': 'Terrace', 'TSSE': 'Terrace',
         'PL': 'Place', 'BLVD': 'Boulevard', 'CL': 'Close', 'GT': 'Gate', 'GR': 'Grove', 'HWY': 'Highway', 'TRL': 'Trail', 'RW': 'Row', 'PT': 'Point',
         'ST.': 'St.', 'PK': 'Park', 'LANDING': 'Landing', 'CIR': 'Circle', 'SQ': 'Square', 'RDG': 'Ridge', 'VW': 'View', 'XING': 'Crossing'}


WORDS.update({'LG': 'Landing', 'BL': 'Boulevard'})
MAC = {'MACDONALD': 'MacDonald', 'MACINTOSH': 'MacIntosh', 'MACLAUCHLAN': 'MacLauchlan', 'MACNEILL': 'MacNeill', 'MACPHERSON': 'MacPherson',
       'MACMILLAN': 'MacMillan'}  # Macbeth Court stays Macbeth (Shakespeare)


def nice(s):
    words = (s or '').split()
    out = []
    for i, w in enumerate(words):
        if i == 0 and w in ('ST', 'ST.') and len(words) > 2:
            out.append('St.')  # Saint, not Street, at the start
        elif i == 0 and w == 'DR' and len(words) > 2:
            out.append('Dr.')
        elif w in MAC:
            out.append(MAC[w])
        elif w.startswith('MC') and len(w) > 2:
            out.append('Mc' + w[2:].capitalize())
        elif i == len(words) - 1 or w not in ('ST', 'DR'):
            out.append(WORDS.get(w, w.capitalize()) if i == len(words) - 1 else w.capitalize())
        else:
            out.append(w.capitalize())
    return ' '.join(out)


AREA = to_m(shape(json.load(open(HERE / 'town.geojson'))['geometry']).buffer(20 / 77000))
NOT_BUILT = {15878}  # Lorne Drive north of the highway: in the Province's data, not on the ground (Derek, 2026-11-21)

walking = json.load(open(SITE / 'walking.json', encoding='utf-8'))
layer = lambda name: next(l for l in walking['layers'] if l['name'] == name)['features']

# Skip the build when nothing it reads has changed since the last one.
fingerprint = hashlib.sha256(json.dumps([layer(n) for n in ('Walking Routes',)], sort_keys=True).encode()
                             + b''.join((HERE / n).read_bytes() for n in ('build.py', 'roads.geojson', 'town.geojson'))).hexdigest()[:16]
if '--force' not in sys.argv and OUT.exists() and json.loads(OUT.read_text(encoding='utf-8')).get('src') == fingerprint:
    print('walking network: inputs unchanged, not rebuilt')
    sys.exit(0)

# ---- inputs -----------------------------------------------------------------------------------------------------------
lines = []  # dicts: kind route|road|link, geom (metres), name (road name or ''), raw (Province name), busy_override, id
for f in layer('Walking Routes'):
    g = to_m(shape(f['geometry']))
    for p in (g.geoms if hasattr(g, 'geoms') else [g]):
        if p.length > 0.5:
            ov = str(f['properties'].get('Busy', '')).strip().lower()
            lines.append({'kind': 'route', 'geom': p, 'name': '', 'raw': '', 'id': f['properties'].get('id'),
                          'override': True if ov in ('yes', 'true') else False if ov in ('no', 'false') else None})
seen = set(NOT_BUILT)
for f in json.load(open(HERE / 'roads.geojson', encoding='utf-8'))['features']:
    oid = f['properties'].get('OBJECTID')
    if oid in seen:
        continue
    seen.add(oid)
    raw = (f['properties'].get('NAME') or '').strip()
    g = to_m(shape(f['geometry'])).intersection(AREA)
    for p in (g.geoms if hasattr(g, 'geoms') else [g]):
        if p.geom_type == 'LineString' and p.length > 0.5:
            lines.append({'kind': 'road', 'geom': p, 'name': nice(raw), 'raw': raw, 'id': oid, 'override': None})

is_busy_road = lambda L: L['kind'] == 'road' and L['raw'] in BUSY
is_tch = lambda L: L['kind'] == 'road' and L['raw'] in TCH
busy_roads = [L['geom'] for L in lines if is_busy_road(L)]
busy_names = [L['name'] for L in lines if is_busy_road(L)]
busy_raw = [L['raw'] for L in lines if is_busy_road(L)]
busy_tree = STRtree(busy_roads)

# ---- junctions ----------------------------------------------------------------------------------------------------------
geoms = [L['geom'] for L in lines]
tree = STRtree(geoms)
cuts = collections.defaultdict(list)       # line index -> distances along it to put a junction
crossings = []                             # (route index, distance along route, busy road index, point)
road_junctions = collections.defaultdict(set)  # busy-road junction point (rounded) -> indexes of non-busy roads meeting it
links, gaps = [], []


def nearest(pt, tol, want):
    best = None
    for j in tree.query(pt.buffer(tol)):
        if want(j):
            d = geoms[j].distance(pt)
            if d < tol and (best is None or d < best[1]):
                best = (j, d)
    return best


for i, L in enumerate(lines):
    p = L['geom']
    for j in tree.query(p):
        if j <= i:
            continue
        x = p.intersection(geoms[j])
        for q in (x.geoms if hasattr(x, 'geoms') else [x]):
            if q.geom_type != 'Point':
                continue
            cuts[i].append(p.project(q)); cuts[j].append(geoms[j].project(q))
            a, b = (i, j) if L['kind'] == 'route' else (j, i)
            if lines[a]['kind'] == 'route' and lines[b]['kind'] == 'road':  # busy and quiet roads 
                crossings.append((a, geoms[a].project(q), b, q))
            if L['kind'] == 'road' and lines[j]['kind'] == 'road' and is_busy_road(L) != is_busy_road(lines[j]):
                side = j if is_busy_road(L) else i
                road_junctions[(round(q.x, 1), round(q.y, 1))].add((side, geoms[side].project(q)))
    for end in (Point(p.coords[0]), Point(p.coords[-1])):
        if L['kind'] == 'route':
            hit = nearest(end, JOIN_ROUTE_M, lambda j: j != i and lines[j]['kind'] == 'route')
            if not hit:
                hit = nearest(end, JOIN_ROAD_M, lambda j: lines[j]['kind'] == 'road')
                near_route = nearest(end, GAP_REVIEW_M, lambda j: j != i and lines[j]['kind'] == 'route')
                if near_route:
                    q = geoms[near_route[0]].interpolate(geoms[near_route[0]].project(end))
                    gaps.append({'at': end, 'to': q, 'gap_m': round(near_route[1], 1), 'joined_to_road': bool(hit), 'route': L['id']})
        else:
            hit = nearest(end, JOIN_ROADROAD_M, lambda j: j != i and lines[j]['kind'] == 'road')
        if hit:
            j, d = hit
            dd = geoms[j].project(end)
            cuts[j].append(dd)
            q = geoms[j].interpolate(dd)
            if d > 0.05:
                links.append({'kind': 'link', 'geom': LineString([end, q]), 'name': '', 'raw': '', 'id': None, 'override': None,
                              'busy_target': is_busy_road(lines[j]), 'tch_target': is_tch(lines[j]), 'from': L['kind'], 'target': lines[j]['name']})
            if L['kind'] == 'road' and lines[j]['kind'] == 'road' and is_busy_road(L) != is_busy_road(lines[j]):
                side = i if not is_busy_road(L) else None
                if side is not None:
                    road_junctions[(round(q.x, 1), round(q.y, 1))].add((i, p.project(end)))

# ---- crossing halves: the HALF_M of route/side-street either side of a busy road's centreline -----------------------
cross_spans = collections.defaultdict(list)  # line index -> [(from, to, ok, nogo, junction point)]
cross_review = []


def underpass(q):
    return any(Point(lng * KX, lat * KY).distance(q) <= 15 for lat, lng, _ in UNDERPASSES)


for a, d, b, q in crossings:
    busy = is_busy_road(lines[b])
    ok = True  # a Walking Routes line across a road = a crosswalk (or an underpass)
    nogo = False
    cross_spans[a].append((max(0, d - HALF_M), min(geoms[a].length, d + HALF_M), ok, nogo, busy, lines[b]['name'], underpass(q)))
    cuts[a] += [max(0, d - HALF_M), min(geoms[a].length, d + HALF_M)]
    cross_review.append({'at': q, 'road': lines[b]['name'], 'via': 'walking route', 'busy': busy, 'crosswalk': ok, 'blocked': nogo, 'route': lines[a]['id']})
for key, sides in road_junctions.items():
    q = Point(key)
    busy_here = [j for j in busy_tree.query(q.buffer(1)) if busy_roads[j].distance(q) < 1]
    road = busy_names[busy_here[0]] if busy_here else ''
    tch = any(busy_raw[j] in TCH for j in busy_here)
    ok = False  # street-to-street across a busy road with no walking route line: not a crosswalk
    nogo = tch
    for side, d in sides:
        lo, hi = (d, min(geoms[side].length, d + HALF_M)) if d < geoms[side].length / 2 else (max(0, d - HALF_M), d)
        cross_spans[side].append((lo, hi, ok, nogo, True, road, False))
        cuts[side] += [lo, hi]
    cross_review.append({'at': q, 'road': road, 'via': 'street', 'busy': True, 'crosswalk': ok, 'blocked': nogo, 'route': None})

# Where a side street meets a busy road and the nearest sidewalk is on the FAR side, add a link straight across the busy
# road to it. Walking in a busy road's lanes is off-limits (NO_LANES_M), so without this, streets like Bellevue Road
# (sidewalk only across Keppoch Road) would be cut off.
ACROSS_M = 40
for key, sides in road_junctions.items():
    q = Point(key)
    busy_here = [j for j in busy_tree.query(q.buffer(1)) if busy_roads[j].distance(q) < 1]
    if not busy_here:
        continue
    r = busy_roads[busy_here[0]]
    t = r.project(q)
    a, b = r.interpolate(max(0, t - 5)), r.interpolate(min(r.length, t + 5))
    side_of = lambda pt: (b.x - a.x) * (pt.y - q.y) - (b.y - a.y) * (pt.x - q.x)  # + left of the busy road, - right
    street_sides = set()
    for si, d in sides:
        g = geoms[si]
        away = g.interpolate(min(g.length, d + 10) if d < g.length / 2 else max(0, d - 10))
        street_sides.add(side_of(away) > 0)
    if len(street_sides) != 1:
        continue  # side streets on both sides: they already connect across the junction
    best = None
    for j in tree.query(q.buffer(ACROSS_M)):
        if lines[j]['kind'] != 'route' or geoms[j].distance(q) > ACROSS_M:
            continue
        dj = geoms[j].project(q)
        qq = geoms[j].interpolate(dj)
        if (side_of(qq) > 0) in street_sides or qq.distance(q) < 1:
            continue  # same side as the street: reached by crossing the side street instead
        if best is None or qq.distance(q) < best[0]:
            best = (qq.distance(q), j, dj, qq)
    if best:
        _, j, dj, qq = best
        cuts[j].append(dj)
        tch = any(busy_raw[k] in TCH for k in busy_here)
        links.append({'kind': 'xlink', 'geom': LineString([q, qq]), 'name': busy_names[busy_here[0]],
                      'flags': CROSS | XBUSY | BUSYF | (NOGO if tch else 0)})  # no route line across here: not a crosswalk

# ---- split into pieces and tag them -----------------------------------------------------------------------------------
def sub(line, a, b):
    from shapely.ops import substring
    return substring(line, a, b)


def beside_busy(seg):
    mid = seg.interpolate(0.5, normalized=True)
    (x1, y1), (x2, y2) = seg.coords[0], seg.coords[-1]
    ang = math.degrees(math.atan2(y2 - y1, x2 - x1))
    for j in busy_tree.query(mid.buffer(BESIDE_M)):
        r = busy_roads[j]
        if r.distance(mid) > BESIDE_M:
            continue
        t = r.project(mid)
        a, b = r.interpolate(max(0, t - 5)), r.interpolate(min(r.length, t + 5))
        rang = math.degrees(math.atan2(b.y - a.y, b.x - a.x))
        diff = abs((ang - rang + 90) % 180 - 90)
        if diff <= BESIDE_DEG:
            return busy_names[j]
    return None


route_lines = [L['geom'] for L in lines if L['kind'] == 'route']
route_tree = STRtree(route_lines)


def has_sidewalk(seg):
    """A walking route runs alongside this road stretch (Derek 2026-11-22: then use it, even when Sidewalks and trails is Any)."""
    mid = seg.interpolate(0.5, normalized=True)
    (x1, y1), (x2, y2) = seg.coords[0], seg.coords[-1]
    ang = math.degrees(math.atan2(y2 - y1, x2 - x1))
    for j in route_tree.query(mid.buffer(SIDE_M)):
        r = route_lines[j]
        if r.distance(mid) > SIDE_M:
            continue
        t = r.project(mid)
        a, b = r.interpolate(max(0, t - 5)), r.interpolate(min(r.length, t + 5))
        if abs((ang - math.degrees(math.atan2(b.y - a.y, b.x - a.x)) + 90) % 180 - 90) <= SIDE_DEG:
            return True
    return False


all_roads = [L['geom'] for L in lines if L['kind'] == 'road']
all_road_tree = STRtree(all_roads)


def is_sidewalk(seg):
    """This walking route stretch runs right beside a road, parallel to it (Derek 2026-11-23: sidewalk, not trail)."""
    mid = seg.interpolate(0.5, normalized=True)
    (x1, y1), (x2, y2) = seg.coords[0], seg.coords[-1]
    ang = math.degrees(math.atan2(y2 - y1, x2 - x1))
    for j in all_road_tree.query(mid.buffer(SIDEWALK_M)):
        r = all_roads[j]
        if r.distance(mid) > SIDEWALK_M:
            continue
        t = r.project(mid)
        a, b = r.interpolate(max(0, t - 5)), r.interpolate(min(r.length, t + 5))
        if abs((ang - math.degrees(math.atan2(b.y - a.y, b.x - a.x)) + 90) % 180 - 90) <= BESIDE_DEG:
            return True
    return False


names = ['']
name_ix = lambda n: names.index(n) if n in names else (names.append(n) or len(names) - 1)
pieces = []  # [flags, name, LineString]
beside_review = collections.defaultdict(float)

for i, L in enumerate(lines + links):
    g = L['geom']
    if L['kind'] == 'xlink':
        pieces.append([L['flags'], L['name'], g])
        continue
    if L['kind'] == 'link':
        flags = INFRA if L['from'] == 'route' else 0
        if L['from'] == 'route':  # stepping from a walking route onto a road = half a road crossing, never a crosswalk
            flags |= CROSS | (BUSYF if L['busy_target'] else 0) | (NOGO if L['tch_target'] else 0) | (XBUSY if L['busy_target'] else 0)
        elif L['busy_target']:
            flags |= BUSYF
        pieces.append([flags, L['target'] if L['from'] == 'route' else '', g])
        continue
    ds = sorted({0, g.length, *[c for c in cuts.get(i, []) if 0 < c < g.length]})
    spans = cross_spans.get(i, [])
    for a, b in zip(ds, ds[1:]):
        if b - a < 0.05:
            continue
        part = sub(g, a, b)
        mid_d = (a + b) / 2
        cs = [s for s in spans if s[0] - 0.01 <= mid_d <= s[1] + 0.01]
        base = INFRA if L['kind'] == 'route' else 0
        if cs:
            c = cs[0]
            flags = base | CROSS | (CROSS_OK if c[2] and c[4] and not c[6] else 0) | (BUSYF if c[4] and not c[2] else 0) | (NOGO if c[3] else 0) | (XBUSY if c[4] else 0) | (UNDER if c[6] else 0)
            pieces.append([flags, c[5], part])  # crossing pieces carry the crossed road's name
            continue
        # judge every STEP_M for beside-busy (routes), then merge runs with the same flags
        n = max(1, round(part.length / STEP_M))
        run_start, run_flags, run_name = 0.0, None, None
        for k in range(n):
            s0, s1 = part.length * k / n, part.length * (k + 1) / n
            seg = sub(part, s0, s1)
            flags, nm = base, L['name']
            if L['kind'] == 'road' and is_busy_road(L):
                flags |= BUSYF
                # No walking in the lanes of the TCH, or of any busy road where a sidewalk or crosswalk is close by
                # (Derek 2026-11-22: routes cut diagonally through the Kinlock / TCH intersection).
                mid = seg.interpolate(0.5, normalized=True)
                if is_tch(L) or any(route_lines[j].distance(mid) <= NO_LANES_M for j in route_tree.query(mid.buffer(NO_LANES_M))):
                    flags |= NOGO
            if L['kind'] == 'road' and has_sidewalk(seg):
                flags |= SIDE
            elif L['kind'] == 'route':
                if is_sidewalk(seg):
                    flags |= WALK
                bb = beside_busy(seg) if L['override'] is None else (None if L['override'] is False else 'override')
                if bb:
                    flags |= BUSYF
                    if bb != 'override':
                        nm = bb
                        beside_review[L['id']] += seg.length
            if run_flags is None:
                run_flags, run_name = flags, nm
            elif (flags, nm) != (run_flags, run_name):
                pieces.append([run_flags, run_name, sub(part, run_start, s0)])
                run_start, run_flags, run_name = s0, flags, nm
        pieces.append([run_flags, run_name, sub(part, run_start, part.length)])

# ---- graph + output -----------------------------------------------------------------------------------------------------
node_ix, nodes = {}, []
def node(c):
    k = (round(c[0], 1), round(c[1], 1))  # 10 cm in metres
    if k not in node_ix:
        node_ix[k] = len(nodes); nodes.append(to_ll(*c))
    return node_ix[k]

edges, edge_geoms = [], []
for flags, nm, g in pieces:
    cs = list(g.coords)
    a, b = node(cs[0]), node(cs[-1])
    if a == b and g.length < 0.5:
        continue
    mid = [c for xy in cs[1:-1] for c in to_ll(*xy)]
    edges.append([a, b, flags, name_ix(nm), round(g.length, 1), mid])
    edge_geoms.append(g)
OUT.write_text(json.dumps({'v': 1, 'src': fingerprint, 'flags': {'infra': INFRA, 'busy': BUSYF, 'side': SIDE, 'cross': CROSS, 'crossOk': CROSS_OK, 'nogo': NOGO, 'crossBusy': XBUSY, 'under': UNDER, 'sidewalk': WALK},
                           'names': names, 'nodes': nodes, 'edges': edges}, separators=(',', ':')), encoding='utf-8')

# A gap is only real if the network can't get from the dead end to the nearby route without a detour (e.g. route-043 at
# Barkley Avenue runs along its own "gap" to the fork: not a gap). Keep it if no path within 2 x gap + 20 m reaches it.
import heapq
gadj = collections.defaultdict(list)
for k, (a, b, *_rest) in enumerate(edges):
    gadj[a].append((b, k)); gadj[b].append((a, k))
def reaches(end, to, limit):
    start = node_ix.get((round(end.x, 1), round(end.y, 1)))
    if start is None:
        return False
    dist, todo = {start: 0.0}, [(0.0, start)]
    while todo:
        d, n = heapq.heappop(todo)
        if d > dist.get(n, 1e18) or d > limit:
            continue
        for m, k in gadj[n]:
            if edge_geoms[k].distance(to) < 1:
                return True
            nd = d + edges[k][4]
            if nd < dist.get(m, 1e18):
                dist[m] = nd; heapq.heappush(todo, (nd, m))
    return False
before = len(gaps)
gaps = [g for g in gaps if not reaches(g['at'], g['to'], 2 * g['gap_m'] + 20)]
print(f'gap check: {before} candidates, {before - len(gaps)} already connected nearby, {len(gaps)} listed')

# connectivity
adj = collections.defaultdict(set)
for a, b, *_ in edges:
    adj[a].add(b); adj[b].add(a)
seen, comps = set(), []
for n in adj:
    if n in seen:
        continue
    stack, size = [n], 0; seen.add(n)
    while stack:
        x = stack.pop(); size += 1
        for y in adj[x]:
            if y not in seen:
                seen.add(y); stack.append(y)
    comps.append(size)
comps.sort(reverse=True)

# ---- review files (GeoJSON, lng/lat), for the sandbox review page -------------------------------------------------
if REVIEW:
    REVIEW.mkdir(parents=True, exist_ok=True)
    ll = lambda g: [to_ll(*c) for c in g.coords]
    pt = lambda p: to_ll(p.x, p.y)
    fc = lambda feats: {'type': 'FeatureCollection', 'features': feats}
    json.dump(fc([{'type': 'Feature', 'properties': {'flags': fl, 'name': nm, 'len': round(g.length, 1)}, 'geometry': {'type': 'LineString', 'coordinates': ll(g)}} for fl, nm, g in pieces]),
              open(REVIEW / 'network.geojson', 'w'), separators=(',', ':'))
    json.dump(fc([{'type': 'Feature', 'properties': {'gap_m': g['gap_m'], 'joined_to_road': g['joined_to_road'], 'route': g['route']},
                   'geometry': {'type': 'LineString', 'coordinates': [pt(g['at']), pt(g['to'])]}} for g in gaps]),
              open(REVIEW / 'gaps.geojson', 'w'))
    json.dump(fc([{'type': 'Feature', 'properties': {k: v for k, v in c.items() if k != 'at'}, 'geometry': {'type': 'Point', 'coordinates': pt(c['at'])}} for c in cross_review]),
              open(REVIEW / 'crossings.geojson', 'w'))

total = lambda f: sum(g.length for fl, _, g in pieces if f(fl)) / 1000
print(f'{len(nodes)} nodes, {len(edges)} edges, {OUT.stat().st_size / 1e3:.0f} KB; network pieces {comps[:5]} (+{len(comps) - 5} small)')
print(f'km: walking infra {total(lambda f: f & INFRA):.1f}, roads {total(lambda f: not f & INFRA):.1f}, busy (on or beside) {total(lambda f: f & BUSYF):.1f}, road with a sidewalk alongside {total(lambda f: f & SIDE and not f & INFRA):.1f}, walking routes that are sidewalks {total(lambda f: f & WALK):.1f} (rest are trails)')
print(f'route km beside busy roads: {sum(beside_review.values()) / 1000:.1f} on {len(beside_review)} routes')
print(f'gaps 5-{GAP_REVIEW_M} m: {len(gaps)} ({sum(not g["joined_to_road"] for g in gaps)} not joined to a road either)')
bc = [c for c in cross_review if c['busy']]; qc = [c for c in cross_review if not c['busy']]
print(f'busy-road crossings: {len(bc)}; at crosswalks {sum(c["crosswalk"] for c in bc)}; TCH blocked {sum(c["blocked"] for c in bc)}')
print(f'quiet-road crossings by walking routes: {len(qc)}; at crosswalks {sum(c["crosswalk"] for c in qc)}; route ends stepping onto a road: {sum(1 for L in links if L.get("from") == "route")}; links across busy roads at side streets: {sum(1 for L in links if L["kind"] == "xlink")}')
