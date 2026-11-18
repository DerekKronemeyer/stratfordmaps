// The site is static files (dist/, served by Cloudflare). This Worker only adds one thing: POST /api/lookup
// records which address someone looked up on the Address Lookup page, in the D1 database bound as DB.
// It stores the time, the address and how it was opened, nothing about the person (no IP, no browser details).
// Everything else goes straight to the static files.

const SCHEMA = `CREATE TABLE IF NOT EXISTS lookups (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  address TEXT NOT NULL,
  how TEXT NOT NULL
)`;
let ready; // the table is created once per Worker instance, the first time it's needed

const logLookup = async (request, env) => {
  let body;
  try { body = JSON.parse(await request.text()); } catch { return new Response('Bad request', { status: 400 }); }
  const address = String(body.address || '').trim();
  const how = body.how === 'link' ? 'link' : 'search';
  // Only things shaped like a Stratford civic address ("12 Keppoch Road"), so the table can't fill with junk.
  if (address.length > 80 || !/^\d{1,5} [A-Za-z][A-Za-z .'-]*$/.test(address)) return new Response('Bad request', { status: 400 });
  ready ||= env.DB.prepare(SCHEMA).run();
  await ready;
  await env.DB.prepare('INSERT INTO lookups (address, how) VALUES (?, ?)').bind(address, how).run();
  return new Response(null, { status: 204 });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/lookup') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      try { return await logLookup(request, env); } catch { ready = undefined; return new Response('Error', { status: 500 }); }
    }
    return env.ASSETS.fetch(request);
  },
};
