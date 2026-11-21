-- Community Resources map, EV chargers: open (or temporarily closed) charging stations inside Stratford (hub
-- pei_ev_chargers, all of PEI, clipped to the Town of Stratford boundary). One JSON object per line.
SELECT json_build_object(
  'id', f.source_oid, 'lng', round(ST_X(f.geom)::numeric, 6), 'lat', round(ST_Y(f.geom)::numeric, 6),
  'name', f.attrs->>'station_name', 'address', f.attrs->>'street_address', 'status', f.attrs->>'status_code',
  'l2', f.attrs->'ev_level2_evse_num', 'dc', f.attrs->'ev_dc_fast_num', 'l1', f.attrs->'ev_level1_evse_num',
  'network', f.attrs->>'ev_network', 'connectors', f.attrs->'ev_connector_types', 'units', f.attrs->'ev_charging_units',
  'hours', f.attrs->>'access_days_time', 'pricing', f.attrs->>'ev_pricing', 'where', f.attrs->>'intersection_directions',
  'confirmed', f.attrs->>'date_last_confirmed')
FROM canonical.feature f
WHERE f.dataset_id = 'pei_ev_chargers' AND f.state IS DISTINCT FROM 'stale' AND f.attrs->>'status_code' IN ('E', 'T')
  AND ST_Within(f.geom, (SELECT b.geom FROM canonical.feature b WHERE b.dataset_id = 'pei_municipal_boundary' AND b.name = 'Town of Stratford'))
ORDER BY f.source_oid::int;
