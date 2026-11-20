-- Streets map, Traffic volumes: the latest year's provincial count segments in Stratford, each with every
-- year's count (older segments matched by route section and position, since a few were re-cut over the years)
-- and the road name from pei_roads. One JSON object per line.
WITH t AS (
  SELECT f.geom, (f.attrs->>'survey_year')::int AS yr, f.attrs->>'PROVID' AS provid,
         (SELECT (v)::text::numeric FROM jsonb_each(f.attrs) e(k, v) WHERE lower(k) = 'aadt' AND jsonb_typeof(v) = 'number' LIMIT 1) AS aadt,
         (SELECT (v)::text::numeric FROM jsonb_each(f.attrs) e(k, v) WHERE lower(k) = 'sadt' AND jsonb_typeof(v) = 'number' LIMIT 1) AS sadt,
         (SELECT (v)::text::numeric FROM jsonb_each(f.attrs) e(k, v) WHERE lower(k) = 'wadt' AND jsonb_typeof(v) = 'number' LIMIT 1) AS wadt
  FROM canonical.feature f
  WHERE f.dataset_id = 'pei_traffic_volumes' AND f.state IS DISTINCT FROM 'stale'
), latest AS (
  SELECT * FROM t WHERE yr = (SELECT max(yr) FROM t)
)
SELECT json_build_object(
  'id', l.provid || '-' || round(ST_X(ST_LineInterpolatePoint(ST_LineMerge(l.geom), 0.5))::numeric, 4),
  'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(l.geom, 0.00002), 5)::json,
  'road', (SELECT r.attrs->>'NAME' FROM canonical.feature r     -- the road it runs along most (within 10 m)
           WHERE r.dataset_id = 'pei_roads' AND ST_DWithin(r.geom::geography, l.geom::geography, 10)
           ORDER BY ST_Length(ST_Intersection(r.geom, ST_Buffer(l.geom::geography, 10)::geometry)::geography) DESC LIMIT 1),
  'provid', l.provid, 'year', l.yr, 'aadt', l.aadt, 'sadt', l.sadt, 'wadt', l.wadt,
  'history', (SELECT json_object_agg(o.yr, o.aadt ORDER BY o.yr) FROM t o
              WHERE o.provid = l.provid AND o.aadt IS NOT NULL
                AND ST_DWithin(ST_LineInterpolatePoint(ST_LineMerge(o.geom), 0.5)::geography, l.geom::geography, 20)))
FROM latest l
ORDER BY l.provid;
