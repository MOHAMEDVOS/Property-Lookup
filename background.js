const slug = (a) => a.trim().replace(/[,#]/g, '').replace(/\s+/g, '-');

const SITES = {
  zillow: (a) => `https://www.zillow.com/homes/${slug(a)}_rb/`,
  redfin: () => 'https://www.redfin.com/robots.txt', // tiny page: the address lookup runs from here, no heavy homepage load
};

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, 30000);
    function done() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpd); setTimeout(resolve, 300); }
    function onUpd(id, info) { if (id === tabId && info.status === 'complete') done(); }
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

// Nothing usable yet: no match, or a listing page with neither price.
const needsRetry = (res) => res?.noMatch || (res && !res.follow && !res.blocked && !res.estimate && !res.listPrice);

async function extract(tabId, site, address) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['extract.js'] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (s, a) => extractListing(s, a),
    args: [site, address],
  });
  return result;
}

async function lookupSite(site, address, windowId) {
  const startUrl = SITES[site](address);
  const tab = await chrome.tabs.create({ url: startUrl, active: false, windowId });
  try {
    await waitForLoad(tab.id);
    for (let hop = 0; hop < 3; hop++) {
      let res = await extract(tab.id, site, address);
      // Slow PCs load the page data late: keep checking (up to 15s) and stop the moment a result shows up.
      for (const end = Date.now() + 15000; needsRetry(res) && Date.now() < end;) {
        await new Promise((r) => setTimeout(r, 500));
        res = await extract(tab.id, site, address);
      }
      if (res?.follow) {
        await chrome.tabs.update(tab.id, { url: res.follow });
        await waitForLoad(tab.id);
        continue;
      }
      const { url } = await chrome.tabs.get(tab.id);
      if (res?.blocked) {
        // Leave the tab open and bring its window forward so the user can pass the site's check.
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(windowId, { state: 'normal', focused: true });
        return { site, blocked: true, link: url };
      }
      await chrome.tabs.remove(tab.id);
      if (res?.noMatch) return { site, noMatch: true, link: url };
      return { site, ...res, link: res.url || url };
    }
    await chrome.tabs.remove(tab.id);
    return { site, noMatch: true, link: startUrl };
  } catch (e) {
    chrome.tabs.remove(tab.id).catch(() => {});
    return { site, error: String(e.message || e), link: startUrl };
  }
}

// Each lookup gets a number; one that is no longer the latest (new lead, or panel closed) saves nothing.
let current = 0;

async function startLookup(address, lead) {
  const { auth } = await chrome.storage.local.get('auth');
  if (!auth || Date.now() >= auth.exp) return;
  const id = ++current;
  const state = { address, lead, running: true, results: {} };
  const save = (s) => id === current && chrome.storage.local.set({ last: s });
  save(state);
  let win;
  try {
    win = await chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false });
    const windowId = win.id;
    await Promise.all(Object.keys(SITES).map(async (site) => {
      state.results[site] = await lookupSite(site, address, windowId);
      await save(state);
    }));
  } finally {
    const waitingOnCheck = id === current && Object.values(state.results).some((r) => r.blocked);
    if (win && !waitingOnCheck) chrome.windows.remove(win.id).catch(() => {});
    save({ ...state, running: false });
  }
}

let leadTimer;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'lookup') startLookup(msg.address);
  if (msg.type === 'leadAddress') {
    // The short wait skips leads flicked past quickly.
    clearTimeout(leadTimer);
    leadTimer = setTimeout(async () => {
      const { last } = await chrome.storage.local.get('last'); // survives the worker going to sleep
      if (msg.address !== last?.address) startLookup(msg.address, { owner: msg.owner, phone: msg.phone });
    }, 700);
  }
});

// Panel is off everywhere; a click on the icon turns it on for that tab only.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
chrome.sidePanel.setOptions({ enabled: false });
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true });
  chrome.sidePanel.open({ tabId: tab.id }); // must run straight from the click, so no await before it
});

const isReadyMode = (url) => /^https:\/\/[^/]*\.readymode\.com\//.test(url || '');

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(async ([tab]) => {
    const lead = tab && isReadyMode(tab.url) && await chrome.tabs.sendMessage(tab.id, { type: 'getLead' }).catch(() => null);
    if (lead?.address) startLookup(lead.address, lead);
  });
  port.onDisconnect.addListener(() => { current++; chrome.storage.local.remove('last'); });
});
