// Runs on ReadyMode. Reads only the lead's four address fields and tells the extension when they change.
// Field ids checked on the live lead screen 2026-11-16.

function readLeadAddress(doc) {
  const v = (id) => (doc.getElementById(id)?.value || '').trim();
  const street = v('profile_address'), city = v('profile_city'), state = v('profile_state'), zip = v('profile_zip');
  // Zillow/Redfin matching needs a house number and a ZIP; skip leads without both.
  if (!/^\d+/.test(street) || !/^\d{5}/.test(zip)) return null;
  return `${street}, ${city ? city + ', ' : ''}${state} ${zip.slice(0, 5)}`.replace(/\s+/g, ' ').trim();
}

// Owner name and first phone. Ids/names checked on the live lead screen 2026-11-17; Ph#2+ are other inputs and are ignored.
function readLeadContact(doc) {
  const v = (sel) => (doc.querySelector(sel)?.value || '').trim();
  const owner = [v('#profile_firstName'), v('#profile_lastName')].filter(Boolean).join(' ');
  return { owner, phone: v('input[name$="@phone"]') };
}

if (typeof module !== 'undefined') module.exports = { readLeadAddress, readLeadContact };
else {
  let sent = '';
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => { if (msg.type === 'getLead') reply({ address: readLeadAddress(document), ...readLeadContact(document) }); });
  const timer = setInterval(() => {
    const address = readLeadAddress(document);
    if (!address || address === sent) return;
    sent = address;
    try { chrome.runtime.sendMessage({ type: 'leadAddress', address, ...readLeadContact(document) }); }
    catch { clearInterval(timer); } // extension was reloaded; this old script stops
  }, 1000);
}
