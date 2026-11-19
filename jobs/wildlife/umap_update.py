# Replaces the iNaturalist sightings in the Wildlife uMap (map 18) with the hub's latest, keeping every layer's
# style, name and settings as Derek left them. Runs inside the uMap container after popups.py:
#   cat popups.py umap_update.py | docker exec -i umap umap shell   (with /srv/umap/uploads/import/wildlife_rows.jsonl in place)
# The eBird layer is left alone (it isn't refreshed; the site skips it).
import json
from django.core.files.base import ContentFile
from umap.models import DataLayer

MAP_ID = 18
feats = build_features('/srv/umap/uploads/import/wildlife_rows.jsonl')  # from popups.py
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
