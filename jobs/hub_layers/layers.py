# Hub-fed layers in uMap, kept current by refresh.sh (run on elsa by stratfordmaps-sync before fetch-umap).
# Each entry: which uMap map and layer, the rows file its SQL wrote, how to turn rows into features, and the
# layer's settings (used when the layer is first created; later runs keep Derek's edits to the settings).
# Runs inside the uMap container:  cat layers.py umap_update.py | docker exec -i umap umap shell
import json
import math

IMPORT = '/srv/umap/uploads/import'


def rows(name):
    with open(f'{IMPORT}/{name}', encoding='utf-8') as fh:
        return [json.loads(line) for line in fh if line.startswith('{')]


def fmt(n):
    return f'{int(round(float(n))):,}' if n not in (None, '') else ''


def road_name(s):
    words = {'RD': 'Road', 'HWY': 'Highway', 'DR': 'Drive', 'ST': 'Street', 'AVE': 'Avenue', 'LN': 'Lane', 'CRES': 'Crescent', 'CT': 'Court'}
    return ' '.join(words.get(w, w.capitalize()) for w in (s or '').split())


# Roads' "Traffic volume" (Streets map, Derek 2026-11-28; replaces the old Traffic Volumes layer, history stays in the hub):
# each road line gets the latest yearly count of the count segment it runs along for at least half its length
# (points every 10 m within NEAR_M of the segment) and has the same name, else no value. Plain Python: the uMap container has no shapely.
NEAR_M = 20


def _xy(lng, lat):  # metres, good enough across one town
    return lng * 111320 * math.cos(math.radians(46.2)), lat * 110540


def _lines(g):
    cs = g['coordinates']
    return [cs] if g['type'] == 'LineString' else cs


def _near(pt, segs):
    px, py = pt
    best = 1e18
    for (ax, ay), (bx, by) in segs:
        dx, dy = bx - ax, by - ay
        t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy or 1)))
        best = min(best, (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2)
    return best ** 0.5


def _samples(g, step=10):
    out = []
    for line in _lines(g):
        xy = [_xy(*c[:2]) for c in line]
        for (ax, ay), (bx, by) in zip(xy, xy[1:]):
            n = max(1, int(math.hypot(bx - ax, by - ay) // step))
            out += [(ax + (bx - ax) * i / n, ay + (by - ay) * i / n) for i in range(n)]
        out.append(xy[-1])
    return out


def road_volumes(roads):
    counts = []
    for r in rows('traffic.jsonl'):
        segs = []
        for line in _lines(r['geometry']):
            xy = [_xy(*c[:2]) for c in line]
            segs += list(zip(xy, xy[1:]))
        counts.append((int(round(float(r['aadt']))), segs, road_name(r.get('road')).lower()))
    out = {}
    for f in roads:
        pts = _samples(f['geometry'])
        name = (f['properties'].get('name') or '').strip().lower()
        best = max(((sum(_near(p, segs) <= NEAR_M for p in pts) / len(pts), v) for v, segs, road in counts if road == name), default=(0, None))
        out[id(f)] = best[1] if best[0] >= 0.5 else None
    return out


# Province roads to check (Streets map, Derek 2026-11-28): stretches of the Province's road lines (pei_roads) that are
# more than CHECK_M from every line in Roads and Service Roads for at least CHECK_RUN_M, i.e. a street the Province has
# that Derek's layers don't (usually a new street). Shown only in uMap (skipLayers on the site). Tick "Ignore" on one
# to leave that Province line out for good (Alexandra Road, left out on purpose); the next run keeps it ticked.
CHECK_M, CHECK_RUN_M, CELL = 25, 50, 50


def _grid(geoms):
    grid = {}
    for g in geoms:
        for line in _lines(g):
            xy = [_xy(*c[:2]) for c in line]
            for a, b in zip(xy, xy[1:]):
                for cx in range(int(min(a[0], b[0]) // CELL) - 1, int(max(a[0], b[0]) // CELL) + 2):
                    for cy in range(int(min(a[1], b[1]) // CELL) - 1, int(max(a[1], b[1]) // CELL) + 2):
                        grid.setdefault((cx, cy), []).append((a, b))
    return grid


def _ll(x, y):
    return [round(x / (111320 * math.cos(math.radians(46.2))), 6), round(y / 110540, 6)]


def roads_check(ours, ignored):
    grid, out = _grid(ours), []
    for r in rows('roads_check.jsonl'):
        if str(r['oid']) in ignored:
            continue
        for line in _lines(r['geometry']):
            run = []
            for pt in _samples({'type': 'LineString', 'coordinates': line}, 5) + [None]:
                far = pt is not None and _near(pt, grid.get((int(pt[0] // CELL), int(pt[1] // CELL)), [])) > CHECK_M
                if far:
                    run.append(pt)
                    continue
                if len(run) * 5 >= CHECK_RUN_M:
                    out.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': [_ll(*q) for q in run]},
                                'properties': {'name': road_name(r.get('road')) or 'Unnamed Province road', 'Province id': str(r['oid']),
                                               'Ownership': (r.get('ownership') or '').title(), 'Ignore': False,
                                               'description': f'About {len(run) * 5} m of the Province line has no road in Roads or Service Roads near it.'}})
                run = []
    return out


def roads_check_layer():  # inside the uMap shell: compare with the Streets map's own layers, keep the Ignore ticks
    from umap.models import DataLayer
    layers = {d.name: json.loads(d.geojson.read()) for d in DataLayer.objects.filter(map__pk=4).exclude(share_status=99)}
    ours = [f['geometry'] for n in ('Roads', 'Service Roads') for f in layers.get(n, {}).get('features', [])]
    kept = [f for f in layers.get('Province roads to check', {}).get('features', []) if (f.get('properties') or {}).get('Ignore')]
    return kept + roads_check(ours, {str(f['properties'].get('Province id')) for f in kept})


# EV chargers: listings within MERGE_M of each other are one site (Stratford Town Hall is two ChargePoint listings).
# PLACES names known sites by station id (listed names are often network codes like "STRATFORD EV STRATFORDTWNHLL");
# any other site is named by its street address.
MERGE_M = 25
PLACES = {'232437': 'Town Hall', '232438': 'Town Hall', '232439': 'Emergency Services building', '464815': 'Provincial Credit Union',
          '464821': 'Shepard Drive parking lot'}  # 464821 is listed at Town Hall's address but sits on the Town's lot at 17 Shepard Dr
PLUGS = {'J1772': 'J1772 (fits most electric cars; Teslas use an adapter)', 'J1772COMBO': 'CCS fast charger',
         'CHADEMO': 'CHAdeMO fast charger', 'TESLA': 'Tesla (NACS)', 'NEMA515': 'Wall outlet', 'NEMA520': 'Wall outlet',
         'NEMA1450': 'Wall outlet (50 A)', 'J3271': 'Megawatt charger'}
STREET = {'Dr': 'Drive', 'Rd': 'Road', 'Ave': 'Avenue', 'Av': 'Avenue', 'St': 'Street', 'Ln': 'Lane', 'Cres': 'Crescent', 'Ct': 'Court'}
MONTHS = 'January February March April May June July August September October November December'.split()


def nice_address(a):
    return ' '.join(STREET.get(w, w) for w in (a or '').strip().split())


def ev_chargers():
    sites = []
    for r in rows('ev.jsonl'):  # group listings into sites
        for s in sites:
            if math.hypot((s[0]['lng'] - r['lng']) * 77000, (s[0]['lat'] - r['lat']) * 111000) <= MERGE_M:
                s.append(r)
                break
        else:
            sites.append([r])
    out = []
    for site in sites:
        n = lambda k: sum(int(r.get(k) or 0) for r in site)
        kinds = sorted({c for r in site for c in (r.get('connectors') or [])}, key=lambda c: list(PLUGS).index(c) if c in PLUGS else 99)
        nets = sorted({r.get('network') or '' for r in site} - {''})
        name = next((PLACES[r['id']] for r in site if r['id'] in PLACES), None) or nice_address(site[0].get('address')) or 'EV charger'
        total = n('dc') + n('l2') + n('l1')
        props = {'id': f"ev-{site[0]['id']}", 'name': name, 'Plugs': str(total) if total else 'unknown'}
        if kinds:
            props['Plug type'] = ', '.join(PLUGS.get(k, k) for k in kinds)
        # Speed: one entry per charging level present (Plugs is just the count), with the listed kW when known.
        speeds = []
        for key, level, label in (('dc', None, 'Fast (DC)'), ('l2', '2', 'Level 2'), ('l1', '1', 'Level 1')):
            if not n(key):
                continue
            kw = sorted({c['power_kw'] for r in site for u in (r.get('units') or []) if (u.get('charging_level') in ('1', '2')) == (level is not None)
                         and (level is None or u.get('charging_level') == level) for c in (u.get('connectors') or {}).values()
                         if c.get('port_count') and c.get('power_kw')})
            text = label + (', ' + ' / '.join(f'{k:g} kW' for k in kw) if kw else '')
            if kw and level:
                text += f' (about {round(max(kw) * 6, -1):.0f} km of driving per hour)'
            speeds.append(text)
        if speeds:
            props['Speed'] = '; '.join(speeds)
        if nets:
            props['Network'] = ', '.join('none, just plug in' if x == 'Non-Networked' else x.removesuffix(' Network') for x in nets)
        pricing = next((r['pricing'] for r in site if r.get('pricing')), None)
        if pricing:
            props['Cost'] = pricing
        hours = next((r['hours'] for r in site if r.get('hours')), None)
        if hours:
            props['Hours'] = 'Open 24 hours' if hours.lower().startswith('24 hours') else hours
        where = next((r['where'] for r in site if r.get('where')), None)
        if where:
            props['Where'] = where
        if all(r.get('status') == 'T' for r in site):
            props['Status'] = 'Temporarily out of service'
        confirmed = max((r.get('confirmed') or '' for r in site), default='')
        if confirmed:
            props['Listing checked'] = f'{MONTHS[int(confirmed[5:7]) - 1]} {confirmed[:4]}'  # month + year only
        lng = sum(r['lng'] for r in site) / len(site)
        lat = sum(r['lat'] for r in site) / len(site)
        out.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(lng, 6), round(lat, 6)]}, 'properties': props})
    return out


LAYERS = [
    # 'field': fills one field of an existing layer's features instead of replacing the layer
    {'map': 4, 'name': 'Roads', 'rows': 'traffic.jsonl', 'min': 5, 'field': 'Traffic volume', 'values': road_volumes},
    {'map': 4, 'name': 'Province roads to check', 'rows': 'roads_check.jsonl', 'min': 0, 'build': roads_check_layer,
     'settings': {'color': '#D50000', 'weight': 6, 'browsable': True, 'inCaption': True, 'displayOnLoad': False,
                  'fields': [{'key': 'name', 'type': 'String'}, {'key': 'Ignore', 'type': 'Boolean'}, {'key': 'Province id', 'type': 'String'},
                             {'key': 'Ownership', 'type': 'String'}, {'key': 'description', 'type': 'Text'}]}},
    {'map': 7, 'name': 'EV Chargers', 'rows': 'ev.jsonl', 'min': 1, 'build': ev_chargers,
     'settings': {'color': '#1E88E5', 'iconClass': 'Drop', 'iconUrl': '🔌', 'browsable': True, 'inCaption': True,
                  'fields': [{'key': 'name', 'type': 'String'}, {'key': 'Plugs', 'type': 'String'}]}},
]
