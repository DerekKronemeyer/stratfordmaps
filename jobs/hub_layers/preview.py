# Dev-site preview: adds or refreshes the hub-fed layers in src/static/data/<map>.json, using the same layers.py
# as the real refresh, without touching uMap (so nothing goes live).
#   for q in traffic ev; do tailscale ssh derek@elsa 'docker exec -i maps-db psql -U datahub -d datahub -At' < $q.sql > <dir>/$q.jsonl; done
#   python preview.py <dir>     (then node build.mjs)
import json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ns = {}
exec((HERE / 'layers.py').read_text(encoding='utf-8'), ns)
ns['IMPORT'] = sys.argv[1]
SLUGS = {2: 'walking', 4: 'streets', 7: 'community-resources'}
STYLE_KEYS = ['color', 'weight', 'opacity', 'fillColor', 'fillOpacity', 'iconUrl']

for spec in ns['LAYERS']:
    feats = []
    for f in spec['build']():  # flattened the way fetch-umap.mjs does
        props = dict(f['properties'])
        style = props.pop('_umap_options', {})
        props.update({f'_{k}': style[k] for k in STYLE_KEYS if k in style})
        feats.append({'type': 'Feature', 'properties': props, 'geometry': f['geometry']})
    s = spec['settings']
    layer = {'key': spec['name'].lower().replace(' ', '-'), 'name': spec['name'], 'color': s.get('color', 'DarkBlue'),
             'weight': s.get('weight', 3), 'opacity': s.get('opacity', 1), 'fillColor': None, 'fillOpacity': 0.3,
             'iconClass': s.get('iconClass'), 'iconUrl': None, 'show': s.get('displayOnLoad') is not False,
             'showLabel': False, 'fields': [x['key'] for x in s.get('fields', [])], 'features': feats}
    path = HERE.parents[1] / 'src' / 'static' / 'data' / f"{SLUGS[spec['map']]}.json"
    data = json.loads(path.read_text(encoding='utf-8'))
    # data['layers'] runs bottom to top (the site lists it reversed), so first = end of the site's list.
    data['layers'] = [layer] + [l for l in data['layers'] if l['name'] != spec['name']]
    path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    print(path.name, spec['name'], len(feats))
