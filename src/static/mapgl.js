// Draws a map page with MapLibre from window.MAP_CONFIG.data (made by fetch-umap.mjs).
// Shareable links: ?layers=best,winter shows only those layers; &feature=<id> opens that feature.
(function () {
  const cfg = window.MAP_CONFIG;
  const params = new URLSearchParams(location.search);
  const narrow = window.matchMedia('(max-width: 700px)').matches;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const link = (u, label) => `<a href="${u}" target="_blank" rel="noopener">${label}</a>`;
  // A block of lines that all start with "- " or "1. " becomes a list; anything else a paragraph.
  const block = (p) => {
    const lines = p.split('\n');
    if (lines.every((x) => /^- /.test(x))) return `<ul>${lines.map((x) => `<li>${x.slice(2)}</li>`).join('')}</ul>`;
    if (lines.every((x) => /^\d+\. /.test(x))) return `<ol>${lines.map((x) => `<li>${x.replace(/^\d+\. /, '')}</li>`).join('')}</ol>`;
    // A bold heading line followed by a list: "**Implementation**\n1. ...".
    if (lines.length > 1 && /^<strong>[^<]+<\/strong>$/.test(lines[0])) return `<p class="h">${lines[0]}</p>${block(lines.slice(1).join('\n'))}`;
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  };
  // uMap text: {{image url}}, [[url|label]] links, bare URLs, **bold**, *italic*, lists, line breaks.
  const richText = (s) => esc(s)
    .replace(/\{\{((?:https?:\/\/|\/)[^}\s]+)\}\}/g, '<img src="$1" alt="" loading="lazy">')
    .replace(/\[\[(https?:\/\/[^|\]]+)\|([^\]]+)\]\]/g, (_, u, t) => link(u, t))
    .replace(/\[\[(https?:\/\/[^\]]+)\]\]/g, (_, u) => link(u, u))
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}${link(u, u.replace(/^https?:\/\/(www\.)?/, '').replace(/[/?#].*$/, ''))}`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .split(/\n{2,}/).map(block).join('');
  // A field value: links show just their domain; everything else is plain text.
  const valueHtml = (v) => (/^https?:\/\/\S+$/.test(v) ? link(esc(v), esc(v.replace(/^https?:\/\/(www\.)?/, '').replace(/[/?#].*$/, ''))) : esc(v));

  // ---------- Backgrounds ----------

  const ESRI = { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Imagery &copy; Esri, Vantor, City of Charlottetown, Earthstar Geographics' };
  const bases = {
    aerial: { name: 'Aerial', tiles: [ESRI.url], maxzoom: 18, attribution: ESRI.attribution },
    streets: { name: 'Streets', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
  };

  // ---------- Geometry helpers ----------

  const kindOf = (g) => (/Polygon/.test(g.type) ? 'area' : /LineString/.test(g.type) ? 'line' : 'point');
  const allCoords = (c) => (typeof c[0] === 'number' ? [c] : c.flatMap(allCoords));
  const centerOf = (g) => {
    if (g.type === 'Point') return g.coordinates;
    const pts = allCoords(g.coordinates);
    if (g.type === 'LineString') return pts[Math.floor(pts.length / 2)];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  };
  // Maps with a done checkbox (`done` in maps.json, e.g. the AT Plan's "Completed") draw ticked features
  // with a coloured edge and let the Map key show all, planned or completed features.
  const done = cfg.done;
  const isDone = (p) => !!done && ['true', '1', 'yes'].includes(String(p[done.field]).toLowerCase());
  const doneExpr = done ? ['in', ['downcase', ['to-string', ['get', done.field]]], ['literal', ['true', '1', 'yes']]] : false;
  // Popup table rows: every field except name, description, id, the done checkbox and hidden _style fields.
  const extraFields = (l, p) => [...new Set([...(l.fields || []), ...Object.keys(p)])].filter((k) => !['name', 'description', 'id', done?.field].includes(k) && !k.startsWith('_') && p[k] !== '' && p[k] != null);
  const hasContent = (l, p) => p.name || p.description || extraFields(l, p).length > 0;
  // uMap "icons" here are emoji (up to 4 characters, since some emoji are several); image URLs are ignored.
  const emojiOf = (icon) => (icon && [...icon].length <= 4 && !/^https?:|\//.test(icon) ? icon : '');

  fetch(cfg.data).then((r) => r.json()).then((data) => {
    const wanted = (params.get('layers') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const focusId = params.get('feature');
    for (const l of data.layers) {
      if (wanted.length) l.show = wanted.includes(l.key);
      if (focusId && l.features.some((f) => f.properties.id === focusId)) l.show = true;
      const kinds = new Set(l.features.map((f) => kindOf(f.geometry)));
      l.kind = kinds.has('area') ? 'area' : kinds.has('line') ? 'line' : 'point';
      // Pins for Drop/Default markers; plain dots for "Circle" layers and very dense ones.
      l.pins = kinds.has('point') && l.iconClass !== 'Circle' && l.iconClass !== 'Dot' && l.features.length <= 400;
    }
    // One-layer maps (oneLayer in maps.json) show a single layer at a time: the first one switched on.
    if (cfg.oneLayer) {
      const first = data.layers.find((l) => l.show) || data.layers[0];
      for (const l of data.layers) l.show = l === first;
    }
    // Phones are too narrow for the desktop view, so they start framed on what's switched on instead.
    const shownPts = data.layers.filter((l) => l.show).flatMap((l) => l.features.flatMap((f) => allCoords(f.geometry.coordinates)));
    const fit = narrow && !focusId && shownPts.length > 1
      ? shownPts.reduce(([[w, s], [e, n]], [x, y]) => [[Math.min(w, x), Math.min(s, y)], [Math.max(e, x), Math.max(n, y)]], [[180, 90], [-180, -90]])
      : null;
    // Show: all, planned (not done) or completed features. ?show=completed in a link picks one.
    let showMode = done && ['planned', 'completed'].includes(params.get('show')) ? params.get('show') : 'all';
    const showOk = (p) => showMode === 'all' || (showMode === 'completed') === isDone(p);
    const showFilter = () => (showMode === 'all' ? true : showMode === 'completed' ? doneExpr : ['!', doneExpr]);
    const startBase = /World_Imagery|aerial|satellite/i.test(`${data.basemap?.url} ${data.basemap?.name}`) || !data.basemap ? 'aerial' : 'streets';

    const map = new maplibregl.Map({
      container: 'map',
      // uMap (Leaflet) counts zoom in 256px tiles, MapLibre in 512px, so MapLibre's zoom is one lower for the same view.
      center: data.center, zoom: data.zoom - 1, maxZoom: 20,
      ...(fit ? { bounds: fit, fitBoundsOptions: { padding: 24, maxZoom: 15 } } : {}),
      attributionControl: { compact: true },
      style: {
        version: 8,
        sources: Object.fromEntries(Object.entries(bases).map(([k, b]) => [`base-${k}`, { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution }])),
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#2a2d32' } },
          ...Object.keys(bases).map((k) => ({ id: `base-${k}`, type: 'raster', source: `base-${k}`, layout: { visibility: k === startBase ? 'visible' : 'none' } })),
        ],
      },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
    if (document.fullscreenEnabled) map.addControl(new maplibregl.FullscreenControl(), 'top-right');

    // ---------- Drawing the layers ----------

    const markers = {}; // layer key -> [{ f, mk }] HTML pin markers
    const clickable = []; // MapLibre layer ids that open a popup, topmost first
    const layerOf = {}; // MapLibre layer id -> our layer
    // A feature's own style if it has one, otherwise the layer's.
    const style = (key, fallback) => ['coalesce', ['get', `_${key}`], fallback];
    const baseFilter = {}; // MapLibre layer id -> its geometry filter (the show filter is added on top)

    map.on('load', () => {
      // Start with the credits collapsed to the (i) button; MapLibre opens them on load.
      document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
      // Areas first, then lines, then dots, so smaller things stay on top.
      for (const l of data.layers) map.addSource(`src-${l.key}`, { type: 'geojson', data: { type: 'FeatureCollection', features: l.features } });
      const add = (l, spec, click) => {
        baseFilter[spec.id] = spec.filter;
        map.addLayer({ ...spec, filter: ['all', spec.filter, showFilter()], source: `src-${l.key}`, layout: { ...(spec.layout || {}), visibility: l.show ? 'visible' : 'none' } });
        layerOf[spec.id] = l;
        if (click) clickable.unshift(spec.id);
      };
      for (const l of data.layers) {
        if (!l.features.some((f) => kindOf(f.geometry) === 'area')) continue;
        const isArea = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
        add(l, { id: `${l.key}-fill`, type: 'fill', filter: isArea, paint: { 'fill-color': ['coalesce', ['get', '_fillColor'], ['get', '_color'], l.fillColor || l.color], 'fill-opacity': style('fillOpacity', l.fillOpacity) } }, true);
        add(l, { id: `${l.key}-outline`, type: 'line', filter: isArea, paint: { 'line-color': style('color', l.color), 'line-width': style('weight', l.weight) } });
      }
      for (const l of data.layers) {
        if (!l.features.some((f) => kindOf(f.geometry) === 'line')) continue;
        const isLine = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
        const rounded = { 'line-join': 'round', 'line-cap': 'round' };
        // A thin dark edge under each line keeps it readable on the aerial photo; done features get a
        // wider edge in the done colour instead (green for completed AT Plan projects).
        const casing = done
          ? { 'line-color': ['case', doneExpr, done.outline, '#111'], 'line-opacity': ['case', doneExpr, 1, 0.5], 'line-width': ['+', style('weight', l.weight), ['case', doneExpr, 6, 3]] }
          : { 'line-color': '#111', 'line-opacity': 0.5, 'line-width': ['+', style('weight', l.weight), 3] };
        const lineOpacity = done ? ['case', doneExpr, 1, style('opacity', l.opacity)] : style('opacity', l.opacity);
        add(l, { id: `${l.key}-casing`, type: 'line', filter: isLine, layout: rounded, paint: casing });
        add(l, { id: `${l.key}-line`, type: 'line', filter: isLine, layout: rounded, paint: { 'line-color': style('color', l.color), 'line-opacity': lineOpacity, 'line-width': style('weight', l.weight) } }, true);
      }
      for (const l of data.layers) {
        const points = l.features.filter((f) => f.geometry.type === 'Point');
        if (!points.length) continue;
        if (!l.pins) {
          add(l, { id: `${l.key}-point`, type: 'circle', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': style('color', l.color), 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 17, 7], 'circle-stroke-color': '#fff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 1.5] } }, true);
          continue;
        }
        markers[l.key] = points.map((f) => {
          const p = f.properties;
          const el = document.createElement('button');
          el.type = 'button';
          el.className = 'pin';
          el.style.setProperty('--pin-color', p._color || l.color);
          if (isDone(p)) el.style.setProperty('--pin-ring', done.outline);
          const mark = emojiOf(p._iconUrl || l.iconUrl) || (isDone(p) ? '✓' : '');
          el.innerHTML = `<span class="pin-head"><b>${esc(mark)}</b></span>${l.showLabel && p.name ? `<span class="pin-label">${esc(p.name)}</span>` : ''}`;
          el.setAttribute('aria-label', p.name || l.name);
          if (!hasContent(l, p)) el.style.cursor = 'default';
          el.addEventListener('click', (e) => { e.stopPropagation(); showPopup(l, f, f.geometry.coordinates); });
          const mk = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(f.geometry.coordinates);
          if (l.show && showOk(p)) mk.addTo(map);
          return { f, mk };
        });
      }

      const hitAt = (pt) => map.queryRenderedFeatures(pt, { layers: clickable }).find((x) => hasContent(layerOf[x.layer.id], x.properties));
      map.on('click', (e) => {
        const f = hitAt(e.point);
        if (f) showPopup(layerOf[f.layer.id], f, e.lngLat);
      });
      map.on('mousemove', (e) => { map.getCanvas().style.cursor = hitAt(e.point) ? 'pointer' : ''; });

      // A shared link to one feature: centre on it and open its popup.
      if (focusId) {
        for (const l of data.layers) {
          const f = l.features.find((x) => x.properties.id === focusId);
          if (!f) continue;
          const at = centerOf(f.geometry);
          map.jumpTo({ center: at, zoom: Math.max(map.getZoom(), 14) });
          showPopup(l, f, at);
          break;
        }
      }
    });

    // ---------- Popups ----------

    // Keep popups clear of the pin (about 34px tall, anchored at its tip).
    const PIN_OFFSET = { top: [0, 0], bottom: [0, -36], left: [16, -18], right: [-16, -18], 'top-left': [0, 0], 'top-right': [0, 0], 'bottom-left': [0, -36], 'bottom-right': [0, -36] };
    let popup;
    function showPopup(l, f, at) {
      const p = f.properties;
      if (!hasContent(l, p)) return;
      // Status line on done-checkbox maps, e.g. "High priority · Completed" (parts of a project share its name).
      let status = '';
      if (done?.status) {
        const parts = l.features.filter((x) => x.properties.name === p.name);
        const doneParts = parts.filter((x) => isDone(x.properties)).length;
        const note = isDone(p) ? (doneParts < parts.length ? 'This section is completed' : 'Completed') : doneParts ? 'Part of this project is completed' : '';
        status = `<p class="status"><strong>${esc(done.status.replace('{layer}', l.name))}</strong>${note ? ` · ${note}` : ''}</p>`;
      }
      const rows = extraFields(l, p).map((k) => `<tr><th>${esc(k)}</th><td>${valueHtml(String(p[k]))}</td></tr>`).join('');
      popup?.remove();
      popup = new maplibregl.Popup({ maxWidth: '340px', focusAfterOpen: false, offset: f.geometry.type === 'Point' && l.pins ? PIN_OFFSET : 8 })
        .setLngLat(at)
        .setHTML(`${p.name ? `<h3>${esc(p.name).replace(/\n/g, '<br>')}</h3>` : ''}${status}${rows ? `<table>${rows}</table>` : ''}${p.description ? richText(p.description) : ''}`)
        .addTo(map);
    }

    // ---------- Map key and Info panels ----------

    function setLayer(l, on) {
      l.show = on;
      for (const suffix of ['fill', 'outline', 'casing', 'line', 'point']) if (map.getLayer(`${l.key}-${suffix}`)) map.setLayoutProperty(`${l.key}-${suffix}`, 'visibility', on ? 'visible' : 'none');
      for (const { f, mk } of markers[l.key] || []) on && showOk(f.properties) ? mk.addTo(map) : mk.remove();
    }
    function setShow(mode) {
      showMode = mode;
      for (const [id, filter] of Object.entries(baseFilter)) map.setFilter(id, ['all', filter, showFilter()]);
      for (const l of data.layers) setLayer(l, l.show);
    }

    // The little sample beside each layer name: its emoji, or a patch of its line, area or dot colour.
    const swatch = (l) => {
      const icon = l.pins ? emojiOf(l.iconUrl) : '';
      if (icon) return `<span class="sw sw-icon">${esc(icon)}</span>`;
      const cls = { area: 'sw-area', line: 'sw-line', point: 'sw-dot' }[l.kind];
      return `<span class="sw ${cls}" style="--c:${esc(l.kind === 'area' ? l.fillColor || l.color : l.color)}"></span>`;
    };
    const keyPanel = document.getElementById('key-panel');
    // Checkboxes normally; radio buttons on one-layer maps, so picking a layer switches off the last one.
    const layerInput = cfg.oneLayer ? 'type="radio" name="layer"' : 'type="checkbox"';
    keyPanel.innerHTML = `<fieldset><legend>Layers</legend>${data.layers.map((l, i) => `<label><input ${layerInput} data-i="${i}"${l.show ? ' checked' : ''}>${swatch(l)}<span>${esc(l.name)}</span></label>`).join('')}</fieldset>
${done ? `<fieldset class="basemaps"><legend>Show</legend>${[['all', 'All'], ['planned', 'Planned'], ['completed', 'Completed']].map(([k, label]) => `<label><input type="radio" name="show" value="${k}"${k === showMode ? ' checked' : ''}><span>${label}</span></label>`).join('')}</fieldset>` : ''}
<fieldset class="basemaps"><legend>Background</legend>${Object.entries(bases).map(([k, b]) => `<label><input type="radio" name="base" value="${k}"${k === startBase ? ' checked' : ''}><span>${b.name}</span></label>`).join('')}</fieldset>`;
    keyPanel.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.i && cfg.oneLayer) data.layers.forEach((l, i) => setLayer(l, i === +t.dataset.i));
      else if (t.dataset.i) setLayer(data.layers[+t.dataset.i], t.checked);
      if (t.name === 'show') setShow(t.value);
      if (t.name === 'base') for (const k of Object.keys(bases)) map.setLayoutProperty(`base-${k}`, 'visibility', k === t.value ? 'visible' : 'none');
    });
    const updated = data.updated ? new Date(data.updated).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Halifax' }) : '';
    // The map's description from uMap (links allowed), or the card text if uMap has none.
    document.getElementById('info-panel').innerHTML = `${richText(data.description || cfg.description)}${updated ?`<p class="updated">Updated ${updated}</p>` : ''}`;

    // Each button opens and closes its own panel; opening one closes the other.
    const buttons = [...document.querySelectorAll('.map-buttons button')];
    const show = (btn) => {
      for (const b of buttons) {
        const open = b === btn;
        b.setAttribute('aria-expanded', String(open));
        document.getElementById(b.getAttribute('aria-controls')).hidden = !open;
      }
    };
    for (const b of buttons) b.addEventListener('click', () => show(b.getAttribute('aria-expanded') === 'true' ? null : b));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') show(null); });
    if (narrow) map.on('click', () => show(null));
    show(narrow ? null : document.getElementById('map-key')); // desktop opens with the key showing
  });
})();
