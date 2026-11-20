// `split` in maps.json (Housing Density): one uMap layer becomes several site layers by a number field, e.g. every
// building in uMap's "Residential buildings" layer goes into Singles, Doubles, ... 13+ Units by its Units.
// The classes and colours come from that uMap layer's Choropleth settings (manual breakpoints and colour palette),
// using uMap's own rule (a value goes in the first class whose upper breakpoint it doesn't exceed), so the site
// matches what Derek sees in uMap. Each building's popup name comes from its class.
//   "split": { "layer": "Residential buildings", "field": "Units",
//              "classes": [ { "name": "Singles", "label": "Single detached home" }, ... ] }   // one per uMap class

// uMap's ColorBrewer palettes, read from the uMap server (the same file uMap uses).
export async function loadPalettes(umapUrl, download) {
  const js = await (await download(`${umapUrl}/static/umap/vendors/colorbrewer/colorbrewer.js`)).text();
  const body = js.slice(js.indexOf('{'), js.lastIndexOf('export')).trim().replace(/;$/, '');
  return Function(`return (${body})`)();
}

export function splitLayer(layer, choropleth, palettes, split, slugify) {
  const breaks = String(choropleth?.breaks || '').split(',').map((b) => +b).filter((b) => !Number.isNaN(b));
  const thresholds = breaks.slice(1); // the first breakpoint is the bottom of the range
  if (choropleth?.mode !== 'manual' || thresholds.length !== split.classes.length)
    throw new Error(`split: uMap layer "${layer.name}" needs Choropleth mode Manual with ${split.classes.length + 1} breakpoints (has "${choropleth?.breaks || ''}")`);
  const scheme = palettes[choropleth.brewer] ? choropleth.brewer : 'Blues'; // uMap's own fallback
  const colors = palettes[scheme][thresholds.length] || [];
  const out = split.classes.map((c, i) => ({ ...layer, key: slugify(c.name), name: c.name, color: colors[i] || layer.color, fillColor: colors[i] || layer.fillColor, features: [] }));
  for (const f of layer.features) {
    const v = +f.properties[split.field];
    let i = Number.isNaN(v) ? 0 : thresholds.findIndex((t) => v <= t);
    if (i < 0) i = thresholds.length - 1; // above the top breakpoint: uMap leaves it uncoloured; the site puts it in the top class
    if (split.classes[i].label) f.properties.name = split.classes[i].label;
    out[i].features.push(f);
  }
  return out;
}
