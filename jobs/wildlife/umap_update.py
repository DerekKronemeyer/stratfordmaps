# Replaces the iNaturalist sightings in the Wildlife uMap (map 18) with the hub's latest, keeping every layer's
# style, name and settings as Derek left them. Run inside the uMap container:
#   docker exec -i umap umap shell < umap_update.py   (with /srv/umap/uploads/import/wildlife_rows.jsonl in place)
# The eBird layer is left alone (it isn't refreshed; the site skips it).
import json
from collections import defaultdict
from django.core.files.base import ContentFile
from umap.models import DataLayer

MAP_ID = 18
ROWS = '/srv/umap/uploads/import/wildlife_rows.jsonl'
# iNaturalist's iconic taxon -> Wildlife layer name in uMap.
LAYER = {'Aves': 'Birds', 'Plantae': 'Plants', 'Insecta': 'Insects', 'Fungi': 'Mushrooms and fungi', 'Mammalia': 'Mammals',
         'Amphibia': 'Frogs, salamanders and snakes', 'Reptilia': 'Frogs, salamanders and snakes', 'Mollusca': 'Snails, slugs and shellfish',
         'Arachnida': 'Spiders and ticks'}
OTHER = 'Other animals and life'
LIC = {'cc0': 'CC0', 'cc-by': 'CC BY', 'cc-by-nc': 'CC BY-NC', 'cc-by-sa': 'CC BY-SA', 'cc-by-nd': 'CC BY-ND', 'cc-by-nc-sa': 'CC BY-NC-SA', 'cc-by-nc-nd': 'CC BY-NC-ND'}

feats = defaultdict(list)
for line in open(ROWS, encoding='utf-8'):
    line = line.strip()
    if not line.startswith('{'):
        continue
    o = json.loads(line)
    name = o['common'] or o['sci'] or 'Unknown'
    name = name[0].upper() + name[1:]
    confirmed = o['grade'] == 'research'
    d = [f"*{o['sci']}*, seen {o['date'] or 'on an unknown date'}." if o['sci'] else f"Seen {o['date'] or 'on an unknown date'}."]
    if not confirmed:
        d.append('Not yet confirmed by other iNaturalist users, so the name may be wrong.')
    if o['photo'] and o['photo_lic']:  # only photos the photographer licensed for reuse
        d.append('{{' + o['photo'].replace('/square.', '/medium.') + '}}')
        d.append(f"Photo © {o['user']}, {LIC.get(o['photo_lic'], o['photo_lic'])}.")
    d.append(f"[[https://www.inaturalist.org/observations/{o['id']}|See it on iNaturalist]]")
    feats[LAYER.get(o['group'], OTHER)].append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [float(o['lng']), float(o['lat'])]},
        'properties': {'name': name, 'description': '\n\n'.join(d), 'Confirmed': 'yes' if confirmed else 'no'}})

total = 0
for dl in DataLayer.objects.filter(map_id=MAP_ID).exclude(share_status=99):
    if dl.name not in set(LAYER.values()) | {OTHER}:
        continue
    gj = json.loads(dl.geojson.read())
    gj['features'] = feats.get(dl.name, [])
    dl.geojson.save(f'{dl.uuid}.geojson', ContentFile(json.dumps(gj).encode()), save=False)
    dl.save()
    total += len(gj['features'])
    print(f'{dl.name}: {len(gj["features"])}')
print('total', total)
