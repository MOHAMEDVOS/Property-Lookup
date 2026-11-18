{
  const NAMES = { zillow: 'Zillow', redfin: 'Redfin' };
  const priceOf = (r) => r?.estimate || r?.soldPrice || r?.listPrice || 0;
  const money = (n) => (n ? `$${Math.round(n).toLocaleString()}` : null);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // "SINGLE_FAMILY" and "SingleFamily" both read "Single Family".
  const prettyType = (t) => String(t).replace(/[_-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

  chrome.runtime.connect({ name: 'panel' }); // lets the background see when the panel closes

  const $ = (s) => document.querySelector(s);
  const body = $('.body'), input = $('input'), btn = $('form .pill');

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const address = input.value.trim();
    if (address) chrome.runtime.sendMessage({ type: 'lookup', address });
  });

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }

  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  function lines(site, r) {
    if (site === 'lead') return [['Owner', r.owner || '—'], ['Phone', r.phone || '—']];
    return [
      ['Bed / Bath', `${r.beds ?? '—'} bed · ${r.baths ?? '—'} bath`],
      [site === 'zillow' ? 'Zestimate' : r.soldPrice && !r.estimate ? 'Sold price' : 'Redfin Estimate', money(priceOf(r)) || '—'],
      ['Listed', r.listPrice ? 'Yes' : 'No'],
      ['Address', r.fullAddress || r.address || '—'],
      ['Type', r.type ? prettyType(r.type) : '-'],
      ['Zoning', r.zoning || '-'],
      ['Sqft', r.sqft ? `${r.sqft.toLocaleString()} sqft` : '—'],
      ['Link', r.link],
    ];
  }

  const siteLink = (site, url) => `<a href="${esc(url)}" target="_blank" rel="noopener">Open on ${NAMES[site]} ↗</a>`;

  const rowHtml = (site, k, shown, i, tint = '') =>
    `<div class="row${tint}"><span class="lbl">${k}</span><span class="val">${shown}</span>
      <button class="copy" data-site="${site}" data-i="${i}" title="Copy ${k}" aria-label="Copy ${k}">${ICON}</button></div>`;

  function leadCard(l) {
    const rows = lines('lead', l).map(([k, v], i) => rowHtml('lead', k, esc(v), i)).join('');
    return `<div class="card lead"><div class="card-h"><span class="site">Lead</span></div>${rows}</div>`;
  }

  function card(site, r, top, low) {
    const head = (badge, cls = '', copyAll = '') =>
      `<div class="card-h"><span class="site">${NAMES[site]}</span>${badge ? `<span class="badge ${cls}">${badge}</span>` : ''}${copyAll}</div>`;
    const link = r?.link ? `<div class="row"><span class="lbl">Link</span><span class="val">${siteLink(site, r.link)}</span></div>` : '';
    if (!r) return `<div class="card ${site}">${head('Searching')}<div class="skel"></div><div class="skel" style="width:60%"></div></div>`;
    if (r.blocked) return `<div class="card ${site}">${head('Check needed', 'warn')}<div class="msg warn">${NAMES[site]} asked for a human check. Finish it in the window that opened, then look up again.</div>${link}</div>`;
    if (r.error) return `<div class="card ${site}">${head('Error', 'warn')}<div class="msg warn">${esc(r.error)}</div>${link}</div>`;
    if (r.noMatch) return `<div class="card ${site}">${head('No match')}<div class="msg">No exact match for this address.</div>${link}</div>`;

    const rows = lines(site, r).map(([k, v], i) =>
      rowHtml(site, k, k === 'Link' ? siteLink(site, v) : esc(v), i, i === 1 ? (site === top ? ' hi' : site === low ? ' lo' : '') : '')).join('');
    return `<div class="card ${site}">${head('', '', `<button class="pill ghost" data-all="${site}">Copy all</button>`)}${rows}</div>`;
  }

  let last = null;
  function render(state) {
    last = state;
    if (!state) return;
    if (document.activeElement !== input) input.value = state.address; // follows ReadyMode leads without overwriting typing
    btn.disabled = !!state.running;
    btn.textContent = state.running ? 'Searching' : 'Look up';
    const [a, b] = Object.keys(NAMES).map((s) => priceOf(state.results[s]));
    const top = a !== b ? (a > b ? 'zillow' : 'redfin') : null;
    const low = top && a && b ? (top === 'zillow' ? 'redfin' : 'zillow') : null; // red only when both have a price
    body.innerHTML = (state.lead && (state.lead.owner || state.lead.phone) ? leadCard(state.lead) : '') + Object.keys(NAMES).map((s) => card(s, state.results[s], top, low)).join('');
  }

  body.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !last) return;
    let text;
    const dataOf = (site) => (site === 'lead' ? last.lead : last.results[site]);
    if (b.dataset.all) text = lines(b.dataset.all, dataOf(b.dataset.all)).map(([, v]) => v).join('\n');
    else if (b.dataset.site) text = lines(b.dataset.site, dataOf(b.dataset.site))[b.dataset.i][1];
    else return;
    await copyText(text);
    const old = b.innerHTML;
    b.classList.add('done'); b.innerHTML = b.dataset.all ? 'Copied' : CHECK;
    setTimeout(() => { b.classList.remove('done'); b.innerHTML = old; }, 1200);
  });

  // --- RES-ID login: allowed IDs live in a Google Sheet behind an Apps Script web app (see apps_script.gs).
  const AUTH_URL = 'https://script.google.com/macros/s/AKfycby0K6JeotbpAXWJO0m3cOPyP9d8OhiII49pLkxn6KiyaIc-kzh4nsSkxd51OQ_zSn-t/exec';
  const WEEK = 7 * 24 * 3600 * 1000;
  const loginBox = $('#login');
  const checkId = async (id) => {
    const r = await fetch(`${AUTH_URL}?id=${encodeURIComponent(id)}`);
    return (await r.json()).ok === true;
  };
  async function ensureLogin() {
    const { auth } = await chrome.storage.local.get('auth');
    if (auth && Date.now() < auth.exp) {
      loginBox.hidden = true;
      // Re-check so a removed ID is cut off at once; offline keeps the week's grace.
      checkId(auth.id).then((ok) => { if (!ok) { chrome.storage.local.remove('auth'); loginBox.hidden = false; } }).catch(() => {});
      return;
    }
    loginBox.hidden = false;
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#resId').value.trim(), msg = $('#loginMsg');
    msg.textContent = '';
    try {
      if (!(await checkId(id))) { msg.textContent = 'RES-ID not allowed.'; return; }
      await chrome.storage.local.set({ auth: { id, exp: Date.now() + WEEK } });
      loginBox.hidden = true;
    } catch { msg.textContent = 'Could not reach the server. Try again.'; }
  });
  ensureLogin();

  chrome.storage.local.get('last').then(({ last }) => render(last));
  chrome.storage.onChanged.addListener((ch) => ch.last && render(ch.last.newValue));
  input.focus();
}
