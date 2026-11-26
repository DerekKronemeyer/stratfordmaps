// The walking network page (/walking/network): what Navigation finds routes on, drawn from walking-network.json.
// A simplified version of the build's review page (Derek 2026-11-27): one colour per kind of piece, each can be switched off.
(async () => {
  const town = { minzoom: 12, maxzoom: 18, bounds: [-63.1336, 46.1837, -63.0181, 46.2502] };
  const map = new maplibregl.Map({
    container: 'map', center: [-63.085, 46.215], zoom: 13.6, maxZoom: 20, hash: true, attributionControl: { compact: true },
    style: {
      version: 8,
      sources: {
        esri: { type: 'raster', tileSize: 256, maxzoom: 18, tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], attribution: 'Imagery &copy; Esri' },
        town: { type: 'raster', tileSize: 256, tiles: ['https://tiles.stratfordmaps.ca/aerial-2025b/{z}/{x}/{y}.webp'], ...town, attribution: 'Imagery &copy; Town of Stratford, from the Province of PEI (2025)' },
      },
      layers: [{ id: 'esri', type: 'raster', source: 'esri' }, { id: 'town', type: 'raster', source: 'town' }],
    },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  const d = await (await fetch('/static/data/walking-network.json')).json();
  const F = d.flags;
  const features = d.edges.map(([a, b, flags, name, len, mid]) => {
    const c = [d.nodes[a]];
    for (let i = 0; i < mid.length; i += 2) c.push([mid[i], mid[i + 1]]);
    c.push(d.nodes[b]);
    return { type: 'Feature', properties: { flags, name: d.names[name] }, geometry: { type: 'LineString', coordinates: c } };
  });
  const bit = (f) => ['!=', ['%', ['floor', ['/', ['get', 'flags'], f]], 2], 0];
  const not = (x) => ['!', x];
  // key, label, colour, which pieces, drawn on by default
  const KINDS = [
    ['edge', 'Street edges', '#6e6e6e', ['all', not(bit(F.infra)), not(bit(F.cross)), not(bit(F.busy)), not(bit(F.service)), not(bit(F.private))], true],
    ['busy', 'Busy street edges', '#ff6a3d', ['all', not(bit(F.infra)), not(bit(F.cross)), bit(F.busy)], true],
    ['service', 'Service roads (lots and lanes)', '#ffb347', ['all', not(bit(F.cross)), bit(F.service)], true],
    ['private', 'Private roads', '#c07ee0', ['all', not(bit(F.cross)), bit(F.private)], true],
    ['trail', 'Trails', '#3ccf5a', ['all', bit(F.infra), not(bit(F.sidewalk)), not(bit(F.cross)), not(bit(F.lowtide))], true],
    ['sidewalk', 'Sidewalks', '#29c6f0', ['all', bit(F.sidewalk), not(bit(F.cross))], true],
    ['crossing', 'Crosswalks and road crossings', '#ffe14d', bit(F.cross), true],
    ['lowtide', 'Low-tide hike', '#1e88e5', ['all', bit(F.lowtide), not(bit(F.cross))], true],
  ];
  map.on('load', () => {
    map.addSource('net', { type: 'geojson', data: { type: 'FeatureCollection', features } });
    const W = ['interpolate', ['linear'], ['zoom'], 13, 1.5, 17, 4, 19, 6];
    for (const [key, , color, filter, on] of KINDS) {
      map.addLayer({ id: key, source: 'net', type: 'line', filter, layout: { 'line-cap': 'round', 'line-join': 'round', visibility: on ? 'visible' : 'none' }, paint: { 'line-color': color, 'line-width': W } });
    }
  });
  const key = document.getElementById('net-key');
  key.insertAdjacentHTML('beforeend', KINDS.map(([k, label, color, , on]) =>
    `<label><input type="checkbox" data-k="${k}"${on ? ' checked' : ''}><span class="swatch-line" style="--c:${color}"></span>${label}</label>`).join(''));
  key.addEventListener('change', (e) => { const k = e.target.dataset.k; if (k) map.setLayoutProperty(k, 'visibility', e.target.checked ? 'visible' : 'none'); });
})();
