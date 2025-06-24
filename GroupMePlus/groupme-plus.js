(() => {
  'use strict';

  // Helpers
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

  // IndexedDB Cache
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

  const FONT_FAMILIES = [
    'Anton','Archivo','Arvo','Barlow','Bebas Neue','Bitter','Cabin','Caveat','Comic Neue','Cormorant Garamond','Creepster',
    'DM Sans','Dosis','Exo 2','Fira Sans','Heebo','Hind','Inconsolata','Inter','JetBrains Mono','Josefin Sans','Karla',
    'Lato','Libre Baskerville','Lobster','Manrope','Merriweather','Mona Sans','Montserrat','Muli','Mulish','Mukta','Noto Sans',
    'Noto Serif','Nunito','Open Sans','Orbitron','Oswald','PT Sans','Playfair Display','Poppins','Press Start 2P','Questrial','Quicksand',
    'Raleway','Roboto','Rubik','Source Sans Pro','Tajawal','Teko','Titillium Web','Ubuntu','Varela Round','Work Sans','Zilla Slab'
  ];

  // Available weights for each font
  const FONT_WEIGHTS = {
    'Mona Sans': [200,300,400,500,600,700,800,900],
    'Roboto': [100,200,300,400,500,600,700,800,900],
    'Open Sans': [300,400,500,600,700,800],
    'Lato': [100,300,400,700,900],
    'Montserrat': [100,200,300,400,500,600,700,800,900],
    'Oswald': [200,300,400,500,600,700],
    'Orbitron': [400,500,600,700,800,900],
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
    'Comic Neue': [300,400,700],
    'Creepster': [400],
    'Anton': [400],
    'Arvo': [400,700],
    'Josefin Sans': [100,200,300,400,500,600,700],
    'Libre Baskerville': [400,700],
    'Lobster': [400],
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
  };
  const FONT_MAP = Object.fromEntries(
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
      .gm-sidebar{position:fixed;width:360px;max-height:80vh;overflow:auto;border-radius:8px;z-index:2147483000}
      .gm-hidden{display:none}
      .gm-pane{padding:12px}
      .gm-btn{margin:6px 4px;padding:8px 12px;border-radius:6px;background:var(--gm-accent-1,#667eea);color:#fff;border:none;cursor:pointer}
      .gm-plus-sep{width:32px;height:1px;background:#3a3a3a;margin:4px auto}
      .gm-plus-btn{background:none;border:none;width:40px;height:40px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer}
      .gm-plus-btn:hover,.gm-plus-btn.active{background:rgba(255,255,255,.08)}
      .gm-plus-btn svg{pointer-events:none}
      .gm-font-select{background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;padding:6px;font-size:14px}
      .gm-font-select option{background:#2a2a2a;color:#fff}
      .gm-color-input{width:100%;height:36px;border:1px solid #444;border-radius:4px;background:none;cursor:pointer}
      .gm-search-input{width:100%;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;padding:8px;font-size:14px;margin-bottom:8px}
      .gm-search-input::placeholder{color:#888}
      .gm-font-dropdown{position:relative;width:100%}
      .gm-dropdown-list{position:fixed;background:#2a2a2a;border:1px solid #444;border-radius:4px;max-height:300px;overflow-y:auto;z-index:2147483001;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.3)}
      .gm-dropdown-item{padding:8px 12px;cursor:pointer;color:#fff;font-size:14px;border-bottom:1px solid #333}
      .gm-dropdown-item:last-child{border-bottom:none}
      .gm-dropdown-item:hover,.gm-dropdown-item.highlighted{background:#444}
      .gm-dropdown-item.selected{background:#667eea;color:#fff}
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
    const dropdownContainer = document.createElement('div');
    dropdownContainer.className = 'gm-font-dropdown';
    
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search and select a font...';
    searchInput.className = 'gm-search-input';
    
    const dropdownList = document.createElement('div');
    dropdownList.className = 'gm-dropdown-list';
    
    dropdownContainer.appendChild(searchInput);
    dropdownContainer.appendChild(dropdownList);
    pane.appendChild(dropdownContainer);

    let selectedFont = 'Mona Sans';
    let highlightedIndex = -1;
    let filteredFonts = [...FONT_FAMILIES];
    
    const populateDropdown = (filter = '') => {
      filteredFonts = FONT_FAMILIES.filter(f => 
        f.toLowerCase().includes(filter.toLowerCase())
      );
      
      dropdownList.innerHTML = '';
      filteredFonts.forEach((font, index) => {
        const item = document.createElement('div');
        item.className = 'gm-dropdown-item';
        item.textContent = font;
        
        if (font === selectedFont) {
          item.classList.add('selected');
        }
        
        item.addEventListener('click', () => {
          selectedFont = font;
          searchInput.value = font;
          hideDropdown();
          updateWeightOptions(font);
          apply();
        });
        
        dropdownList.appendChild(item);
      });
      
      highlightedIndex = -1;
    };
    
    const showDropdown = () => {
      populateDropdown(searchInput.value);
      
      const inputRect = searchInput.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const dropdownMaxHeight = 300;
      
      const spaceBelow = viewportHeight - inputRect.bottom - 8;
      const spaceAbove = inputRect.top - 8;
      
      if (spaceBelow >= Math.min(dropdownMaxHeight, 150) || spaceBelow >= spaceAbove) {
        dropdownList.style.top = `${inputRect.bottom + 4}px`;
        dropdownList.style.maxHeight = `${Math.min(dropdownMaxHeight, spaceBelow)}px`;
      } else {
        dropdownList.style.top = `${Math.max(8, inputRect.top - Math.min(dropdownMaxHeight, spaceAbove))}px`;
        dropdownList.style.maxHeight = `${Math.min(dropdownMaxHeight, spaceAbove)}px`;
      }
      
      dropdownList.style.left = `${inputRect.left}px`;
      dropdownList.style.width = `${inputRect.width}px`;
      dropdownList.style.display = 'block';
    };
    
    const hideDropdown = () => {
      dropdownList.style.display = 'none';
      highlightedIndex = -1;
    };
    
    const updateHighlight = () => {
      const items = dropdownList.querySelectorAll('.gm-dropdown-item');
      items.forEach((item, index) => {
        item.classList.toggle('highlighted', index === highlightedIndex);
      });
      
      if (highlightedIndex >= 0 && items[highlightedIndex]) {
        items[highlightedIndex].scrollIntoView({ block: 'nearest' });
      }
    };
    
    searchInput.addEventListener('focus', showDropdown);
    
    searchInput.addEventListener('input', () => {
      populateDropdown(searchInput.value);
      showDropdown();
    });
    
    searchInput.addEventListener('keydown', (e) => {
      const items = dropdownList.querySelectorAll('.gm-dropdown-item');
      
      switch(e.key) {
        case 'ArrowDown':
          e.preventDefault();
          highlightedIndex = Math.min(highlightedIndex + 1, items.length - 1);
          updateHighlight();
          break;
        case 'ArrowUp':
          e.preventDefault();
          highlightedIndex = Math.max(highlightedIndex - 1, -1);
          updateHighlight();
          break;
        case 'Enter':
          e.preventDefault();
          if (highlightedIndex >= 0 && items[highlightedIndex]) {
            const font = filteredFonts[highlightedIndex];
            selectedFont = font;
            searchInput.value = font;
            hideDropdown();
            updateWeightOptions(font);
            apply();
          } else if (filteredFonts.length > 0) {
            selectedFont = filteredFonts[0];
            searchInput.value = filteredFonts[0];
            hideDropdown();
            updateWeightOptions(filteredFonts[0]);
            apply();
          }
          break;
        case 'Escape':
          hideDropdown();
          searchInput.blur();
          break;
      }
    });
    
    // Hide dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!dropdownContainer.contains(e.target)) {
        hideDropdown();
      }
    });

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:8px;margin-top:8px';

    const weightSel = document.createElement('select');
    weightSel.className = 'gm-font-select';
    
    const updateWeightOptions = (fontFamily) => {
      const availableWeights = FONT_WEIGHTS[fontFamily] || [400];
      const currentWeight = weightSel.value;
      
      weightSel.innerHTML = '';
      
      availableWeights.forEach(w => {
        const o = document.createElement('option');
        o.value = o.textContent = w;
        weightSel.appendChild(o);
      });
      
      // Use current weight if available, otherwise default to 400 or first available weight
      if (availableWeights.includes(parseInt(currentWeight))) {
        weightSel.value = currentWeight;
      } else {
        weightSel.value = availableWeights.includes(400) ? 400 : availableWeights[0];
      }
    };

    const colorIn = document.createElement('input');
    colorIn.type = 'color'; 
    colorIn.value = '#f3f4f6';
    colorIn.className = 'gm-color-input';

    controls.append(weightSel, colorIn);
    pane.append(controls);

    const preview = document.createElement('p');
    preview.textContent = 'Aa';
    preview.style.cssText = 'margin-top:20px;font-size:18px;';
    pane.appendChild(preview);

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset to Defaults';
    resetBtn.className = 'gm-btn';
    resetBtn.style.cssText = 'width:100%;margin-top:16px;background:#666;';
    pane.appendChild(resetBtn);
    
    const KEY = 'GMPlusFont';
    const defaults = { family: 'Mona Sans', weight: 400, color: '#f3f4f6' };
    
    // Initialize weight options for default font
    updateWeightOptions(defaults.family);
    
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (saved.family) {
      selectedFont = saved.family;
      searchInput.value = saved.family;
      updateWeightOptions(saved.family);
      weightSel.value = saved.weight;
      colorIn.value = saved.color;
    } else {
      selectedFont = defaults.family;
      searchInput.value = defaults.family;
      updateWeightOptions(defaults.family);
      weightSel.value = defaults.weight;
      colorIn.value = defaults.color;
    }

    // Update font weights when selection changes (handled by dropdown click events)
    
    const apply = () => {
      const fam = selectedFont;
      const weight = weightSel.value;
      const color = colorIn.value;

      preview.style.cssText = `margin-top:20px;font-size:18px;font-family:${FONT_MAP[fam]};font-weight:${weight};color:${color}`;

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

        let st = $('#gm-font-style');
        if (!st) { st = document.createElement('style'); st.id = 'gm-font-style'; document.head.appendChild(st); }
        st.textContent =
          `body,*{font-family:${FONT_MAP[fam]} !important;font-weight:${weight} !important;color:${color} !important}`;
      }

      localStorage.setItem(KEY, JSON.stringify({ family:fam, weight:weightSel.value, color }));
    };

    const reset = () => {
      selectedFont = defaults.family;
      searchInput.value = defaults.family;
      updateWeightOptions(defaults.family);
      weightSel.value = defaults.weight;
      colorIn.value = defaults.color;
      
      const st = $('#gm-font-style');
      if (st) st.remove();
      
      // Clear localstorage
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
  
  // Create UI
  (async () => {
    const tray  = await waitForTray();
    injectSidebarStyles();
    const paneFactory = buildSidebar();

    const fontPane   = paneFactory('fonts');   buildFontPane(fontPane);
    const cachePane  = paneFactory('cache');   buildCachePane(cachePane);
    const countPane  = paneFactory('counter'); Counter.init(countPane);
    const jumpPane   = paneFactory('jump');    buildJumpPane(jumpPane);

    panes.push({ btn: addTrayBtn(tray, SVGs.font,  'Fonts',        () => open(0)), pane: fontPane  });
    panes.push({ btn: addTrayBtn(tray, SVGs.save,  'Cache',        () => open(1)), pane: cachePane });
    panes.push({ btn: addTrayBtn(tray, SVGs.bars,  'Msg Counter',  () => open(2)), pane: countPane });
    panes.push({ btn: addTrayBtn(tray, SVGs.rocket,'Quick Jump',   () => open(3)), pane: jumpPane  });

    document.addEventListener('click', e => {
      if (sidebar && !sidebar.contains(e.target) && !e.target.classList.contains('gm-plus-btn')) {
        sidebar.classList.add('gm-hidden');
        panes.forEach(p => p.btn.classList.remove('active'));
      }
    });

  })();

  // open/close helpers
  function open(idx) {
    const activeBtn = panes[idx].btn;
    const btnRect = activeBtn.getBoundingClientRect();
    
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    panes.forEach((p, i) => {
      p.btn.classList.toggle('active', i === idx);
      p.pane.style.display = i === idx ? 'block' : 'none';
    });
    sidebar.classList.remove('gm-hidden');
    
    requestAnimationFrame(() => {
      const sidebarRect = sidebar.getBoundingClientRect();
      const sidebarWidth = sidebarRect.width;
      const sidebarHeight = sidebarRect.height;
      
      const gap = 8;
      let left = btnRect.right + gap;
      
      if (left + sidebarWidth > viewportWidth) {
        left = btnRect.left - sidebarWidth - gap;
        
        if (left < 0) {
          left = gap;
        }
      }
      
      let top = btnRect.top;
      
      if (top + sidebarHeight > viewportHeight) {
        top = viewportHeight - sidebarHeight - gap;
        
        if (top < gap) {
          top = gap;
        }
      }
      
      sidebar.style.left = `${left}px`;
      sidebar.style.top = `${top}px`;
    });
  }

  // Message bus
  window.addEventListener('message', ev => {
    if (ev.source !== window) return;
    if (ev.data?.type === 'GM_MESSAGES') {
      idle(() => Cache?.store?.(ev.data.payload));
      Counter.handle(ev.data.payload);
    }  });

})();
