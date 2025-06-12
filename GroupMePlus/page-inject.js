// page-inject.js - Runs inside the page context to intercept API calls
(function () {
  const origFetch = window.fetch;
  window.fetch = async function (...a) {
    const r = await origFetch.apply(this, a);
    if (isGM(a[0])) {
      handle(r.clone(), a[0]);
    }
    return r;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url, ...rest) {
    if (isGM(url)) {
      this.addEventListener('load', () => {
        if (['', 'text', 'json'].includes(this.responseType)) {
          try { handle(JSON.parse(this.responseText), url); } catch {}
        }
      });
    }
    return origOpen.apply(this, [m, url, ...rest]);
  };

  function isGM(u) {
    return typeof u === 'string' && u.includes('/v3/') && 
           (u.includes('/groups/') && u.includes('/messages') || 
            u.includes('/direct_messages'));
  }

  function handle(payloadOrRes, url) {
    const p = payloadOrRes?.json ? payloadOrRes.json() : Promise.resolve(payloadOrRes);
    p.then(d => {
      // Handle both group messages and direct messages
      const msgs = d?.response?.messages || d?.response?.direct_messages;
      if (!Array.isArray(msgs) || !msgs.length) return;
      
      const bag = {};
      msgs.forEach(m => {
        // For DMs, we might need to add context about which DM conversation this is
        if (url && url.includes('/direct_messages')) {
          // Extract other_user_id from URL for DM context
          const match = url.match(/other_user_id=(\d+)/);
          if (match) {
            m.dm_other_user_id = match[1];
            m.is_dm = true;
          }
        }
        bag['msg-' + m.id] = m;
      });
      
      window.postMessage({ type: 'GM_MESSAGES', payload: bag }, '*');
    });
  }

  console.log('🚀 GroupMe Ultimate page script active');
})();
