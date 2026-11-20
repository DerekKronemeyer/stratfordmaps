# Hub-fed layers in uMap, kept current by refresh.sh (run on elsa by stratfordmaps-sync before fetch-umap).
# Each entry: which uMap map and layer, the rows file its SQL wrote, how to turn rows into features, and the
# layer's settings (used when the layer is first created; later runs keep Derek's edits to the settings).
# Runs inside the uMap container:  cat layers.py umap_update.py | docker exec -i umap umap shell
import json

IMPORT = '/srv/umap/uploads/import'


def rows(name):
    with open(f'{IMPORT}/{name}', encoding='utf-8') as fh:
        return [json.loads(line) for line in fh if line.startswith('{')]


def fmt(n):
    return f'{int(round(float(n))):,}' if n not in (None, '') else ''


def road_name(s):
    words = {'RD': 'Road', 'HWY': 'Highway', 'DR': 'Drive', 'ST': 'Street', 'AVE': 'Avenue', 'LN': 'Lane', 'CRES': 'Crescent', 'CT': 'Court'}
    return ' '.join(words.get(w, w.capitalize()) for w in (s or '').split())


def streetlights():
    out = []
    for r in rows('streetlights.jsonl'):
        lamp = ' '.join(x for x in [f"{r['wattage']} W" if r.get('wattage') else '', r.get('fixture') or ''] if x)
        props = {'id': f"light-{r['id']}", 'name': 'Streetlight'}
        if lamp:
            props['Lamp'] = lamp
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
