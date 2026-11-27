-- Streets map, Province roads to check: every Province road line in Stratford (pei_roads, refreshed monthly),
-- for layers.py roads_check() to compare with Derek's Roads and Service Roads layers. One JSON object per line.
SELECT json_build_object('oid', f.source_oid, 'road', f.attrs->>'NAME', 'ownership', trim(f.attrs->>'OWNERSHIP'),
  'geometry', ST_AsGeoJSON(f.geom, 6)::json)
FROM canonical.feature f
WHERE f.dataset_id = 'pei_roads' AND f.state IS DISTINCT FROM 'stale' AND f.geom IS NOT NULL
ORDER BY f.source_oid;
