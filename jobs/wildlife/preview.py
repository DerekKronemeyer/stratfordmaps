# Dev-site preview: rebuilds the Wildlife sightings in src/static/data/wildlife.json from the hub, using the same
# popups.py as the real refresh, without touching uMap (so nothing goes live). Layer styles stay as fetched.
#   tailscale ssh derek@elsa 'docker exec -i maps-db psql -U datahub -d datahub -At' < hub_query.sql > rows.jsonl
#   python preview.py rows.jsonl     (then node build.mjs)
import json, sys
from pathlib import Path
from popups import build_features

feats = build_features(sys.argv[1])
data_file = Path(__file__).resolve().parents[2] / 'src' / 'static' / 'data' / 'wildlife.json'
data = json.loads(data_file.read_text(encoding='utf-8'))
for layer in data['layers']:
    if layer['name'] in feats:
        # same shape fetch-umap.mjs writes: coordinates rounded, style keys absent (layer defaults apply)
        layer['features'] = [{'type': 'Feature', 'properties': f['properties'], 'geometry': f['geometry']} for f in feats[layer['name']]]
        print(layer['name'], len(layer['features']))
data_file.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
