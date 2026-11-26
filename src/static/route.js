// Navigation (Walking map): tap a start and an end, get the best walking route under two preferences and two tick boxes.
// The network (walking routes + both edges of every road, each piece tagged busy / walking route / crossing / service /
// private / low tide) is built by jobs/walking_network/build.py into /static/data/walking-network.json. Routing runs here (Dijkstra).
// mapgl.js calls window.RouteTool(map, cfg.route) after the map loads; it mounts in the Navigation tab of the Map key.
window.RouteTool = function (map, opt) {
  const LAT0 = 46.22, KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110574;
  const toM = ([lng, lat]) => [lng * KX, lat * KY];
  const toLL = ([x, y]) => [x / KX, y / KY];
  const PACE = 4.8; // km/h
  const NEVER = 1000; // cost per metre of a piece that breaks a "Never" rule: only used when there is no other way
  const SNAP_MAX = 150; // a tap farther than this from the network is outside the area
  const EMPTY = { type: 'FeatureCollection', features: [] };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Preferences: key, label, choices [value, label], default.
  const CHOICES = [['any', 'Any'], ['prefer', 'Prefer'], ['only', 'Only']];
  const PREFS = [
    // Each row names what you want; Any = don't mind, Prefer = worth a reasonable detour, Only = a strict rule (Derek, 2026-11-22).
    // The key is also the share-link parameter (?quiet=only&paths=any).
    { key: 'quiet', rule: 'busy', label: 'Quiet streets', choices: CHOICES, def: 'prefer' },
    { key: 'paths', rule: 'infra', label: 'Sidewalks and trails', choices: CHOICES, def: 'prefer' },
  ];
  // Tick boxes (Derek 2026-11-27), both off by default. The key is also the share-link parameter (?lowtide=1).
  // Low-tide routes off: never used. Private roads off: each metre counts PRIVATE_OFF times, so a trip only uses them to
  // get on or off a start or end point that's on one.
  const TOGGLES = [
    { key: 'lowtide', label: 'Low-tide routes' },
    { key: 'private', label: 'Private roads' },
  ];
  const PRIVATE_OFF = 50; // strong enough that a private shortcut never beats a public detour (10 let a 144 m shortcut through)
  const on = Object.fromEntries(TOGGLES.map((t) => [t.key, false]));
  const pref = Object.fromEntries(PREFS.map((p) => [p.key, p.def]));
  const level = (rule) => pref[PREFS.find((p) => p.rule === rule).key]; // 'any' | 'prefer' | 'only' for busy / infra / cross
  // How much longer a piece "feels" under Prefer (multiplies its length), and the extra metres for an unmarked road crossing.
  // Prefer weights (Derek 2026-11-23): sidewalks and trails 1x, a street with no sidewalk 1.5x, a busy street (on or beside)
  // 1.5x, so both settings weigh the same. They add up: walking on a quiet street with no sidewalk beside a busy one = 2x.
  const AVOID = { busy: 1.5, infra: 1.5 };
  const TCH_PREFER = 2.5; // walking beside the TCH counts 2.5x on Quiet streets = Prefer, 1x above the other busy streets: it's far busier (Derek 2026-11-23)
  const isTch = (e) => net.highways.has(e.name || ''); // roads of Type Highway (from the network build)
  // Crossing costs (Derek 2026-11-23): on a walking route you drew (crosswalks, the underpass) free; a quiet street +25 m
  // (Derek 2026-11-25, was 5: neighbours on Mason Road were sent over to the sidewalk and back; with Prefer you now stay
  // on your side for up to ~150 m); a busy street at a pin or where a path meets it +100 m; across the middle of a busy
  // intersection +250 m; the TCH only on a drawn route.
  const CROSS_QUIET_M = 25;
  const CROSS_SERVICE_M = 5; // a lot entrance or service lane: stepping across a driveway, not a street (Derek 2026-11-27)
  const SERVICE_PREFER = 2;
  const CROSS_DRAWN_BUSY_M = 30; // a drawn crosswalk over a busy street still costs a little, so routes don't zigzag between the two sidewalks of Kinlock etc. (Derek)
  const CROSS_DEST_M = 100;
  const CROSS_UNMARKED_M = 250;

  let net = null, loading = null;
  async function load() {
    if (net) return net;
    loading ||= fetch(opt.network).then((r) => r.json()).then((d) => {
      const F = d.flags;
      const nodes = d.nodes.map(toM);
      const edges = d.edges.map(([a, b, flags, name, len, mid]) => {
        const pts = [nodes[a]];
        for (let i = 0; i < mid.length; i += 2) pts.push(toM([mid[i], mid[i + 1]]));
        pts.push(nodes[b]);
        return { a, b, flags, name: d.names[name], len, pts };
      });
      const adj = nodes.map(() => []);
      edges.forEach((e, k) => { adj[e.a].push(k); adj[e.b].push(k); });
      // Busy-street centrelines, to tell when the walk from a pin to a sidewalk crosses a busy street (destination crossings)
      // Street centrelines (0 quiet, 1 busy, 2 TCH), to tell which street a pin's walk to the network crosses
      const streetSegs = [];
      for (const [type, c] of d.roadLines || []) for (let i = 2; i < c.length; i += 2) streetSegs.push([toM([c[i - 2], c[i - 1]]), toM([c[i], c[i + 1]]), type]);
      net = { F, nodes, edges, adj, streetSegs, highways: new Set(d.highways || []) };
      return net;
    });
    return loading;
  }

  // ---------- What a piece is, and what it costs ----------
  const kind = (e) => (e.flags & net.F.busy ? 'busy' : e.flags & net.F.infra ? 'path' : 'road');
  // Colour of each leg: a road crossing takes the colour of the route around it (e.g. orange where the sidewalk beside a
  // busy street crosses a side street), so crossings don't break up a stretch (Derek 2026-11-23).
  function kinds(legs) {
    // Crossings and slivers under 12 m of path (corners where a sidewalk bends away from the road) take their neighbours' colour.
    const flex = (l) => !!(l.e.flags & net.F.cross) || (l.len < 12 && kind(l.e) === 'path');
    const out = legs.map((l) => (flex(l) ? null : kind(l.e)));
    const near = (i, dir) => { for (let j = i + dir; j >= 0 && j < out.length; j += dir) if (out[j]) return out[j]; return null; };
    return out.map((k, i) => {
      if (k) return k;
      const a = near(i, -1), b = near(i, 1);
      return a && a === b ? a : kind(legs[i].e) === 'busy' || a === 'busy' || b === 'busy' ? 'busy' : kind(legs[i].e);
    });
  }
  const broken = (e) => { // the Never rules a piece breaks
    const F = net.F, out = [];
    if (level('busy') === 'only' && e.flags & F.busy) out.push('busy');
    if (level('infra') === 'only' && !(e.flags & F.infra)) out.push('infra');
    return out;
  };
  function cost(e, len) {
    const F = net.F;
    if (e.flags & F.nogo) return Infinity; // the TCH away from a crosswalk or the underpass
    if (e.flags & F.lowtide && !on.lowtide) return Infinity;
    let m = 1, add = 0;
    if (e.flags & F.private && !on.private) m += PRIVATE_OFF - 1;
    const rule = (key, hit) => { if (!hit) return; if (level(key) === 'prefer') m += AVOID[key] - 1; if (level(key) === 'only') m += NEVER; };
    rule('busy', e.flags & F.busy);
    if (e.flags & F.busy && !(e.flags & F.cross) && isTch(e) && level('busy') === 'prefer') m += TCH_PREFER - AVOID.busy;
    rule('infra', !(e.flags & F.infra));
    // a service lane (parking lot, drive-through) counts 2x under Sidewalks and trails = Prefer, not 1.5x (Derek 2026-11-27)
    if (e.flags & F.service && !(e.flags & F.cross) && level('infra') === 'prefer') m += SERVICE_PREFER - AVOID.infra;
    // A drawn crossing piece of a busy street is part of an ~18 m span (8 m each side + 1): charge per metre so the whole crossing adds CROSS_DRAWN_BUSY_M
    if (e.flags & F.cross && e.flags & F.infra && e.flags & F.crossBusy && !(e.flags & F.under)) add += len * (CROSS_DRAWN_BUSY_M / 18);
    if (e.flags & F.cross && !(e.flags & F.under) && !(e.flags & F.infra)) { // crossings on a drawn walking route of a quiet street are free
      const whole = e.flags & F.full ? 1 : 0.5; // a FULL piece is a whole crossing, others are one half each
      if (!(e.flags & F.crossBusy)) add += (e.flags & F.service ? CROSS_SERVICE_M : CROSS_QUIET_M) * whole;
      else if (e.flags & F.entr) add += CROSS_DEST_M;
      else add += CROSS_UNMARKED_M * whole;
    } // crossings take time; busy streets more, so routes keep to one side of them. The underpass is free: it's just trail (Derek 2026-11-23)
    return len * m + add;
  }
  const plainCost = (e, len) => (e.flags & net.F.nogo || (e.flags & net.F.lowtide && !on.lowtide) ? Infinity : len); // the shortest way, for comparison

  // ---------- Snapping a tap to the network ----------
  // A pin attaches to the nearest piece of network AND, if there is one within SNAP_PATH_M, the nearest walking route
  // (Derek 2026-11-23: a pin on a road beside a sidewalk made routes walk the road, or overshoot and walk back).
  // Each attachment is a short straight walk from the pin (across a lawn or driveway), and the router picks the best.
  const SNAP_PATH_M = 40;
  function snap(lngLat) {
    const p = toM([lngLat.lng, lngLat.lat]);
    const cross2 = (a, b, c, d) => { const o = (p1, p2, p3) => (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p2[1] - p1[1]) * (p3[0] - p1[0]); return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0; };
    // The busiest street the straight walk from the pin to q crosses: -1 none, 0 quiet, 1 busy, 2 TCH
    const crosses = (q) => { let worst = -1; for (const [a, b, type] of net.streetSegs) if (type > worst && Math.min(a[0], b[0]) < Math.max(p[0], q[0]) + 1 && Math.max(a[0], b[0]) > Math.min(p[0], q[0]) - 1 && Math.min(a[1], b[1]) < Math.max(p[1], q[1]) + 1 && Math.max(a[1], b[1]) > Math.min(p[1], q[1]) - 1 && cross2(p, q, a, b)) worst = type; return worst; };
    let best = null; const pick = {}; // pick[kind]: nearest walking route / street side, without or with a street to cross
    net.edges.forEach((e, k) => {
      if (e.flags & net.F.nogo || e.flags & net.F.cross) return; // never attach in the middle of a road crossing
      if (e.flags & net.F.lowtide && !on.lowtide) return; // nor to a low-tide route that's switched off
      let along = 0;
      for (let i = 1; i < e.pts.length; i++) {
        const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, seg = Math.sqrt(L2);
        const t = L2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2)) : 0;
        const qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(p[0] - qx, p[1] - qy);
        const c = { k, d, at: along + t * seg, q: [qx, qy], tap: p };
        if (!best || d < best.d) best = c;
        if (d <= SNAP_PATH_M) {
          const kind = e.flags & net.F.infra ? 'path' : e.flags & (net.F.service || 0) ? 'service' : 'street'; // a lot's service lane never hides the real street beside the pin
          const x = crosses(c.q);
          if (x < 2) { // never across the TCH
            const key = kind + (x < 0 ? '' : 'X');
            if (!pick[key] || d < pick[key].d) pick[key] = { ...c, cross: x }; // cross: -1 none, 0 quiet street, 1 busy street
          }
        }
        along += seg;
      }
    });
    if (!best) return null;
    best.cross = crosses(best.q);
    const out = best.cross < 2 ? [best] : [];
    for (const c of Object.values(pick)) if (!out.some((o) => o.k === c.k && Math.abs(o.at - c.at) < 1)) out.push(c); // the same piece can be both sides of a street (a road edge wraps round a dead end)
    for (const c of out) {
      const e = net.edges[c.k], total = e.pts.reduce((s2, q, i) => (i ? s2 + Math.hypot(q[0] - e.pts[i - 1][0], q[1] - e.pts[i - 1][1]) : 0), 0);
      c.frac = total ? c.at / total : 0; // the drawn length can differ a little from e.len; work in fractions
      c.across = c.cross === 1; // crossing a busy street at the pin
    }
    out.d = best.d;
    return out.length ? out : null;
  }
  // Points of edge e between fractions f0 and f1 (f0 > f1 runs backwards).
  function slice(e, f0, f1) {
    const lens = [0];
    for (let i = 1; i < e.pts.length; i++) lens.push(lens[i - 1] + Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]));
    const total = lens[lens.length - 1] || 1;
    const at = (f) => {
      const d = f * total;
      let i = 1;
      while (i < lens.length - 1 && lens[i] < d) i++;
      const t = (d - lens[i - 1]) / ((lens[i] - lens[i - 1]) || 1);
      return [e.pts[i - 1][0] + t * (e.pts[i][0] - e.pts[i - 1][0]), e.pts[i - 1][1] + t * (e.pts[i][1] - e.pts[i - 1][1])];
    };
    const lo = Math.min(f0, f1), hi = Math.max(f0, f1);
    const out = [at(lo), ...e.pts.filter((_, i) => lens[i] / total > lo && lens[i] / total < hi), at(hi)];
    return f0 <= f1 ? out : out.reverse();
  }

  // ---------- Dijkstra from a snapped start to a snapped end ----------
  function route(s, t, costFn, attach = (c) => c.d) {
    const { edges, adj, nodes } = net;
    const N = nodes.length, S = N, T = N + 1; // two extra nodes for the tap points
    const dist = new Float64Array(N + 2).fill(Infinity), prev = new Array(N + 2).fill(null);
    const heap = [];
    const push = (d, n) => { heap.push([d, n]); let i = heap.length - 1; while (i) { const j = (i - 1) >> 1; if (heap[j][0] <= heap[i][0]) break; [heap[i], heap[j]] = [heap[j], heap[i]]; i = j; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
    // s and t are lists of attachments (snap()); walking from the pin to an attachment costs its straight distance.
    const endMoves = new Map(); // network node -> moves into T: [edge, from fraction, to fraction, attachment]
    for (const c of t) {
      const e = edges[c.k];
      for (const [from, f0] of [[e.a, 0], [e.b, 1]]) { if (!endMoves.has(from)) endMoves.set(from, []); endMoves.get(from).push([c.k, f0, c.frac, c]); }
    }
    const step = (from, d0, to, k, f0, f1, extra = 0, at = null) => {
      const c = costFn(edges[k], edges[k].len * Math.abs(f1 - f0)) + extra;
      if (d0 + c < dist[to]) { dist[to] = d0 + c; prev[to] = [from, k, f0, f1, at]; push(dist[to], to); }
    };
    dist[S] = 0;
    for (const c of s) {
      const e = edges[c.k];
      step(S, 0, e.a, c.k, c.frac, 0, attach(c), c);
      step(S, 0, e.b, c.k, c.frac, 1, attach(c), c);
      for (const u of t) if (u.k === c.k) step(S, 0, T, c.k, c.frac, u.frac, attach(c) + attach(u), [c, u]); // both pins on the same piece
    }
    while (heap.length) {
      const [d, n] = pop();
      if (d > dist[n]) continue;
      if (n === T) break;
      if (n === S) continue;
      for (const [k, f0, f1, c] of endMoves.get(n) || []) step(n, d, T, k, f0, f1, attach(c), c);
      for (const k of adj[n]) {
        const e = edges[k];
        if (e.a === n) step(n, d, e.b, k, 0, 1);
        if (e.b === n) step(n, d, e.a, k, 1, 0);
      }
    }
    if (dist[T] === Infinity) return null;
    const legs = [];
    let from = null, to = null;
    for (let n = T; n !== S; n = prev[n][0]) {
      const [p0, k, f0, f1, at] = prev[n];
      if (n === T) to = Array.isArray(at) ? at[1] : at;
      if (p0 === S) from = Array.isArray(at) ? at[0] : at;
      legs.push({ e: edges[k], f0, f1, len: edges[k].len * Math.abs(f1 - f0) });
    }
    legs.reverse();
    legs.from = from; legs.to = to; // the attachments used, for the dashed walk from each pin
    return legs;
  }

  // ---------- Map layers ----------
  const COLORS = { path: '#4fc77a', road: '#f2c94c', busy: '#f2994a', broken: '#eb5757' };
  function ensureLayers() {
    if (map.getSource('route')) return;
    map.addSource('route', { type: 'geojson', data: EMPTY });
    map.addSource('route-taps', { type: 'geojson', data: EMPTY });
    const W = (a, b) => ['interpolate', ['linear'], ['zoom'], 12, a, 18, b];
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#111', 'line-width': W(6, 14), 'line-opacity': 0.75 } });
    map.addLayer({ id: 'route-broken', type: 'line', source: 'route', filter: ['==', ['get', 'broken'], true], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLORS.broken, 'line-width': W(10, 22), 'line-opacity': 0.55, 'line-blur': 2 } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['match', ['get', 'kind'], 'busy', COLORS.busy, 'road', COLORS.road, COLORS.path], 'line-width': W(3.5, 9) } });
    map.addLayer({ id: 'route-taps', type: 'line', source: 'route-taps', paint: { 'line-color': '#fff', 'line-width': 2, 'line-dasharray': [1, 1.5], 'line-opacity': 0.8 } });
  }
  const setData = (id, d) => map.getSource(id)?.setData(d);

  // ---------- Addresses (the Address Lookup's list, loaded on first use) ----------
  const SHORT = { rd: 'road', ln: 'lane', ct: 'court', crt: 'court', cres: 'crescent', blvd: 'boulevard', hts: 'heights', hwy: 'highway', wy: 'way', ave: 'avenue', av: 'avenue', st: 'street', dr: 'drive', pl: 'place', ter: 'terrace', terr: 'terrace', cl: 'close' };
  const words = (t) => t.toLowerCase().replace(/['’.,]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  let addrs = null, addrLoad = null;
  const loadAddrs = () => (addrLoad ||= fetch(opt.addresses).then((r) => r.json()).then((d) => {
    const at = (f) => d.fields.indexOf(f);
    addrs = d.addresses.map((row) => { const street = d.streets[row[at('street')]]; return { label: `${row[at('no')]} ${street}`, no: row[at('no')], words: words(street), lngLat: { lng: row[at('lon')], lat: row[at('lat')] } }; });
    return addrs;
  }));
  // Every word typed has to start a word of the street name; a number has to match the start of the house number.
  function findAddrs(q) {
    const typed = words(q), nums = typed.filter((w) => /^\d+$/.test(w)), text = typed.filter((w) => !/^\d+$/.test(w));
    if (!typed.length || !addrs) return [];
    const hits = addrs.filter((a) => nums.every((n) => String(a.no).startsWith(n)) && text.every((t) => a.words.some((w) => w.startsWith(t) || w === SHORT[t])));
    const exact = (a) => (nums.length && String(a.no) === nums[0] ? 0 : 1);
    return hits.sort((x, y) => exact(x) - exact(y) || x.label.localeCompare(y.label, undefined, { numeric: true })).slice(0, 8);
  }

  // ---------- Elevation (the Trace Water ground model: 2 m cells, heights averaged over 8 x 8 cells) ----------
  const R = 6378137;
  const merc = ([lng, lat]) => [(lng * Math.PI * R) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
  let grid = null;
  const ztiles = new Map();
  async function heights(lls) {
    if (!opt.elevation) return null;
    try {
      grid ||= await fetch(`${opt.elevation}/meta.json`).then((r) => r.json()).then((m) => ({ ...m, have: new Set(m.tiles) }));
      const g = grid, cells = lls.map((ll) => { const [x, y] = merc(ll); return [Math.floor((g.y0 - y) / g.cell), Math.floor((x - g.x0) / g.cell)]; });
      const name = ([r, c]) => `${Math.floor(r / g.tile)}_${Math.floor(c / g.tile)}`;
      await Promise.all([...new Set(cells.map(name))].filter((n) => g.have.has(n) && !ztiles.has(n)).map((n) => {
        const job = fetch(`${opt.elevation}/z/${n}.bin`).then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()).then((b) => new Int16Array(b));
        ztiles.set(n, job);
        return job;
      }));
      const out = [];
      for (const rc of cells) {
        const n = name(rc);
        if (!g.have.has(n)) { out.push(null); continue; }
        const t = await ztiles.get(n), v = t[((rc[0] % g.tile) >> 3) * (g.tile >> 3) + ((rc[1] % g.tile) >> 3)];
        out.push(v === -32768 ? null : v / 10);
      }
      return out.some((v) => v != null) ? out : null;
    } catch { return null; } // hills are a bonus: the route still works without them
  }
  // Tobler's hiking rule, scaled so flat ground is PACE: about 15% slower up a 5% grade, faster on gentle descents.
  const tobler = (slope) => 6 * Math.exp(-3.5 * Math.abs(slope + 0.05));
  async function hills(coords) { // coords in local metres along the route
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]));
    const total = cum[cum.length - 1], pts = [], along = [];
    for (let d = 0, k = 1; ; d = Math.min(total, d + 10)) { // a point every 10 m, and the end
      while (k < cum.length - 1 && cum[k] < d) k++;
      const t = (d - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1);
      pts.push([coords[k - 1][0] + t * (coords[k][0] - coords[k - 1][0]), coords[k - 1][1] + t * (coords[k][1] - coords[k - 1][1])]);
      along.push(d);
      if (d >= total) break;
    }
    const z = await heights(pts.map(toLL));
    if (!z) return null;
    for (let i = 0; i < z.length; i++) if (z[i] == null) z[i] = z[i - 1] ?? z.find((v) => v != null); // fill gaps
    const sm = z.map((_, i) => (z[Math.max(0, i - 1)] + z[i] + z[Math.min(z.length - 1, i + 1)]) / 3); // soften the 16 m steps
    let up = 0, down = 0, ref = sm[0], minutes = 0;
    for (let i = 1; i < sm.length; i++) { // climb counted in 1 m steps so flat ground doesn't add up noise
      if (sm[i] - ref >= 1) { up += sm[i] - ref; ref = sm[i]; } else if (ref - sm[i] >= 1) { down += ref - sm[i]; ref = sm[i]; }
      const dx = along[i] - along[i - 1];
      // Slopes are judged over at least 10 m and capped at 30%: the last sample can sit millimetres from the one before,
      // and a 1 m height step over 1 mm read as a cliff and gave times of thousands of hours (Derek 2026-11-23).
      const slope = Math.max(-0.3, Math.min(0.3, (sm[i] - sm[i - 1]) / Math.max(dx, 10)));
      if (dx > 0) minutes += (dx / 1000 / (PACE * (tobler(slope) / tobler(0)))) * 60;
    }
    return { up: Math.round(up), down: Math.round(down), minutes, profile: sm.map((v, i) => [along[i], v]) };
  }
  function profileSvg(pr) {
    const W = 300, H = 46, xs = pr.map((p) => p[0]), zs = pr.map((p) => p[1]);
    const x1 = Math.max(...xs) || 1, z0 = Math.min(...zs), z1 = Math.max(z0 + 10, Math.max(...zs)); // at least 10 m tall, so gentle routes look gentle
    const pt = ([x, z]) => `${((x / x1) * W).toFixed(1)},${(H - 2 - ((z - z0) / (z1 - z0)) * (H - 6)).toFixed(1)}`;
    const line = pr.map(pt).join(' ');
    return `<svg class="route-profile" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Elevation along the route, ${Math.round(Math.min(...zs))} to ${Math.round(Math.max(...zs))} m">
      <polygon points="0,${H} ${line} ${W},${H}" fill="rgba(108,197,143,.18)"/><polyline points="${line}" fill="none" stroke="#a3a8b0" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>
      <div class="route-profile-labels"><span>${Math.round(Math.min(...zs))} m</span><span>Elevation</span><span>${Math.round(Math.max(...zs))} m</span></div>`;
  }

  // ---------- Panel ----------
  const panel = document.createElement('div');
  panel.className = 'route-panel';
  const pin = (which) => `<span class="route-dot route-dot--${which}">${which.toUpperCase()}</span>`;
  panel.innerHTML = `<div class="route-points">
      <div class="route-field">${pin('a')}<input type="text" data-field="a" role="combobox" aria-autocomplete="list" placeholder="Start: tap the map or type an address" autocomplete="off" spellcheck="false" aria-label="Start address">
        <button type="button" class="route-icon-btn" data-route-locate title="Start from my location" aria-label="Start from my location"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/></svg></button></div>
      <ul class="route-suggest" data-list="a" role="listbox" hidden></ul>
      <div class="route-field">${pin('b')}<input type="text" data-field="b" role="combobox" aria-autocomplete="list" placeholder="End: tap the map or type an address" autocomplete="off" spellcheck="false" aria-label="End address"></div>
      <ul class="route-suggest" data-list="b" role="listbox" hidden></ul>
      <div class="route-actions" hidden><button type="button" class="reset-btn" data-route-swap>Swap</button><button type="button" class="reset-btn" data-route-clear>Clear</button><button type="button" class="reset-btn" data-route-share>Share</button><span class="route-flash" aria-live="polite"></span><button type="button" class="start-btn" data-route-start disabled>Start</button></div>
    </div><div class="filters route-prefs"></div><div class="route-result" aria-live="polite"></div>`;
  const $ = (sel) => panel.querySelector(sel);
  const input = { a: $('[data-field="a"]'), b: $('[data-field="b"]') };
  const lists = { a: $('[data-list="a"]'), b: $('[data-list="b"]') };
  const pts = { a: null, b: null }; // {lngLat, marker, label}
  let result = null, message = '', hill = null, solving = 0, locked = false, routeCoords = [];
  const fmtLen = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
  const fmtMin = (min) => { min = Math.max(1, Math.round(min)); return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`; };
  const RULE_TEXT = { busy: 'on or beside a busy street', infra: 'with no sidewalk or trail' };

  function summary(r) {
    const by = { path: 0, road: 0, busy: 0 };
    let total = 0;
    const ks = kinds(r.legs);
    r.legs.forEach((l, i) => { by[ks[i]] += l.len; total += l.len; });
    // Rule-breaking stretches, merged by rule and name ("420 m on Kinlock Road"). Road crossings are counted, not
    // measured: back-to-back crossing pieces are one crossing ("2 crossings of a busy street with no crosswalk").
    const groups = new Map(), crossings = { busy: 0 };
    let run = null;
    for (const l of r.legs) {
      const rules = broken(l.e);
      if (l.e.flags & net.F.cross) { run ||= new Set(); for (const rule of rules) run.add(rule); continue; }
      if (run) { if (run.has('busy')) crossings.busy++; run = null; }
      for (const rule of rules) {
        const key = `${rule}|${l.e.name}`;
        groups.set(key, { rule, name: l.e.name, len: (groups.get(key)?.len || 0) + l.len });
      }
    }
    if (run) { if (run.has('busy')) crossings.busy++; }
    if (level('busy') === 'only') for (const c of [r.legs.from, r.legs.to]) if (c?.across) crossings.busy++; // crossing at the destination
    const list = [...groups.values()].filter((g) => g.len >= 5).sort((a, b) => b.len - a.len)
      .map((g) => `${fmtLen(g.len)} ${RULE_TEXT[g.rule]}${g.name ? ` (${esc(g.name)})` : ''}`);
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    if (crossings.busy) list.push(`${plural(crossings.busy, 'crossing', 'crossings')} of a busy street with no crosswalk`);
    return { by, total, fails: list };
  }

  function render() {
    $('.route-prefs').innerHTML = PREFS.map((p) => `<div class="seg-row"><span>${p.label}</span><div class="seg" role="group" aria-label="${p.label}">${p.choices.map(([v, label]) => `<button type="button" data-pref="${p.key}" data-v="${v}" aria-pressed="${pref[p.key] === v}">${label}</button>`).join('')}</div></div>`).join('')
      + `<div class="route-checks">${TOGGLES.map((t) => `<label><input type="checkbox" data-toggle="${t.key}"${on[t.key] ? ' checked' : ''}> ${t.label}</label>`).join('')}</div>`;
    for (const w of ['a', 'b']) if (document.activeElement !== input[w]) input[w].value = pts[w]?.label || '';
    $('.route-actions').hidden = !pts.a && !pts.b;
    // Start locks the trip in; while locked the settings and points can't change, and the button unlocks it (Edit).
    const go = $('[data-route-start]');
    go.disabled = !locked && !(result && !message);
    go.textContent = locked ? 'Edit' : 'Start';
    for (const el of panel.querySelectorAll('[data-pref], [data-toggle], [data-route-swap], [data-route-clear], [data-route-locate], .route-field input')) el.disabled = locked;
    const s = result && summary(result);
    let res = '';
    if (message) res = `<p class="route-msg">${esc(message)}</p>`;
    else if (s) {
      const bar = ['path', 'road', 'busy'].filter((k) => s.by[k] >= 5).map((k) => `<span style="flex:${s.by[k]};background:${COLORS[k]}"></span>`).join('');
      const rows = [['path', 'Sidewalks and trails'], ['road', 'Quiet streets, no sidewalk'], ['busy', 'On or beside busy streets']].filter(([k]) => s.by[k] >= 5) // hide slivers
        .map(([k, label]) => `<div class="route-row"><span class="swatch-line" style="--c:${COLORS[k]}"></span><span>${label}</span><span class="route-num">${fmtLen(s.by[k])}</span></div>`).join('');
      const detour = result.shortest && result.shortest < s.total - 20 ? s.total - result.shortest : 0;
      const tide = result.legs.some((l) => l.e.flags & net.F.lowtide) ? '<p class="route-note">This route uses the low-tide hike along the shore, check the tide before you go.</p>' : '';
      const extra = tide + (detour ? `<p class="route-note">${fmtLen(detour)} longer than the shortest way${s.fails.length ? '' : ', to follow your choices'}.</p>` : '');
      const fail = s.fails.length ? `<div class="route-fail"><p><strong>No route follows all your choices.</strong> The closest one, shown in red, needs:</p><ul>${s.fails.map((t) => `<li>${t}</li>`).join('')}</ul></div>` : '';
      const minutes = hill ? hill.minutes : (s.total / 1000 / PACE) * 60;
      const climb = hill ? `<span class="route-climb" title="Climb and descent along the route">↑ ${hill.up} m ↓ ${hill.down} m</span>` : '';
      res = `${fail}<div class="route-total"><strong>${fmtLen(s.total)}</strong><span>about ${fmtMin(minutes)} on foot</span>${climb}</div><div class="route-bar">${bar}</div>${hill ? profileSvg(hill.profile) : ''}${rows}${extra}`;
    }
    $('.route-result').innerHTML = res;
  }

  function marker(which, lngLat) {
    const el = document.createElement('div');
    el.className = `route-pin route-pin--${which}`;
    el.textContent = which.toUpperCase();
    const m = new maplibregl.Marker({ element: el, draggable: true, anchor: 'center' }).setLngLat(lngLat).addTo(map);
    m.on('dragend', () => { pts[which].lngLat = m.getLngLat(); pts[which].label = 'Point on the map'; solve(); });
    return m;
  }
  function place(which, lngLat, label) {
    if (pts[which]) { pts[which].marker.setLngLat(lngLat); Object.assign(pts[which], { lngLat, label }); }
    else pts[which] = { lngLat, label, marker: marker(which, lngLat) };
  }

  async function solve() {
    const id = ++solving;
    await load();
    ensureLayers();
    message = ''; result = null; hill = null;
    setData('route', EMPTY); setData('route-taps', EMPTY);
    syncUrl();
    if (!pts.a || !pts.b) return render();
    const s = snap(pts.a.lngLat), t = snap(pts.b.lngLat);
    if (!s || s.d > SNAP_MAX || !t || t.d > SNAP_MAX) { message = 'That spot is too far from any path or road. Navigation only covers Stratford, so tap closer to a street or trail.'; return render(); }
    // Walking from a pin straight across a busy street to a sidewalk = an unmarked crossing at the destination
    // Walking from a pin straight across a street: a quiet one +5 m, a busy one +100 m (and against Quiet streets = Only)
    const attachCost = (c) => c.d + (c.cross === 0 ? CROSS_QUIET_M : c.cross === 1 ? CROSS_DEST_M + (level('busy') === 'only' ? CROSS_UNMARKED_M * NEVER : 0) : 0);
    const legs = route(s, t, cost, attachCost);
    if (!legs) { message = 'Those two spots aren’t connected by any walking route or road.'; return render(); }
    const short = route(s, t, plainCost);
    result = { legs, shortest: short ? short.reduce((a, l) => a + l.len, 0) : null };
    const ks = kinds(legs);
    const feats = legs.map((l, i) => ({ type: 'Feature', properties: { kind: ks[i], broken: broken(l.e).length > 0}, geometry: { type: 'LineString', coordinates: slice(l.e, l.f0, l.f1).map(toLL) } }));
    setData('route', { type: 'FeatureCollection', features: feats });
    routeCoords = feats.flatMap((f) => f.geometry.coordinates);
    // Dashed lines from each tap to where the route starts/ends, when the tap is off the network
    const taps = [legs.from, legs.to].filter((x) => x && x.d > 3).map((x) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [toLL(x.tap), toLL(x.q)] } }));
    setData('route-taps', { type: 'FeatureCollection', features: taps });
    render();
    const h = await hills(legs.flatMap((l, i) => slice(l.e, l.f0, l.f1).slice(i ? 1 : 0)));
    if (id === solving && h) { hill = h; render(); }
  }

  function clear() {
    for (const w of ['a', 'b']) { pts[w]?.marker.remove(); pts[w] = null; input[w].value = ''; }
    result = null; message = ''; hill = null;
    setData('route', EMPTY); setData('route-taps', EMPTY);
    syncUrl();
    render();
  }

  // ---------- Share links: /walking?view=navigation&from=12+Keppoch+Road&to=46.22140,-63.08900&busy=never ----------
  const asParam = (p) => (p.label && p.label !== 'Point on the map' && p.label !== 'My location' ? p.label : `${p.lngLat.lat.toFixed(5)},${p.lngLat.lng.toFixed(5)}`);
  function linkUrl() {
    const u = new URL(location.href);
    for (const k of ['view', 'from', 'to', ...PREFS.map((p) => p.key), ...TOGGLES.map((t) => t.key)]) u.searchParams.delete(k);
    if (tool.active) {
      u.searchParams.set('view', opt.viewKey || 'navigation');
      if (pts.a) u.searchParams.set('from', asParam(pts.a));
      if (pts.b) u.searchParams.set('to', asParam(pts.b));
      for (const p of PREFS) if (pref[p.key] !== p.def) u.searchParams.set(p.key, pref[p.key]);
      for (const t of TOGGLES) if (on[t.key]) u.searchParams.set(t.key, '1');
    }
    return u;
  }
  const syncUrl = () => history.replaceState(history.state, '', linkUrl());
  async function fromParam(v) { // "46.22140,-63.08900" or an address
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(v || '');
    if (m) return { lngLat: { lat: +m[1], lng: +m[2] }, label: 'Point on the map' };
    if (!v) return null;
    await loadAddrs();
    const hit = findAddrs(v).find((a) => a.label.toLowerCase() === v.trim().toLowerCase()) || findAddrs(v)[0];
    return hit ? { lngLat: hit.lngLat, label: hit.label } : null;
  }
  async function readLink() {
    const q = new URLSearchParams(location.search);
    for (const p of PREFS) if (p.choices.some(([v]) => v === q.get(p.key))) pref[p.key] = q.get(p.key);
    for (const t of TOGGLES) on[t.key] = q.get(t.key) === '1';
    const [a, b] = await Promise.all([fromParam(q.get('from')), fromParam(q.get('to'))]);
    if (a) place('a', a.lngLat, a.label);
    if (b) place('b', b.lngLat, b.label);
    if (a && b) map.fitBounds([[Math.min(a.lngLat.lng, b.lngLat.lng), Math.min(a.lngLat.lat, b.lngLat.lat)], [Math.max(a.lngLat.lng, b.lngLat.lng), Math.max(a.lngLat.lat, b.lngLat.lat)]], fitPad());
    solve();
  }
  // Room for the panel when fitting the route: beside it on desktop, above it on phones (bottom sheet).
  const fitPad = () => ({ padding: window.innerWidth < 700 ? { top: 70, bottom: Math.round(window.innerHeight * 0.58), left: 40, right: 60 } : { top: 80, bottom: 60, left: 400, right: 60 }, maxZoom: 16 });
  let flashTimer;
  const flash = (t) => { const el = $('.route-flash'); el.textContent = t; clearTimeout(flashTimer); flashTimer = setTimeout(() => { el.textContent = ''; }, 2500); };
  async function share() {
    const url = linkUrl().toString();
    if (navigator.share && matchMedia('(pointer: coarse)').matches) { try { await navigator.share({ title: 'Walking directions in Stratford', url }); } catch { /* closed */ } return; }
    try { await navigator.clipboard.writeText(url); flash('Link copied'); } catch { prompt('Copy this link:', url); }
  }

  // ---------- Panel events ----------
  let shown = { a: [], b: [] }, active = { a: -1, b: -1 }; // suggestions, and the one picked with the arrow keys
  function drawList(w) {
    const typed = input[w].value.trim();
    lists[w].innerHTML = shown[w].length ? shown[w].map((a, i) => `<li role="option" id="route-${w}-opt-${i}" data-pick="${i}" aria-selected="${i === active[w]}">${esc(a.label)}</li>`).join('')
      : typed ? '<li class="none">No Stratford address matches that. Try the house number and street.</li>' : '';
    lists[w].hidden = !typed;
    if (active[w] >= 0) { input[w].setAttribute('aria-activedescendant', `route-${w}-opt-${active[w]}`); lists[w].children[active[w]]?.scrollIntoView({ block: 'nearest' }); }
    else input[w].removeAttribute('aria-activedescendant');
  }
  async function suggest(w) {
    await loadAddrs();
    shown[w] = findAddrs(input[w].value);
    active[w] = -1;
    drawList(w);
  }
  function pick(w, a) {
    lists[w].hidden = true;
    place(w, a.lngLat, a.label);
    input[w].value = a.label;
    input[w].blur();
    if (!pts.a || !pts.b) map.easeTo({ center: a.lngLat, zoom: Math.max(map.getZoom(), 15) });
    else map.fitBounds([[Math.min(pts.a.lngLat.lng, pts.b.lngLat.lng), Math.min(pts.a.lngLat.lat, pts.b.lngLat.lat)], [Math.max(pts.a.lngLat.lng, pts.b.lngLat.lng), Math.max(pts.a.lngLat.lat, pts.b.lngLat.lat)]], fitPad());
    solve();
  }
  for (const w of ['a', 'b']) {
    input[w].addEventListener('input', () => suggest(w));
    input[w].addEventListener('focus', () => { loadAddrs(); if (input[w].value && pts[w] && input[w].value === pts[w].label && !/^\d/.test(pts[w].label)) input[w].select(); });
    input[w].addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown[w].length && !lists[w].hidden) { // move through the list, wrapping at the ends
        e.preventDefault();
        const n = shown[w].length;
        active[w] = e.key === 'ArrowDown' ? (active[w] + 1) % n : (active[w] <= 0 ? n - 1 : active[w] - 1);
        drawList(w);
      }
      if (e.key === 'Enter' && shown[w].length) { e.preventDefault(); pick(w, shown[w][Math.max(0, active[w])]); } // Enter takes the highlighted one, else the first
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (!lists[w].hidden && shown[w].length) { lists[w].hidden = true; input[w].value = pts[w]?.label || ''; return; } // first Escape closes the suggestions
        input[w].blur(); if (locked) lock(false); clear(); // otherwise it clears the trip, like Clear
      }
    });
    input[w].addEventListener('blur', () => setTimeout(() => { lists[w].hidden = true; if (!input[w].value.trim() && pts[w]) input[w].value = pts[w].label; }, 150));
    lists[w].addEventListener('mousedown', (e) => { const li = e.target.closest('[data-pick]'); if (li) { e.preventDefault(); pick(w, shown[w][+li.dataset.pick]); } });
  }
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pref]');
    if (b) { pref[b.dataset.pref] = b.dataset.v; return solve(); }
    const tg = e.target.closest('[data-toggle]');
    if (tg) { on[tg.dataset.toggle] = tg.checked; return solve(); }
    if (e.target.closest('[data-route-clear]')) return clear();
    if (e.target.closest('[data-route-share]')) return share();
    if (e.target.closest('[data-route-start]')) return lock(!locked);
    if (e.target.closest('[data-route-swap]')) {
      const a = pts.a, bb = pts.b;
      for (const w of ['a', 'b']) pts[w]?.marker.remove();
      pts.a = pts.b = null;
      if (bb) place('a', bb.lngLat, bb.label);
      if (a) place('b', a.lngLat, a.label);
      return solve();
    }
    if (e.target.closest('[data-route-locate]')) {
      if (!navigator.geolocation) { message = 'Your browser can’t share its location.'; return render(); }
      flash('Finding you…');
      navigator.geolocation.getCurrentPosition(
        (p) => { flash(''); const ll = { lng: p.coords.longitude, lat: p.coords.latitude }; place('a', ll, 'My location'); map.easeTo({ center: ll, zoom: Math.max(map.getZoom(), 15) }); solve(); },
        () => { flash(''); message = 'Your location isn’t available. Check that location is allowed for this site, or tap the map instead.'; render(); },
        { enableHighAccuracy: true, timeout: 15000 });
    }
  });
  // ---------- Start: lock the trip in for walking it ----------
  const strip = document.createElement('div');
  strip.className = 'route-strip';
  strip.hidden = true;
  map.getContainer().append(strip);
  function routeBounds() {
    const cs = [...routeCoords];
    for (const w of ['a', 'b']) if (pts[w]) cs.push([pts[w].lngLat.lng, pts[w].lngLat.lat]);
    return cs.reduce(([[w, s2], [e, n]], [x, y]) => [[Math.min(w, x), Math.min(s2, y)], [Math.max(e, x), Math.max(n, y)]], [[180, 90], [-180, -90]]);
  }
  function lock(on) {
    locked = on;
    for (const w of ['a', 'b']) pts[w]?.marker.setDraggable(!on);
    map.getCanvas().style.cursor = on ? '' : 'crosshair';
    if (on) {
      const s0 = summary(result);
      const minutes = hill ? hill.minutes : (s0.total / 1000 / PACE) * 60;
      strip.innerHTML = `<span><strong>${fmtLen(s0.total)}</strong> about ${fmtMin(minutes)} on foot</span><button type="button" data-route-edit>Edit</button>`;
      tool.onLock?.(); // closes the Map key
      map.fitBounds(routeBounds(), { padding: { top: 70, bottom: 110, left: 40, right: 70 }, maxZoom: 17 }); // bottom: room for the summary strip
      tool.geolocate?.trigger(); // the blue dot, so the trip can be walked with the map
    } else tool.onUnlock?.(); // reopens the Map key
    strip.hidden = !on;
    render();
  }
  strip.addEventListener('click', (e) => { if (e.target.closest('[data-route-edit]')) lock(false); });
  // Escape clears the trip, like the Clear button (Derek 2026-11-25). The address boxes handle their own Escape (above).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !tool.active || e.target.closest?.('.route-field input')) return;
    if (locked) lock(false);
    clear();
  });
  map.on('click', (e) => {
    if (!tool.active || locked) return; // a locked trip ignores taps
    place(pts.a ? 'b' : 'a', e.lngLat, 'Point on the map'); // with both set, a tap moves the end
    solve();
  });
  map.on('mousemove', () => { if (tool.active && !locked) map.getCanvas().style.cursor = 'crosshair'; });

  let first = true;
  function setActive(on) {
    tool.active = on;
    map.getCanvas().style.cursor = on ? 'crosshair' : '';
    if (on) {
      load();
      render();
      if (first && new URLSearchParams(location.search).get('view') === (opt.viewKey || 'navigation')) readLink();
      else syncUrl();
    } else { if (locked) { locked = false; strip.hidden = true; } clear(); } // leaving the tab clears the route (and its part of the address)
    first = false;
  }
  const tool = { active: false, setActive, pref, mount: (el) => { if (el) { render(); el.append(panel); } } };
  render();
  return tool;
};
