// Trace water (Watershed map): click a spot to see where rain falling there runs downhill.
// Flow directions come from a 1 m / 2 m ground model (NRCan HRDEM 2020, streams burned in), cut into 512-cell tiles
// (flow/<res>/d/<row>_<col>.bin, gzip, 1 byte per cell) that load as a trace reaches them. See sandbox flow/04_tiles.py.
// mapgl.js calls window.FlowTool(map, cfg.flow) after the map loads; while `active`, clicks trace instead of opening popups.
window.FlowTool = function (map, opt) {
  const R = 6378137;
  const toMerc = ([lng, lat]) => [(lng * Math.PI * R) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
  const toLngLat = ([x, y]) => [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)];
  // Codes 1-8: E, SE, S, SW, W, NW, N, NE. 0 = runs off the land into the water, 9 = water.
  const DR = [0, 0, 1, 1, 1, 0, -1, -1, -1];
  const DC = [0, 1, 1, 0, -1, -1, -1, 0, 1];
  const resList = opt.res || ['2m'];
  let res = resList[0];
  const base = opt.path || '/static/flow';

  // ---------- Grids and tiles ----------
  const grids = {};
  async function grid(r) {
    if (!grids[r]) grids[r] = fetch(`${base}/${r}/meta.json`).then((x) => x.json()).then((m) => ({ ...m, res: r, have: new Set(m.tiles), d: new Map(), z: new Map(), loading: new Map() }));
    return grids[r];
  }
  async function bytes(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${url}: ${resp.status}`);
    return new Response(resp.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  function load(g, kind, name) {
    const key = kind + name;
    if (!g.loading.has(key)) g.loading.set(key, bytes(`${base}/${g.res}/${kind}/${name}.bin`).then((buf) => g[kind].set(name, kind === 'z' ? new Int16Array(buf) : new Uint8Array(buf))));
    return g.loading.get(key);
  }
  const tileOf = (g, r, c) => `${Math.floor(r / g.tile)}_${Math.floor(c / g.tile)}`;
  const inTile = (g, r, c) => (r % g.tile) * g.tile + (c % g.tile);
  // Direction code at a cell: -1 off the grid, 9 water, undefined if its tile isn't loaded yet.
  function codeAt(g, r, c) {
    if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) return -1;
    const name = tileOf(g, r, c);
    if (!g.have.has(name)) return 9;
    const t = g.d.get(name);
    return t ? t[inTile(g, r, c)] : undefined;
  }
  async function heightAt(g, r, c) {
    const name = tileOf(g, r, c);
    if (!g.have.has(name)) return null;
    await load(g, 'z', name);
    const v = g.z.get(name)[((r % g.tile) >> 3) * (g.tile >> 3) + ((c % g.tile) >> 3)]; // 8x8-cell averages, in dm
    return v === -32768 ? null : v / 10;
  }
  const cellCentre = (g, r, c) => toLngLat([g.x0 + (c + 0.5) * g.cell, g.y0 - (r + 0.5) * g.cell]);

  // ---------- Downstream: follow the arrows to the water ----------
  async function down(g, r, c) {
    const cells = [[r, c]];
    const seen = new Set();
    let end;
    for (;;) {
      const k = codeAt(g, r, c);
      if (k === undefined) { await load(g, 'd', tileOf(g, r, c)); continue; }
      if (k === -1) { end = 'edge'; break; }
      if (k === 9) { cells.pop(); end = 'water'; break; } // stepped into the water: the last land cell is the end
      if (k === 0) { end = 'water'; break; }
      const key = r * g.cols + c;
      if (seen.has(key)) { end = 'loop'; break; }
      seen.add(key);
      r += DR[k]; c += DC[k];
      cells.push([r, c]);
    }
    if (!cells.length) cells.push([r, c]);
    // Keep only the corners of the path (where its direction changes).
    const pts = cells.filter((p, i) => i === 0 || i === cells.length - 1 || p[0] - cells[i - 1][0] !== cells[i + 1][0] - p[0] || p[1] - cells[i - 1][1] !== cells[i + 1][1] - p[1]);
    return { end, cells, coords: pts.map(([a, b]) => cellCentre(g, a, b)), metres: pathLength(g, cells) };
  }
  function pathLength(g, cells) {
    let n = 0;
    for (let i = 1; i < cells.length; i++) n += cells[i][0] !== cells[i - 1][0] && cells[i][1] !== cells[i - 1][1] ? Math.SQRT2 : 1;
    return n * g.metres;
  }

  // ---------- Map layers ----------
  const EMPTY = { type: 'FeatureCollection', features: [] };
  map.addSource('flow-down', { type: 'geojson', data: EMPTY });
  map.addSource('flow-start', { type: 'geojson', data: EMPTY });
  // The traced line: a soft glow, a dark edge and a bright core, wider as you zoom in, so it stands out from the streams.
  const W = (a, b) => ['interpolate', ['linear'], ['zoom'], 12, a, 17, b];
  const round = { 'line-join': 'round', 'line-cap': 'round' };
  map.addLayer({ id: 'flow-down-glow', type: 'line', source: 'flow-down', layout: round, paint: { 'line-color': '#5fd8ff', 'line-width': W(16, 26), 'line-blur': 8, 'line-opacity': 0.45 } });
  map.addLayer({ id: 'flow-down-casing', type: 'line', source: 'flow-down', layout: round, paint: { 'line-color': '#021522', 'line-width': W(9, 15), 'line-opacity': 0.9 } });
  map.addLayer({ id: 'flow-down', type: 'line', source: 'flow-down', layout: round, paint: { 'line-color': '#5fd8ff', 'line-width': W(5, 9) } });
  map.addLayer({ id: 'flow-start', type: 'circle', source: 'flow-start', paint: { 'circle-radius': 8, 'circle-color': '#4dc4ff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  let anim;
  function drawPath(coords) {
    cancelAnimationFrame(anim);
    const t0 = performance.now(), ms = Math.min(2500, 400 + coords.length * 4);
    const step = (t) => {
      const n = Math.max(2, Math.ceil((coords.length * Math.min(1, (t - t0) / ms))));
      map.getSource('flow-down').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords.slice(0, n) } });
      if (n < coords.length) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }
  function clear() {
    cancelAnimationFrame(anim);
    map.getSource('flow-down').setData(EMPTY);
    map.getSource('flow-start').setData(EMPTY);
  }

  // ---------- Button and note ----------
  const btn = document.getElementById('map-flow'); // beside Info (build.mjs)
  const note = document.createElement('div');
  note.className = 'map-panel flow-note';
  note.hidden = true;
  map.getContainer().append(note);

  const fmtKm = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
  let last = null, busy = 0, message = '';
  function renderNote() {
    note.innerHTML = `<div class="filters-head"><span class="key-head">Trace Water</span><button type="button" class="reset-btn" data-flow-close>Close</button></div>
<p class="flow-msg">${message || 'Click anywhere on the map to see where rain falling there runs downhill.'}</p>
${resList.length > 1 ? `<div class="seg-row"><span>Detail</span><div class="seg">${resList.map((r) => `<button type="button" data-flow-res="${r}" aria-pressed="${r === res}">${r.replace('m', ' m')}</button>`).join('')}</div></div>` : ''}
<p class="flow-caveat">A rough guide from the shape of the ground in 2020. Storm sewers and culverts are not modelled, so where a street has storm drains the water really goes underground.</p>`;
  }
  async function trace(lngLat) {
    const id = ++busy;
    last = lngLat;
    const g = await grid(res);
    const [x, y] = toMerc([lngLat.lng, lngLat.lat]);
    const c = Math.floor((x - g.x0) / g.cell), r = Math.floor((g.y0 - y) / g.cell);
    cancelAnimationFrame(anim);
    map.getSource('flow-down').setData(EMPTY);
    map.getSource('flow-start').setData(EMPTY);
    const k0 = codeAt(g, r, c);
    if (k0 === -1) { message = 'That spot is outside the area this tool covers.'; return renderNote(); }
    if (k0 === undefined) await load(g, 'd', tileOf(g, r, c));
    if (codeAt(g, r, c) === 9) { message = 'That spot is in the water. Click on land to trace where rain runs.'; return renderNote(); }
    map.getSource('flow-start').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] } });
    message = 'Tracing…';
    renderNote();
    const d = await down(g, r, c);
    if (id !== busy) return;
    drawPath(d.coords);
    const end = d.cells[d.cells.length - 1];
    const [z0, z1] = await Promise.all([heightAt(g, r, c), heightAt(g, end[0], end[1])]);
    const drop = z0 != null && z1 != null ? Math.max(0, Math.round(z0 - z1)) : null;
    const where = d.end === 'water' ? 'before it reaches the water' : d.end === 'edge' ? 'before it leaves the area this tool covers' : 'before it settles in a low spot';
    const first = d.metres < 5 ? 'Rain falling here runs straight into the water.' : `Rain falling here runs about ${fmtKm(d.metres)}${drop ? ` and drops ${drop} m` : ''} ${where}.`;
    message = first;
    renderNote();
  }
  function setActive(on) {
    tool.active = on;
    btn.setAttribute('aria-pressed', String(on));
    note.hidden = !on;
    map.getCanvas().style.cursor = on ? 'crosshair' : '';
    if (on) { message = ''; renderNote(); } else { busy++; last = null; clear(); }
  }
  btn.addEventListener('click', () => setActive(!tool.active));
  note.addEventListener('click', (e) => {
    if (e.target.closest('[data-flow-close]')) return setActive(false);
    const pick = e.target.closest('[data-flow-res]');
    if (!pick || pick.dataset.flowRes === res) return;
    res = pick.dataset.flowRes;
    if (last) trace(last); else renderNote();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && tool.active) setActive(false); });
  map.on('click', (e) => { if (tool.active) trace(e.lngLat); });
  map.on('mousemove', () => { if (tool.active) map.getCanvas().style.cursor = 'crosshair'; });
  const tool = { active: false, trace: (lng, lat) => { if (!tool.active) setActive(true); return trace({ lng, lat }); } };
  window.FlowTool.instance = tool; // for testing from the console
  return tool;
};
