# Walking network for Navigation on the Walking map (src/static/route.js): the Walking map's Walking Routes plus the
# Streets map's Roads and service-road layers, joined into one network. Every piece is tagged for the Navigation toggles
# (quiet streets, sidewalks and trails) and for road crossings. A Walking Routes line across a road is a crosswalk.
# People walk along the EDGES of a road, not its middle: each road gets a width, they merge into one road surface, and its
# outline is where people walk. Corners, curves, roundabouts and dead ends all come out of that one shape.
# The rules are general (Derek: no one-off fixes for particular streets; it should work for any town's data).
# Reads src/static/data/walking.json and streets.json (from `node fetch-umap.mjs`), writes src/static/data/walking-network.json.
# Runs in elsa's nightly stratfordmaps-sync after the uMap fetch, and only rebuilds when its inputs or this script changed
# (their fingerprint is stored in the output as "src"). `--force` rebuilds anyway; `--review DIR` also writes review GeoJSON.
# Local: python jobs/walking_network/build.py
import json, math, collections, hashlib, heapq, sys
from pathlib import Path
import shapely
from shapely.geometry import shape, Point, LineString, Polygon
from shapely.ops import substring, unary_union, polygonize
from shapely.strtree import STRtree

HERE = Path(__file__).resolve().parent
SITE = HERE.parents[1] / 'src' / 'static' / 'data'
OUT = SITE / 'walking-network.json'
REVIEW = Path(sys.argv[sys.argv.index('--review') + 1]) if '--review' in sys.argv else None

# Local metres (equirectangular around Stratford; error well under 1% across the town).
LAT0 = 46.22
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110574
to_m = lambda g: shapely.transform(g, lambda c: c * (KX, KY))
to_ll = lambda x, y: [round(x / KX, 6), round(y / KY, 6)]


def heading(g, t, half):
    # direction (degrees) of line g at distance t along it, measured over +-half metres
    a, b = g.interpolate(max(0, t - half)), g.interpolate(min(g.length, t + half))
    return math.degrees(math.atan2(b.y - a.y, b.x - a.x))


def angle_off(a1, a2):
    # how far apart two directions are, ignoring which way along they run: 0 (parallel) to 90 (square)
    return abs((a1 - a2 + 90) % 180 - 90)


def alongside(pt, ang, geoms, tree, tol, half=5, other=None):
    # index of a line in geoms that runs beside pt (within tol, within PARALLEL_DEG of direction ang, and not past its own
    # end), or None. With `other` (the matching point across the street) the line must also be nearer pt than other.
    for j in tree.query(pt.buffer(tol)):
        g = geoms[j]
        d = g.distance(pt)
        if d > tol or (other is not None and g.distance(other) <= d):
            continue
        t = g.project(pt)
        if t < PAST_END_M or t > g.length - PAST_END_M:
            continue  # past the end of that line (a path carrying on from a road end, or ending at the road)
        if angle_off(ang, heading(g, t, half)) <= PARALLEL_DEG:
            return j
    return None


def short_runs(vals, on, step, min_len):
    # (first, last) index of each run of consecutive equal values in vals that `on` accepts and that is shorter than min_len
    k, out = 0, []
    while k < len(vals):
        j = k
        while j + 1 < len(vals) and vals[j + 1] == vals[k]:
            j += 1
        if on(vals[k]) and (j - k + 1) * step < min_len:
            out.append((k, j))
        k = j + 1
    return out

# ---- settings ---------------------------------------------------------------------------------------------------------
# What the data means (Roads layer Type values; layers)
BUSY_TYPES = {'Arterial', 'Highway'}    # busy roads
HIGHWAY_TYPE = 'Highway'                # crossed only on a walking route (a drawn crosswalk or a grade-separated crossing)
SERVICE_TYPE = 'Service'                # parking aisles, drive-through and service lanes, shared driveways (Derek 2026-11-27):
SERVICE_NAME = 'Service road'           # narrow, never busy, no crossings of the road they join (their own mouth is crossed)
SERVICE_LAYERS = ['New service roads']  # Streets map layers whose lines are all service roads (field Unpaved)
PRIVATE_TYPE = 'Private'                # private roads: tagged, so Navigation can avoid them unless ticked
LOW_TIDE_LAYERS = ['Low Tide Hike']     # Walking map layers that are only walkable at low tide: tagged, off unless ticked
# Road widths: metres from the centreline to each edge
SIDE_OFFSET = {False: 4, True: 6}       # quiet / busy street (Derek 2026-11-23)
NARROW_OFFSET = 3                       # private or unpaved road (Derek 2026-11-25)
SERVICE_OFFSET = 2                      # service road (Derek 2026-11-27)
# Joining things up
JOIN_ROADROAD_M = 6       # a road end this close to another road is extended onto it (same as Housing Density)
JOIN_ROUTE_M = 5          # a walking route end this close to another route is joined to it
ROUTE_TO_SIDE_M = 15      # a walking route end this close to a road edge steps onto it
STEP_LINK_M = 12          # a road edge that stops where a sidewalk takes over joins it if it's this close
TRIM_IN_ROAD_M = 15       # a walking route that ends inside a road stops at the road edge, if that's no more than this back
# Sidewalks: a walking route alongside a road
SIDEWALK_M = 15           # within this of a road's centreline and parallel to it = that road's sidewalk (else a trail)...
SIDEWALK_MIN_M = 25       # ...for at least this long (Derek 2026-11-25)
COVER_M = 10              # a road edge with its road's sidewalk this close alongside is left out (the sidewalk replaces it)
BESIDE_M = 25             # a walking route this close to a busy road and parallel to it is "beside a busy street"
PARALLEL_DEG = 35         # "parallel" = within this many degrees
PAST_END_M = 2            # a route only runs alongside a road where the road continues beside it, not past the road's end
STEP_M = 5                # roads and routes are judged in pieces this long
# The road surface
HOLE_MIN_M2 = 300         # an enclosed area is filled in when smaller than this (a splitter island)...
SLIVER_HALF_M = 4         # ...or nowhere wider than twice this (a sliver between close roads), or inside a closed-loop road
LABEL_SLACK_M = 3         # at a corner a road edge belongs to the street it runs along if that one is within this of the nearest
SCRAP_M = 20              # road-edge bits shorter than this that only touch sidewalks/joins are left out
# Crossings
THROUGH_DEG = 40          # two arms of a junction this close to a straight line are the road running through it
CROSS_REACH_M = 8         # a crossing reaches this far past the road edge to land on a sidewalk
CROSSWALK_NEAR_M = 25     # no crossing of a street the build adds within this of a drawn crosswalk over it
CROSSWALK_MIN_DEG = 30    # a route end crossing a road centreline this steeply (and mid-road) is a crosswalk drawn short...
DEAD_END_ZONE_M = 10      # ...but one meeting a road this close to its dead end is a trail leading into the end of the road
FAR_DEDUPE_M = 10         # paths meeting a street from both sides within this get one crossing between them
# Review page
GAP_REVIEW_M = 30         # walking route ends with another route 5-30 m away are listed
ROAD_END_REVIEW_M = 30    # road ends that stop this close to another road without meeting it are listed

# Flags per network piece
INFRA, BUSYF, CROSS, CROSS_OK, NOGO, XBUSY, UNDER, WALK, FULL, ENTR, SVC, TIDE, PRIV = 1, 2, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192
# INFRA: a walking route (anything else is road edge or a link); BUSYF: on or beside a busy road; CROSS: a road crossing;
# CROSS_OK: at a drawn crosswalk; NOGO: never (a highway away from a crosswalk); XBUSY: crossing a busy road; UNDER: under or
# over the road; WALK: a walking route that's a sidewalk, not a trail; FULL: one piece is a whole crossing (others are
# halves); ENTR: crossing to the far side where a path meets a street; SVC: edge or crossing of a service road; TIDE: only walkable
# at low tide; PRIV: edge of a private road. (Bit 4 is unused.)

walking = json.load(open(SITE / 'walking.json', encoding='utf-8'))
layer = lambda name: next(l for l in walking['layers'] if l['name'] == name)['features']
_sdata = json.load(open(SITE / 'streets.json', encoding='utf-8'))
_streets = _sdata['layers'] + _sdata.get('dataOnly', [])  # (dataOnly: fetched for Navigation, not drawn on the Streets page)
ROADS = next(l for l in _streets if l['name'] == 'Roads')['features']
for _l in _streets:  # lines in a service-road layer join the roads as Type Service (paved unless ticked Unpaved)
    if _l['name'] in SERVICE_LAYERS:
        ROADS = ROADS + [{**f, 'properties': {**f['properties'], 'Type': SERVICE_TYPE, 'Paved': f['properties'].get('Unpaved') is not True}} for f in _l['features']]

# Skip the build when nothing it reads has changed since the last one.
fingerprint = hashlib.sha256(json.dumps([layer('Walking Routes'), [layer(n) for n in LOW_TIDE_LAYERS], ROADS], sort_keys=True).encode() + (HERE / 'build.py').read_bytes()).hexdigest()[:16]
if '--force' not in sys.argv and OUT.exists() and json.loads(OUT.read_text(encoding='utf-8')).get('src') == fingerprint:
    print('walking network: inputs unchanged, not rebuilt')
    sys.exit(0)

# ---- inputs -----------------------------------------------------------------------------------------------------------
lines = []  # dicts: kind route|road, geom (metres), name, busy, highway, service, w (edge offset), override (routes: Busy field), grade, id
for f, tide in [(f, False) for f in layer('Walking Routes')] + [(f, True) for n in LOW_TIDE_LAYERS for f in layer(n)]:
    g = to_m(shape(f['geometry']))
    for p in (g.geoms if hasattr(g, 'geoms') else [g]):
        if p.length > 0.5:
            ov = str(f['properties'].get('Busy', '')).strip().lower()
            lines.append({'kind': 'route', 'geom': p, 'name': '', 'busy': False, 'highway': False, 'id': f['properties'].get('id'), 'tide': tide,
                          'override': True if ov in ('yes', 'true') else False if ov in ('no', 'false') else None,
                          'grade': f['properties'].get('Grade separated') is True})  # its road crossings go under or over the road
for f in ROADS:
    typ = f['properties'].get('Type')
    service = typ == SERVICE_TYPE
    name = (f['properties'].get('name') or '').strip() or (SERVICE_NAME if service else '')  # (an empty name means a join in the network)
    g = to_m(shape(f['geometry']))
    for p in (g.geoms if hasattr(g, 'geoms') else [g]):
        if p.geom_type == 'LineString' and p.length > 0.5:
            busy = typ in BUSY_TYPES
            narrow = typ == PRIVATE_TYPE or f['properties'].get('Paved') is False
            lines.append({'kind': 'road', 'geom': p, 'name': name, 'busy': busy, 'w': SIDE_OFFSET[True] if busy else SERVICE_OFFSET if service else NARROW_OFFSET if narrow else SIDE_OFFSET[False],
                          'highway': typ == HIGHWAY_TYPE, 'service': service, 'private': typ == PRIVATE_TYPE, 'id': f['properties'].get('id'), 'override': None})


# ---- roads: the road surface and its outline ---------------------------------------------------------------------------

roads = [L for L in lines if L['kind'] == 'road']
routes = [L for L in lines if L['kind'] == 'route']
# Near-miss road ends (the Province's lines often stop short of the road they meet): extend the end onto that road.
rg = [L['geom'] for L in roads]
rt = STRtree(rg)
extra_cuts = collections.defaultdict(list)
for i, L in enumerate(roads):
    cs = list(L['geom'].coords)
    if L['geom'].is_ring:
        continue  # a closed loop (roundabout, circle) has no loose ends
    for at in (0, -1):
        end = Point(cs[at])
        near = [(rg[j].distance(end), j) for j in rt.query(end.buffer(JOIN_ROADROAD_M)) if j != i]
        near = [x for x in near if x[0] < JOIN_ROADROAD_M]
        if not near:
            continue
        d, j = min(near)
        dj = rg[j].project(end)
        q = rg[j].interpolate(dj)
        extra_cuts[j].append(dj)
        if d > 0.05:
            if at == 0:
                cs.insert(0, (q.x, q.y))
            else:
                cs.append((q.x, q.y))
    L['geom'] = LineString(cs)
rg = [L['geom'] for L in roads]
rt = STRtree(rg)
rcuts = collections.defaultdict(list, {k: list(v) for k, v in extra_cuts.items()})
for i, g in enumerate(rg):
    for j in rt.query(g):
        if j <= i:
            continue
        x = g.intersection(rg[j])
        for q in (x.geoms if hasattr(x, 'geoms') else [x]):
            if q.geom_type == 'Point':
                rcuts[i].append(g.project(q)); rcuts[j].append(rg[j].project(q))
    for at in (0, -1):  # ends that touch another road exactly
        end = Point(g.coords[at])
        for j in rt.query(end.buffer(0.1)):
            if j != i and rg[j].distance(end) < 0.1:
                rcuts[j].append(rg[j].project(end))

# Junctions: road-piece ends within 1 m of each other are one junction.
jpts, jgrid = [], collections.defaultdict(list)


def junction(pt):
    key = (int(pt[0] // 2), int(pt[1] // 2))
    for gx in (key[0] - 1, key[0], key[0] + 1):
        for gy in (key[1] - 1, key[1], key[1] + 1):
            for k in jgrid[(gx, gy)]:
                if math.hypot(jpts[k][0] - pt[0], jpts[k][1] - pt[1]) < 1.0:
                    return k
    jpts.append(pt); jgrid[key].append(len(jpts) - 1)
    return len(jpts) - 1


segs = []  # {geom, L, busy, tch, j0, j1}
for i, L in enumerate(roads):
    g = L['geom']
    busy = L['busy']
    ds = sorted({0.0, g.length, *[c for c in rcuts[i] if 0.3 < c < g.length - 0.3]})
    pieces = [substring(g, a, b) for a, b in zip(ds, ds[1:]) if b - a >= 0.5]
    for sg in pieces:
        segs.append({'geom': sg, 'L': L, 'busy': busy, 'highway': L['highway'], 'j0': junction(sg.coords[0]), 'j1': junction(sg.coords[-1])})

route_geoms = [L['geom'] for L in routes]
route_tree = STRtree(route_geoms)


def route_belongs(pt, L):
    # the walking route beside this edge belongs to road L: where it passes, L (or a road of the same name) is the nearest
    # road (Derek 2026-11-27: a sidewalk round a corner of Glen Stewart Drive took over a parking lane's edge)
    best = min(((route_geoms[j].distance(pt), j) for j in route_tree.query(pt.buffer(COVER_M))), default=None)
    if best is None:
        return False
    r = route_geoms[best[1]]
    q = r.interpolate(r.project(pt))
    near = min(((rg[k].distance(q), k) for k in rt.query(q.buffer(30))), default=None)
    # ...and is near enough to count as its sidewalk (the same SIDEWALK_M from the centreline the sidewalk colouring uses)
    return near is not None and near[0] <= SIDEWALK_M and (roads[near[1]] is L or roads[near[1]]['name'] == L['name'])


def parallel_route_near(pt, ang, tol, other=None):
    # A walking route parallel to this edge and within tol of it, and nearer this edge than the matching point across the
    # street: a sidewalk drawn near the centreline belongs to one side only (Derek 2026-11-23: Hollis Avenue, MacIntosh Drive)
    return alongside(pt, ang, route_geoms, route_tree, tol, half=4, other=other) is not None


surface = unary_union([x['geom'].buffer(x['L']['w'], quad_segs=4) for x in segs])
# A walking route that ends inside the road (e.g. a trail drawn into the end of Bonavista Avenue) stops at the road edge
# instead (Derek 2026-11-25). Only the last TRIM_IN_ROAD_M: a sidewalk drawn close to the centreline keeps its length.


def dead_end(r, at):
    e = Point(r.coords[at])
    return not any(j_geom is not r and j_geom.distance(e) < 1 for j_geom in (rg[j] for j in rt.query(e.buffer(1))))


def crosses_road(tip):
    for k in rt.query(tip):
        x = tip.intersection(rg[k])
        for q in (x.geoms if hasattr(x, 'geoms') else [x]):
            if q.is_empty:
                continue
            if q.geom_type != 'Point':
                continue  # runs along the centreline: not across it
            t, u = tip.project(q), rg[k].project(q)
            if (u <= DEAD_END_ZONE_M and dead_end(rg[k], 0)) or (u >= rg[k].length - DEAD_END_ZONE_M and dead_end(rg[k], -1)):
                continue  # meets the road right at its dead end: a trail leading into the end of the road, not a crosswalk
            if angle_off(heading(tip, t, 2), heading(rg[k], u, 2)) >= CROSSWALK_MIN_DEG:
                return True
    return False


road_inside, road_edge = surface.buffer(-0.5), surface.boundary
for R in routes:
    g = R['geom']
    for at in (0, -1):
        if not road_inside.contains(Point(g.coords[at])):
            continue
        if any(r2 is not R and r2['geom'].distance(Point(g.coords[at])) < JOIN_ROUTE_M for r2 in routes):
            continue  # it ends at another walking route: that's a connection (Georgetown Road at Bryer Jones Court), not a trail into the road
        x = g.intersection(road_edge)
        ds = [g.project(q) for q in getattr(x, 'geoms', [x]) if q.geom_type == 'Point']
        if not ds:
            continue  # wholly inside the road
        cut = max(ds) if at == -1 else min(ds)
        tip = substring(g, cut, g.length) if at == -1 else substring(g, 0, cut)
        if tip.length <= TRIM_IN_ROAD_M and not crosses_road(tip):  # a tip across the centreline is a crosswalk drawn just short (Georgetown Road): keep it
            g = substring(g, 0, cut) if at == -1 else substring(g, cut, g.length)
    R['geom'] = g
route_geoms = [L['geom'] for L in routes]
route_tree = STRtree(route_geoms)
# The middle of a road drawn as a closed loop (a roundabout island, a cul-de-sac loop) is filled in whatever its size: its
# inside edge reaches nothing (Derek 2026-11-25). Only when no other street runs inside the loop.
by_name = collections.defaultdict(list)
for L in lines:
    if L['kind'] == 'road':
        by_name[L['name']].append(L['geom'])  # whole road lines: pieces split at junctions don't always meet exactly
loop_faces = []
for nm, gs in by_name.items():
    for face in polygonize(unary_union(gs)):
        core = face.buffer(-1)
        if not any(L['kind'] == 'road' and L['name'] != nm and core.intersects(L['geom']) for L in lines):
            loop_faces.append(face)
loop_area = unary_union(loop_faces)
outlines = []
for P in getattr(surface, 'geoms', [surface]):
    outlines.append(LineString(P.exterior.coords))
    outlines += [LineString(h.coords) for h in P.interiors if Polygon(h).area >= HOLE_MIN_M2 and not Polygon(h).buffer(-SLIVER_HALF_M).is_empty
                 and not loop_area.contains(Polygon(h).representative_point())]
seg_geoms = [x['geom'] for x in segs]
seg_tree = STRtree(seg_geoms)


def nearest_seg(pt, ang=None):
    # The street this bit of road edge belongs to: the nearest centreline, or at a corner (another within LABEL_SLACK_M
    # of the nearest) the one it runs parallel to (Derek 2026-11-26, Billy MacMillan Drive: the corner piece along the busy
    # road was labelled with the side street, whose end was a little closer).
    cands = [(seg_geoms[k].distance(pt), k) for k in seg_tree.query(pt.buffer(15))]
    if not cands:
        return None
    dmin = min(cands)[0]
    if ang is None:
        return min(cands)[1]
    off = lambda k: angle_off(ang, heading(seg_geoms[k], seg_geoms[k].project(pt), 3))
    return min((c for c in cands if c[0] <= dmin + LABEL_SLACK_M), key=lambda c: (off(c[1]) > 30, c[0]))[1]


def ring_part(line, a, b):  # a..b along a closed line, wrapping past its end
    L = line.length
    if b <= L:
        return substring(line, a, b)
    return LineString(list(substring(line, a, L).coords) + list(substring(line, 0, b - L).coords)[1:])


# Label each ~5 m of outline with its street; leave out highway edges and edges that their road's sidewalk replaces.
side_lines = []   # {geom, L (road), busy}
loose_ends = []   # edge ends where a sidewalk takes over
for line in outlines:
    n = max(4, round(line.length / STEP_M))
    step = line.length / n
    labels = []
    for k in range(n):
        pa, pb, mid = line.interpolate(k * step), line.interpolate((k + 1) * step), line.interpolate((k + 0.5) * step)
        ks = nearest_seg(mid, math.degrees(math.atan2(pb.y - pa.y, pb.x - pa.x)))
        if ks is None or segs[ks]['highway']:
            labels.append(None)
            continue
        g = segs[ks]['geom']
        c0 = g.interpolate(g.project(mid))
        other = Point(2 * c0.x - mid.x, 2 * c0.y - mid.y)  # the same spot on the far edge of the street
        ang = math.degrees(math.atan2(pb.y - pa.y, pb.x - pa.x))
        L0 = segs[ks]['L']
        labels.append(('cover', id(L0)) if parallel_route_near(mid, ang, COVER_M, other) and route_belongs(mid, L0) else id(L0))
    # A walking route only stands in for a road edge as that road's sidewalk: for SIDEWALK_MIN_M or more (Derek
    # 2026-11-27, Mason Road: a trail dipping under COVER_M for a few metres cut the road edge and left two joins).
    for k, j in short_runs(labels, lambda v: isinstance(v, tuple), step, SIDEWALK_MIN_M):
        if not (k == 0 and j == n - 1):  # (a whole ring with a sidewalk all round stays left out)
            for m_ in range(k, j + 1):
                labels[m_] = labels[m_][1]
    labels = [None if isinstance(lb, tuple) else lb for lb in labels]
    seg_of = {id(x['L']): x for x in segs}
    # runs of equal labels, starting at a change so no run wraps unseen
    start = next((k for k in range(n) if labels[k] != labels[k - 1]), None)
    if start is None:  # one label all the way round
        if labels[0] is not None:
            x = seg_of[labels[0]]
            for a, b in ((0, line.length / 2), (line.length / 2, line.length)):
                side_lines.append({'geom': substring(line, a, b), 'L': x['L'], 'busy': x['busy']})
        continue
    runs, k = [], start
    while k < start + n:
        k2 = k
        while k2 + 1 < start + n and labels[(k2 + 1) % n] == labels[k % n]:
            k2 += 1
        runs.append([labels[k % n], k, k2 + 1])
        k = k2 + 1
    for r in range(len(runs)):  # short bits of edge between left-out stretches are noise (they'd each need two joins)
        lab, a, b = runs[r]
        if lab is not None and (b - a) * step < 6 and (runs[r - 1][0] is None or runs[(r + 1) % len(runs)][0] is None):
            runs[r][0] = None
    for r, (lab, a, b) in enumerate(runs):
        if lab is None:
            continue
        x = seg_of[lab]
        geom = ring_part(line, a * step, b * step)
        side_lines.append({'geom': geom, 'L': x['L'], 'busy': x['busy']})
        if runs[r - 1][0] is None:
            loose_ends.append(Point(geom.coords[0]))
        if runs[(r + 1) % len(runs)][0] is None:
            loose_ends.append(Point(geom.coords[-1]))

side_geoms = [x['geom'] for x in side_lines]
side_tree = STRtree(side_geoms)
scut = collections.defaultdict(list)   # side line index -> distances to cut at

# Crossings: each street straight across, just outside the intersection (clear of the other streets' surface). It lands
# on the road edge or, where that edge is a sidewalk, on the sidewalk. Nothing to land on (a roundabout's island) = none.
arm_ends = collections.defaultdict(list)
for x in segs:
    arm_ends[x['j0']].append((x, 0)); arm_ends[x['j1']].append((x, 1))
junction_links = []  # {geom, flags, name} or {geom: None, to_route}
cross_review = []


def landing(p, nx, ny, reach):
    # where a crossing from p in direction (nx, ny) lands: the nearest walking route within reach (a sidewalk, even if the
    # corner of a side street's road edge pokes out in front of it: Derek 2026-11-25), else the nearest road edge
    ray = LineString([(p.x, p.y), (p.x + nx * reach, p.y + ny * reach)])
    best = {}
    for kind, geoms, tree in (('side', side_geoms, side_tree), ('route', route_geoms, route_tree)):
        for j in tree.query(ray):
            xx = ray.intersection(geoms[j])
            for q in (xx.geoms if hasattr(xx, 'geoms') else [xx]):
                if q.geom_type == 'Point' and (kind not in best or q.distance(p) < best[kind][0]):
                    best[kind] = (q.distance(p), kind, j, q)
    return best.get('route') or best.get('side')


def outward(x, end):
    """Street piece x from this junction outwards, continued through junctions where only service lanes join the same
    street (a lot entrance across from a side street splits the street a few metres on: the crossing beyond the side
    street's corner needs the road past that split)."""
    cs = list(x['geom'].coords) if end == 0 else list(x['geom'].coords)[::-1]
    cur, jf = x, (x['j1'] if end == 0 else x['j0'])
    for _ in range(5):
        at = arm_ends.get(jf, [])
        cont = [(o, e) for o, e in at if o is not cur and not o['L']['service']]
        if len(cont) != 1 or cont[0][0]['L']['name'] != x['L']['name'] or not any(o['L']['service'] for o, _ in at):
            break
        o, e = cont[0]
        oc = list(o['geom'].coords) if e == 0 else list(o['geom'].coords)[::-1]
        cs += oc[1:]
        cur, jf = o, (o['j1'] if e == 0 else o['j0'])
    return LineString(cs)


for jn, arms in arm_ends.items():
    if len(arms) < 3:
        continue  # a dead end (its edge wraps round), or a street's line just breaking in two: no junction, no crossing
    # The main road through a junction = the pair of arms that line up best (within THROUGH_DEG of straight); the others
    # are side streets. At a crossroads every arm is in a straight pair.
    def arm_dir(arm):  # direction from the junction 10 m out along the arm
        g0 = arm[0]['geom']
        a = g0.interpolate(0 if arm[1] == 0 else g0.length)
        b = g0.interpolate(min(10, g0.length) if arm[1] == 0 else max(0, g0.length - 10))
        return math.degrees(math.atan2(b.y - a.y, b.x - a.x))
    hd = [arm_dir(a) for a in arms]
    through = set()
    pairs = sorted(((abs((hd[i] - hd[j]) % 360 - 180), i, j) for i in range(len(arms)) for j in range(i + 1, len(arms))))
    for dev, i, j in pairs:
        if dev <= THROUGH_DEG and i not in through and j not in through:
            through |= {i, j}
    for ai, (x, end) in enumerate(arms):
        others = [o for o, _ in arms if o is not x]
        if not x['L']['service']:
            # a service road joining a street (a lot entrance) adds no crossings of that street, and doesn't push them back
            if not any(not o['L']['service'] and o['L']['name'] != x['L']['name'] for o in others) and any(o['L']['service'] for o in others):
                continue
            others = [o for o in others if not o['L']['service']] or others
        g, w = x['geom'], x['L']['w']
        if not x['L']['service']:
            g, end = outward(x, end), 0  # carry on along the street through points where only service lanes join it
        other_surf = unary_union([o['geom'].buffer(o['L']['w']) for o in others])
        # The crossing runs between this street's two corners: on each side, where its road edge comes out from the
        # other streets' road surface (Derek 2026-11-25: at a slanted junction it sits across the mouth of the street,
        # not pushed back square to it). A side with no street in the way takes the other side's distance (square across).
        def edge_pt(t, side):
            p, a, b = g.interpolate(t), g.interpolate(max(0, t - 1)), g.interpolate(min(g.length, t + 1))
            ux, uy = b.x - a.x, b.y - a.y
            nn = math.hypot(ux, uy) or 1
            return Point(p.x - side * uy / nn * w, p.y + side * ux / nn * w)
        # Corner to corner at the mouth of a side street (both corners with the same street), along the main road's edge
        # however slanted the side street (Derek 2026-11-25, Brandy Lane / Anne Crescent); otherwise square across at the
        # further corner (staggered side streets either side of a main road get one each).
        steps = [k * 0.5 for k in range(int(g.length * 2))]  # half-metre steps along the whole piece (a short piece between staggered side streets needs a crossing at each end)
        other_surfs = [(id(o['L']), o['geom'].buffer(o['L']['w'])) for o in others]
        tt, by = {}, {}
        for side in (1, -1):
            free = next((D for D in steps if not other_surf.contains(edge_pt(D if end == 0 else g.length - D, side))), None)
            tt[side] = free
            if free:
                q = edge_pt(free - 0.5 if end == 0 else g.length - (free - 0.5), side)
                by[side] = {k for k, s in other_surfs if s.contains(q)}
        if None in tt.values():
            continue
        mouth = bool(tt[1] and tt[-1]) and ai not in through and len(through) >= 2  # a side street off a main road
        if not mouth:
            tt[1] = tt[-1] = max(tt.values())
        cL, cR = (edge_pt(tt[s] if end == 0 else g.length - tt[s], s) for s in (1, -1))
        p = Point((cL.x + cR.x) / 2, (cL.y + cR.y) / 2)
        if any(q.distance(p) <= CROSSWALK_NEAR_M for j in route_tree.query(p.buffer(CROSSWALK_NEAR_M)) for q in [route_geoms[j].intersection(g)] if not q.is_empty):
            continue  # a walking route already crosses this street here (a drawn crosswalk)
        hits = []
        for c in (cL, cR):
            dd = p.distance(c) or 1
            hits.append(landing(p, (c.x - p.x) / dd, (c.y - p.y) / dd, dd + CROSS_REACH_M))
        if None in hits or (x['busy'] and all(h[1] == 'route' for h in hits)):
            continue  # nothing to cross to; or two sidewalks of a busy street (cross those on a drawn crosswalk)
        for _, kind, j, q in hits:
            if kind == 'side':
                scut[j].append(side_geoms[j].project(q))
            else:
                junction_links.append({'geom': None, 'to_route': (j, route_geoms[j].project(q))})
        # crossing a quiet street where it meets a busy one runs along the busy street's edge: it counts as busy (Derek 2026-11-23)
        at_busy = any(o['busy'] for o in others)
        flags = (CROSS | XBUSY | BUSYF | FULL | (NOGO if x['highway'] else 0)) if x['busy'] else (CROSS | FULL | (BUSYF if at_busy else 0) | (SVC if x['L']['service'] else 0))
        junction_links.append({'geom': LineString([hits[0][3], hits[1][3]]), 'flags': flags, 'name': x['L']['name']})
        if x['busy']:
            cross_review.append({'at': p, 'road': x['L']['name'], 'via': 'street', 'busy': True, 'crosswalk': False, 'blocked': x['highway'], 'route': None})

# A road edge that stops where a sidewalk takes over steps onto that sidewalk.
for e in loose_ends:
    best = None
    for j in route_tree.query(e.buffer(STEP_LINK_M)):
        dd = route_geoms[j].distance(e)
        if dd <= STEP_LINK_M and (best is None or dd < best[0]):
            best = (dd, j)
    if best:
        r = route_geoms[best[1]]
        q = r.interpolate(r.project(e))
        if best[0] > 0.05:
            junction_links.append({'geom': LineString([e, q]), 'flags': 0, 'name': '', 'to_route': (best[1], r.project(e))})
        else:  # the edge ends right on the sidewalk: just split the sidewalk there so they share a point (Dairy Lane)
            junction_links.append({'geom': None, 'to_route': (best[1], r.project(e))})

busy_roads = [L['geom'] for L in roads if L['busy']]
busy_names = [L['name'] for L in roads if L['busy']]
busy_tree = STRtree(busy_roads)

# ---- walking routes: junctions with each other and with the side lines; road crossings -------------------------------
rcut = collections.defaultdict(list)   # route index -> distances to cut at
far_done = []                          # both ends of each crossing made where a path meets a street
crossings = []                         # (route index, distance along it, road dict, point)
links, gaps = [], []
for i, R in enumerate(routes):
    p = R['geom']
    for j in route_tree.query(p):
        if j <= i:
            continue
        x = p.intersection(route_geoms[j])
        for q in (x.geoms if hasattr(x, 'geoms') else [x]):
            if q.geom_type == 'Point':
                rcut[i].append(p.project(q)); rcut[j].append(route_geoms[j].project(q))
    for j in side_tree.query(p):
        x = p.intersection(side_geoms[j])
        for q in (x.geoms if hasattr(x, 'geoms') else [x]):
            if q.geom_type == 'Point':
                rcut[i].append(p.project(q)); scut[j].append(side_geoms[j].project(q))
    for k in rt.query(p):
        x = p.intersection(rg[k])
        for q in (x.geoms if hasattr(x, 'geoms') else [x]):
            if q.geom_type == 'Point':
                crossings.append((i, p.project(q), roads[k], q))
    for end in (Point(p.coords[0]), Point(p.coords[-1])):
        cands = [(route_geoms[j].distance(end), j) for j in route_tree.query(end.buffer(JOIN_ROUTE_M)) if j != i]
        cands = [c for c in cands if c[0] < JOIN_ROUTE_M]
        if cands:
            d, j = min(cands)
            dd = route_geoms[j].project(end); rcut[j].append(dd)
            if d > 0.05:
                links.append({'geom': LineString([end, route_geoms[j].interpolate(dd)]), 'flags': INFRA | (TIDE if R['tide'] or routes[j]['tide'] else 0), 'name': ''})
            # joined to another route; if it's also right on a road edge it still gets its crossing to the far side
            # (Derek 2026-11-27, Clifton Road: two trails meet at the road, the trail carries on across it)
            if not any(side_geoms[k].distance(end) < 1 for k in side_tree.query(end.buffer(1))):
                continue
        sc = [(side_geoms[j].distance(end), j) for j in side_tree.query(end.buffer(ROUTE_TO_SIDE_M))]
        sc = [c for c in sc if c[0] < (1 if cands else ROUTE_TO_SIDE_M)]
        if sc:
            d, j = min(sc)
            dd = side_geoms[j].project(end); scut[j].append(dd)
            q0 = side_geoms[j].interpolate(dd)
            if d > 0.05:
                links.append({'geom': LineString([end, q0]), 'flags': INFRA | (TIDE if R['tide'] else 0), 'name': ''})
            S0 = side_lines[j]
            cg = S0['L']['geom']
            tc = cg.project(q0)
            c0 = cg.interpolate(tc)
            mirror = Point(2 * c0.x - q0.x, 2 * c0.y - q0.y)  # straight across the street
            at_road_end = (tc < PAST_END_M and dead_end(cg, 0)) or (tc > cg.length - PAST_END_M and dead_end(cg, -1))  # at a dead end the edge wraps round: no crossing (not where a road just carries on as another line: Clifton Road)
            far = [] if at_road_end else [(side_geoms[k].distance(mirror), k) for k in side_tree.query(mirror.buffer(3)) if side_geoms[k].distance(mirror) < 3
                                        and (k != j or abs(side_geoms[k].project(mirror) - dd) > 3 * S0['L']['w'])]  # the same edge line counts when it has come back round a cul-de-sac (Clifton Road)
            drawn = any(q.distance(q0) <= CROSSWALK_NEAR_M for jj in route_tree.query(q0.buffer(CROSSWALK_NEAR_M)) for q in [route_geoms[jj].intersection(cg)] if not q.is_empty)
            if far and not drawn and not any(q0.distance(fq) < FAR_DEDUPE_M for fq in far_done):  # (not next to a drawn crosswalk over the same street)  # one crossing where two paths meet the street from either side
                _, k = min(far)
                dk = side_geoms[k].project(mirror); scut[k].append(dk)
                far_done += [q0, side_geoms[k].interpolate(dk)]
                fl = (CROSS | XBUSY | BUSYF | ENTR) if S0['busy'] else (CROSS | FULL | (SVC if S0['L']['service'] else 0))
                links.append({'geom': LineString([q0, side_geoms[k].interpolate(dk)]), 'flags': fl, 'name': S0['L']['name']})
        near = [(route_geoms[j].distance(end), j) for j in route_tree.query(end.buffer(GAP_REVIEW_M)) if j != i]
        near = [c for c in near if c[0] < GAP_REVIEW_M]
        if near:
            d, j = min(near)
            q = route_geoms[j].interpolate(route_geoms[j].project(end))
            gaps.append({'at': end, 'to': q, 'gap_m': round(d, 1), 'joined_to_road': bool(sc), 'route': R['id']})
for jl in junction_links:
    if 'to_route' in jl:
        rcut[jl['to_route'][0]].append(jl['to_route'][1])


cross_spans = collections.defaultdict(list)
for i, d, road, q in crossings:
    busy = road['busy']
    half = road['w'] + 1
    g = route_geoms[i]
    lo, hi = max(0, d - half), min(g.length, d + half)
    cross_spans[i].append((lo, hi, busy, road['name'], routes[i]['grade']))  # a grade-separated route goes under/over (field on the route, Derek 2026-11-26)
    rcut[i] += [lo, hi]
    cross_review.append({'at': q, 'road': road['name'], 'via': 'walking route', 'busy': busy, 'crosswalk': True, 'blocked': False, 'route': routes[i]['id']})

# ---- split into pieces and tag them -----------------------------------------------------------------------------------


def seg_dir(seg):
    (x1, y1), (x2, y2) = seg.coords[0], seg.coords[-1]
    return math.degrees(math.atan2(y2 - y1, x2 - x1))


def beside_busy(seg):
    # the name of the busy road this stretch of walking route runs beside, or None
    j = alongside(seg.interpolate(0.5, normalized=True), seg_dir(seg), busy_roads, busy_tree, BESIDE_M)
    return None if j is None else busy_names[j]


def is_sidewalk(seg):
    """This stretch of walking route runs right beside a road, parallel to it: a sidewalk, not a trail (Derek 2026-11-23)."""
    return alongside(seg.interpolate(0.5, normalized=True), seg_dir(seg), rg, rt, SIDEWALK_M) is not None


names = ['']
name_ix = lambda n: names.index(n) if n in names else (names.append(n) or len(names) - 1)
pieces = []  # [flags, name, LineString]
beside_review = collections.defaultdict(float)

for i, R in enumerate(routes):
    g = R['geom']
    # sidewalk or trail, judged every STEP_M along the whole route (cuts for joins and crossings don't split a sidewalk)
    nw = max(1, round(g.length / STEP_M)); sw = g.length / nw
    walk_all = [is_sidewalk(substring(g, sw * k, sw * (k + 1))) for k in range(nw)]
    for k, j in short_runs(walk_all, bool, sw, SIDEWALK_MIN_M):  # a sidewalk stretch shorter than SIDEWALK_MIN_M is trail
        walk_all[k:j + 1] = [False] * (j - k + 1)
    walk_at = lambda d: walk_all[min(nw - 1, int(d / sw))]
    ds = sorted({0, g.length, *[c for c in rcut.get(i, []) if 0 < c < g.length]})
    spans = cross_spans.get(i, [])
    for a, b in zip(ds, ds[1:]):
        if b - a < 0.05:
            continue
        part = substring(g, a, b)
        mid_d = (a + b) / 2
        cs = [c for c in spans if c[0] - 0.01 <= mid_d <= c[1] + 0.01]
        if cs:
            lo, hi, busy, nm, under = cs[0]
            flags = INFRA | CROSS | (CROSS_OK if busy and not under else 0) | (XBUSY if busy else 0) | (UNDER if under else 0) | (TIDE if R['tide'] else 0)
            pieces.append([flags, nm, part])  # a walking route across a road = a crosswalk (or the underpass)
            continue
        n = max(1, round(part.length / STEP_M))
        step = part.length / n
        walk = [walk_at(a + step * (k + 0.5)) for k in range(n)]
        run_start, run_flags, run_name = 0.0, None, None
        for k in range(n):
            s0, s1 = part.length * k / n, part.length * (k + 1) / n
            seg = substring(part, s0, s1)
            flags, nm = INFRA | (TIDE if R['tide'] else 0), ''
            if walk[k]:
                flags |= WALK
            bb = beside_busy(seg) if R['override'] is None else (None if R['override'] is False else 'override')
            if bb:
                flags |= BUSYF
                if bb != 'override':
                    nm = bb
                    beside_review[R['id']] += seg.length
            if run_flags is None:
                run_flags, run_name = flags, nm
            elif (flags, nm) != (run_flags, run_name):
                pieces.append([run_flags, run_name, substring(part, run_start, s0)])
                run_start, run_flags, run_name = s0, flags, nm
        pieces.append([run_flags, run_name, substring(part, run_start, part.length)])

for j, S in enumerate(side_lines):  # the sides of streets
    g = S['geom']
    ds = sorted({0, g.length, *[c for c in scut.get(j, []) if 0 < c < g.length]})
    flags = (BUSYF if S['busy'] else 0) | (SVC if S['L'].get('service') else 0) | (PRIV if S['L'].get('private') else 0)
    for a, b in zip(ds, ds[1:]):
        if b - a >= 0.05:
            pieces.append([flags, S['L']['name'], substring(g, a, b)])
for x in junction_links + links:
    if x.get('geom') is not None:
        pieces.append([x['flags'], x['name'], x['geom']])

# Busy-street centrelines, for route.js to tell when a pin's walk to a sidewalk crosses a busy street
road_lines = [[2 if L['highway'] else 1 if L['busy'] else 0, [c for xy in L['geom'].simplify(1).coords for c in to_ll(*xy)]] for L in roads]

# ---- graph + output -----------------------------------------------------------------------------------------------------
nodes, node_xy = [], []
node_grid = collections.defaultdict(list)
def node(c):
    # Points within 25 cm are one node (rounding to a grid split points that sat a hair apart either side of a grid line).
    # node_grid holds (point, node) pairs: a node can answer for more than one point (see alias below).
    key = (int(c[0] // 1), int(c[1] // 1))
    for gx in (key[0] - 1, key[0], key[0] + 1):
        for gy in (key[1] - 1, key[1], key[1] + 1):
            for (px, py), k in node_grid[(gx, gy)]:
                if abs(px - c[0]) < 0.25 and abs(py - c[1]) < 0.25:
                    return k
    node_grid[key].append((c, len(nodes))); node_xy.append(c); nodes.append(to_ll(*c))
    return len(nodes) - 1


def alias(c, k):
    # a tiny piece that collapsed into node k: its other end is node k too, so what touches that end still joins up
    node_grid[(int(c[0] // 1), int(c[1] // 1))].append((c, k))

edges, edge_geoms = [], []
for flags, nm, g in pieces:
    cs = list(g.coords)
    a, b = node(cs[0]), node(cs[-1])
    if a == b and g.length < 0.5:
        alias(cs[0], a); alias(cs[-1], a)
        continue
    mid = [c for xy in cs[1:-1] for c in to_ll(*xy)]
    edges.append([a, b, flags, name_ix(nm), round(g.length, 1), mid])
    edge_geoms.append(g)
# Short road-edge scraps that only touch sidewalks or joins (where a road edge pokes across a sidewalk, e.g. at roundabout
# entries) are left out, then any join left hanging. Repeat until nothing changes.
is_join = lambda e: not e[2] & (INFRA | CROSS) and names[e[3]] == ''
is_edge = lambda e: not e[2] & (INFRA | CROSS) and names[e[3]] != ''
scraps = 0
while True:
    at_node = collections.defaultdict(list)
    for k, e in enumerate(edges):
        at_node[e[0]].append(k); at_node[e[1]].append(k)
    # a run of road edge = road-edge pieces joined end to end; it's a scrap if it's short and, apart from itself, every
    # point on it touches only walking routes (not crossings or other road edge)
    road_at = lambda n: [j for j in at_node[n] if is_edge(edges[j])]
    cut, seen_k = set(), set()
    for k0, e0 in enumerate(edges):
        if k0 in seen_k or not is_edge(e0):
            continue
        run, todo = {k0}, [k0]
        while todo:
            for n in edges[todo.pop()][:2]:
                for j in road_at(n):
                    if j not in run:
                        run.add(j); todo.append(j)
        seen_k |= run
        rnodes = {n for k in run for n in edges[k][:2]}
        simple = all(len(road_at(n)) <= 2 for n in rnodes)
        walk_only = all(edges[j][2] & INFRA and not edges[j][2] & CROSS or is_join(edges[j]) for n in rnodes for j in at_node[n] if j not in run)
        if simple and walk_only and sum(edges[k][4] for k in run) < SCRAP_M:
            cut |= run
    # a short tail of road edge past the point where it already meets a walking route or crosswalk, leading only to a join
    on_walk = lambda n: any(edges[j][2] & (INFRA | CROSS) for j in at_node[n])  # a walking route, crosswalk or street crossing
    # (the tail can be several pieces end to end: walk back from the loose end while the road edge just carries on)
    for k0, e0 in enumerate(edges):
        if not is_edge(e0):
            continue
        for start in e0[:2]:
            if not all(is_join(edges[j]) for j in at_node[start] if j != k0):
                continue
            run, n, k, total = [], start, k0, 0.0
            while k is not None and total < SCRAP_M:
                run.append(k); total += edges[k][4]
                n = edges[k][1] if edges[k][0] == n else edges[k][0]
                if on_walk(n):
                    if total < SCRAP_M:
                        cut |= set(run)
                    break
                nxt = [j for j in at_node[n] if j != k]
                k = nxt[0] if len(nxt) == 1 and is_edge(edges[nxt[0]]) else None
    # joins and street crossings left hanging (what they landed on was cut) go too
    cut |= {k for k, e in enumerate(edges) if (is_join(e) or (e[2] & CROSS and not e[2] & INFRA)) and any(len([j for j in at_node[n] if j != k and j not in cut]) == 0 for n in e[:2])}
    if not cut:
        break
    scraps += sum(1 for k in cut if is_edge(edges[k]))
    edges = [e for k, e in enumerate(edges) if k not in cut]
    edge_geoms = [g for k, g in enumerate(edge_geoms) if k not in cut]
print(f'left out {scraps} short road-edge scraps that only touch sidewalks')

# The inside edge of a big cul-de-sac loop is a ring of road edge that reaches nothing: left out, or a pin could snap there
# and find no way out. Other cut-off pieces stay (Meadowview), so they show up in the review.
owner = list(range(len(nodes)))
def root(x):
    while owner[x] != x:
        owner[x] = owner[owner[x]]; x = owner[x]
    return x
for a, b, *_ in edges:
    owner[root(a)] = root(b)
piece_edges = collections.defaultdict(list)
for k, e in enumerate(edges):
    piece_edges[root(e[0])].append(k)
main = max(piece_edges, key=lambda r: len(piece_edges[r]))
degree = collections.Counter(n for e in edges for n in e[:2])
is_ring = lambda ks: all(degree[n] == 2 for k in ks for n in edges[k][:2])
drop = {k for r, ks in piece_edges.items() if r != main and not any(edges[k][2] & INFRA for k in ks) and is_ring(ks) for k in ks}
if drop:
    print(f'left out {len(drop)} road edges in closed rings that connect to nothing (inside big cul-de-sac loops)')
    edges = [e for k, e in enumerate(edges) if k not in drop]
    edge_geoms = [g for k, g in enumerate(edge_geoms) if k not in drop]
OUT.write_text(json.dumps({'v': 1, 'src': fingerprint, 'flags': {'infra': INFRA, 'busy': BUSYF, 'cross': CROSS, 'crossOk': CROSS_OK, 'nogo': NOGO, 'crossBusy': XBUSY, 'under': UNDER, 'sidewalk': WALK, 'full': FULL, 'entr': ENTR, 'service': SVC, 'lowtide': TIDE, 'private': PRIV},
                           'names': names, 'highways': sorted({L['name'] for L in roads if L['highway']}), 'nodes': nodes, 'edges': edges, 'roadLines': road_lines}, separators=(',', ':')), encoding='utf-8')

# A gap is only real if the network can't get from the dead end to the nearby route without a detour (e.g. route-043 at
# Barkley Avenue runs along its own "gap" to the fork: not a gap). Keep it if no path within 2 x gap + 20 m reaches it.
gadj = collections.defaultdict(list)
for k, (a, b, *_rest) in enumerate(edges):
    gadj[a].append((b, k)); gadj[b].append((a, k))
def reaches(end, to, limit):
    start = node((end.x, end.y))
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
    json.dump(fc([{'type': 'Feature', 'properties': {'flags': e[2], 'name': names[e[3]], 'len': e[4]}, 'geometry': {'type': 'LineString', 'coordinates': ll(g)}} for e, g in zip(edges, edge_geoms)]),  # the final network, as route.js gets it
              open(REVIEW / 'network.geojson', 'w'), separators=(',', ':'))
    json.dump(fc([{'type': 'Feature', 'properties': {'gap_m': g['gap_m'], 'joined_to_road': g['joined_to_road'], 'route': g['route']},
                   'geometry': {'type': 'LineString', 'coordinates': [pt(g['at']), pt(g['to'])]}} for g in gaps]),
              open(REVIEW / 'gaps.geojson', 'w'))
    json.dump(fc([{'type': 'Feature', 'properties': {k: v for k, v in c.items() if k != 'at'}, 'geometry': {'type': 'Point', 'coordinates': pt(c['at'])}} for c in cross_review]),
              open(REVIEW / 'crossings.geojson', 'w'))
    # Road ends that stop short of another road (after the build's own JOIN_ROADROAD_M joins): a line from the end to the
    # nearest road, ROAD_END_REVIEW_M at most. Many are real dead ends (a parking aisle that just stops); some are misses.
    rtree_all = STRtree([L['geom'] for L in roads])
    road_ends = []
    for L in roads:
        for at in (0, -1):
            e = Point(L['geom'].coords[at])
            near = [(roads[j]['geom'].distance(e), j) for j in rtree_all.query(e.buffer(ROAD_END_REVIEW_M)) if roads[j] is not L]
            near = [c for c in near if c[0] <= ROAD_END_REVIEW_M]
            if not near:
                continue
            d, j = min(near)
            if d > 0.3:
                q = roads[j]['geom'].interpolate(roads[j]['geom'].project(e))
                road_ends.append({'type': 'Feature', 'properties': {'road': L['name'], 'service': bool(L.get('service')), 'short_m': round(d, 1), 'to': roads[j]['name']},
                                  'geometry': {'type': 'LineString', 'coordinates': [pt(e), pt(q)]}})
    json.dump(fc(road_ends), open(REVIEW / 'road_ends.geojson', 'w'))
    print(f'road ends short of another road (0.3-{ROAD_END_REVIEW_M} m): {len(road_ends)}, {sum(f["properties"]["service"] for f in road_ends)} of them service lanes')

total = lambda f: sum(g.length for fl, _, g in pieces if f(fl)) / 1000
print(f'{len(nodes)} nodes, {len(edges)} edges, {OUT.stat().st_size / 1e3:.0f} KB; network pieces {comps[:5]} (+{len(comps) - 5} small)')
print(f'km: walking infra {total(lambda f: f & INFRA):.1f}, roads {total(lambda f: not f & INFRA):.1f}, busy (on or beside) {total(lambda f: f & BUSYF):.1f}, walking routes that are sidewalks {total(lambda f: f & WALK):.1f} (rest are trails)')
print(f'route km beside busy roads: {sum(beside_review.values()) / 1000:.1f} on {len(beside_review)} routes')
print(f'gaps 5-{GAP_REVIEW_M} m: {len(gaps)} ({sum(not g["joined_to_road"] for g in gaps)} not joined to a road either)')
bc = [c for c in cross_review if c['busy']]; qc = [c for c in cross_review if not c['busy']]
print(f'busy-road crossings: {len(bc)}; at crosswalks {sum(c["crosswalk"] for c in bc)}; highway blocked {sum(c["blocked"] for c in bc)}')
print(f'quiet-road crossings by walking routes: {len(qc)}; side lines {len(side_lines)} ({sum(x["geom"].length for x in side_lines) / 1000:.1f} km); junction + crossing links {len(junction_links)}')
