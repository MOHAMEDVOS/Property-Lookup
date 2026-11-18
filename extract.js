// Injected into each site's tab. Reads the data the page already embeds; no hidden APIs except
// Redfin's own search-box lookup, called same-origin from redfin.com like the site does.

function parseAddress(text) {
  const s = String(text || '').toLowerCase();
  const lead = s.match(/^\s*(\d+[a-z]?)\b/);
  const rest = lead ? s.slice(lead[0].length) : s; // so a 5-digit house number isn't read as the ZIP
  const zips = rest.match(/\b\d{5}\b/g);
  return { num: lead ? lead[1] : null, zip: zips ? zips[zips.length - 1] : null };
}

function addressMatches(wanted, found) {
  const a = parseAddress(wanted), b = parseAddress(found);
  if (!a.num || !b.num || a.num !== b.num) return false;
  return !(a.zip && b.zip && a.zip !== b.zip);
}

// Plain functions (not const) so injecting this file twice into one page doesn't throw.
function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return num(v.value ?? v.estimate ?? v.amount);
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function addressOf(o) {
  const a = o.address;
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object') {
    const street = a.streetAddress ?? a.line ?? a.street ?? '';
    const zip = a.zipcode ?? a.postalCode ?? a.postal_code ?? a.zip ?? '';
    return `${street} ${zip}`.trim();
  }
  return o.streetAddress ? `${o.streetAddress} ${o.zipcode ?? ''}` : o.addressStreet ? `${o.addressStreet} ${o.addressZipcode ?? ''}` : '';
}

function pick(o) {
  const beds = num(o.bedrooms ?? o.beds ?? o.numberOfBedrooms ?? o.numberOfRooms);
  const baths = num(o.bathrooms ?? o.baths ?? o.numberOfBathroomsTotal);
  if (beds == null && baths == null) return null;
  return {
    address: addressOf(o),
    listPrice: num(o.unformattedPrice ?? o.listPrice ?? o.price ?? o.offers?.price),
    estimate: num(o.zestimate ?? o.estimate),
    beds, baths,
    sqft: num(o.livingArea ?? o.sqft ?? o.floorSize),
    type: o.resoFacts?.homeType ?? o.homeType ?? (/Residence$/.test(o['@type']) ? o['@type'].replace(/Residence$/, '') : null),
    zoning: o.resoFacts?.zoning ?? o.resoFacts?.zoningDescription ?? null,
    status: o.homeStatus ?? o.status ?? o.statusText ?? null,
    url: o.hdpUrl ?? o.detailUrl ?? o.href ?? o.url ?? null,
  };
}

function findListing(roots, wanted) {
  const seen = new Set(), hits = [];
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || seen.has(v) || depth > 40 || hits.length > 200) return;
    seen.add(v);
    if (!Array.isArray(v)) { const p = pick(v); if (p) hits.push(p); }
    for (const k in v) walk(v[k], depth + 1);
  };
  roots.forEach((r) => walk(r, 0));
  return hits.find((h) => h.address && addressMatches(wanted, h.address)) || null;
}

function pageJson(doc) {
  const roots = [];
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const next = doc.getElementById('__NEXT_DATA__');
  if (next) {
    const d = tryParse(next.textContent);
    if (d) {
      roots.push(d);
      const cache = d?.props?.pageProps?.componentProps?.gdpClientCache; // Zillow property page
      if (typeof cache === 'string') roots.unshift(tryParse(cache));
    }
  }
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => roots.push(tryParse(s.textContent)));
  return roots.filter(Boolean);
}

function fromMeta(doc) {
  const t = doc.querySelector('meta[name="description"]')?.content || doc.querySelector('meta[property="og:description"]')?.content || '';
  const m = (re) => num((t.match(re) || [])[1]);
  const beds = m(/([\d.]+)\s*(?:beds?|bd)\b/i), baths = m(/([\d.]+)\s*(?:baths?|ba)\b/i);
  if (beds == null && baths == null) return null;
  // A "$" in an off-market description is an old sale price, not a list price.
  const listed = metaIsListed(t);
  return { beds, baths, sqft: m(/([\d,]+)\s*sq\.?\s*ft/i), listPrice: listed ? m(/\$([\d,]+)/) : null, estimate: null, status: listed ? 'FOR_SALE' : null };
}

// Redfin's meta description starts "For Sale: ..." only on listed homes.
function metaIsListed(text) { return /^\s*(for sale|pending|contingent)/i.test(text); }

function isForSale(status) {
  return /for_?\s?sale|active|pending|contingent|coming/i.test(status || '') && !/not/i.test(status || '');
}

function isBlocked(doc) {
  return /denied|robot|verification|captcha|could not be satisfied|blocked/i.test(doc.title);
}

async function extractListing(site, wanted, doc = document, loc = location) {
  if (isBlocked(doc)) return { blocked: true };

  // Any redfin.com page that isn't a home page: ask Redfin's own search-box endpoint where this address lives.
  if (site === 'redfin' && !/\/home\/\d+/.test(loc.pathname)) {
    const r = await fetch(`/stingray/do/location-autocomplete?location=${encodeURIComponent(wanted)}&v=2`);
    const body = JSON.parse((await r.text()).replace(/^\{\}&&/, ''));
    const p = body.payload || {};
    const rows = [p.exactMatch, ...(p.sections || []).flatMap((s) => s.rows || [])].filter(Boolean);
    const row = rows.find((x) => x.url && addressMatches(wanted, `${x.name || ''} ${x.subName || ''}`)) || rows.find((x) => x.url && /\/home\//.test(x.url));
    return row ? { follow: new URL(row.url, loc.origin).href } : { noMatch: true };
  }

  const roots = pageJson(doc);
  const hit = findListing(roots, wanted);
  if (hit) {
    const onDetail = /homedetails|\/home\/\d+/.test(loc.pathname);
    if (!onDetail && hit.url) return { follow: new URL(hit.url, loc.origin).href };
    if (site === 'redfin') {
      // Redfin keeps price and estimate outside its JSON-LD (checked live 2026-11-16). Its meta
      // description starts "For Sale:" on listed homes; otherwise the big price is the estimate.
      const text = doc.body?.innerText || '';
      const meta = doc.querySelector('meta[name="description"]')?.content || '';
      hit.status = metaIsListed(meta) ? 'FOR_SALE' : 'NOT_FOR_SALE';
      if (hit.status === 'FOR_SALE') hit.listPrice ??= num((doc.querySelector('[data-rf-test-id="abp-price"]')?.innerText.match(/\$[\d,]+/) || [])[0]);
      // Redfin prints the value above its label ("Single-family" then "Property Type"); more specific than the generic JSON-LD tag.
      hit.type = (text.match(/([^\n]{2,40})\n\s*Property Type\b/i) || [])[1]?.trim() || hit.type;
      hit.zoning ??= (text.match(/Zoning(?: Description| Code)?\s*[:\n]\s*([^\n]{1,60})/i) || [])[1]?.trim().match(/^(?=.*\d).+$/)?.[0] || null; // digit required (SF-3, R1): drops stray labels like "Beds"
      hit.estimate ??= num((text.match(/Redfin Estimate(?: for[^\n]*)?\n\s*\$([\d,]+)/) || [])[1]);
      // Closed homes show the sold price where an estimate would be: keep it as a sold price, not an estimate.
      const sold = num((text.match(/(?:^|\n)[^\w\n]*(?:Closed|Sold)\s*\n\s*\$([\d,]+)/) || [])[1]);
      if (sold && !/Redfin Estimate/.test(text)) { hit.soldPrice = sold; hit.estimate = null; }
    }
    // Off-market homes: Zillow puts the Zestimate in "price", so only trust a price on listed homes.
    if (!isForSale(hit.status)) hit.listPrice = null;
    // Page titles on both sites start with the full address: "12703 Timberside Dr, Austin, TX 78727 | ...".
    const titleAddr = doc.title.split('|')[0].trim();
    if (addressMatches(wanted, titleAddr)) hit.fullAddress = titleAddr;
    return { ...hit, url: loc.href };
  }

  const titleMatches = addressMatches(wanted, doc.title.replace(/\s*[|-].*$/, '')) ||
    addressMatches(wanted, (doc.title.match(/^[^|]*/) || [''])[0]);
  const meta = titleMatches ? fromMeta(doc) : null;
  if (meta) return { ...meta, address: doc.title, url: loc.href };

  return { noMatch: true };
}

if (typeof module !== 'undefined') module.exports = { parseAddress, addressMatches, findListing, pick, fromMeta, extractListing };
