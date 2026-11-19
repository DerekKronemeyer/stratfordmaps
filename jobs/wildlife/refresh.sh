#!/bin/bash
# Wildlife map refresh, run on elsa by stratfordmaps-sync just before it fetches uMap and pushes the site.
# hub (inat_observations, scraped weekly) -> Wildlife uMap (map 18) layers. Skips uMap when nothing changed,
# so the site only gets a commit when there are new or changed sightings.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
IMPORT=/home/derek/umap/uploads/import          # /srv/umap/uploads/import inside the uMap container
STATE=/home/derek/umap/publish/wildlife_rows.sha256
ROWS="$IMPORT/wildlife_rows.jsonl"

docker exec -i maps-db psql -U datahub -d datahub -At -v ON_ERROR_STOP=1 < "$HERE/hub_query.sql" > "$ROWS" || { echo "wildlife: hub query failed, uMap left as is"; rm -f "$ROWS"; exit 0; }
n=$(grep -c '^{' "$ROWS")
if [ "$n" -lt 3000 ]; then echo "wildlife: only $n sightings from the hub (expected thousands), uMap left as is"; rm -f "$ROWS"; exit 0; fi
sum=$(sha256sum "$ROWS" | cut -d' ' -f1)
if [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$sum" ]; then echo "wildlife: no new sightings"; rm -f "$ROWS"; exit 0; fi
cat "$HERE/popups.py" "$HERE/umap_update.py" | docker exec -i umap umap shell && echo "$sum" > "$STATE" && echo "wildlife: uMap updated with $n sightings"
rm -f "$ROWS"
exit 0
