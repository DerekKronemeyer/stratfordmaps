# Writes each hub-fed layer (LAYERS, from layers.py) into its uMap map: creates the layer the first time,
# otherwise replaces only its features, keeping the layer's name, style and settings as Derek left them.
# Only layers whose rows file is present are touched (refresh.sh removes the ones that didn't change).
import os
from django.core.files.base import ContentFile
from umap.models import DataLayer, Map

for spec in LAYERS:
    if not os.path.exists(f"{IMPORT}/{spec['rows']}"):
        continue
    feats = spec['build']()
    if len(feats) < spec['min']:
        print(f"{spec['name']}: only {len(feats)} features, left as is")
        continue
    m = Map.objects.get(pk=spec['map'])
    dl = DataLayer.objects.filter(map=m, name=spec['name']).exclude(share_status=99).first()
    if dl is None:
        settings = {'name': spec['name'], **spec['settings']}
        # New layers go at the END of the site's layer list (Derek), i.e. uMap rank 0, below the existing layers.
        for other in DataLayer.objects.filter(map=m).exclude(share_status=99):
            DataLayer.objects.filter(pk=other.pk).update(rank=other.rank + 1)
        dl = DataLayer(map=m, name=spec['name'], settings=settings, rank=0)
        gj = {'type': 'FeatureCollection', '_umap_options': settings, 'features': feats}
        print(f"{spec['name']}: new layer on map {m.pk}")
    else:
        gj = json.loads(dl.geojson.read())
        gj['features'] = feats
    dl.geojson.save(f'{dl.uuid}.geojson', ContentFile(json.dumps(gj).encode()), save=False)
    dl.save()
    print(f"{spec['name']}: {len(feats)} features")
