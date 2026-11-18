// Address Lookup: type a Stratford address, see what applies to it. Address data comes from
// /static/data/lookup.json (made by fetch-lookup.mjs); people and phone numbers from window.LOOKUP_INFO (src/lookup.json).
(() => {
  const info = window.LOOKUP_INFO;
  const input = document.getElementById('address');
  const list = document.getElementById('address-list');
  const results = document.getElementById('results');
  const status = document.getElementById('lookup-status');

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const link = (src) => `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.label)}</a>`;

  // People write street endings both ways: "Keppoch Rd" should find "Keppoch Road".
  const SHORT = { rd: 'road', ln: 'lane', ct: 'court', crt: 'court', cres: 'crescent', blvd: 'boulevard', hts: 'heights', hwy: 'highway', wy: 'way', ave: 'avenue', av: 'avenue', st: 'street', dr: 'drive', pl: 'place', ter: 'terrace', terr: 'terrace', cl: 'close' };
  const words = (s) => s.toLowerCase().replace(/['’.,]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

  let data, entries = [];
  const label = (a) => `${a.no} ${a.street}`;

  const load = fetch(document.body.dataset.lookup).then((r) => r.json()).then((d) => {
    data = d;
    entries = d.addresses.map((row) => {
      const a = Object.fromEntries(d.fields.map((f, i) => [f, row[i]]));
      a.street = d.streets[a.street];
      a.words = words(a.street);
      return a;
    });
  });

  // Every word typed has to start a word of the street name; a number has to match the start of the house number.
  const search = (q) => {
    const typed = words(q);
    const nums = typed.filter((w) => /^\d+$/.test(w));
    const text = typed.filter((w) => !/^\d+$/.test(w));
    if (!typed.length) return [];
    const hits = entries.filter((a) => nums.every((n) => String(a.no).startsWith(n))
      && text.every((t) => a.words.some((w) => w.startsWith(t) || w === SHORT[t])));
    const exact = (a) => (nums.length && String(a.no) === nums[0] ? 0 : 1);
    return hits.sort((x, y) => exact(x) - exact(y) || x.street.localeCompare(y.street) || x.no - y.no).slice(0, 8);
  };

  // ---------- Suggestions list ----------

  let shown = [], active = -1;
  const closeList = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const showList = () => {
    if (!shown.length) {
      list.innerHTML = input.value.trim() ? '<li class="none" role="option" aria-disabled="true">No Stratford address matches that. Try just the house number and street.</li>' : '';
      list.hidden = !input.value.trim();
    } else {
      list.innerHTML = shown.map((a, i) => `<li id="opt-${i}" role="option" aria-selected="${i === active}">${esc(label(a))}</li>`).join('');
      list.hidden = false;
    }
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (active >= 0) input.setAttribute('aria-activedescendant', `opt-${active}`); else input.removeAttribute('aria-activedescendant');
  };

  input.addEventListener('input', async () => {
    await load;
    shown = search(input.value);
    active = shown.length ? 0 : -1;
    showList();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!shown.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      showList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) choose(shown[active]);
    } else if (e.key === 'Escape') closeList();
  });
  list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the box while clicking
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[id]');
    if (li) choose(shown[Number(li.id.slice(4))]);
  });
  input.addEventListener('blur', closeList);

  // ---------- Results ----------

  const distance = (m) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);
  const lower = (s) => s.replace(/\bof every Month\b/i, 'of every month');
  const card = (title, body, foot = '') => `<section class="result"><h2>${title}</h2>${body}${foot ? `<p class="src">${foot}</p>` : ''}</section>`;
  const row = (k, v) => `<div class="row"><dt>${k}</dt><dd>${v}</dd></div>`;

  const render = (a) => {
    const out = [];

    const c = data.collection[a.collection];
    out.push(card('Garbage and recycling', c
      ? `<dl>${row('Blue bag', `<strong>${esc(lower(c.bluebag))}</strong>`)}${row('Green and black carts', esc(c.cart))}</dl>`
      : '<p>No collection zone found for this address.</p>', `Collection zones from ${link(info.wasteSource)}.`));

    const ward = info.wards[data.wards[a.ward]];
    out.push(card('Town council', ward
      ? `<dl>${row('Ward', `<strong>Ward ${ward.number}, ${esc(ward.name)}</strong>`)}${row('Councillors', ward.councillors.map(esc).join('<br>'))}${row('Mayor', esc(info.mayor))}</dl>`
      : '<p>No ward found for this address.</p>', `Contact details at ${link(info.councilContact)}.`));

    const d = info.districts[data.districts[a.district]];
    out.push(card('Provincial (MLA)', d
      ? `<dl>${row('District', `<strong>${esc(d.name)}</strong>`)}${row('MLA', `${esc(d.mla)}<br><span class="muted">${esc(d.party)}</span>`)}</dl>`
      : '<p>No provincial district found for this address.</p>', link(info.mlaSource)));

    out.push(card('Federal (MP)', `<dl>${row('Riding', `<strong>${esc(info.riding.name)}</strong>`)}${row('MP', `${esc(info.riding.mp)}<br><span class="muted">${esc(info.riding.party)}</span>`)}</dl>`,
      `All of Stratford is in ${esc(info.riding.name)}. ${link(info.mpSource)}`));

    const zones = data.zones[a.zones] || [];
    const base = zones.filter((z) => z !== 'SS'), overlay = zones.includes('SS');
    out.push(card('Zoning', base.length
      ? `<p><strong>${base.map((z) => `${esc(info.zones[z] || z)} (${esc(z)})`).join(', ')}</strong></p>${overlay ? `<p>Also in the ${esc(info.zones.SS)}.</p>` : ''}${base.length > 1 ? '<p class="muted">This address sits on a zone boundary.</p>' : ''}`
      : '<p>No zone found for this address.</p>', `From the Town&rsquo;s May 2023 zoning map. The Town is working on a new zoning bylaw, so check with the Town before you plan anything. ${link(info.zoningSource)}`));

    // The house being in a flood area is the stronger warning; the lot only counts when the house is clear and at least 10% of the lot is in one.
    const flood = data.flood[a.flood];
    const kind = { coastal: 'from the sea in a 1-in-100-year storm by 2100, once sea-level rise is included', inland: 'from heavy rain or streams in a 1-in-100-year storm, in a future climate' };
    const area = (t) => (t === 'coastal' ? 'a coastal' : 'an inland');
    const floodText = !flood ? '<p>Not inside a flood area on the Town&rsquo;s flood map.</p>'
      : flood.types.map((t) => (flood.where === 'house'
        ? `<p><strong class="warn">The house is inside ${area(t)} flood area.</strong> The Town&rsquo;s flood map shows it could flood ${kind[t]}.</p>`
        : `<p><strong class="warn">Part of the property is in ${area(t)} flood area.</strong> The house is outside it, but at least 10% of the lot could flood ${kind[t]}.</p>`)).join('');
    out.push(card('Flood risk', floodText, 'The house is checked at its address point. This is the Town&rsquo;s planning map, not a guarantee either way.'));

    const stop = a.stop && data.stops[a.stop[0]];
    const park = a.park && data.parks[a.park[0]];
    const play = a.playground && data.playgrounds[a.playground[0]];
    const straight = 'Distances are in a straight line, so walking is usually a bit farther.';
    const near = (name, m) => `<strong>${esc(name)}</strong><br><span class="muted">about ${distance(m)}</span>`;
    out.push(card('Bus', stop
      ? `<dl>${row('Nearest stop', near(stop.name, a.stop[1]))}${stop.routes.length ? row('Routes', stop.routes.map(esc).join('<br>')) : ''}</dl>`
      : '<p>No bus stop found nearby.</p>', straight));
    out.push(card('Parks', `<dl>${park ? row('Nearest park', near(park, a.park[1])) : ''}${play ? row('Nearest playground', near(play, a.playground[1])) : ''}</dl>`,
      `${straight} <a href="/parks">Parks map</a>`));

    results.innerHTML = `<h2 class="result-title">${esc(label(a))}</h2><div class="results-grid">${out.join('')}</div>`;
    results.hidden = false;
  };

  // Counts each lookup on the live site (see src/worker.js): just the address and whether it came from
  // the search box or a shared link. Picking the same address again in a row isn't counted twice.
  let lastLogged = '';
  const logLookup = (address, how) => {
    if (address === lastLogged || location.hostname !== 'www.stratfordmaps.ca') return;
    lastLogged = address;
    try { navigator.sendBeacon('/api/lookup', JSON.stringify({ address, how })); } catch { /* counting is optional */ }
  };

  const choose = (a, how = 'search') => {
    input.value = label(a);
    closeList();
    render(a);
    logLookup(label(a), how);
    const url = new URL(location.href);
    url.searchParams.set('address', label(a));
    history.replaceState(null, '', url);
  };

  // A shared link (?address=33 Sauls Pride Crescent) opens straight to that address.
  const start = new URLSearchParams(location.search).get('address');
  if (start) load.then(() => {
    const a = entries.find((e) => label(e).toLowerCase() === start.toLowerCase()) || search(start)[0];
    if (a) choose(a, 'link'); else { input.value = start; status.textContent = 'That address was not found.'; }
  });
})();
