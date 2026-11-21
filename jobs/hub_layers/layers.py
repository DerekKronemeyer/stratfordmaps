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


# Streetlight kinds, from the Town's fixture codes (Claude's reading: the "L" prefix = decorative lantern, since
# "Lantern HPS" and "LHPS" both appear and most have no arm). For the glow: whole-fixture lumens per watt, the share
# of light thrown downward, and an assumed mounting height (utility-pole heads ~9 m, post-top lanterns ~4.5 m).
KINDS = {
    'LED': ('Streetlight', 'LED', 110, 1.0, 9),
    'HPS': ('Streetlight', 'sodium (older, orange light)', 65, 1.0, 9),
    'LLED': ('Decorative lantern', 'LED', 80, 0.7, 4.5),
    'Lantern HPS': ('Decorative lantern', 'sodium (older, orange light)', 55, 0.7, 4.5),
    'LHPS': ('Decorative lantern', 'sodium (older, orange light)', 55, 0.7, 4.5),
    'LMH': ('Decorative lantern', 'metal halide (older, white light)', 45, 0.7, 4.5),
}
EDGE_LUX = 1  # the glow reaches out to where the ground gets about 1 lux (dim, but enough to see by)


def reach(lumens, down, h):
    """Metres from the pole to where the ground light falls to EDGE_LUX, treating the light as a point source
    spreading its downward light evenly over the lower half-sphere: E(r) = I*h / (h^2 + r^2)^1.5."""
    i = down * lumens / (2 * math.pi)
    return math.sqrt(max(0.0, (i * h / EDGE_LUX) ** (2 / 3) - h * h))


def streetlights():
    out = []
    for r in rows('streetlights.jsonl'):
        code = (r.get('fixture') or '').strip()
        name, light, eff, down, h = KINDS.get(code, ('Streetlight', code or 'unknown', 90, 1.0, 9))
        props = {'id': f"light-{r['id']}", 'name': name, 'Light': light}
        watts = float(r['wattage']) if r.get('wattage') else None
        if watts:
            lumens = watts * eff
            radius = reach(lumens, down, h)
            props['Power'] = f'{watts:g} W'
            props['Brightness (estimate)'] = f'about {round(lumens, -2):,.0f} lumens'
            props['Lights up (estimate)'] = f'about {radius:.0f} m around'
            props['_glow'] = round(radius, 1)  # metres; the site draws a soft glow this size
            if 'sodium' in light:
                props['_glowColor'] = '#FF9A3C'  # sodium lights really are orange
        out.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [r['lng'], r['lat']]}, 'properties': props})
    return out


# Traffic: colour and width by the latest year's vehicles a day.
BANDS = [(2500, '#FFE082', 4), (7500, '#FFB74D', 5), (15000, '#FB8C00', 6), (25000, '#E65100', 7), (None, '#B71C1C', 8)]


def traffic():
    out = []
    for r in rows('traffic.jsonl'):
        aadt = float(r['aadt'] or 0)
        color, weight = next((c, w) for limit, c, w in BANDS if limit is None or aadt < limit)
        years = sorted((r.get('history') or {}).items(), reverse=True)
        props = {'id': f"traffic-{r['id']}", 'name': road_name(r.get('road')) or 'Provincial road',
                 'Vehicles a day': f"{fmt(r['aadt'])} ({r['year']})"}
        if r.get('sadt') and r.get('wadt'):
            props['Summer / winter'] = f"{fmt(r['sadt'])} / {fmt(r['wadt'])}"
        props['description'] = ('Average vehicles a day, by year (Province of PEI traffic counts):\n'
                                + '\n'.join(f'{y}: {fmt(v)}' for y, v in years))
        props['_umap_options'] = {'color': color, 'weight': weight}
        out.append({'type': 'Feature', 'geometry': r['geometry'], 'properties': props})
    return out


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
    {'map': 2, 'name': 'Streetlights', 'rows': 'streetlights.jsonl', 'min': 1000, 'build': streetlights,
     'settings': {'color': '#FFD54F', 'iconClass': 'Circle', 'browsable': True, 'inCaption': True, 'displayOnLoad': False,
                  'fields': [{'key': 'name', 'type': 'String'}, {'key': 'Lamp', 'type': 'String'}]}},
    {'map': 4, 'name': 'Traffic Volumes', 'rows': 'traffic.jsonl', 'min': 5, 'build': traffic,
     'settings': {'color': '#FB8C00', 'weight': 6, 'browsable': True, 'inCaption': True, 'displayOnLoad': False,
                  'fields': [{'key': 'name', 'type': 'String'}, {'key': 'Vehicles a day', 'type': 'String'},
                             {'key': 'Summer / winter', 'type': 'String'}, {'key': 'description', 'type': 'Text'}]}},
    {'map': 7, 'name': 'EV Chargers', 'rows': 'ev.jsonl', 'min': 1, 'build': ev_chargers,
     'settings': {'color': '#1E88E5', 'iconClass': 'Drop', 'iconUrl': '🔌', 'browsable': True, 'inCaption': True,
                  'fields': [{'key': 'name', 'type': 'String'}, {'key': 'Plugs', 'type': 'String'}]}},
]
