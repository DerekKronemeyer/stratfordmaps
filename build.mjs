// Builds the static site into dist/ from the files in src/. No dependencies: `node build.mjs`.
// To add a map, add it to src/maps.json, pull its data with `node fetch-umap.mjs <slug>`, then rebuild.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const OUT = 'dist';
const read = (file) => JSON.parse(readFileSync(join('src', file), 'utf8'));
const site = read('site.json');
const { categories, maps } = read('maps.json');
const resources = read('resources.json');
const lookup = read('lookup.json');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mapHref = (m) => (m.source === 'external' ? m.url : `/${m.slug}`);

// ---------- Icons ----------

const icons = {
  facebook: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z"/></svg>',
  legend: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="4.5" width="4" height="4" rx="1" fill="currentColor"/><rect x="3" y="10" width="4" height="4" rx="1" fill="currentColor"/><rect x="3" y="15.5" width="4" height="4" rx="1" fill="currentColor"/><path d="M10 6.5h11M10 12h11M10 17.5h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M7 6H4.5a2.5 2.5 0 0 0 2.6 4M17 6h2.5a2.5 2.5 0 0 1-2.6 4M12 14v4M8 20.5h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  drop: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3c3.5 4.4 6 7.9 6 11a6 6 0 0 1-12 0c0-3.1 2.5-6.6 6-11z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 10.5v6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="7.3" r="1.4" fill="currentColor"/></svg>',
  externalArrow: '<span aria-hidden="true">&#8599;</span>',
};

// ---------- Shared page parts ----------

// `path` (like "/walking") sets the page's address for link previews; `image` is the preview picture.
// Map pages use their card photo (640x360); other pages fall back to the logo.
const head = ({ title, description, path, image, extraHead = '' }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="darkreader-lock">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(site.name)}">
${path ? `<meta property="og:url" content="${site.url}${path}">\n` : ''}<meta property="og:image" content="${site.url}${image || '/static/logo.png'}">
${image ? `<meta property="og:image:width" content="640">
<meta property="og:image:height" content="360">
<meta name="twitter:card" content="summary_large_image">
` : ''}<meta name="theme-color" content="#1f2125">
<link rel="icon" href="/static/favicon.png">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
${extraHead}<link rel="stylesheet" href="/static/style.css">
<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "dcb4e8cff9d44692b51cd52b5c36fafe"}'></script>
</head>`;

const facebookLink = `<a class="social" href="${esc(site.facebookUrl)}" target="_blank" rel="noopener" aria-label="Stratford Maps on Facebook" title="Facebook">${icons.facebook}</a>`;
const logo = '<img src="/static/logo-96.png" alt="" width="36" height="36">';

const navLinks = [['/', 'Maps'], ['/lookup', '<span class="nav-long">Address </span>Lookup'], ['/resources', 'Resources'], ['/about', 'About']];
const siteHeader = (path) => `<header class="site-header">
  <a class="brand" href="/">${logo}<span>${esc(site.name)}</span></a>
  <nav>${navLinks.map(([href, label]) => `<a href="${href}"${href === path ? ' aria-current="page"' : ''}>${label}</a>`).join('')}${facebookLink}</nav>
</header>`;

const footer = `<footer class="site-footer">
  <p>An independent project, <strong>not affiliated with the Town of Stratford</strong>.</p>
</footer>`;

// A normal page: header, content, footer.
const page = ({ title, description, path, body, bodyAttrs = '', scripts = '' }) => `${head({ title, description, path })}
<body class="site"${bodyAttrs}>
${siteHeader(path)}
<main class="page">
${body}
</main>
${footer}
${scripts}</body>
</html>
`;

// ---------- Home ----------

const card = (m) => {
  const external = m.source === 'external';
  return `<a class="card" href="${esc(mapHref(m))}"${external ? ' target="_blank" rel="noopener"' : ''}>
  <div class="thumb thumb--${esc(m.category)}">${m.thumb ? `<img src="${esc(m.thumb)}" alt="" loading="lazy">` : ''}</div>
  <div class="card-body"><h3>${esc(m.title)}${external ? ` ${icons.externalArrow}` : ''}</h3><p>${esc(m.description)}</p>${external ? '<span class="badge">External</span>' : ''}</div>
</a>`;
};

const homeBody = `<section class="intro">
  <h1 class="sr-only">${esc(site.name)}</h1>
  <p>${esc(site.tagline)}</p>
</section>
${categories.map((c) => `<section class="category">
  <h2>${esc(c.title)}</h2>
  <div class="grid">
${maps.filter((m) => m.category === c.id).map(card).join('\n')}
  </div>
</section>`).join('\n')}`;

// ---------- About and Resources ----------

const messageMe = `<a href="${esc(site.facebookUrl)}">Message me on Facebook</a>`;

const aboutBody = `<article class="prose">
<h1>About</h1>
<p>Hi, I&rsquo;m <a href="https://kronemeyer.ca">Derek Kronemeyer</a>, and I live here in Stratford. I started this site because I love maps, and I found the ones that already existed were often hard to use, out of date, or hard to find. So I started building my own, pulling together information from many different sources and laying it out so it&rsquo;s easier to follow.</p>
<p>I&rsquo;ve done my best to make these maps accurate and useful, but they aren&rsquo;t official documents. They&rsquo;re meant for general reference, not as official records.</p>
<h2 id="services">Maps for your community</h2>
<p>I also build maps like these for other municipalities and organizations. If your community has information that would be easier to understand on a map, such as trails, parks, wards or local services, I&rsquo;d be happy to talk about what that could look like. Email <a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a>.</p>
<h2>Independence</h2>
<p>Stratford Maps is an independent project. It is <strong>not affiliated with, or endorsed by, the Town of Stratford</strong> or any government agency. The maps come from public sources and my own work, and they may not reflect the most recent changes, so please check official sources before relying on anything important.</p>
<h2 id="privacy">Privacy</h2>
<p>I count visits with Cloudflare Web Analytics, which doesn&rsquo;t use cookies. The Address Lookup also records which addresses are looked up and when, so I can see how it&rsquo;s being used. It doesn&rsquo;t record anything about who did the search, like your IP address, and I never share it.</p>
<h2 id="feedback">Feedback</h2>
<p>Have a question, spotted something that looks off, or know of something I should add? I&rsquo;d like to hear from you. These maps are always a work in progress, and corrections and ideas help make them better for everyone. ${messageMe}.</p>
<h2>Credits</h2>
<p>The maps are made with <a href="https://umap-project.org/">uMap</a>, an open source map editor I run myself, and drawn on this site with <a href="https://maplibre.org/">MapLibre</a>. Aerial imagery is from Esri and from the Town of Stratford&rsquo;s 2018 and 2025 aerial photos, and the street map is from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>.</p>
</article>`;

const resourceGroups = [...new Set(resources.map((r) => r.group))];
const resourceLink = (r) => `  <li><a class="resource" href="${esc(r.url)}" target="_blank" rel="noopener"><strong>${esc(r.title)} ${icons.externalArrow}</strong><span>${esc(r.description)}</span></a></li>`;

const resourcesBody = `<article class="prose">
<h1>Resources</h1>
<p>Other useful maps and tools for Stratford and PEI.</p>
${resourceGroups.map((group) => `<h2>${esc(group)}</h2>
<ul class="resources">
${resources.filter((r) => r.group === group).map(resourceLink).join('\n')}
</ul>`).join('\n')}
<p>Know of a resource I should add? ${messageMe}.</p>
</article>`;

// ---------- Address Lookup ----------

// The address data loads from /static/data/lookup.json (fetch-lookup.mjs); people and phone numbers come from src/lookup.json.
const checked = new Date(`${lookup.checked}T12:00:00`).toLocaleDateString('en-CA', { year: 'numeric', month: 'long' }); // month and year only, never the day
const phoneLink = (n) => `<a href="tel:${n.replace(/\D/g, '')}">${esc(n)}</a>`;
const lookupBody = `<article class="lookup">
<h1>Address Lookup</h1>
<p class="lede">Type your Stratford address to see your blue bag day, who represents you, your zoning and more.</p>
<div class="search">
  <label for="address" class="sr-only">Your address</label>
  <input id="address" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="address-list" autocomplete="off" spellcheck="false" placeholder="Start typing, like 234 Shakespeare">
  <ul id="address-list" role="listbox" aria-label="Matching addresses" hidden></ul>
</div>
<p id="lookup-status" class="muted" role="status"></p>
<div id="results" aria-live="polite" hidden></div>
<section class="everyone">
  <h2>For all of Stratford</h2>
  <dl class="phones">
${lookup.emergency.map((e) => `    <div class="row"><dt>${esc(e.label)}${e.note ? `<br><span class="muted">${esc(e.note)}</span>` : ''}</dt><dd>${phoneLink(e.phone)}</dd></div>`).join('\n')}
  </dl>
  <p>${lookup.services.map((s) => `${esc(s.label)}: ${esc(s.value)}`).join(' &middot; ')}</p>
  <p class="muted">Phone numbers and names were last checked in ${checked}. If something looks wrong, please <a href="${esc(site.facebookUrl)}">let me know on Facebook</a>.</p>
</section>
<p class="muted small">This page is for general reference, not an official record. Addresses, wards, districts and collection zones are from the Province of PEI, zoning and flood areas from the Town of Stratford, bus stops from T3 Transit, and parks and playgrounds from my <a href="/parks">Parks map</a>. Addresses looked up here are counted, see <a href="/about#privacy">Privacy</a>.</p>
</article>`;

// ---------- Not found ----------

// A dashed route that wanders, loops back on itself and ends at a pin in the middle of nowhere.
const notFoundBody = `<article class="lost">
<svg viewBox="0 0 320 160" width="320" height="160" aria-hidden="true">
  <path d="M14 140 C 60 150, 70 96, 110 104 S 150 150, 182 118 S 150 52, 196 46 S 260 96, 228 112 S 196 70, 252 60" fill="none" stroke="var(--muted)" stroke-width="3" stroke-dasharray="7 7" stroke-linecap="round"/>
  <circle cx="14" cy="140" r="5" fill="var(--muted)"/>
  <path d="M276 66 c-12-16-18-24-18-33 a18 18 0 0 1 36 0 c0 9-6 17-18 33z" fill="var(--pin)"/>
  <circle cx="276" cy="33" r="6.5" fill="var(--bg)"/>
</svg>
<h1>Lost? Even with all these maps?</h1>
<p>This page doesn&rsquo;t exist, or it&rsquo;s moved somewhere else. Let&rsquo;s get you back on track.</p>
<a class="button" href="/">Back to the maps</a>
</article>`;

// ---------- Map pages ----------

// A full-screen map drawn by /static/mapgl.js from /static/data/<slug>.json (made by fetch-umap.mjs).
const mapPage = (m) => `${head({
  title: `${m.title} | ${site.name}`,
  description: m.description,
  path: `/${m.slug}`,
  image: m.thumb,
  extraHead: '<link rel="stylesheet" href="/static/vendor/maplibre-gl/maplibre-gl.css">\n',
})}
<body class="map-page">
<header class="map-bar">
  <a class="brand" href="/" title="All maps">${logo}<span class="brand-name">${esc(site.name)}</span></a>
  <span class="sep" aria-hidden="true">/</span>
  <h1>${esc(m.title)}</h1>
  <nav>${facebookLink}</nav>
</header>
<div class="map-wrap">
  <div id="map" role="region" aria-label="${esc(m.title)} map"></div>
  <div class="map-buttons">
    <button type="button" id="map-key" aria-label="Map key" title="Map key" aria-controls="key-panel" aria-expanded="false">${icons.legend}<span>Map key</span></button>
    <button type="button" id="map-info" aria-label="Info" title="Info" aria-controls="info-panel" aria-expanded="false">${icons.info}<span>Info</span></button>
    ${m.leaderboard ? `<button type="button" id="map-leaders" aria-label="Leaderboard" title="Leaderboard" aria-controls="leaders-panel" aria-expanded="false">${icons.trophy}<span>Leaderboard</span></button>` : ''}
    ${m.flow && !(m.views || []).some((v) => v.tool === 'flow') ? `<button type="button" id="map-flow" aria-label="Trace Water" title="Trace Water" aria-pressed="false">${icons.drop}<span>Trace Water</span></button>` : ''}
  </div>
  <div id="key-panel" class="map-panel" hidden></div>
  <div id="info-panel" class="map-panel map-panel--info" hidden></div>
  ${m.leaderboard ? '<div id="leaders-panel" class="map-panel map-panel--leaders" hidden></div>' : ''}
</div>
<script>window.MAP_CONFIG = ${JSON.stringify({ title: m.title, description: m.description, data: `/static/data/${m.slug}.json`, oneLayer: !!m.oneLayer, background: m.background || null, dates: m.dates || null, search: !!m.search, leaderboard: m.leaderboard || null, done: m.done || null, components: m.components || null, flow: m.flow || null, route: m.route || null, heatmap: m.heatmap || null, areaDots: !!m.areaDots, streets: m.streets || null, views: m.views || null, insetOutlines: m.insetOutlines || null })};</script>
<script src="/static/vendor/maplibre-gl/maplibre-gl.js"></script>
${m.flow ? '<script src="/static/flow.js"></script>\n' : ''}${m.route ? '<script src="/static/route.js"></script>\n' : ''}${m.streets ? '<script src="/static/streets.js"></script>\n' : ''}<script src="/static/mapgl.js"></script>
</body>
</html>
`;

// Old Google Sites addresses send visitors to the new page.
const redirect = (to) => `<!doctype html><meta charset="utf-8"><title>Redirecting</title><meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${to}"><a href="${to}">Continue</a>\n`;

// ---------- Build ----------

// Cache busting: "/static/x.png" becomes "/static/x.png?v=<content hash>", so browsers fetch changed files.
const bust = (html) => html.replace(/"\/static\/([\w./-]+)"/g, (whole, file) => {
  if (!statSync(join('src', 'static', file), { throwIfNoEntry: false })?.isFile()) return whole; // folders (e.g. elevation tiles) stay as they are
  const hash = createHash('md5').update(readFileSync(join('src', 'static', file))).digest('hex').slice(0, 8);
  return `"/static/${file}?v=${hash}"`;
});
const writePage = (path, html) => {
  mkdirSync(join(OUT, path), { recursive: true });
  writeFileSync(join(OUT, path, 'index.html'), bust(html));
};

rmSync(OUT, { recursive: true, force: true });
cpSync(join('src', 'static'), join(OUT, 'static'), { recursive: true });

writePage('', page({ title: `${site.name} | maps of Stratford, PEI`, description: site.tagline, path: '/', body: homeBody }));
writePage('about', page({ title: `About | ${site.name}`, description: 'About Stratford Maps, an independent mapping project.', path: '/about', body: aboutBody }));
writePage('lookup', page({ title: `Address Lookup | ${site.name}`, description: 'Look up your Stratford address: blue bag day, councillors, MLA, MP, zoning, flood risk and more.', path: '/lookup', body: lookupBody,
  bodyAttrs: ' data-lookup="/static/data/lookup.json"', scripts: `<script>window.LOOKUP_INFO = ${JSON.stringify(lookup)};</script>
<script src="/static/lookup.js"></script>
` }));
writePage('resources', page({ title: `Resources | ${site.name}`, description: 'Other useful maps and tools for Stratford and PEI.', path: '/resources', body: resourcesBody }));
writeFileSync(join(OUT, '404.html'), bust(page({ title: `Page not found | ${site.name}`, description: 'Page not found.', body: notFoundBody })));
writePage('home', redirect('/'));
writePage('feedback', redirect('/about#feedback'));

const mapsWithPages = maps.filter((m) => m.source === 'umap');
for (const m of mapsWithPages) {
  if (!existsSync(join('src', 'static', 'data', `${m.slug}.json`))) throw new Error(`No data for ${m.slug}: run \`node fetch-umap.mjs ${m.slug}\` first.`);
  writePage(m.slug, mapPage(m));
}
console.log(`Built ${mapsWithPages.length} map pages into ${OUT}/`);
