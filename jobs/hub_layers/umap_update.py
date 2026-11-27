# Writes each hub-fed layer (LAYERS, from layers.py) into its uMap map: creates the layer the first time,
# otherwise replaces only its features, keeping the layer's name, style and settings as Derek left them.
# Only layers whose rows file is present are touched (refresh.sh removes the ones that didn't change).
import os
import uuid
from django.core.files.base import ContentFile
from umap.models import DataLayer, Map

for spec in LAYERS:
    if not os.path.exists(f"{IMPORT}/{spec['rows']}"):
        continue
    if spec.get('field'):  # fill one field of an existing layer's features; never creates the layer
        if len(rows(spec['rows'])) < spec['min']:
            print(f"{spec['name']}: too few rows, left as is"); continue
        dl = DataLayer.objects.filter(map__pk=spec['map'], name=spec['name']).exclude(share_status=99).first()
        if dl is None:
            print(f"{spec['name']}: no such layer on map {spec['map']}, left as is"); continue
        gj = json.loads(dl.geojson.read())
        vals = spec['values'](gj['features'])
        n = 0
        for f in gj['features']:
            v, props = vals[id(f)], f.setdefault('properties', {})
            if props.get(spec['field']) != v:
                n += 1
                if v is None: props.pop(spec['field'], None)
                else: props[spec['field']] = v
        if n:
            dl.geojson.save(f'{dl.uuid}.geojson', ContentFile(json.dumps(gj).encode()), save=False)
            dl.save()
        print(f"{spec['name']}: {spec['field']} changed on {n} features")
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
        others = DataLayer.objects.filter(map=m).exclude(share_status=99)
        if any(o.rank <= 0 for o in others):  # make room at rank 0
            for other in others:
                DataLayer.objects.filter(pk=other.pk).update(rank=other.rank + 1)
        dl = DataLayer(map=m, name=spec['name'], settings=settings, rank=0, uuid=uuid.uuid4())
        gj = {'type': 'FeatureCollection', '_umap_options': settings, 'features': feats}
        print(f"{spec['name']}: new layer on map {m.pk}")
    else:
        gj = json.loads(dl.geojson.read())
        gj['features'] = feats
    dl.geojson.save(f'{dl.uuid}.geojson', ContentFile(json.dumps(gj).encode()), save=False)
    dl.save()
    print(f"{spec['name']}: {len(feats)} features")
