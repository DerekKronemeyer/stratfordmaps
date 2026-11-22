#!/bin/bash
# Hub-fed uMap layers (Streets: Traffic Volumes; Community Resources: EV chargers; Walking streetlights dropped 2026-11-21: the Town's list only has the lights it pays for), run on elsa by stratfordmaps-sync just
# before it fetches uMap and pushes the site. Each layer's SQL runs against the hub; uMap is only touched for
# layers whose rows changed since last time, so the site only gets a commit when the data changed.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
IMPORT=/home/derek/umap/uploads/import          # /srv/umap/uploads/import inside the uMap container
STATE=/home/derek/umap/publish
changed=()
for q in traffic ev; do
  rows="$IMPORT/$q.jsonl"
  if ! docker exec -i maps-db psql -U datahub -d datahub -At -v ON_ERROR_STOP=1 < "$HERE/$q.sql" > "$rows"; then
    echo "hub_layers: $q query failed, left as is"; rm -f "$rows"; continue
  fi
  sum=$(cat "$rows" "$HERE/layers.py" | sha256sum | cut -d' ' -f1)   # rows + how they are drawn
  if [ -f "$STATE/$q.sha256" ] && [ "$(cat "$STATE/$q.sha256")" = "$sum" ]; then
    echo "hub_layers: $q unchanged"; rm -f "$rows"; continue
  fi
  changed+=("$q:$sum")
done
if [ ${#changed[@]} -gt 0 ]; then
  if cat "$HERE/layers.py" "$HERE/umap_update.py" | docker exec -i umap umap shell; then
    for c in "${changed[@]}"; do echo "${c#*:}" > "$STATE/${c%%:*}.sha256"; done
  fi
fi
rm -f "$IMPORT/traffic.jsonl" "$IMPORT/ev.jsonl"
exit 0
