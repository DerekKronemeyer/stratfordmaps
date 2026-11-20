-- Walking map, Streetlights: the Town's streetlights (hub stratford_streetlights). One JSON object per line.
SELECT json_build_object(
  'id', f.source_oid, 'lng', round(ST_X(f.geom)::numeric, 6), 'lat', round(ST_Y(f.geom)::numeric, 6),
  'wattage', f.attrs->>'wattage', 'fixture', trim(f.attrs->>'description'), 'status', f.attrs->>'status')
FROM canonical.feature f
WHERE f.dataset_id = 'stratford_streetlights' AND f.state IS DISTINCT FROM 'stale'
ORDER BY f.source_oid::int;
