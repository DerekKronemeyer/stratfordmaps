-- Wildlife map sightings from the hub: iNaturalist, confirmed (research) or not yet (needs_id),
-- licences that allow reuse, real locations only, inside the Town of Stratford. One JSON object per line.
WITH town AS (
  SELECT ST_Union(geom) AS g FROM canonical.feature
  WHERE dataset_id = 'pei_municipal_boundary' AND attrs->>'MUNICIPAL1' = 'Town of Stratford'
)
SELECT json_build_object(
  'id', f.source_oid, 'lng', round(ST_X(f.geom)::numeric, 5), 'lat', round(ST_Y(f.geom)::numeric, 5),
  'common', f.attrs->>'common_name', 'sci', f.attrs->>'scientific_name', 'group', f.attrs->>'iconic_taxon',
  'date', f.attrs->>'observed_on', 'grade', f.attrs->>'quality_grade', 'user', f.attrs->>'user_login',
  'photo', f.attrs->>'photo_url', 'photo_lic', f.attrs->>'photo_license_code')
FROM canonical.feature f, town
WHERE f.dataset_id = 'inat_observations'
  AND f.state IS DISTINCT FROM 'stale'
  AND f.attrs->>'quality_grade' IN ('research', 'needs_id')
  AND f.attrs->>'license_code' IN ('cc0', 'cc-by', 'cc-by-nc')
  AND NOT (f.attrs->>'obscured')::boolean
  AND ST_Within(f.geom, town.g)
ORDER BY f.source_oid::bigint;
