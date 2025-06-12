// GroupMe Ultimate Extension - Combined Font Picker, Message Cacher, and Message Counter
// Version 2.0
(() => {
  'use strict';
  
  console.log('🚀 GroupMe Ultimate Extension - Loading...');

  /*────────────────── SECTION 1: PAGE INJECTION ──────────────────*/
  // Inject page-inject.js into the page context for API interception
  {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('page-inject.js');
    s.onload = () => s.remove();
    (document.documentElement || document.head).appendChild(s);
  }

  // Ensure LZString is available for message caching
  if (!('LZString' in window)) {
    console.warn('[GroupMe Ultimate] LZString not found; message caching disabled.');
  }

  /*────────────────── SECTION 2: MESSAGE CACHING ──────────────────*/
  const MessageCache = (() => {
    if (!window.LZString) {
      console.warn('[GroupMe Ultimate] LZString not available, message caching disabled');
      return null;
    }

    const DB = (() => {
      const NAME = 'GMCache', STORE = 'msgs';
      let dbp;

      function open() {
        if (dbp) return dbp;
        dbp = new Promise((resolve, reject) => {
          const req = indexedDB.open(NAME, 1);
          req.onupgradeneeded = e => e.target.result.createObjectStore(STORE, { keyPath: 'id' });
          req.onsuccess = e => resolve(e.target.result);
          req.onerror = e => reject(e.target.error);
        });
        return dbp;
      }

      async function putMany(objs) {
        const db = await open();
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        Object.values(objs).forEach(o => store.put(o));
        return tx.complete ?? new Promise((res, rej) => {
          tx.oncomplete = res;
          tx.onerror = e => rej(e.target.error);
        });
      }

      async function count() {
        const db = await open();
        return new Promise((res, rej) => {
          const r = db.transaction(STORE).objectStore(STORE).count();
          r.onsuccess = () => res(r.result);
          r.onerror = e => rej(e.target.error);
        });
      }

      function firstValidSample() {
        return open().then(db => new Promise((res, rej) => {
          const c = db.transaction(STORE).objectStore(STORE).openCursor();
          c.onsuccess = e => {
            const cur = e.target.result;
            if (!cur) return res(null);
            const v = cur.value;
            if (v?.d) {
              try {
                const json = LZString.decompressFromUTF16(v.d);
                return res(JSON.parse(json));
              } catch {/* keep looking */}
            }
            cur.continue();
          };
          c.onerror = e => rej(e.target.error);
        }));
      }

      async function all() {
        const db = await open();
        return new Promise((res, rej) => {
          const out = [];
          const c = db.transaction(STORE).objectStore(STORE).openCursor();
          c.onsuccess = e => {
            const cur = e.target.result;
            if (!cur) return res(out);
            try {
              const raw = LZString.decompressFromUTF16(cur.value.d);
              out.push(JSON.parse(raw));
            } catch {/* ignore bad records */}
            cur.continue();
          };
          c.onerror = e => rej(e.target.error);
        });
      }

      return { putMany, count, firstValidSample, all };
    })();

    // Listen for batches from the page
    window.addEventListener('message', e => {
      if (e.source !== window || e.data?.type !== 'GM_MESSAGES') return;
      const batch = {};
      for (const id in e.data.payload) {
        const m = e.data.payload[id];
        const slim = {
          i: m.id,
          g: m.group_id,
          t: m.text,
          c: m.created_at,
          u: m.sender_id,
          n: m.name
        };
        if (m.attachments?.length) slim.a = m.attachments;
        if (m.favorited_by?.length) slim.f = m.favorited_by;
        if (m.is_dm) slim.dm = true;
        if (m.dm_other_user_id) slim.dmu = m.dm_other_user_id;
        batch[id] = { id, d: LZString.compressToUTF16(JSON.stringify(slim)) };
      }
      DB.putMany(batch).then(() =>
        console.log('✅ Cached', Object.keys(batch).length, 'messages → IndexedDB')
      );
    });

    // CSV export helper
    function toCsv(rows) {
      const esc = s => '"' + (s?.toString().replace(/"/g, '""') ?? '') + '"';
      const header = ['id','group','text','created_at','sender_id','name','attachments','favorited_by','is_dm','dm_other_user'];
      const lines = rows.map(r => [
        esc(r.i), esc(r.g), esc(r.t), esc(r.c), esc(r.u), esc(r.n),
        esc(r.a ? JSON.stringify(r.a) : ''),
        esc(r.f ? JSON.stringify(r.f) : ''),
        esc(r.dm ? 'true' : 'false'),
        esc(r.dmu || '')
      ].join(','));
      return [header.join(','), ...lines].join('\r\n');
    }

    async function exportCsv() {
      const allRaw = await DB.all();
      const msgs = allRaw.filter(r => r && r.i !== undefined);
      if (!msgs.length) return alert('No messages cached yet.');
      const csv = toCsv(msgs);
      const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = blobUrl;
      a.download = `groupme_messages_${Date.now()}.csv`;
      a.click(); URL.revokeObjectURL(blobUrl);
    }

    return { DB, exportCsv };
  })();

  /*────────────────── SECTION 3: MESSAGE COUNTER ──────────────────*/
  const MessageCounter = (() => {
    let currentGroupId = null;
    let messageCount = 0;
    let lastCountTimestamp = Date.now();

    function detectGroupId(url) {
      const patterns = [
        /\/v3\/groups\/(\d+)\/messages/,
        /\/v3\/groups\/(\d+)/,
        /groupme\.com\/groups\/(\d+)/,
        /\/groups\/(\d+)/
      ];
      
      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
          console.log('🎯 Group ID detected:', match[1], 'from URL:', url);
          return match[1];
        }
      }
      return null;
    }

    function updateDisplay() {
      const existingCounter = document.getElementById('groupme-counter-display');
      if (existingCounter) {
        existingCounter.remove();
      }
      
      if (currentGroupId) {
        const display = document.createElement('div');
        display.id = 'groupme-counter-display';
        display.style.cssText = `
          position: fixed;
          top: 10px;
          right: 10px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 12px 16px;
          border-radius: 8px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 14px;
          font-weight: 600;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          z-index: 10000;
          pointer-events: none;
          border: 2px solid rgba(255,255,255,0.2);
        `;
        display.innerHTML = `
          <div style="font-size: 12px; opacity: 0.9;">Group: ${currentGroupId}</div>
          <div style="font-size: 16px; margin-top: 2px;">📧 ${messageCount} messages</div>
          <div style="font-size: 10px; opacity: 0.7; margin-top: 2px;">Since: ${new Date(lastCountTimestamp).toLocaleTimeString()}</div>
        `;
        document.body.appendChild(display);
      }
    }

    function countMessage() {
      if (currentGroupId) {
        messageCount++;
        updateDisplay();
        console.log(`📧 Message count: ${messageCount} for group ${currentGroupId}`);
      }
    }

    function detectFromCurrentUrl() {
      const groupId = detectGroupId(window.location.href);
      if (groupId) {
        currentGroupId = groupId;
        messageCount = 0;
        lastCountTimestamp = Date.now();
        console.log(`✅ Group ID set to: ${groupId}`);
        updateDisplay();
        return true;
      }
      return false;
    }

    // Intercept fetch
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      const url = args[0];
      
      if (typeof url === 'string' && url.includes('groupme.com')) {
        const groupId = detectGroupId(url);
        if (groupId && groupId !== currentGroupId) {
          currentGroupId = groupId;
          messageCount = 0;
          lastCountTimestamp = Date.now();
          console.log(`✅ Group ID updated to: ${groupId}`);
          updateDisplay();
        }
      }
      
      return originalFetch.apply(this, args).then(response => {
        if (typeof url === 'string' && url.includes('/messages')) {
          response.clone().json().then(data => {
            if (data && data.response && data.response.messages) {
              for (let i = 0; i < data.response.messages.length; i++) {
                countMessage();
              }
            }
          }).catch(() => {});
        }
        return response;
      });
    };

    // Initialize
    if (!detectFromCurrentUrl()) {
      console.log('⚠️ No group ID in current URL');
    }

    // Monitor URL changes
    let lastUrl = window.location.href;
    setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        console.log('🔄 URL changed:', lastUrl);
        detectFromCurrentUrl();
      }
    }, 1000);

    // Global debug functions
    window.debugGroupCounter = function() {
      return {
        groupId: currentGroupId,
        messageCount: messageCount,
        lastCount: new Date(lastCountTimestamp).toLocaleString(),
        url: window.location.href
      };
    };

    window.setGroupId = function(groupId) {
      currentGroupId = groupId;
      messageCount = 0;
      lastCountTimestamp = Date.now();
      updateDisplay();
      return `Group ID set to: ${groupId}`;
    };

    window.resetCounter = function() {
      messageCount = 0;
      lastCountTimestamp = Date.now();
      updateDisplay();
      return 'Counter reset';
    };

    return { updateDisplay, countMessage, detectFromCurrentUrl };
  })();

  /*────────────────── SECTION 4: FONT PICKER ──────────────────*/
  const FontPicker = (() => {    // Font data
    const cats = [
      { title:'Sans‑Serif', fonts:['Sans‑Serif','Poppins','Inter','Roboto','Open Sans','Lato','Source Sans Pro','Work Sans','DM Sans','Nunito','Quicksand','Montserrat','Red Hat Display'] },
      { title:'Monospace',  fonts:['JetBrains Mono','Fira Code','Courier Prime','IBM Plex Mono','Victor Mono','Recursive Mono Casual','Cascadia Code'] },
      { title:'Display / Stylized', fonts:['Bebas Neue','Oswald','Raleway','Playfair Display','Pacifico','Satisfy','Fredoka','Unica One','Righteous'] },
      { title:'Retro / Terminal', fonts:['VT323','Press Start 2P','Share Tech Mono','Major Mono Display','Courier New','Orbitron'] },
      { title:'Chaotic / Handwritten', fonts:['Comic Neue','Papyrus','Impact','Caveat','Indie Flower','Amatic SC','Gloria Hallelujah','Kalam','Shadows Into Light'] },
      { title:'Fantasy / Decorative', fonts:['Uncial Antiqua','Cinzel Decorative','IM Fell English','Cormorant Garamond','Spectral','Crimson Text'] }
    ];const fmap = {
      'Sans‑Serif':'sans-serif',
      'Poppins':`'Poppins',sans-serif`,
      'Inter':`'Inter',sans-serif`,
      'Roboto':`'Roboto',sans-serif`,
      'Open Sans':`'Open Sans',sans-serif`,
      'Lato':`'Lato',sans-serif`,
      'Source Sans Pro':`'Source Sans Pro',sans-serif`,
      'Work Sans':`'Work Sans',sans-serif`,
      'DM Sans':`'DM Sans',sans-serif`,
      'Nunito':`'Nunito',sans-serif`,
      'Quicksand':`'Quicksand',sans-serif`,
      'Montserrat':`'Montserrat',sans-serif`,
      'Red Hat Display':`'Red Hat Display',sans-serif`,
      'JetBrains Mono':`'JetBrains Mono',monospace`,
      'Fira Code':`'Fira Code',monospace`,
      'Courier Prime':`'Courier Prime',monospace`,
      'IBM Plex Mono':`'IBM Plex Mono',monospace`,
      'Victor Mono':`'Victor Mono',monospace`,
      'Recursive Mono Casual':`'Recursive Mono Casual',monospace`,
      'Cascadia Code':`'Cascadia Code',monospace`,
      'Bebas Neue':`'Bebas Neue',cursive`,
      'Oswald':`'Oswald',sans-serif`,
      'Raleway':`'Raleway',sans-serif`,
      'Playfair Display':`'Playfair Display',serif`,
      'Pacifico':`'Pacifico',cursive`,
      'Satisfy':`'Satisfy',cursive`,
      'Fredoka':`'Fredoka',sans-serif`,
      'Unica One':`'Unica One',cursive`,      'Orbitron':`'Orbitron',sans-serif`,
      'Righteous':`'Righteous',cursive`,
      'VT323':`'VT323',monospace`,
      'Press Start 2P':`'Press Start 2P',monospace`,
      'Share Tech Mono':`'Share Tech Mono',monospace`,
      'Major Mono Display':`'Major Mono Display',monospace`,
      'Courier New':'Courier New,monospace',
      'Comic Neue':`'Comic Neue',cursive`,
      'Papyrus':'Papyrus,fantasy',
      'Impact':'Impact,sans-serif',
      'Caveat':`'Caveat',cursive`,
      'Indie Flower':`'Indie Flower',cursive`,
      'Amatic SC':`'Amatic SC',cursive`,
      'Gloria Hallelujah':`'Gloria Hallelujah',cursive`,
      'Kalam':`'Kalam',cursive`,
      'Shadows Into Light':`'Shadows Into Light',cursive`,
      'Uncial Antiqua':`'Uncial Antiqua',cursive`,
      'Cinzel Decorative':`'Cinzel Decorative',cursive`,
      'IM Fell English':`'IM Fell English',serif`,
      'Cormorant Garamond':`'Cormorant Garamond',serif`,
      'Spectral':`'Spectral',serif`,
      'Crimson Text':`'Crimson Text',serif`
    };

    const STAR='★', STAR_O='☆';
    let active = null;
    let previewing = false;    // Load Google Fonts CSS
    const googleList = Object.keys(fmap)
      .filter(f=>!['Sans‑Serif','Papyrus','Impact','Courier New'].includes(f))
      .map(f=>f.replace(/ /g,'+')).join('&family=');

    if (googleList) {
      fetch(`https://fonts.googleapis.com/css2?family=${googleList}&display=swap`)
        .then(r=>r.text())
        .then(css=>{
          const style=document.createElement('style');
          style.textContent=css; document.head.appendChild(style);
        })
        .catch(err=>console.warn('Font CSS fetch failed:',err));
    }function waitForTray(callback) {
      const checkForTray = () => {
        const tray = document.querySelector('.tray-controls');
        if (tray) {
          callback(tray);
          return true;
        }
        return false;
      };

      // Try immediately
      if (checkForTray()) return;

      // If not found, set up observer with proper error handling
      const setupObserver = () => {
        const targetNode = document.body || document.documentElement;
        if (!targetNode) {
          // If neither body nor documentElement exists, wait a bit and try again
          setTimeout(setupObserver, 100);
          return;
        }

        const observer = new MutationObserver((mutations, obs) => {
          if (checkForTray()) {
            obs.disconnect();
          }
        });
        
        try {
          observer.observe(targetNode, {childList: true, subtree: true});
        } catch (error) {
          console.warn('Failed to set up MutationObserver, retrying...', error);
          setTimeout(setupObserver, 100);
        }
      };

      // Wait for DOM to be ready if needed
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupObserver);
      } else {
        setupObserver();
      }
    }    function makeTrayButton(tray) {
      const iconPath=`<path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/>`;
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">${iconPath}</svg>`;
      const b=document.createElement('button'); 
      b.className='tab accessible-focus gm-font-tab'; 
      b.role='tab'; 
      b.title='Fonts';
      b.innerHTML=svg; 
      tray.appendChild(b); 
      return b;
    }function buildPanel() {
      const panel=document.createElement('div');
      panel.id='gm-font-panel';
      panel.style.cssText=`position:fixed;bottom:64px;left:12px;width:380px;max-height:480px;
        overflow-y:auto;background:#fff;border:1px solid #cfcfcf;border-radius:8px;
        box-shadow:0 6px 20px rgba(0,0,0,.18);padding:12px 16px;display:none;
        z-index:999999;color:#222;font:14px/1 sans-serif;`;

      // Top bar
      const bar=document.createElement('div'); 
      bar.style='display:flex;gap:8px;margin-bottom:10px;';
      const search=document.createElement('input');
      search.placeholder='Search fonts…'; 
      search.style='flex:1;padding:6px 8px;border:1px solid #bbb;border-radius:4px;font-size:14px;';
      const reset=document.createElement('button');      reset.innerHTML='🗑'; 
      reset.title='Reset to default font'; 
      reset.style='border:none;background:transparent;font-size:20px;cursor:pointer;padding:4px;border-radius:4px;';
      reset.onmouseenter=()=>reset.style.background='#f0f0f0';
      reset.onmouseleave=()=>reset.style.background='transparent';
      reset.onclick=()=>{
        active=null;
        setStyle(null);
        chrome.storage.local.remove('gmFont');
        buildList(search.value.trim().toLowerCase());
        console.log('🗑 Font reset to default');
      };
      bar.append(search,reset);
      panel.appendChild(bar);

      // List container
      const list=document.createElement('div'); 
      panel.appendChild(list);

      // Favorites & stored font
      let favs=[], active=null;
      chrome.storage.local.get(['gmFav','gmFont'],d=>{
        favs=d.gmFav||[]; 
        active=d.gmFont||null; 
        buildList();
        if(active) applyFont(active);
      });

      // Search filter
      search.oninput=()=>buildList(search.value.trim().toLowerCase());

      // Reset handler
      reset.onclick=()=>{
        chrome.storage.local.remove('gmFont'); 
        active=null; 
        setStyle(null);
      };

      // Builder
      function buildList(filter=''){
        list.textContent='';
        const mkHead=t=>{
          const h=document.createElement('h4');
          h.textContent=t;
          h.style='margin:10px 0 6px;font:700 13px sans-serif;color:#666;';
          return h;
        };        const addRow=name=>{
          if(filter && !name.toLowerCase().includes(filter)) return;
          const row=document.createElement('div'); 
          row.tabIndex=0; 
          row.dataset.font=name;
          const isSelected = active === name;
          row.style=`display:flex;align-items:center;justify-content:space-between;
            font-family:${fmap[name]};padding:8px 10px;margin:2px 0;border-radius:6px;cursor:pointer;
            min-height:32px;max-height:32px;overflow:hidden;
            background:${isSelected ? '#e3f2fd' : 'transparent'};
            border:${isSelected ? '1px solid #2196f3' : '1px solid transparent'};`;          const lab=document.createElement('span'); 
          lab.textContent=name;
          lab.className='font-preview';
          lab.style='overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
          const star=document.createElement('span'); 
          star.textContent=favs.includes(name)?STAR:STAR_O;
          star.style='margin-left:8px;cursor:pointer;color:#e0a800;font-size:16px;flex-shrink:0;'; 
          star.onclick=e=>{
            e.stopPropagation();
            toggleFav(name);
          };
          row.append(lab,star);
          row.onmouseenter=()=>tempApply(name);
          row.onmouseleave=()=>restoreActive();
          row.onclick=()=>{
            applyFont(name); 
            hide(panel,document.querySelector('.gm-font-tab'));
          };
          row.onkeydown=e=>{
            const rows=[...list.querySelectorAll('div[tabindex]')];
            if(e.key==='ArrowDown'){
              e.preventDefault();
              rows[(rows.indexOf(row)+1)%rows.length].focus();
            }
            else if(e.key==='ArrowUp'){
              e.preventDefault();
              rows[(rows.indexOf(row)-1+rows.length)%rows.length].focus();
            }
            else if(e.key==='Enter'){
              row.click();
            }
          };
          list.appendChild(row);
        };
        if(favs.length){
          list.appendChild(mkHead('Favorites'));
          favs.slice(0,3).forEach(addRow);
        }
        cats.forEach(cat=>{
          if(cat.fonts.some(f=>!filter||f.toLowerCase().includes(filter))){
            list.appendChild(mkHead(cat.title));
            cat.fonts.forEach(addRow);
          }
        });
      }      function toggleFav(name){
        if(favs.includes(name)) favs=favs.filter(f=>f!==name);
        else {favs.unshift(name);favs=favs.slice(0,3);}
        chrome.storage.local.set({gmFav:favs}); 
        buildList(search.value.trim().toLowerCase());
      }

      // Add event listener for rebuilding list when selection changes
      panel.addEventListener('rebuildList', (e) => {
        buildList(e.detail || '');
      });

      document.body.appendChild(panel);
      return panel;
    }function applyFont(name){ 
      active=name; 
      previewing=false; 
      setStyle(name); 
      chrome.storage.local.set({gmFont:name});
      // Update the panel if it exists to show new selection
      const panel = document.getElementById('gm-font-panel');
      if (panel) {
        const search = panel.querySelector('input');
        if (search) {
          // Find the buildList function in the panel context and call it
          const event = new CustomEvent('rebuildList', { detail: search.value.trim().toLowerCase() });
          panel.dispatchEvent(event);
        }
      }
    }

    function tempApply(name){ 
      previewing=true; 
      setStyle(name); 
    }

    function restoreActive(){ 
      if(previewing) setStyle(active); 
      previewing=false; 
    }    function setStyle(name){ 
      let s=document.getElementById('gm-font-style'); 
      if(!s){
        s=document.createElement('style');
        s.id='gm-font-style';
        document.head.appendChild(s);
      } 
      
      if (!name) {
        s.textContent = '';
      } else if (name === 'Press Start 2P') {
        // Scale down Press Start 2P slightly for better readability
        s.textContent = `
          body,textarea,input,.chat,.message,.message-text,* {
            font-family:${fmap[name]} !important;
            font-size: 0.971em !important;
          }
        `;
      } else {
        s.textContent = `body,textarea,input,.chat,.message,.message-text,*{font-family:${fmap[name]} !important;}`;
      }
    }

    function hide(p,b){
      p.style.display='none';
      b.classList.remove('active');
    }

    function togglePanel(p,b){
      const open=p.style.display==='none';
      p.style.display=open?'block':'none';
      b.classList.toggle('active',open); 
      if(open) p.querySelector('input').focus();
    }    // Initialize font picker safely
    const initializeFontPicker = () => {
      // Load saved font and favorites immediately
      chrome.storage.local.get(['gmFont', 'gmFav'], (res) => {
        if (res.gmFont && fmap[res.gmFont]) {
          active = res.gmFont;
          setStyle(active);
          console.log('✅ Restored saved font:', active);
        }
        if (res.gmFav) {
          favs = res.gmFav;
        }
      });      waitForTray(tray=>{
        try {
          const btn = makeTrayButton(tray);
          const panel = buildPanel();
            // Add hover effects for the font picker button
          if (!document.getElementById('gm-font-button-styles')) {
            const buttonStyles = document.createElement('style');
            buttonStyles.id = 'gm-font-button-styles';
            buttonStyles.textContent = `
              .gm-font-tab {
                transition: all 0.2s ease;
              }
              .gm-font-tab:hover,
              .gm-font-tab.active {
                filter: drop-shadow(0 0 8px rgba(255, 255, 255, 0.4));
              }
              .gm-font-tab:hover svg,
              .gm-font-tab.active svg {
                filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.3));
              }
              /* Reduce Press Start 2P font size */
              [data-font="Press Start 2P"] .font-preview {
                font-size: 11px !important;
              }
            `;
            document.head.appendChild(buttonStyles);
          }
          
          btn.onclick = ()=>togglePanel(panel,btn);
          document.addEventListener('click',e=>{
            if(!panel.contains(e.target)&&!btn.contains(e.target)) hide(panel,btn);
          });
          document.addEventListener('keydown',e=>{ 
            if(e.key==='Escape') hide(panel,btn);
          });
          
          // Re-apply saved font after panel is built (in case DOM changed)
          if (active) {
            setTimeout(() => setStyle(active), 500);
          }
          
          console.log('✅ Font picker initialized');
        } catch (error) {
          console.error('❌ Error initializing font picker:', error);
        }
      });
    };    // Delay initialization to ensure DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(initializeFontPicker, 1000);
      });
    } else {
      setTimeout(initializeFontPicker, 1000);
    }

    // Periodic font persistence check to prevent random resets
    setInterval(() => {
      if (active) {
        const styleEl = document.getElementById('gm-font-style');
        if (!styleEl || !styleEl.textContent.includes(fmap[active])) {
          console.log('🔄 Font style lost, reapplying:', active);
          setStyle(active);
        }
      }
    }, 5000); // Check every 5 seconds

    return { applyFont, setStyle };
  })();

  /*────────────────── SECTION 5: UI BUTTONS ──────────────────*/
  const BTN_STYLE = {
    position: 'fixed', 
    right: '10px', 
    zIndex: 99999,
    background: '#333', 
    color: '#fff', 
    padding: '8px',
    border: 'none', 
    borderRadius: '4px', 
    cursor: 'pointer',
    fontSize: '13px'
  };

  function makeBtn(label, topPx, handler) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.onclick = handler;
    Object.assign(btn.style, BTN_STYLE, { top: `${topPx}px` });
    document.body.appendChild(btn);
  }

  function addButtons() {
    if (!MessageCache) {
      console.log('Message caching not available - buttons disabled');
      return;
    }

    makeBtn('📦 Check Cache', 150, async () => {
      const total = await MessageCache.DB.count();
      const sample = await MessageCache.DB.firstValidSample();
      console.log('📂 Cached messages:', total, sample ?? '(no valid samples)');
      alert(`Cached messages: ${total}`);
    });

    makeBtn('⬇️ Export CSV', 190, MessageCache.exportCsv);
  }

  // Initialize buttons when DOM is ready
  if (document.body) {
    addButtons();
  } else {
    window.addEventListener('DOMContentLoaded', addButtons);
  }

  console.log('✅ GroupMe Ultimate Extension loaded successfully!');
})();
