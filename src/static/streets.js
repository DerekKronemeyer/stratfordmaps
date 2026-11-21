// Streets view (Housing Density, `streets` in maps.json): streets coloured by the homes or buildings on them, or by
// the households that would pass along them if every household drove to one spot. Each building names its street (`Street`, edited in uMap); the street
// network (static/data/housing-density-streets.json, from sandbox housing/build_streets.py) is the Province's road
// centrelines inside Stratford with a shared point at every junction.
// mapgl.js calls window.StreetsView(map, data, cfg.streets) after the map loads and drives it (setActive, refresh,
// click, html for the Map key options).
window.StreetsView = function (map, data, opt) {
  // Modes: homes, homesM (per 100 m), bldgs, bldgsM, traffic. The Map key shows them as two switches
  // (Count: Homes | Buildings, Measure: Total | Per 100 m) plus a "Where would traffic go?" button.
  const RAMP = ['#ffffb2', '#fed976', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026']; // YlOrRd, like the buildings
  const sv = { active: false, mode: 'homes', dest: null };
  let net = null; // loaded on first use

  // ---------- Geometry helpers (metres, good enough across a town) ----------
  const M_LAT = 111320, M_LNG = 111320 * Math.cos((46.22 * Math.PI) / 180);
  const dist = (a, b) => Math.hypot((a[0] - b[0]) * M_LNG, (a[1] - b[1]) * M_LAT);
  const key = (c) => `${Math.round(c[0] * 1e5)},${Math.round(c[1] * 1e5)}`; // ~1 m: the same junction
  // Nearest point on segment a-b to p: [point, distance from a along the segment, distance from p]
  function project(p, a, b) {
    const ax = a[0] * M_LNG, ay = a[1] * M_LAT, bx = b[0] * M_LNG, by = b[1] * M_LAT, px = p[0] * M_LNG, py = p[1] * M_LAT;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
    const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    return [q, t * Math.sqrt(L2), Math.hypot(px - (ax + dx * t), py - (ay + dy * t))];
  }
  const inRing = ([x, y], ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  // ---------- The network: junction points (nodes) joined by short pieces (arcs), each on a named street ----------
  async function load() {
    if (net) return net;
    const raw = await (await fetch(opt.url)).json();
    const nodeOf = new Map(), nodes = [], arcs = [], adj = [];
    const node = (c) => {
      const k = key(c);
      if (!nodeOf.has(k)) { nodeOf.set(k, nodes.length); nodes.push(c); adj.push([]); }
      return nodeOf.get(k);
    };
    for (const [ni, cs] of raw.edges) {
      for (let i = 1; i < cs.length; i++) {
        const a = node(cs[i - 1]), b = node(cs[i]);
        if (a === b) continue;
        const id = arcs.length;
        arcs.push({ a, b, name: raw.names[ni], len: dist(cs[i - 1], cs[i]) });
        adj[a].push(id); adj[b].push(id);
      }
    }
    // The main connected network (a few private bits stand alone): buildings and destinations attach to it.
    const comp = new Int32Array(nodes.length).fill(-1);
    let best = 0, bestSize = 0;
    for (let s = 0, c = 0; s < nodes.length; s++) {
      if (comp[s] >= 0) continue;
      let size = 0;
      const stack = [s];
      comp[s] = c;
      while (stack.length) {
        const x = stack.pop(); size++;
        for (const id of adj[x]) { const y = arcs[id].a === x ? arcs[id].b : arcs[id].a; if (comp[y] < 0) { comp[y] = c; stack.push(y); } }
      }
      if (size > bestSize) { bestSize = size; best = c; }
      c++;
    }
    const mainArcs = arcs.map((_, i) => i).filter((i) => comp[arcs[i].a] === best);
    const byName = new Map();
    const lengthOf = new Map();
    for (const i of mainArcs) {
      const n = arcs[i].name;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(i);
    }
    for (const arc of arcs) lengthOf.set(arc.name, (lengthOf.get(arc.name) || 0) + arc.len);
    // A grid of arcs for quick "nearest street" lookups.
    const CELL = 0.002, grid = new Map();
    const cellKey = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
    for (const i of mainArcs) {
      const p = nodes[arcs[i].a], q = nodes[arcs[i].b];
      const ks = new Set([cellKey(p[0], p[1]), cellKey(q[0], q[1]), cellKey((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)]);
      for (const k of ks) { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
    }
    const nearArcs = (c) => {
      const out = [];
      const cx = Math.floor(c[0] / CELL), cy = Math.floor(c[1] / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(grid.get(`${cx + dx},${cy + dy}`) || []));
      return out;
    };
    const closest = (c, ids) => {
      let bestArc = null;
      for (const i of ids) {
        const [q, along, d] = project(c, nodes[arcs[i].a], nodes[arcs[i].b]);
        if (!bestArc || d < bestArc.d) bestArc = { arc: i, at: q, along, d };
      }
      return bestArc;
    };
    // Each building hangs off the nearest point on its own street (else the nearest street).
    const buildings = [];
    for (const l of data.layers) for (const f of l.features) {
      if (f.geometry.type !== 'Point') continue;
      const c = f.geometry.coordinates, street = f.properties.Street;
      const own = street && byName.get(street);
      const hook = (own && closest(c, own)) || closest(c, nearArcs(c)) || closest(c, mainArcs);
      buildings.push({ l, f, street: street || '', units: Number(f.properties.Units) || 1, hook });
    }
    net = { nodes, arcs, adj, mainArcs, byName, lengthOf, nearArcs, closest, buildings, town: raw.town };
    return net;
  }

  // ---------- Map layers ----------
  const EMPTY = { type: 'FeatureCollection', features: [] };
  map.addSource('sv-lines', { type: 'geojson', data: EMPTY });
  map.addSource('sv-dest', { type: 'geojson', data: EMPTY });
  const W = (a, b) => ['interpolate', ['linear'], ['zoom'], 12, a, 17, b];
  const WW = (a, b) => ['interpolate', ['linear'], ['zoom'], 12, ['*', ['get', 'w'], a], 17, ['*', ['get', 'w'], b]]; // per-line width, grows with zoom
  map.addLayer({ id: 'sv-glow', type: 'line', source: 'sv-lines', layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
    paint: { 'line-color': ['get', 'c'], 'line-width': WW(3, 7), 'line-blur': W(3, 8), 'line-opacity': ['case', ['get', 'zero'], 0, 0.55] } });
  map.addLayer({ id: 'sv-line', type: 'line', source: 'sv-lines', layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
    paint: { 'line-color': ['get', 'c'], 'line-width': WW(1.2, 3), 'line-opacity': ['case', ['get', 'zero'], 0.35, 1] } });
  map.addLayer({ id: 'sv-dest', type: 'circle', source: 'sv-dest', layout: { visibility: 'none' },
    paint: { 'circle-radius': 8, 'circle-color': '#fff', 'circle-stroke-color': '#bd0026', 'circle-stroke-width': 4 } });

  // A colour for a value: six classes split at even steps of the values' spread (quantiles), like uMap's palette.
  function scale(values) {
    const v = values.filter((x) => x > 0).sort((a, b) => a - b);
    if (!v.length) return { color: () => '#888', breaks: [] };
    const breaks = [1, 2, 3, 4, 5].map((k) => v[Math.min(v.length - 1, Math.floor((k * v.length) / 6))]);
    return { breaks, max: v[v.length - 1], color: (x) => (x <= 0 ? '#9e9e9e' : RAMP[breaks.filter((b) => x > b).length]) };
  }
  let legend = null;

  const counted = () => net.buildings.filter((b) => b.l.show);
  function drawMetric() {
    const per = new Map();
    for (const b of counted()) {
      const s = per.get(b.street) || { homes: 0, bldgs: 0 };
      s.homes += b.units; s.bldgs += 1;
      per.set(b.street, s);
    }
    const value = (name) => {
      const s = per.get(name) || { homes: 0, bldgs: 0 }, len = net.lengthOf.get(name) || 0;
      return { homes: s.homes, bldgs: s.bldgs, homesM: len ? s.homes / len : 0, bldgsM: len ? s.bldgs / len : 0, len }[sv.mode];
    };
    const names = [...net.lengthOf.keys()].filter(Boolean);
    const sc = scale(names.map(value));
    legend = { breaks: sc.breaks, max: sc.max, perMetre: sv.mode.endsWith('M') };
    const feats = net.arcs.filter((a) => a.name).map((a) => {
      const v = value(a.name), s = per.get(a.name) || { homes: 0, bldgs: 0 };
      return { type: 'Feature', geometry: { type: 'LineString', coordinates: [net.nodes[a.a], net.nodes[a.b]] },
        properties: { c: sc.color(v), w: v > 0 ? 1.6 : 0.8, zero: v <= 0, name: a.name, homes: s.homes, bldgs: s.bldgs, len: net.lengthOf.get(a.name) || 0 } };
    });
    map.getSource('sv-lines').setData({ type: 'FeatureCollection', features: feats });
  }

  // ---------- Traffic: everyone drives the shortest way to the destination ----------
  function drawTraffic() {
    const { nodes, arcs, adj } = net;
    if (!sv.dest) { map.getSource('sv-lines').setData(EMPTY); legend = null; return; }
    const d = sv.dest.hook, A = arcs[d.arc];
    // Shortest distances from the destination to every junction (Dijkstra with a small binary heap).
    const D = new Float64Array(nodes.length).fill(Infinity), via = new Int32Array(nodes.length).fill(-1);
    const heap = [];
    const push = (n, v) => { heap.push([v, n]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    D[A.a] = d.along; D[A.b] = A.len - d.along; via[A.a] = via[A.b] = -2; // -2: next stop is the destination itself
    push(A.a, D[A.a]); push(A.b, D[A.b]);
    while (heap.length) {
      const [v, n] = pop();
      if (v > D[n]) continue;
      for (const id of adj[n]) {
        const arc = arcs[id], m = arc.a === n ? arc.b : arc.a, nv = v + arc.len;
        if (nv < D[m]) { D[m] = nv; via[m] = id; push(m, nv); }
      }
    }
    // Each building's people join its street at the nearest point (not drawn), leave by the nearer end of that piece of
    // street, then follow the tree to the destination.
    const flow = new Float64Array(arcs.length), load = new Float64Array(nodes.length);
    // Households (homes) reaching the destination from each end of its piece of street, shown as two halves.
    const side = { a: 0, b: 0 };
    for (const b of counted()) {
      const t = b.units, h = b.hook, H = arcs[h.arc];
      if (h.arc === d.arc) { side[h.along < d.along ? 'a' : 'b'] += t; continue; }
      const viaA = D[H.a] + h.along, viaB = D[H.b] + (H.len - h.along);
      if (!Number.isFinite(Math.min(viaA, viaB))) continue;
      flow[h.arc] += t;
      load[viaA <= viaB ? H.a : H.b] += t;
    }
    const order = [...nodes.keys()].filter((n) => Number.isFinite(D[n])).sort((x, y) => D[y] - D[x]);
    for (const n of order) {
      if (!load[n]) continue;
      if (via[n] === -2) { side[n === A.a ? 'a' : 'b'] += load[n]; continue; }
      if (via[n] < 0) continue;
      const arc = arcs[via[n]], m = arc.a === n ? arc.b : arc.a;
      flow[via[n]] += load[n];
      load[m] += load[n];
    }
    // Colours on a log scale: a quiet street (tens of households) and a main road (thousands) land far apart.
    const max = Math.max(1, side.a, side.b, ...flow);
    const frac = (t) => Math.log10(1 + t) / Math.log10(1 + max);
    const sc = { max, color: (t) => (t <= 0 ? '#9e9e9e' : RAMP[Math.min(RAMP.length - 1, Math.floor(frac(t) * RAMP.length))]) };
    legend = { breaks: [1], max, households: true };
    const width = (t) => 0.8 + 2.2 * Math.min(1, frac(t));
    const piece = (from, to, t, name) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [from, to] },
      properties: { c: sc.color(t), w: t > 0 ? width(t) : 0.6, zero: t <= 0, name, homes: Math.round(t) } });
    const feats = arcs.map((a, i) => (i === d.arc ? null : piece(nodes[a.a], nodes[a.b], flow[i], a.name))).filter(Boolean);
    feats.push(piece(nodes[A.a], d.at, side.a, A.name), piece(d.at, nodes[A.b], side.b, A.name));
    map.getSource('sv-lines').setData({ type: 'FeatureCollection', features: feats });
  }

  // ---------- Driven by mapgl.js ----------
  sv.refresh = async () => {
    for (const id of ['sv-glow', 'sv-line']) map.setLayoutProperty(id, 'visibility', sv.active ? 'visible' : 'none');
    map.setLayoutProperty('sv-dest', 'visibility', sv.active && sv.mode === 'traffic' && sv.dest ? 'visible' : 'none');
    if (!sv.active) return;
    await load();
    if (sv.mode === 'traffic') drawTraffic(); else drawMetric();
    sv.onLegend?.();
  };
  sv.reset = () => { sv.mode = 'homes'; sv.dest = null; tip.remove(); map.getSource('sv-dest').setData(EMPTY); };
  sv.setMode = (m) => { sv.mode = m; tip.remove(); sv.refresh(); };
  // A Map key button: count (homes/bldgs), measure (total/per100) or traffic (on).
  sv.pick = (what, v) => {
    const homes = !sv.mode.startsWith('bldgs'), per = sv.mode.endsWith('M');
    if (what === 'traffic') return sv.setMode(sv.mode === 'traffic' ? 'homes' : 'traffic');
    const h = what === 'count' ? v === 'homes' : sv.mode === 'traffic' ? true : homes;
    const m = what === 'measure' ? v === 'per100' : sv.mode === 'traffic' ? false : per;
    sv.setMode((h ? 'homes' : 'bldgs') + (m ? 'M' : ''));
  };
  // A click: in traffic mode it picks the destination; otherwise it shows the street's numbers.
  sv.click = async (e, showPopup) => {
    await load();
    const c = [e.lngLat.lng, e.lngLat.lat];
    if (sv.mode === 'traffic') {
      if (!inRing(c, net.town)) return showPopup(e.lngLat, '<p>That spot is outside Stratford. Pick a destination in town.</p>');
      sv.dest = { at: c, hook: net.closest(c, net.nearArcs(c)) || net.closest(c, net.mainArcs) };
      map.getSource('sv-dest').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: sv.dest.hook.at } });
      return sv.refresh();
    }
    const hit = map.queryRenderedFeatures(e.point, { layers: ['sv-line'] }).find((x) => x.properties.name);
    if (!hit) return;
    const p = hit.properties, per100 = (x) => (p.len ? ((100 * x) / p.len).toFixed(1) : '0');
    showPopup(e.lngLat, `<h3>${p.name}</h3><table><tr><th>Homes</th><td>${p.homes.toLocaleString('en-CA')}</td></tr><tr><th>Buildings</th><td>${p.bldgs.toLocaleString('en-CA')}</td></tr><tr><th>Length</th><td>${Math.round(p.len).toLocaleString('en-CA')} m</td></tr><tr><th>Homes per 100 m</th><td>${per100(p.homes)}</td></tr><tr><th>Buildings per 100 m</th><td>${per100(p.bldgs)}</td></tr></table>`);
  };
  // Traffic mode: hovering a street shows its households in a small tooltip that follows the pointer.
  const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'sv-tip', offset: 12 });
  sv.hover = (e) => {
    const hit = sv.active && sv.mode === 'traffic' && sv.dest && map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], { layers: ['sv-line'] }).find((x) => x.properties.homes > 0);
    if (!hit) return tip.remove();
    const n = hit.properties.homes;
    tip.setLngLat(e.lngLat).setHTML(`<strong>${hit.properties.name || 'Street'}</strong><br>${n.toLocaleString('en-CA')} household${n === 1 ? '' : 's'} travel this way`).addTo(map);
  };
  sv.hideTip = () => tip.remove();
  // The Map key's options for this view: one choice per mode, a hint for traffic, and a colour legend.
  const fmt = (x) => (legend?.perMetre ? (100 * x).toFixed(1) : Math.round(x).toLocaleString('en-CA')); // per metre shown per 100 m
  sv.html = () => {
    const traffic = sv.mode === 'traffic', homes = !sv.mode.startsWith('bldgs'), per = sv.mode.endsWith('M');
    const seg = (what, pairs, on) => `<div class="seg">${pairs.map(([v, label]) => `<button type="button" data-sv="${what}" data-v="${v}" aria-pressed="${!traffic && on === v}">${label}</button>`).join('')}</div>`;
    const unit = traffic ? 'households' : homes ? 'homes' : 'buildings';
    return `<fieldset class="sv-modes">
<div class="seg-row"><span>Count</span>${seg('count', [['homes', 'Homes'], ['bldgs', 'Buildings']], homes ? 'homes' : 'bldgs')}</div>
<div class="seg-row"><span>Measure</span>${seg('measure', [['total', 'Total'], ['per100', 'Per 100 m']], per ? 'per100' : 'total')}</div>
<button type="button" class="sv-traffic" data-sv="traffic" aria-pressed="${traffic}">Where would traffic go?</button>
${traffic ? `<p class="sv-hint">${sv.dest ? 'Click the map to move the destination.' : 'Click anywhere in Stratford to pick a destination.'} Every household drives there by the shortest route; each street shows how many households pass along it.</p>` : ''}
${legend && legend.breaks.length ? `<div class="sv-legend">${RAMP.map((c) => `<span style="background:${c}"></span>`).join('')}</div><div class="sv-legend-labels"><span>Fewer ${unit}</span><span>More (up to ${fmt(legend.max)}${legend.perMetre ? ' per 100 m' : ''})</span></div>` : ''}</fieldset>`;
  };
  return sv;
};
