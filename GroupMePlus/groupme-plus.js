(() => {
  'use strict';

  /* ========= Tiny helpers ========= */
  const $  = (sel, p = document) => p.querySelector(sel);
  const $$ = (sel, p = document) => [...p.querySelectorAll(sel)];
  const idle = fn => (window.requestIdleCallback || setTimeout)(fn, 1);
  const importCSS = href => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onerror = () => console.error(`[GM+ Font] CSS failed to load: ${href}`);
    document.head.appendChild(l);
  };

  /* ========= IndexedDB cache ========= */
  const Cache = (() => {
    if (!window.LZString) return null;

    const DB_NAME = 'GMPlusCache';
    const VERSION = 3;
    const STORE   = 'messages';
    const EDITS   = 'editHistory';
    let dbP;

    const open = () => dbP ||= new Promise((ok, bad) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('group_id',  'group_id');
          s.createIndex('group_ts', ['group_id', 'created_at']);
        }
        if (!db.objectStoreNames.contains(EDITS)) {
          const e = db.createObjectStore(EDITS, { keyPath: 'edit_id' });
          e.createIndex('msg', 'message_id');
        }
      };
      req.onsuccess = () => ok(req.result);
      req.onerror   = () => bad(req.error);
    });

    const C = s => LZString.compressToUTF16(JSON.stringify(s));
    const D = s => JSON.parse(LZString.decompressFromUTF16(s));

    async function store(batch) {
      if (!batch || typeof batch !== 'object') return;
      const db = await open();
      const tx = db.transaction([STORE, EDITS], 'readwrite');
      const st = tx.objectStore(STORE);
      const eh = tx.objectStore(EDITS);

      for (const m of Object.values(batch)) {
        if (!m.id || String(m.id).includes('.')) continue;
        const existing = await st.get(m.id);
        if (!existing) {
          st.put({ id: m.id, data: C(m) });
        } else {
          const old = D(existing.data);
          if (old.text !== m.text) {
            eh.put({
              edit_id:        `${m.id}_${Date.now()}`,
              message_id:     m.id,
              original_text:  old.text,
              new_text:       m.text,
              edit_timestamp: Date.now()
            });
            st.put({ id: m.id, data: C(m) });
          }
        }
      }
      return tx.done;
    }

    const stats = async () => {
      const db = await open();
      const m  = db.transaction(STORE).objectStore(STORE).count();
      const e  = db.transaction(EDITS).objectStore(EDITS).count();
      return { messages: await m, edits: await e };
    };

    const all = async () => {
      const db = await open();
      const out = [];
      await new Promise(res => {
        const c = db.transaction(STORE).objectStore(STORE).openCursor();
        c.onsuccess = ev => {
          const cur = ev.target.result;
          if (!cur) return res();
          out.push(D(cur.value.data));
          cur.continue();
        };
      });
      return out;
    };

    return { store, stats, all };
  })();
  // Fonts
  const FONT_FAMILIES = [
    'Mona Sans','Roboto','Open Sans','Lato','Montserrat','Oswald','Source Sans Pro','Poppins','Raleway','Inter','Nunito',
    'Merriweather','Playfair Display','Ubuntu','Work Sans','PT Sans','Rubik','Fira Sans','Inconsolata','JetBrains Mono',
    'DM Sans','Mulish','Cabin','Dosis','Bitter','Quicksand','Karla','Manrope','Noto Sans','Noto Serif','Caveat',
    'Anton','Arvo','Josefin Sans','Libre Baskerville','Muli','Mukta','Barlow','Heebo','Hind','Tajawal',
    'Press Start 2P','Teko','Titillium Web','Zilla Slab','Cormorant Garamond','Exo 2','Bebas Neue','Archivo','Varela Round','Questrial'
  ];

  // Available weights for each font
  const FONT_WEIGHTS = {
    'Mona Sans': [200,300,400,500,600,700,800,900],
    'Roboto': [100,200,300,400,500,600,700,800,900],
    'Open Sans': [300,400,500,600,700,800],
    'Lato': [100,300,400,700,900],
    'Montserrat': [100,200,300,400,500,600,700,800,900],
    'Oswald': [200,300,400,500,600,700],
    'Source Sans Pro': [200,300,400,600,700,900],
    'Poppins': [100,200,300,400,500,600,700,800,900],
    'Raleway': [100,200,300,400,500,600,700,800,900],
    'Inter': [100,200,300,400,500,600,700,800,900],
    'Nunito': [200,300,400,500,600,700,800,900],
    'Merriweather': [300,400,700,900],
    'Playfair Display': [400,500,600,700,800,900],
    'Ubuntu': [300,400,500,700],
    'Work Sans': [100,200,300,400,500,600,700,800,900],
    'PT Sans': [400,700],
    'Rubik': [300,400,500,600,700,800,900],
    'Fira Sans': [100,200,300,400,500,600,700,800,900],
    'Inconsolata': [200,300,400,500,600,700,800,900],
    'JetBrains Mono': [100,200,300,400,500,600,700,800],
    'DM Sans': [100,200,300,400,500,600,700,800,900],
    'Mulish': [200,300,400,500,600,700,800,900],
    'Cabin': [400,500,600,700],
    'Dosis': [200,300,400,500,600,700,800],
    'Bitter': [100,200,300,400,500,600,700,800,900],
    'Quicksand': [300,400,500,600,700],
    'Karla': [200,300,400,500,600,700,800],
    'Manrope': [200,300,400,500,600,700,800],
    'Noto Sans': [100,200,300,400,500,600,700,800,900],
    'Noto Serif': [100,200,300,400,500,600,700,800,900],
    'Caveat': [400,500,600,700],
    'Anton': [400],
    'Arvo': [400,700],
    'Josefin Sans': [100,200,300,400,500,600,700],
    'Libre Baskerville': [400,700],
    'Muli': [200,300,400,500,600,700,800,900],
    'Mukta': [200,300,400,500,600,700,800],
    'Barlow': [100,200,300,400,500,600,700,800,900],
    'Heebo': [100,200,300,400,500,600,700,800,900],
    'Hind': [300,400,500,600,700],
    'Tajawal': [200,300,400,500,700,800,900],
    'Press Start 2P': [400],
    'Teko': [300,400,500,600,700],
    'Titillium Web': [200,300,400,600,700,900],
    'Zilla Slab': [300,400,500,600,700],
    'Cormorant Garamond': [300,400,500,600,700],
    'Exo 2': [100,200,300,400,500,600,700,800,900],
    'Bebas Neue': [400],
    'Archivo': [100,200,300,400,500,600,700,800,900],
    'Varela Round': [400],
    'Questrial': [400]
  };  const FONT_MAP = Object.fromEntries(
    FONT_FAMILIES.map(f => {
      if (f === 'Mona Sans') {
        return [f, `"Mona Sans", -system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`];
      }
      return [f, `'${f}',${/Mono|Code/.test(f)?'monospace':'sans-serif'}`];
    })
  );

  // Sidebar icons
  const SVGs = {
    font: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-type-icon lucide-type"><path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/></svg>`,
    save: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-save-icon lucide-save"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>`,
    bars: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-hash-icon lucide-hash"><line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/></svg>`,
    rocket:`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-fast-forward-icon lucide-fast-forward"><polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/></svg>`
  };
  let sidebar, panes = [];

  function injectSidebarStyles() {
    if (document.getElementById('gm-sidebar-styles')) return;
    const css = `
      .gm-sidebar{position:fixed;top:64px;left:72px;width:360px;max-height:80vh;overflow:auto;border-radius:8px;z-index:2147483000}
      .gm-hidden{display:none}
      .gm-pane{padding:12px}
      .gm-btn{margin:6px 4px;padding:8px 12px;border-radius:6px;background:var(--gm-accent-1,#667eea);color:#fff;border:none;cursor:pointer}
      .gm-plus-sep{width:32px;height:1px;background:#3a3a3a;margin:4px auto}
      .gm-plus-btn{background:none;border:none;width:40px;height:40px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer}
      .gm-plus-btn:hover,.gm-plus-btn.active{background:rgba(255,255,255,.08)}
      .gm-plus-btn svg{pointer-events:none}
    `;
    const s = document.createElement('style');
    s.id = 'gm-sidebar-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  const waitForTray = () => new Promise(res=>{
    const existing = $('.tray-controls');
    if (existing) return res(existing);
    const ob = new MutationObserver(() => {
      const el = $('.tray-controls');
      if (el) { ob.disconnect(); res(el); }
    });
    ob.observe(document.documentElement, { childList: true, subtree: true });
  });

  function buildSidebar() {
    sidebar = document.createElement('div');
    sidebar.className = 'gm-sidebar gm-card gm-hidden';
    document.body.appendChild(sidebar);
    return name => {
      const pane = document.createElement('div');
      pane.className = 'gm-pane';
      pane.dataset.pane = name;
      pane.style.display = 'none';
      sidebar.appendChild(pane);
      return pane;
    };
  }

  // Add buttons to the tray
  function ensureSeparator(tray) {
    if ($('.gm-plus-sep', tray)) return;
    const sep = document.createElement('div');
    sep.className = 'gm-plus-sep';
    tray.appendChild(sep);
  }
  function addTrayBtn(tray, svg, title, cb) {
    ensureSeparator(tray);
    const b = document.createElement('button');
    b.className = 'tab accessible-focus gm-plus-btn';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-label', title);
    b.setAttribute('title', title);
    b.innerHTML = svg;
    b.addEventListener('click', cb);
    tray.appendChild(b);
    return b;
  }

  // Panes for the tools
  const Counter = (() => {
    let total = 0, group = null, lbl;
    const handle = payload => {
      const msgs = Object.values(payload || {});
      if (!msgs.length) return;
      const g = msgs[0].group_id || msgs[0].conversation_id;
      if (g && g !== group) { group = g; total = 0; }
      total += msgs.length;
      if (lbl) lbl.textContent = `${total} msgs`;
    };
    const init = pane => {
      lbl = document.createElement('div');
      lbl.style.font = '600 32px/1 monospace';
      lbl.textContent = '—';
      pane.appendChild(lbl);
    };
    return { handle, init };
  })();

  function buildFontPane(pane) {
    const familySel = document.createElement('select');
    familySel.style.width = '100%';
    FONT_FAMILIES.forEach(f => {
      const o = document.createElement('option'); o.value = f; o.textContent = f; familySel.appendChild(o);
    });

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:8px;margin-top:8px';

    const weightSel = document.createElement('select');
    
    // Function to update weight options based on selected font
    const updateWeightOptions = (fontFamily) => {
      const availableWeights = FONT_WEIGHTS[fontFamily] || [400];
      const currentWeight = weightSel.value;
      
      // Clear existing options
      weightSel.innerHTML = '';
      
      // Add available weights
      availableWeights.forEach(w => {
        const o = document.createElement('option');
        o.value = o.textContent = w;
        weightSel.appendChild(o);
      });
      
      // Try to maintain current weight if it's available, otherwise use first available
      if (availableWeights.includes(parseInt(currentWeight))) {
        weightSel.value = currentWeight;
      } else {
        weightSel.value = availableWeights.includes(400) ? 400 : availableWeights[0];
      }
    };

    const colorIn = document.createElement('input');
    colorIn.type = 'color'; colorIn.value = '#f3f4f6';

    controls.append(weightSel, colorIn);
    pane.append(familySel, controls);

    const preview = document.createElement('p');
    preview.textContent = 'Aa Quick Brown Fox';
    preview.style.marginTop = '12px';    pane.appendChild(preview);

    /* Reset button */
    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset to Defaults';
    resetBtn.className = 'gm-btn';
    resetBtn.style.cssText = 'width:100%;margin-top:8px;background:#666;';
    pane.appendChild(resetBtn);    const KEY = 'GMPlusFont';
    const defaults = { family: 'Mona Sans', weight: 400, color: '#f3f4f6' };
    
    // Initialize weight options for default font
    updateWeightOptions(defaults.family);
    
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (saved.family) {
      familySel.value = saved.family;
      updateWeightOptions(saved.family);
      weightSel.value = saved.weight;
      colorIn.value = saved.color;
    } else {
      familySel.value = defaults.family;
      weightSel.value = defaults.weight;
      colorIn.value = defaults.color;
    }

    // Update weights when font family changes
    familySel.addEventListener('change', () => {
      updateWeightOptions(familySel.value);
      apply();
    });    const apply = () => {
      const fam = familySel.value;
      const weight = weightSel.value;
      const color = colorIn.value;

      preview.style.cssText = `font-family:${FONT_MAP[fam]};font-weight:${weight};color:${color}`;

      const isDefault = (fam === defaults.family && 
                        parseInt(weightSel.value) === defaults.weight && 
                        colorIn.value === defaults.color);

      if (isDefault) {
        const st = $('#gm-font-style');
        if (st) st.remove();
        console.log('[GM+ Font] Using default settings - preserving GroupMe\'s natural font hierarchy');
      } else {
        const fontName = fam.replace(/ /g, '+');
        const fontUrl = `https://fonts.googleapis.com/css2?family=${fontName}:wght@${weight}&display=swap`;
        console.log(`[GM+ Font] Loading font: "${fam}" weight ${weight} from URL: ${fontUrl}`);
        
        importCSS(fontUrl);        
        setTimeout(() => {
          const testElement = document.createElement('div');
          testElement.style.cssText = `position:absolute;visibility:hidden;font-family:${FONT_MAP[fam]};font-size:72px;font-weight:${weight};`;
          testElement.textContent = 'Test';
          document.body.appendChild(testElement);
          
          const fallbackElement = document.createElement('div');
          fallbackElement.style.cssText = `position:absolute;visibility:hidden;font-family:serif;font-size:72px;font-weight:${weight};`;
          fallbackElement.textContent = 'Test';
          document.body.appendChild(fallbackElement);
          
          const fontLoaded = testElement.offsetWidth !== fallbackElement.offsetWidth;
          console.log(`[GM+ Font] Font "${fam}" weight ${weight} loaded successfully: ${fontLoaded}`);
          
          document.body.removeChild(testElement);
          document.body.removeChild(fallbackElement);

          if (!fontLoaded) {
            console.warn(`[GM+ Font] Font "${fam}" weight ${weight} failed to load, falling back to system font`);
          }
        }, 1000);

        /* Apply global custom style - only font family, weight, and color */
        let st = $('#gm-font-style');
        if (!st) { st = document.createElement('style'); st.id = 'gm-font-style'; document.head.appendChild(st); }
        st.textContent =
          `body,*{font-family:${FONT_MAP[fam]} !important;font-weight:${weight} !important;color:${color} !important}`;
      }

      localStorage.setItem(KEY, JSON.stringify({ family:fam, weight:weightSel.value, color }));
    };

    const reset = () => {
      familySel.value = defaults.family;
      updateWeightOptions(defaults.family);
      weightSel.value = defaults.weight;
      colorIn.value = defaults.color;
      
      /* Remove custom font style */
      const st = $('#gm-font-style');
      if (st) st.remove();
      
      /* Clear localStorage */
      localStorage.removeItem(KEY);
      
      console.log('[GM+ Font] Reset to defaults');
      apply();
    };

    [weightSel, colorIn].forEach(el => el.addEventListener('input', apply));
    resetBtn.addEventListener('click', reset);
    apply();
  }

  function buildCachePane(pane) {
    const statsBtn  = document.createElement('button'); statsBtn.textContent = 'Show stats';
    const exportBtn = document.createElement('button'); exportBtn.textContent = 'Export CSV';
    [statsBtn, exportBtn].forEach(b => b.className = 'gm-btn');
    pane.append(statsBtn, exportBtn);

    statsBtn.onclick = async () => {
      const s = await Cache.stats();
      alert(`Messages cached: ${s.messages.toLocaleString()}\nEdits tracked: ${s.edits.toLocaleString()}`);
    };
    exportBtn.onclick = async () => {
      const msgs = await Cache.all();
      if (!msgs.length) return alert('Cache empty.');
      const csv = [
        'Name,Message,Timestamp',
        ...msgs.map(m => [
          `"${(m.name || '').replace(/"/g,'""')}"`,
          `"${(m.text || '').replace(/"/g,'""')}"`,
          new Date((m.created_at || 0) * 1000).toISOString()
        ].join(','))
      ].join('\r\n');
      const blob = new Blob([csv], { type:'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `groupme_export_${Date.now()}.csv`;
      a.click();
    };
  }

  function buildJumpPane(pane) {
    (async () => {
      try {
        const dbs = await indexedDB.databases();
        const gm  = dbs.find(d => d.name && d.name.startsWith('GroupMe'));
        if (!gm) { pane.textContent = 'No GroupMe IndexedDB found.'; return; }

        const db = await new Promise(ok => {
          const r = indexedDB.open(gm.name, gm.version);
          r.onsuccess = () => ok(r.result);
        });

        const wrap = document.createElement('div'); pane.appendChild(wrap);
        const render = (store, label) => {
          if (!db.objectStoreNames.contains(store)) return;
          const st = db.transaction(store).objectStore(store);
          st.getAll().onsuccess = ev => {
            const h = document.createElement('h4'); h.textContent = label; wrap.appendChild(h);
            ev.target.result.forEach(rec => {
              const b = document.createElement('button');
              b.textContent = rec.name || rec.other_user?.name || rec.id;
              b.title       = rec.id;
              b.className   = 'gm-btn';
              b.style.width = '100%';
              b.onclick = () => location.href =
                store === 'Groups'
                  ? `https://web.groupme.com/groups/${rec.id}`
                  : `https://web.groupme.com/chats/${rec.id}`;
              wrap.appendChild(b);
            });
          };
        };
        render('Groups', 'Groups');
        render('DMs',    'Direct Messages');
      } catch (e) {
        pane.textContent = 'Quick‑jump failed: ' + e.message;
      }
    })();
  }
  /* ========= Build UI once tray ready ========= */
  (async () => {
    const tray  = await waitForTray();
    injectSidebarStyles();
    const paneFactory = buildSidebar();

    /* create panes (order matters for index) */
    const fontPane   = paneFactory('fonts');   buildFontPane(fontPane);
    const cachePane  = paneFactory('cache');   buildCachePane(cachePane);
    const countPane  = paneFactory('counter'); Counter.init(countPane);
    const jumpPane   = paneFactory('jump');    buildJumpPane(jumpPane);

    /* tray buttons */
    panes.push({ btn: addTrayBtn(tray, SVGs.font,  'Fonts',        () => open(0)), pane: fontPane  });
    panes.push({ btn: addTrayBtn(tray, SVGs.save,  'Cache',        () => open(1)), pane: cachePane });
    panes.push({ btn: addTrayBtn(tray, SVGs.bars,  'Msg Counter',  () => open(2)), pane: countPane });
    panes.push({ btn: addTrayBtn(tray, SVGs.rocket,'Quick Jump',   () => open(3)), pane: jumpPane  });

    /* click‑outside to close */
    document.addEventListener('click', e => {
      if (sidebar && !sidebar.contains(e.target) && !e.target.classList.contains('gm-plus-btn')) {
        sidebar.classList.add('gm-hidden');
        panes.forEach(p => p.btn.classList.remove('active'));
      }
    });

  })();

  /* ========= open / close helpers ========= */
  function open(idx) {
    panes.forEach((p, i) => {
      p.btn.classList.toggle('active', i === idx);
      p.pane.style.display = i === idx ? 'block' : 'none';
    });
    sidebar.classList.remove('gm-hidden');
  }

  /* ========= message bus ========= */
  window.addEventListener('message', ev => {
    if (ev.source !== window) return;
    if (ev.data?.type === 'GM_MESSAGES') {
      idle(() => Cache?.store?.(ev.data.payload));
      Counter.handle(ev.data.payload);
    }  });

})();
