# Builds the Wildlife map's features (popup text, layer, Confirmed, _date) from the hub's sightings.
# Plain Python, no Django: used by umap_update.py inside the uMap container (refresh.sh sends both files)
# and by preview.py to try changes on the local dev site without touching uMap.
import json
import re
from collections import defaultdict

# iNaturalist's iconic taxon -> Wildlife layer name in uMap.
LAYER = {'Aves': 'Birds', 'Mammalia': 'Mammals', 'Insecta': 'Bugs and spiders', 'Arachnida': 'Bugs and spiders',
         'Plantae': 'Plants and seaweed', 'Chromista': 'Plants and seaweed', 'Fungi': 'Mushrooms and fungi', 'Protozoa': 'Mushrooms and fungi'}
OTHER = 'Other animals'  # frogs, snakes, turtles, snails, shellfish, fish, worms, crabs, unidentified
LIC = {'cc0': 'CC0', 'cc-by': 'CC BY', 'cc-by-nc': 'CC BY-NC', 'cc-by-sa': 'CC BY-SA', 'cc-by-nd': 'CC BY-ND', 'cc-by-nc-sa': 'CC BY-NC-SA', 'cc-by-nc-nd': 'CC BY-NC-ND'}


def build_features(path):
    """Hub rows (JSON lines from hub_query.sql) -> {layer name: [GeoJSON features]}."""
    feats = defaultdict(list)
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line.startswith('{'):
            continue
        o = json.loads(line)
        name = o['common'] or o['sci'] or 'Unknown'
        name = name[0].upper() + name[1:]
        confirmed = o['grade'] == 'research'
        d = [f"*{o['sci']}*, seen {o['date'] or 'on an unknown date'}." if o['sci'] else f"Seen {o['date'] or 'on an unknown date'}."]
        # Its groups (genus, family, order), so searching "frog" or "maple" finds every species in them.
        groups = []
        for rank in ('genus', 'family', 'order'):
            g = next((a for a in (o.get('lineage') or []) if a.get('rank') == rank), None)
            label = g and (g.get('common_name') or g.get('name'))
            if label and label.lower() != name.lower() and label not in groups:
                groups.append(label)
        if groups:
            d.append('Belongs to: ' + ', '.join(groups) + '.')
        if not confirmed:
            d.append('Not yet confirmed by other iNaturalist users, so the name may be wrong.')
        # Who identified it: other people's current identifications that agree (confirmed) or that exist at all (not yet).
        others = [x for x in (o.get('ids') or []) if x.get('current') and x.get('user_login') and x['user_login'] != o['user']]
        agree = [x['user_login'] for x in others if x.get('taxon_id') == o.get('taxon_id') or x.get('category') in ('supporting', 'improving')]
        who = list(dict.fromkeys(agree if confirmed else [x['user_login'] for x in others]))
        if who:
            names = ', '.join(who[:3]) + (f' and {len(who) - 3} other{"s" if len(who) > 4 else ""}' if len(who) > 3 else '')
            d.append(f"{'Confirmed' if confirmed else 'Identified'} by {names}.")
        notes = ' '.join(re.sub(r'[\[\]{}*]', '', re.sub(r'https?://\S+', '', o.get('notes') or '')).split())  # plain text only: no links, images or markup
        if notes:
            d.append('“' + (notes if len(notes) <= 200 else notes[:197].rsplit(' ', 1)[0] + '…') + '” (observer’s notes)')
        # Photos: only ones the photographer licensed for reuse. The first is shown large, up to 4 more as thumbnails.
        photos = [x for x in (o.get('photos') or []) if x.get('url') and x.get('license_code')]
        if not photos and o['photo'] and o['photo_lic']:
            photos = [{'url': o['photo'], 'license_code': o['photo_lic']}]
        if photos:
            d.append('{{' + photos[0]['url'].replace('/square.', '/medium.') + '}}')
            if len(photos) > 1:
                d.append(''.join('{{' + x['url'].replace('/medium.', '/square.') + '}}' for x in photos[1:5]))
            lics = sorted({LIC.get(x['license_code'], x['license_code']) for x in photos[:5]})
            d.append(f"Photo{'s' if len(photos) > 1 else ''} © {o['user']}, {' / '.join(lics)}.")
        for snd in [x for x in (o.get('sounds') or []) if x.get('url') and x.get('license_code')][:2]:
            d.append(f"[[{snd['url']}|Listen]] Recording © {o['user']}, {LIC.get(snd['license_code'], snd['license_code'])}.")
        d.append(f"[[https://www.inaturalist.org/observations/{o['id']}|See it on iNaturalist]]")
        feats[LAYER.get(o['group'], OTHER)].append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [float(o['lng']), float(o['lat'])]},
            'properties': {'id': f"inat-{o['id']}", 'name': name, 'description': '\n\n'.join(d), 'Confirmed': 'yes' if confirmed else 'no', '_date': o['date'] or '', '_by': o['user'] or ''}})  # _by: hidden, for the leaderboard  # _date: hidden, for the site's date filter
    return feats
