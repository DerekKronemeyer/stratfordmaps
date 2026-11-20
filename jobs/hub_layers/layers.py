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


LAYERS = [
    {'map': 2, 'name': 'Streetlights', 'rows': 'streetlights.jsonl', 'min': 1000, 'build': streetlights,
     'settings': {'color': '#FFD54F', 'iconClass': 'Circle', 'browsable': True, 'inCaption': True, 'displayOnLoad': False,
                  'fields': [{'key': 'name', 'type': 'String'}, {'key': 'Lamp', 'type': 'String'}]}},
    {'map': 4, 'name': 'Traffic Volumes', 'rows': 'traffic.jsonl', 'min': 5, 'build': traffic,
     'settings': {'color': '#FB8C00', 'weight': 6, 'browsable': True, 'inCaption': True, 'displayOnLoad': False,
                  'fields': [{'key': 'name', 'type': 'String'}, {'key': 'Vehicles a day', 'type': 'String'},
                             {'key': 'Summer / winter', 'type': 'String'}, {'key': 'description', 'type': 'Text'}]}},
]
