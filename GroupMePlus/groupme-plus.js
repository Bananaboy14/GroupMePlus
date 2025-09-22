(() => {
  'use strict';
  

  
  const injectPageScript = () => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page-inject.js');
    script.onload = () => {
      console.log('[GM+ Page Script] Successfully injected page-inject.js');
      script.remove();
    };
    script.onerror = (error) => {
      console.error('[GM+ Page Script] Failed to inject page-inject.js:', error);
    };
    (document.head || document.documentElement).appendChild(script);
  };

  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      injectPageScript();
      injectSidebarScript();
    });
  } else {
    injectPageScript();
    injectSidebarScript();
  }

  
  function injectSidebarScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('diagnostics.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  
  const $  = (sel, p = document) => p.querySelector(sel);
  const $$ = (sel, p = document) => [...p.querySelectorAll(sel)];
  const idle = fn => {
    if (window.requestIdleCallback) {
      window.requestIdleCallback(fn);
    } else {
      setTimeout(fn, 1);
    }
  };
  const importCSS = href => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.appendChild(l);
  };

  
  const Cache = (() => {
    if (!window.LZString) {
      console.warn('[GM+ Cache] LZString not available, cache disabled');
      return null;
    }

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
          const eStore = db.createObjectStore(EDITS, { keyPath: 'edit_id' });
          eStore.createIndex('msg', 'message_id');
        }
      };
      req.onsuccess = () => ok(req.result);
      req.onerror   = () => bad(req.error);
    });

    const C = s => LZString.compressToUTF16(JSON.stringify(s));
    const D = s => JSON.parse(LZString.decompressFromUTF16(s));

    const validateMessage = (msg) => {
      if (!msg || typeof msg !== 'object') return false;
      if (!msg.id || typeof msg.id !== 'string') return false;
      if (String(msg.id).includes('.')) return false;
      if (!msg.created_at && !msg.text && !msg.attachments?.length) return false;
      return true;
    };

    async function store(batch) {
      if (!batch || typeof batch !== 'object') return;
      const messages = Object.values(batch).filter(validateMessage);
      if (!messages.length) return;
      try {
        const db = await open();
        const tx = db.transaction([STORE, EDITS], 'readwrite');
        const st = tx.objectStore(STORE);
        const eh = tx.objectStore(EDITS);
        const existing = new Map();
        await Promise.all(messages.map(m => new Promise((res, rej) => {
          const r = st.get(m.id);
          r.onsuccess = () => { if (r.result) existing.set(m.id, r.result); res(); };
          r.onerror = () => rej(r.error);
        })));
        let newCount = 0, editCount = 0;
        for (const m of messages) {
          const prev = existing.get(m.id);
            if (!prev) {
              await new Promise((res, rej) => {
                const r = st.put({ id: m.id, group_id: m.group_id, created_at: m.created_at, data: C(m), stored_at: Date.now() });
                r.onsuccess = res; r.onerror = () => rej(r.error);
              });
              newCount++;
            } else {
              const old = D(prev.data);
              if (old.text !== m.text && old.text && m.text && old.text.trim() !== m.text.trim()) {
                await new Promise((res, rej) => {
                  const r = eh.put({ edit_id: `${m.id}_${Date.now()}_${Math.random().toString(36).slice(2)}`, message_id: m.id, original_text: old.text, new_text: m.text, edit_timestamp: Date.now(), original_updated_at: old.updated_at, new_updated_at: m.updated_at });
                  r.onsuccess = res; r.onerror = () => rej(r.error);
                });
                await new Promise((res, rej) => {
                  const r = st.put({ id: m.id, group_id: m.group_id, created_at: m.created_at, data: C(m), updated_at: Date.now() });
                  r.onsuccess = res; r.onerror = () => rej(r.error);
                });
                editCount++;
              }
            }
        }
        return { stored: newCount, edited: editCount };
      } catch (e) {
        console.error('[GM+ Cache] Store error:', e);
      }
    }

    const stats = async () => {
      try {
        const db = await open();
        const messageCount = await new Promise((res, rej) => { const r = db.transaction(STORE).objectStore(STORE).count(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const editCount = await new Promise((res, rej) => { const r = db.transaction(EDITS).objectStore(EDITS).count(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        return { messages: messageCount, edits: editCount };
      } catch (e) { return { messages: 0, edits: 0 }; }
    };

    const all = async () => {
      try {
        const db = await open();
        const out = [];
        return await new Promise((res, rej) => {
          const curReq = db.transaction(STORE).objectStore(STORE).openCursor();
          curReq.onsuccess = ev => {
            const c = ev.target.result; if (!c) return res(out);
            try { out.push(D(c.value.data)); } catch { }
            c.continue();
          };
          curReq.onerror = () => rej(curReq.error);
        });
      } catch { return []; }
    };

    const getByGroup = async (groupId) => {
      if (!groupId) return [];
      try {
        const db = await open();
        const idx = db.transaction(STORE).objectStore(STORE).index('group_id');
        const out = [];
        return await new Promise((res, rej) => {
          const req = idx.openCursor(IDBKeyRange.only(groupId));
            req.onsuccess = ev => { const cur = ev.target.result; if (!cur) { out.sort((a,b)=> b.created_at - a.created_at); return res(out);} try { out.push(D(cur.value.data)); } catch {} cur.continue(); };
            req.onerror = () => rej(req.error);
        });
      } catch (e) { console.warn('[GM+ Cache] getByGroup error', e); return []; }
    };

    const getEditHistory = async (messageId) => {
      if (!messageId) return [];
      try {
        const db = await open();
        const idx = db.transaction(EDITS).objectStore(EDITS).index('msg');
        const out = [];
        return await new Promise((res, rej) => {
          const req = idx.openCursor(IDBKeyRange.only(messageId));
          req.onsuccess = ev => { const cur = ev.target.result; if (!cur) return res(out); out.push(cur.value); cur.continue(); };
          req.onerror = () => rej(req.error);
        });
      } catch (e) { console.warn('[GM+ Cache] getEditHistory error', e); return []; }
    };

    const validate = async () => {
      const result = { valid: 0, invalid: 0, issues: [], totalSize: 0 };
      try {
        const db = await open();
        const store = db.transaction(STORE).objectStore(STORE);
        await new Promise((res, rej) => {
          const req = store.openCursor();
          req.onsuccess = ev => {
            const cur = ev.target.result; if (!cur) return res();
            const rec = cur.value; const raw = rec.data; result.totalSize += (raw?.length || 0) * 2; // estimate for UTF-16
            try {
              const msg = D(raw);
              if (validateMessage(msg)) result.valid++; else { result.invalid++; result.issues.push(`Invalid structure for id ${rec.id}`); }
            } catch (e) { result.invalid++; result.issues.push(`Decompression error for id ${rec.id}: ${e.message}`); }
            cur.continue();
          };
          req.onerror = () => rej(req.error);
        });
      } catch (e) {
        result.issues.push('Validation failed: ' + e.message);
      }
      return result;
    };

    const cleanup = async ({ olderThanDays = 30, dryRun = true } = {}) => {
      const secondsCutoff = Date.now()/1000 - olderThanDays * 86400;
      let deleted = 0; const sample = [];
      try {
        const db = await open();
        const store = db.transaction(STORE, dryRun ? 'readonly' : 'readwrite').objectStore(STORE);
        await new Promise((res, rej) => {
          const req = store.openCursor();
          req.onsuccess = ev => {
            const cur = ev.target.result; if (!cur) return res();
            try {
              const msg = D(cur.value.data);
              if (msg.created_at && msg.created_at < secondsCutoff) {
                deleted++; if (sample.length < 5) sample.push(msg.id);
                if (!dryRun) cur.delete();
              }
            } catch {}
            cur.continue();
          };
          req.onerror = () => rej(req.error);
        });
      } catch (e) {
        return { deleted: 0, error: e.message, sample: [] };
      }
      return { deleted, dryRun, sample };
    };

  const search = async (query, options = {}) => {
      try {
        const db = await open();
        const results = [];
        const { limit = 100, groupId = null, userId = null, dateFrom = null, dateTo = null, hasAttachments = null, caseSensitive = false, fullWord = false } = options;
        return await new Promise((resolve, reject) => {
          const store = db.transaction(STORE).objectStore(STORE);
          const cursor = groupId ? store.index('group_id').openCursor(IDBKeyRange.only(groupId)) : store.openCursor();
          cursor.onsuccess = ev => {
            const cur = ev.target.result;
            if (!cur || results.length >= limit) return resolve(results);
            try {
              const msg = D(cur.value.data);
              let match = true;
              if (query && query.trim()) {
                const term = caseSensitive ? query : query.toLowerCase();
                const text = caseSensitive ? (msg.text || '') : (msg.text || '').toLowerCase();
                const name = caseSensitive ? (msg.name || '') : (msg.name || '').toLowerCase();
                if (fullWord) {
                  const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`, caseSensitive ? 'g' : 'gi');
                  match = regex.test(text) || regex.test(name);
                } else {
                  match = text.includes(term) || name.includes(term);
                }
              }
              if (userId && match) match = (msg.user_id === userId || msg.sender_id === userId);
              if (dateFrom && match) match = msg.created_at >= dateFrom;
              if (dateTo && match) match = msg.created_at <= dateTo;
              if (hasAttachments !== null && match) match = hasAttachments ? (msg.attachments && msg.attachments.length > 0) : (!msg.attachments || !msg.attachments.length);
              if (match) results.push(msg);
            } catch {}
            cur.continue();
          };
          cursor.onerror = () => reject(cursor.error);
        });
      } catch { return []; }
    };

  return { store, stats, all, getByGroup, getEditHistory, validate, cleanup, search, open };
  })();

  console.log('[GM+ Cache] Cache system initialized:', Cache ? 'enabled' : 'disabled');
  // Runtime safety: if an older build returned a Cache object without newer helpers, polyfill them.
  if (Cache) {
    const polyfillValidate = async () => {
      try {
        const db = await Cache.open();
        const store = db.transaction('messages').objectStore('messages');
        let valid = 0, invalid = 0, totalSize = 0; const issues = [];
        await new Promise((res, rej) => {
          const cur = store.openCursor();
          cur.onsuccess = e => { const c = e.target.result; if (!c) return res(); try { totalSize += (c.value.data?.length||0)*2; JSON.parse(LZString.decompressFromUTF16(c.value.data)); valid++; } catch (err) { invalid++; issues.push('Bad record '+c.key); } c.continue(); };
          cur.onerror = () => rej(cur.error);
        });
        return { valid, invalid, totalSize, issues };
      } catch (e) { return { valid:0, invalid:0, totalSize:0, issues:['Validate failed '+e.message] }; }
    };
    if (typeof Cache.validate !== 'function') Cache.validate = polyfillValidate;
    if (typeof Cache.cleanup !== 'function') Cache.cleanup = async ({ olderThanDays = 30, dryRun = true } = {}) => {
      try { const cutoff = Date.now()/1000 - olderThanDays*86400; const db = await Cache.open(); const store = db.transaction('messages', dryRun?'readonly':'readwrite').objectStore('messages'); let deleted=0; await new Promise((res,rej)=>{ const cur=store.openCursor(); cur.onsuccess = e=>{ const c=e.target.result; if(!c) return res(); try { const msg = JSON.parse(LZString.decompressFromUTF16(c.value.data)); if (msg.created_at && msg.created_at < cutoff) { if(!dryRun) c.delete(); deleted++; } } catch {} c.continue(); }; cur.onerror=()=>rej(cur.error); }); return { deleted, dryRun }; } catch(e){ return { deleted:0, dryRun, error:e.message }; } };
    if (typeof Cache.getByGroup !== 'function') Cache.getByGroup = async (groupId) => { const all = await Cache.all(); return all.filter(m=>m.group_id===groupId).sort((a,b)=>b.created_at-a.created_at); };
    if (typeof Cache.getEditHistory !== 'function') Cache.getEditHistory = async () => [];
    window.GMPlusCache = Cache; // expose for debugging
  }
  // (Removed duplicate legacy cache helper implementations)
  // SmartFetch module (restored)
  const SmartFetch = (() => {
    if (!Cache) return null;

    const getCacheBoundaries = async (chatId, isDM = false) => {
      try {
        let cached = [];
        const all = await Cache.all();
        if (isDM) {
          cached = all.filter(m => (m.is_dm || m.conversation_id) && (
            m.user_id === chatId || m.sender_id === chatId || m.dm_other_user_id === chatId || (m.conversation_id && m.conversation_id.includes(chatId))));
        } else {
          cached = all.filter(m => m.group_id === chatId);
        }
        if (!cached.length) return { newest: null, oldest: null, count: 0, hasCache: false };
        cached.sort((a,b) => b.created_at - a.created_at);
        const newest = cached[0];
        const oldest = cached[cached.length-1];
        return {
          newest,
          oldest,
            // convenience date objects for UI (may be undefined if timestamps missing)
          newestDate: newest?.created_at ? new Date(newest.created_at * 1000) : null,
          oldestDate: oldest?.created_at ? new Date(oldest.created_at * 1000) : null,
          count: cached.length,
          hasCache: true
        };
      } catch (e) {
        console.error('[GM+ SmartFetch] Boundary error:', e);
        return { newest: null, oldest: null, count: 0, hasCache: false };
      }
    };

    const fetchSince = async (type, chatId, sinceId, sinceTs) => {
      const headers = getAuthHeaders();
      let beforeId = null, newMessages = [], retry = 0; const maxRetry = 5; let batches = 0;
      while (true) {
        batches++;
        const base = type === 'group'
          ? `https://api.groupme.com/v3/groups/${chatId}/messages?acceptFiles=1&limit=100`
          : `https://api.groupme.com/v3/direct_messages?acceptFiles=1&limit=100&other_user_id=${chatId}`;
        const url = base + (beforeId ? `&before_id=${beforeId}` : '');
        try {
          const r = await fetch(url, { headers, credentials: 'omit' });
          if (!r.ok) {
            if (r.status === 429 && retry < maxRetry) { retry++; await new Promise(rs => setTimeout(rs, 500 * retry)); continue; }
            break;
          }
          retry = 0;
          const jd = await r.json();
            const msgs = type === 'group' ? (jd.response?.messages || []) : (jd.response?.direct_messages || []);
          if (!msgs.length) break;
          for (const m of msgs) {
            if (m.id === sinceId || m.created_at <= sinceTs) { beforeId = null; break; }
            newMessages.push(m);
          }
          if (msgs.length) beforeId = msgs[msgs.length-1].id; else break;
          if (beforeId === null) break;
          if (batches > 500) break;
          await new Promise(rs => setTimeout(rs, 10));
        } catch (e) {
          if (retry++ > maxRetry) break; await new Promise(rs => setTimeout(rs, 500 * retry));
        }
      }
      return newMessages;
    };

    const smartFetch = async (type, chatId, progress) => {
      try {
        const bounds = await getCacheBoundaries(chatId, type === 'dm');
        if (!bounds.hasCache) return { mode: 'full', boundaries: bounds };
        if (progress) progress('Checking for new messages...');
        const newer = await fetchSince(type, chatId, bounds.newest.id, bounds.newest.created_at);
        if (!newer.length) return { mode: 'incremental', newMessages: [], boundaries: bounds, alreadyUpToDate: true };
        const batch = Object.fromEntries(newer.map(m => [m.id, m]));
        await Cache.store(batch);
        return { mode: 'incremental', newMessages: newer, boundaries: bounds, alreadyUpToDate: false };
      } catch (e) {
        console.error('[GM+ SmartFetch] smartFetch error:', e);
        return { mode: 'error', error: e, boundaries: null };
      }
    };

    return { getCacheBoundaries, fetchSince, smartFetch };
  })();

  console.log('[GM+ SmartFetch] Smart fetching system initialized:', SmartFetch ? 'enabled' : 'disabled');

  function getAuthHeaders() {
    // try to extract the access token from various sources
    let accessToken = null;
    
    // method 1: Check for token in localStorage
    try {
      const appData = localStorage.getItem('app');
      if (appData) {
        const parsed = JSON.parse(appData);
        accessToken = parsed?.access_token || parsed?.token;
      }
    } catch (e) {}
    
    // method 2: Check for token in sessionStorage
    if (!accessToken) {
      try {
        const sessionData = sessionStorage.getItem('access_token') || sessionStorage.getItem('token');
        if (sessionData) {
          accessToken = sessionData;
        }
      } catch (e) {}
    }
    
    // method 3: Try to extract from page context/window
    if (!accessToken) {
      try {
        accessToken = window.GroupMe?.accessToken || 
                     window.app?.access_token || 
                     window.ACCESS_TOKEN ||
                     window._gm_access_token;
      } catch (e) {}
    }
    
    // method 4: Check for token in cookies
    if (!accessToken) {
      try {
        const cookies = document.cookie.split(';');
        for (let cookie of cookies) {
          const [name, value] = cookie.trim().split('=');
          if (name === 'access_token' || name === 'gm_token' || name === 'token') {
            accessToken = value;
            break;
          }
        }
      } catch (e) {}
    }
    
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'GroupMeWeb/7.23.6-20250619.4',
      'Origin': 'https://web.groupme.com',
      'Referer': 'https://web.groupme.com/'
    };
    
    if (accessToken) {
      headers['X-Access-Token'] = accessToken;
      console.log('[GM+ Auth] Using access token for API requests');
    } else {
      console.warn('[GM+ Auth] No access token found, API requests may fail');
    }
    
    return headers;
  }

  let userMappingCache = null;
  let userMappingCacheTime = 0;
  const USER_MAPPING_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  const getUserMapping = async () => {
    const now = Date.now();
    if (userMappingCache && (now - userMappingCacheTime < USER_MAPPING_CACHE_TTL)) {
      return userMappingCache;
    }

    console.log('[GM+ User Mapping] Building user ID to name mapping...');
    const mapping = new Map();
    
    try {
      const dbs = await indexedDB.databases();
      const gmDb = dbs.find(d => d.name?.startsWith('GroupMe'));
      
      if (!gmDb) {
        console.warn('[GM+ User Mapping] No GroupMe IndexedDB found');
        return mapping;
      }
      
      console.log(`[GM+ User Mapping] Found GroupMe database: ${gmDb.name}`);
      
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(gmDb.name, gmDb.version);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      
      if (db.objectStoreNames.contains('DMs')) {
        const dms = await new Promise((resolve, reject) => {
          const tx = db.transaction('DMs', 'readonly');
          const store = tx.objectStore('DMs');
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        
        console.log(`[GM+ User Mapping] Found ${dms.length} DMs in IndexedDB`);
        
        dms.forEach(dm => {
          if (dm.id && dm.other_user?.name) {
            mapping.set(dm.id, dm.other_user.name);
            console.log(`[GM+ User Mapping] Mapped DM ${dm.id} -> ${dm.other_user.name}`);
          }
        });
      } else {
        console.warn('[GM+ User Mapping] DMs store not found in database');
      }
      
      db.close();
      
      console.log(`[GM+ User Mapping] Built mapping for ${mapping.size} users`);
      userMappingCache = mapping;
      userMappingCacheTime = now;
      return mapping;
      
    } catch (error) {
      console.error('[GM+ User Mapping] Error building mapping:', error);
      return new Map();
    }
  };

  let groupMappingCache = null;
  let groupMappingCacheTime = 0;
  const GROUP_MAPPING_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  const getGroupMapping = async () => {
    const now = Date.now();
    if (groupMappingCache && (now - groupMappingCacheTime < GROUP_MAPPING_CACHE_TTL)) {
      return groupMappingCache;
    }

    console.log('[GM+ Group Mapping] Building group ID to name mapping...');
    const mapping = new Map();
    
    try {
      const dbs = await indexedDB.databases();
      const gmDb = dbs.find(d => d.name?.startsWith('GroupMe'));
      
      if (!gmDb) {
        console.warn('[GM+ Group Mapping] No GroupMe IndexedDB found');
        return mapping;
      }
      
      console.log(`[GM+ Group Mapping] Found GroupMe database: ${gmDb.name}`);
      
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(gmDb.name, gmDb.version);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      
      if (db.objectStoreNames.contains('Groups')) {
        const groups = await new Promise((resolve, reject) => {
          const tx = db.transaction('Groups', 'readonly');
          const store = tx.objectStore('Groups');
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const dms = await new Promise((resolve, reject) => {
          const tx = db.transaction('DMs', 'readonly');
          const store = tx.objectStore('DMs');
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        
        console.log(`[GM+ Group Mapping] Found ${groups.length} groups in IndexedDB`);
        
        groups.forEach(group => {
          if (group.id && group.name) {
            mapping.set(group.id, group.name);
            console.log(`[GM+ Group Mapping] Mapped group ${group.id} -> ${group.name}`);
          }
        });

      } else {
        console.warn('[GM+ Group Mapping] Groups store not found in database');
      }
      
      db.close();
      
      console.log(`[GM+ Group Mapping] Built mapping for ${mapping.size} groups`);
      groupMappingCache = mapping;
      groupMappingCacheTime = now;
      return mapping;
      
    } catch (error) {
      console.error('[GM+ Group Mapping] Error building mapping:', error);
      return new Map();
    }
  };

  const findDMButton = (userName) => {
    console.log(`[GM+ DM Navigation] Looking for DM button for user: ${userName}`);
    
    const dmItems = document.querySelectorAll('.list-item');
    for (const item of dmItems) {
      const nameSpan = item.querySelector('.chat-name');
      if (nameSpan && nameSpan.textContent.trim() === userName) {
        console.log(`[GM+ DM Navigation] Found DM button for ${userName}`);
        return item.querySelector('a');
      }
    }
    
    const alternativeSelectors = [
      `[title="${userName}"]`,
      `[aria-label*="${userName}"]`,
      `.chat-name:contains("${userName}")`,
    ];
    
    for (const selector of alternativeSelectors) {
      try {
        const element = document.querySelector(selector);
        if (element) {
          const dmButton = element.closest('.list-item')?.querySelector('a');
          if (dmButton) {
            console.log(`[GM+ DM Navigation] Found DM button via alternative selector for ${userName}`);
            return dmButton;
          }
        }
      } catch (e) {
        console.warn(`[GM+ DM Navigation] Error finding DM button with selector "${selector}":`, e);
      }
    }
    
    console.warn(`[GM+ DM Navigation] Could not find DM button for user: ${userName}`);
    return null;
  };

  const findGroupButton = (groupName) => {
    console.log(`[GM+ Group Navigation] Looking for group button for: ${groupName}`);
    
    const groupItems = document.querySelectorAll('.list-item');
    for (const item of groupItems) {
      const nameSpan = item.querySelector('.chat-name');
      if (nameSpan && nameSpan.textContent.trim() === groupName) {
        console.log(`[GM+ Group Navigation] Found group button for ${groupName}`);
        return item.querySelector('a');
      }
    }
    
    const alternativeSelectors = [
      `[title="${groupName}"]`,
      `[aria-label*="${groupName}"]`,
      `.chat-name:contains("${groupName}")`,
    ];
    
    for (const selector of alternativeSelectors) {
      try {
        const element = document.querySelector(selector);
        if (element) {
          const groupButton = element.closest('.list-item')?.querySelector('a');
          if (groupButton) {
            console.log(`[GM+ Group Navigation] Found group button via alternative selector for ${groupName}`);
            return groupButton;
          }
        }
      } catch (e) {
        console.warn(`[GM+ Group Navigation] Error finding group button with selector "${selector}":`, e);
      }
    }
    
    console.warn(`[GM+ Group Navigation] Could not find group button for group: ${groupName}`);
    return null;
  };

  const loadMessageContext = async (messageId, groupId, userIdOrConversationId) => {
    try {
      console.log(`[GM+ Context] Loading context for message ${messageId}...`, {
        messageId, groupId, userIdOrConversationId
      });
      
      if (!Cache) {
        console.warn('[GM+ Context] Cache not available, falling back to basic navigation');
        setTimeout(() => {
          findAndScrollToMessage(messageId, groupId, userIdOrConversationId);
        }, 1000);
        return;
      }
      
      // Find the target message in cache first
      const cachedMessages = await Cache.all();
      const targetMessage = cachedMessages.find(m => m.id === messageId);
      
      if (!targetMessage) {
        console.warn('[GM+ Context] Target message not found in cache, proceeding with basic navigation');
        setTimeout(() => {
          findAndScrollToMessage(messageId, groupId, userIdOrConversationId);
        }, 1000);
        return;
      }
      
      console.log(`[GM+ Context] Found target message in cache:`, {
        id: targetMessage.id,
        text: targetMessage.text?.substring(0, 50) + '...',
        created_at: new Date(targetMessage.created_at * 1000).toLocaleString()
      });
      
      // Get messages around the target for context
      let contextMessages = [];
      if (groupId) {
        contextMessages = cachedMessages.filter(msg => msg.group_id === groupId);
      } else {
        contextMessages = cachedMessages.filter(msg => {
          return (msg.is_dm || msg.conversation_id) && (
            msg.user_id === userIdOrConversationId || 
            msg.sender_id === userIdOrConversationId ||
            msg.dm_other_user_id === userIdOrConversationId ||
            (msg.conversation_id && msg.conversation_id.includes(userIdOrConversationId))
          );
        });
      }
      
      // Sort by timestamp
      contextMessages.sort((a, b) => b.created_at - a.created_at);
      
      // Find the target message index in the sorted list
      const targetIndex = contextMessages.findIndex(msg => msg.id === messageId);
      
      if (targetIndex === -1) {
        console.warn('[GM+ Context] Target message not found in context messages');
        setTimeout(() => {
          findAndScrollToMessage(messageId, groupId, userIdOrConversationId);
        }, 1000);
        return;
      }
      
      console.log(`[GM+ Context] Target message is at index ${targetIndex} of ${contextMessages.length} messages`);
      
      // Preload some messages around the target using the API
      const headers = getAuthHeaders();
      const contextSize = 25; // Load 25 messages before and after
      
      try {
        // Try to load some newer messages (if not at the top)
        if (targetIndex > 0) {
          const newerMessage = contextMessages[Math.max(0, targetIndex - contextSize)];
          let apiUrl = '';
          
          if (groupId) {
            apiUrl = `https://api.groupme.com/v3/groups/${groupId}/messages?acceptFiles=1&limit=${contextSize}&since_id=${newerMessage.id}`;
          } else {
            apiUrl = `https://api.groupme.com/v3/direct_messages?acceptFiles=1&limit=${contextSize}&other_user_id=${userIdOrConversationId}&since_id=${newerMessage.id}`;
          }
          
          console.log(`[GM+ Context] Fetching newer messages: ${apiUrl}`);
          const newerResp = await fetch(apiUrl, { headers, credentials: 'omit' });
          
          if (newerResp.ok) {
            const newerData = await newerResp.json();
            const newerMessages = groupId ? 
              (newerData.response?.messages || []) : 
              (newerData.response?.direct_messages || []);
            
            if (newerMessages.length > 0) {
              console.log(`[GM+ Context] Loaded ${newerMessages.length} newer messages`);
              // Store them in cache
              const batch = Object.fromEntries(newerMessages.map(m => [m.id, m]));
              await Cache.store(batch);
            }
          }
        }
        
        // Try to load some older messages (if not at the bottom)
        if (targetIndex < contextMessages.length - 1) {
          const olderMessage = contextMessages[Math.min(contextMessages.length - 1, targetIndex + contextSize)];
          let apiUrl = '';
          
          if (groupId) {
            apiUrl = `https://api.groupme.com/v3/groups/${groupId}/messages?acceptFiles=1&limit=${contextSize}&before_id=${olderMessage.id}`;
          } else {
            apiUrl = `https://api.groupme.com/v3/direct_messages?acceptFiles=1&limit=${contextSize}&other_user_id=${userIdOrConversationId}&before_id=${olderMessage.id}`;
          }
          
          console.log(`[GM+ Context] Fetching older messages: ${apiUrl}`);
          const olderResp = await fetch(apiUrl, { headers, credentials: 'omit' });
          
          if (olderResp.ok) {
            const olderData = await olderResp.json();
            const olderMessages = groupId ? 
              (olderData.response?.messages || []) : 
              (olderData.response?.direct_messages || []);
            
            if (olderMessages.length > 0) {
              console.log(`[GM+ Context] Loaded ${olderMessages.length} older messages`);
              // Store them in cache
              const batch = Object.fromEntries(olderMessages.map(m => [m.id, m]));
              await Cache.store(batch);
            }
          }
        }
        
      } catch (apiError) {
        console.warn('[GM+ Context] API context loading failed:', apiError);
      }
      
      const delay = 1500;
      setTimeout(() => {
        findAndScrollToMessage(messageId, groupId, userIdOrConversationId);
      }, delay);
      
    } catch (error) {
      console.error('[GM+ Context] Error loading context:', error);
      setTimeout(() => {
        findAndScrollToMessage(messageId, groupId, userIdOrConversationId);
      }, 1000);
    }
  };

  const navigateToSearchResult = async (messageId, groupId, otherUserId, conversationId) => {
    try {
      console.log(`[GM+ Search Navigation] Navigating to message ${messageId} via Message Viewer`, {
        groupId, otherUserId, conversationId
      });
      
      await MessageViewer.show();
      
      const chatId = groupId || otherUserId || conversationId;
      
      if (!chatId) {
        throw new Error('No group ID, user ID, or conversation ID provided');
      }
      
      const chatSelector = document.querySelector('.gm-chat-selector');
      if (!chatSelector) {
        throw new Error('Chat selector not found');
      }
      
      await new Promise(resolve => {
        let attempts = 0;
        const interval = setInterval(() => {
          if (chatSelector.options.length > 1 || attempts++ > 20) {
            clearInterval(interval);
            resolve();
          }
        }, 200);
      });
      
      MessageViewer.setPendingJumpMessage(messageId);
      
      const prefix = groupId ? 'group' : 'dm';
      chatSelector.value = `${prefix}:${chatId}`;
      chatSelector.dispatchEvent(new Event('change'));
      
    } catch (error) {
      console.error('[GM+ Search Navigation] Error:', error);
      Modal.alert('Navigation Error', `Failed to navigate to message: ${error.message}`, 'error');
    }
  };

  window.navigateToSearchResult = navigateToSearchResult;

  const handleSearchResultClick = (event) => {
    const searchResult = event.target.closest('.gm-search-result');
    if (!searchResult) return;
    
    const messageId = searchResult.getAttribute('data-msg-id');
    const groupId = searchResult.getAttribute('data-group-id');
    const otherUserId = searchResult.getAttribute('data-other-user-id');
    const conversationId = searchResult.getAttribute('data-conversation-id');
    
    console.log('[GM+ Search Click] Clicked on search result:', {
      messageId, groupId, otherUserId, conversationId
    });
    
    if (messageId) {
      navigateToSearchResult(messageId, groupId, otherUserId, conversationId);
    } else {
      console.error('[GM+ Search Click] No message ID found in clicked element');
    }
  };

  window.jumpToMessage = async (messageId, groupId, conversationId) => {
    try {
      console.log(`[GM+ Jump] Attempting to jump to message ${messageId} in ${groupId ? 'group' : 'conversation'} ${groupId || conversationId}`);
      
      if (groupId) {
        console.log(`[GM+ Jump] Verifying access to group ${groupId}`);
        try {
          const response = await fetch(`https://api.groupme.com/v3/groups/${groupId}`, {
            method: 'GET',
            headers: getAuthHeaders(),
            credentials: 'omit'
          });
          
          if (response.ok) {
            console.log(`[GM+ Jump] Group ${groupId} accessible, navigating`);
            window.location.href = `https://web.groupme.com/chats/${groupId}`;
          } else {
            console.warn(`[GM+ Jump] Group API returned ${response.status}, attempting direct navigation`);
            window.location.href = `https://web.groupme.com/chats/${groupId}`;
          }
        } catch (apiError) {
          console.warn(`[GM+ Jump] Group API call failed: ${apiError.message}, navigating directly`);
          window.location.href = `https://web.groupme.com/chats/${groupId}`;
        }
      } else if (conversationId) {
        console.log(`[GM+ Jump] Navigating to conversation ${conversationId}`);
        window.location.href = `https://web.groupme.com/chats/${conversationId}`;
      } else {
        throw new Error('No group ID or conversation ID provided');
      }
      
      setTimeout(() => {
        findAndScrollToMessage(messageId, groupId, conversationId);
      }, 2000);
      
    } catch (error) {
      console.error('[GM+ Jump] Error jumping to message:', error);
      Modal.alert('Jump Error', `Failed to jump to message: ${error.message}`, 'error');
    }
  };

  async function findAndScrollToMessage(messageId, groupId, conversationId) {
    try {
      console.log(`[GM+ Jump] Searching for message ${messageId}...`, {
        messageId, groupId, conversationId,
        conversationIdType: typeof conversationId
      });
      
      let existingMessage = findMessageInDOM(messageId);
      if (existingMessage) {
        console.log('[GM+ Jump] Message found in current view, scrolling to it');
        existingMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
        highlightMessage(existingMessage);
        return;
      }
      
      console.log('[GM+ Jump] Message not in current view, loading messages...');
      
      const chatType = groupId ? 'groups' : 'chats';
      const chatId = groupId || conversationId;
      
      console.log(`[GM+ Jump] Using chatId: ${chatId}, chatType: ${chatType}`);
      
      let beforeId = getCurrentOldestMessageId();
      let attempts = 0;
      const maxAttempts = 250;
      
      while (attempts < maxAttempts) {
        attempts++;
        console.log(`[GM+ Jump] Loading batch ${attempts}, before_id: ${beforeId}`);
        
        try {
          let apiUrl;
          const authHeaders = getAuthHeaders();
          
          console.log(`[GM+ Jump] Auth headers:`, {
            hasToken: !!authHeaders.token,
            hasXAccessToken: !!authHeaders['X-Access-Token']
          });
          
          if (groupId) {
            apiUrl = `https://api.groupme.com/v3/groups/${chatId}/messages?acceptFiles=1&before_id=${beforeId}&limit=100`;
          } else {
            let otherUserId = chatId;
            
            console.log(`[GM+ Jump] Processing DM chatId: "${chatId}" (type: ${typeof chatId})`);
            
            if (typeof chatId === 'string' && chatId.includes('+')) {
              const parts = chatId.split('+');
              console.log(`[GM+ Jump] Conversation ID parts:`, parts);
              
              if (parts.length === 2) {
                const firstId = parts[0];
                const secondId = parts[1];
                
                console.log(`[GM+ Jump] First ID: "${firstId}", Second ID: "${secondId}"`);
                
                otherUserId = firstId;
                console.log(`[GM+ Jump] Using other user ID: "${otherUserId}" (first ID) from conversation ${chatId}`);
              } else {
                console.warn(`[GM+ Jump] Unexpected conversation ID format: ${chatId}`);
              }
            }
            
            console.log(`[GM+ Jump] Final other user ID: "${otherUserId}"`);
            
            if (!otherUserId || otherUserId === '') {
              console.error(`[GM+ Jump] No valid other user ID found! chatId: "${chatId}"`);
              throw new Error(`No valid other user ID found for DM conversation: ${chatId}`);
            }
            
            apiUrl = `https://api.groupme.com/v3/direct_messages?acceptFiles=1&before_id=${beforeId}&limit=100&other_user_id=${otherUserId}`;
          }
          
          console.log(`[GM+ Jump] Making API call to: ${apiUrl}`);
          
          const response = await fetch(apiUrl, { headers: authHeaders, credentials: 'omit' });
          
          console.log(`[GM+ Jump] API response status: ${response.status}`);
          if (!response.ok) {
            if (response.status === 404 && !groupId) {
              console.log('[GM+ Jump] DM not found, trying alternative approach...');
              break;
            }
            const errorText = await response.text().catch(() => 'Unknown error');
            console.error(`[GM+ Jump] API error response:`, errorText);
            
            console.log('[GM+ Jump] API call failed, skipping to DOM search...');
            break;
          }
          
          const data = await response.json();
          const messages = groupId ? 
            (data.response?.messages || []) : 
            (data.response?.direct_messages || []);
          
          console.log(`[GM+ Jump] Loaded ${messages.length} messages`);
          
          if (!messages.length) {
            console.log('[GM+ Jump] No more messages to load');
            break;
          }
          
          await new Promise(resolve => setTimeout(resolve, 800));
          
          const targetMessage = findMessageInDOM(messageId);
          if (targetMessage) {
            console.log('[GM+ Jump] Target message found! Scrolling to it...');
            targetMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
            highlightMessage(targetMessage);
            return;
          }
          
          const oldestMessage = messages[messages.length - 1];
          if (oldestMessage && oldestMessage.id !== beforeId) {
            beforeId = oldestMessage.id;
          } else {
            console.log('[GM+ Jump] No new messages loaded, stopping');
            break;
          }
          
        } catch (error) {
          console.error('[GM+ Jump] Error loading messages:', error);
          
          console.log('[GM+ Jump] API failed, checking if message exists in current DOM...');
          
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          const targetMessage = findMessageInDOM(messageId);
          if (targetMessage) {
            console.log('[GM+ Jump] Found target message in DOM after API failure!');
            targetMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
            highlightMessage(targetMessage);
            return;
          }
          
          console.log('[GM+ Jump] Message not found in current DOM, stopping search');
          break;
        }
      }
      
      if (attempts >= maxAttempts) {
        console.log('[GM+ Jump] Reached maximum attempts, trying one final DOM search...');
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        const finalMessage = findMessageInDOM(messageId);
        if (finalMessage) {
          console.log('[GM+ Jump] Found message in final DOM search!');
          finalMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
          highlightMessage(finalMessage);
          return;
        }
        
        Modal.alert('Search Timeout', 'Could not find the message after loading many batches. The message might be very old, deleted, or not yet loaded in the chat.', 'error');
      } else {
        Modal.alert('Message Not Found', 'Could not find the specified message. It may have been deleted, is in a different conversation, or the API calls are being blocked.', 'error');
      }
      
    } catch (error) {
      console.error('[GM+ Jump] Error in findAndScrollToMessage:', error);
      Modal.alert('Search Error', `Error searching for message: ${error.message}`, 'error');
    }
  }

  function findMessageInDOM(messageId) {
    const selectors = [
      `[data-message-id="${messageId}"]`,
      `[data-id="${messageId}"]`,
      `[id="${messageId}"]`,
      `[id="message-${messageId}"]`,
      `[id="msg-${messageId}"]`,
      `*[data-reactid*="${messageId}"]`,
      `.message[data-id="${messageId}"]`,
      `.chat-message[data-id="${messageId}"]`
    ];
    
    for (const selector of selectors) {
      try {
        const element = document.querySelector(selector);
        if (element) {
          console.log(`[GM+ Jump] Found message using selector: ${selector}`);
          return element;
        }
      } catch (e) {
      }
    }
    
    const messageElements = document.querySelectorAll('[class*="message"], [id*="message"], [data-id], [class*="chat"]');
    for (const element of messageElements) {
      const elementId = element.getAttribute('data-message-id') || 
                       element.getAttribute('data-id') ||
                       element.id ||
                       element.getAttribute('data-reactid');
      
      if (elementId && (elementId === messageId || elementId.includes(messageId))) {
        console.log(`[GM+ Jump] Found message in element with ID pattern: ${elementId}`);
        return element;
      }
    }
    
    return null;
  }

  function getCurrentOldestMessageId() {
    let oldestId = null;
    
    const messageSelectors = [
      '[data-message-id]',
      '[data-id]',
      '.message[data-id]',
      '.chat-message[data-id]',
      '[class*="message"][data-id]'
    ];
    
    for (const selector of messageSelectors) {
      try {
        const messages = document.querySelectorAll(selector);
        if (messages.length > 0) {
          const lastMessage = messages[messages.length - 1];
          oldestId = lastMessage.getAttribute('data-message-id') || 
                     lastMessage.getAttribute('data-id') ||
                     lastMessage.id;
          if (oldestId && oldestId.length > 10) break;
        }
      } catch (e) {
      }
    }
    
    if (!oldestId) {
      const allElements = document.querySelectorAll('*[data-reactid], *[id], *[data-id]');
      for (const element of allElements) {
        const possibleId = element.getAttribute('data-reactid') ||
                          element.getAttribute('data-id') ||
                          element.id;
        
        if (possibleId && /^\d{15,}$/.test(possibleId)) {
          oldestId = possibleId;
          break;
        }
      }
    }
    
    if (!oldestId) {
      const urlParams = new URLSearchParams(window.location.search);
      oldestId = urlParams.get('before_id') || urlParams.get('message_id');
    }
    
    if (!oldestId) {
      oldestId = String(Date.now() * 1000000);
    }
    
    console.log(`[GM+ Jump] Starting search from message ID: ${oldestId}`);
    return oldestId;
  }

  function highlightMessage(messageElement) {
    const allExistingHighlights = document.querySelectorAll('.gm-message-highlight');
    allExistingHighlights.forEach(highlight => highlight.remove());
    

    const highlight = document.createElement('div');
    highlight.className = 'gm-message-highlight';
    highlight.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(45deg, rgba(102, 126, 234, 0.4), rgba(102, 126, 234, 0.2));
      border: 2px solid #667eea;
      border-radius: 8px;
      z-index: 10;
      pointer-events: none;
      opacity: 1;
      transition: opacity 2s ease-out;
    `;
    
    if (!document.getElementById('search-highlight-animation')) {
      const style = document.createElement('style');
      style.id = 'search-highlight-animation';
      style.textContent = `
        .gm-search-highlight-fadeout {
          opacity: 0 !important;
        }
      `;
      document.head.appendChild(style);
    }
    
    const originalPosition = messageElement.style.position;
    messageElement.style.position = 'relative';
    
    messageElement.appendChild(highlight);
    
    setTimeout(() => {
      highlight.classList.add('gm-search-highlight-fadeout');
    }, 1000);
    
    setTimeout(() => {
      if (highlight.parentNode) highlight.parentNode.removeChild(highlight);
      messageElement.style.position = originalPosition;
    }, 3000);
  }

  const Modal = (() => {
    let modalStack = [];

    const repositionModal = (modal) => {
      const rect = modal.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;
      
      if (rect.bottom > viewportHeight || rect.top < 0) {
        let newTop = Math.max(20, (viewportHeight - rect.height) / 2);
        
        if (rect.height > viewportHeight - 40) {
          newTop = 20;
        }
        
        modal.style.top = `${newTop}px`;
        modal.style.transform = 'translate(-50%, 0)';
      }
      
      if (rect.right > viewportWidth || rect.left < 0) {
        let newLeft = Math.max(20, (viewportWidth - rect.width) / 2);
        modal.style.left = `${newLeft}px`;
        modal.style.transform = modal.style.transform.replace('translate(-50%', 'translate(0');
      }
    };

    const setupModalRepositioning = (modal, modalInstance) => {
      setTimeout(() => repositionModal(modal), 100);
      
      const observer = new MutationObserver(() => {
        requestAnimationFrame(() => {
          repositionModal(modal);
        });
      });
      
      observer.observe(modal, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class']
      });
      
      const handleResize = () => repositionModal(modal);
      window.addEventListener('resize', handleResize);
      
      modalInstance.cleanup = () => {
        window.removeEventListener('resize', handleResize);
        observer.disconnect();
      };
    };

    const create = () => {
      const overlay = document.createElement('div');
      overlay.className = 'gm-modal-overlay';
      
      const modal = document.createElement('div');
      modal.className = 'gm-modal';
      
      const header = document.createElement('div');
      header.className = 'gm-modal-header';
      
      const title = document.createElement('h3');
      title.className = 'gm-modal-title';
      
      const closeBtn = document.createElement('button');
      closeBtn.className = 'gm-modal-close';
      closeBtn.innerHTML = '×';
      
      const body = document.createElement('div');
      body.className = 'gm-modal-body';
      
      const footer = document.createElement('div');
      footer.className = 'gm-modal-footer';
      
      header.append(title, closeBtn);
      modal.append(header, body, footer);
      overlay.appendChild(modal);
      
      const modalInstance = {
        overlay,
        modal,
        header,
        title,
        closeBtn,
        body,
        footer,
        cleanup: null,
        close: null
      };
      
      const closeModal = () => {
        const index = modalStack.indexOf(modalInstance);
        if (index > -1) {
          modalStack.splice(index, 1);
        }
        
        if (modalInstance.cleanup) {
          modalInstance.cleanup();
        }
        
        overlay.classList.remove('show');
        setTimeout(() => {
          if (overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
          }
        }, 200);
      };
      
      modalInstance.close = closeModal;
      closeBtn.onclick = closeModal;
      
      overlay.onclick = (e) => {
        if (e.target === overlay) closeModal();
      };
      
      const handleEscape = (e) => {
        if (e.key === 'Escape') {
          if (modalStack.length > 0 && modalStack[modalStack.length - 1] === modalInstance) {
            closeModal();
          }
        }
      };
      
      const show = () => {
        modalStack.push(modalInstance);
        
        document.body.appendChild(overlay);
        document.addEventListener('keydown', handleEscape);
        overlay.offsetHeight;
        setTimeout(() => {
          overlay.classList.add('show');
          setupModalRepositioning(modal, modalInstance);
        }, 10);
      };
      
      modalInstance.show = show;
      
      const originalClose = modalInstance.close;
      modalInstance.close = () => {
        document.removeEventListener('keydown', handleEscape);
        originalClose();
      };
      
      return modalInstance;
    };

    const close = () => {
      if (modalStack.length > 0) {
        const topModal = modalStack[modalStack.length - 1];
        topModal.close();
      }
    };

    const closeAll = () => {
      while (modalStack.length > 0) {
        const modal = modalStack[modalStack.length - 1];
        modal.close();
      }
    };

    const alert = (titleText, message, type = 'info') => {
      const { title, body, footer, show } = create();
      
      title.textContent = titleText;
      body.innerHTML = `<div class="gm-modal-content">${message}</div>`;
      
      const okBtn = document.createElement('button');
      okBtn.className = `gm-modal-btn ${type === 'error' ? 'danger' : 'primary'}`;
      okBtn.textContent = 'OK';
      okBtn.onclick = close;
      
      footer.appendChild(okBtn);
      show();
      
      setTimeout(() => okBtn.focus(), 100);
    };

    const confirm = (titleText, message, onConfirm, onCancel) => {
      const { title, body, footer, show } = create();
      
      title.textContent = titleText;
      body.innerHTML = `<div class="gm-modal-content">${message}</div>`;
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'gm-modal-btn secondary';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => {
        close();
        if (onCancel) onCancel();
      };
      
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'gm-modal-btn danger';
      confirmBtn.textContent = 'Confirm';
      confirmBtn.onclick = () => {
        close();
        if (onConfirm) onConfirm();
      };
      
      footer.append(cancelBtn, confirmBtn);
      show();
      
      setTimeout(() => confirmBtn.focus(), 100);
    };

    const stats = (titleText, data) => {
      const { title, body, footer, show } = create();
      
      title.textContent = titleText;
      
      const statsHtml = `
        <div class="gm-modal-stats">
          <div class="gm-modal-stat">
            <div class="gm-modal-stat-value">${data.messages.toLocaleString()}</div>
            <div class="gm-modal-stat-label">Messages Cached</div>
          </div>
          <div class="gm-modal-stat">
            <div class="gm-modal-stat-value">${data.edits.toLocaleString()}</div>
            <div class="gm-modal-stat-label">Edits Tracked</div>
          </div>
        </div>
        <div style="margin-top: 16px; color: #888; font-size: 14px;">
          Note: Cached messages are compressed to save storage space.
        </div>
      `;
      
      body.innerHTML = statsHtml;
      
      const okBtn = document.createElement('button');
      okBtn.className = 'gm-modal-btn primary';
      okBtn.textContent = 'Close';
      okBtn.onclick = close;
      
      footer.appendChild(okBtn);
      show();
      
      setTimeout(() => okBtn.focus(), 100);
    };

    const analytics = (titleText, content) => {
      const { title, body, footer, show } = create();
      
      title.textContent = titleText;
      body.innerHTML = content;
      
      const okBtn = document.createElement('button');
      okBtn.className = 'gm-modal-btn primary';
      okBtn.textContent = 'Close';
      okBtn.onclick = close;
      
      footer.appendChild(okBtn);
      show();
      
      setTimeout(() => okBtn.focus(), 100);
    };

    const viewer = (titleText, content) => {
      const { title, body, show } = create();
      
      title.textContent = titleText;
      body.innerHTML = content;
      
      show();
      
      return { title, body };
    };

    return { alert, confirm, stats, analytics, viewer, close, closeAll, create };
  })();

  // message viewer module
  const MessageViewer = (() => {
    let currentChat = null;
    let allMessages = [];
    let visibleMessages = [];
    let currentModal = null;
    let currentContext = null;
    let isNavigating = false;
    let pendingJumpMessageId = null;
    
    const ITEM_HEIGHT = 120;
    const BUFFER_SIZE = 10;
    
    const formatTimestamp = (timestamp) => {
      const date = new Date(timestamp * 1000);
      return date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
    };
    
    const formatDate = (timestamp) => {
      const date = new Date(timestamp * 1000);
      return date.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric',
        year: 'numeric' 
      });
    };
    
    const sanitizeText = (text) => {
      if (!text) return '';
      return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    
    const highlightMessage = (messageElement, messageId) => {
      // Remove ALL existing highlights globally to prevent stacking
      const allExistingHighlights = document.querySelectorAll('.gm-message-highlight, [class*="gm-highlight"]');
      allExistingHighlights.forEach(highlight => highlight.remove());
      
      const highlight = document.createElement('div');
      highlight.className = 'gm-message-highlight';
      highlight.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: linear-gradient(45deg, rgba(102, 126, 234, 0.4), rgba(102, 126, 234, 0.2));
        border: 2px solid #667eea;
        border-radius: 8px;
        z-index: 10;
        pointer-events: none;
        opacity: 1;
        transition: opacity 2s ease-out;
      `;
      
      if (!document.getElementById('message-highlight-animations')) {
        const style = document.createElement('style');
        style.id = 'message-highlight-animations';
        style.textContent = `
          .gm-highlight-fadeout {
            opacity: 0 !important;
          }
        `;
        document.head.appendChild(style);
      }
      
      const originalPosition = messageElement.style.position;
      messageElement.style.position = 'relative';
      
      messageElement.appendChild(highlight);
      
      setTimeout(() => {
        highlight.classList.add('gm-highlight-fadeout');
      }, 1000);
      
      setTimeout(() => {
        if (highlight.parentNode) highlight.parentNode.removeChild(highlight);
        messageElement.style.position = originalPosition;
      }, 3000);
    };
    
    const scrollToMessage = (messageId) => {
      const messageElement = document.getElementById(`gm-msg-${messageId}`);
      if (messageElement) {
        isNavigating = true;
        
        messageElement.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'center' 
        });
        
        setTimeout(() => {
          highlightMessage(messageElement, messageId);
          setTimeout(() => {
            isNavigating = false;
          }, 1500);
        }, 300);
        
        return true;
      }
      return false;
    };
    
    const navigateToMessage = async (messageId) => {
      if (!allMessages.length) return;
      const container = currentModal?.modal.querySelector('.gm-messages-container');
      if (!container) return;
      const index = allMessages.findIndex(m => m.id === messageId);
      if (index === -1) {
        Modal.alert('Message Not Found', 'Message not present in loaded cache for this chat.', 'error');
        return;
      }
      isNavigating = true;
      // Use unified virtualization path (preserves modal padding/styles)
      updateVirtualScroll(container, index);
      setTimeout(() => {
        const el = document.getElementById(`gm-msg-${messageId}`);
        if (el) {
          // Single smooth center scroll; no persistent locking
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => highlightMessage(el, messageId), 300);
        }
        setTimeout(()=>{ isNavigating = false; }, 1800);
      }, 150);
    };
    
    const renderReactions = (reactions) => {
      if (!reactions || !reactions.length) return '';
      
      const reactionCounts = {};
      reactions.forEach(reaction => {
        let emoji = '⬆️'; // default for custom / non-unicode
        if (reaction.type === 'unicode' && reaction.code) {
          // reaction.code may already be the emoji, but if it's a hex code like '1f44d' convert it
            if (/^[0-9a-fA-F]{4,8}$/.test(reaction.code)) {
              try {
                const codePoints = reaction.code.split('-').map(cp => parseInt(cp, 16));
                emoji = String.fromCodePoint(...codePoints);
              } catch (e) {
                emoji = reaction.code; // fallback to raw
              }
            } else {
              emoji = reaction.code;
            }
        }
        if (!emoji) emoji = '⬆️';
        const increment = reaction.user_ids ? reaction.user_ids.length : 1;
        if (reactionCounts[emoji]) {
          reactionCounts[emoji].count += increment;
        } else {
          reactionCounts[emoji] = { count: increment, type: reaction.type || 'emoji' };
        }
      });
      
      return Object.entries(reactionCounts).map(([emoji, data]) => 
        `<div class="gm-message-reaction" title="Reaction: ${emoji} (${data.type})">
          <span class="gm-message-reaction-emoji">${emoji}</span>
          <span>${data.count}</span>
        </div>`
      ).join('');
    };
    
    const renderAttachments = (attachments) => {
      if (!attachments || !attachments.length) return '';
      
      return attachments.map(att => {
        let content = '';
        let isClickable = false;
        let url = '';
        
        switch (att.type) {
          case 'image':
            content = `📷 Image${att.name ? `: ${att.name}` : ''}`;
            isClickable = !!(att.url || att.preview_url);
            url = att.url || att.preview_url;
            break;
          case 'video':
            content = `🎥 Video${att.name ? `: ${att.name}` : ''}`;
            isClickable = !!(att.url || att.video_url);
            url = att.url || att.video_url;
            break;
          case 'file':
            content = `📎 File${att.name ? `: ${att.name}` : ''}`;
            isClickable = !!att.url;
            url = att.url;
            break;
          case 'location':
            content = `📍 Location${att.name ? `: ${att.name}` : ''}`;
            if (att.lat && att.lng) {
              isClickable = true;
              url = `https://www.google.com/maps?q=${att.lat},${att.lng}`;
            }
            break;
          case 'reply': {
            // Handle reply attachments specially - these should navigate to the replied message
            const replyText = att.text || att.reply_text || 'Reply';
            const repliedMessageId = att.reply_id || att.base_reply_id;
            content = `💬 Reply: ${replyText.length > 50 ? replyText.substring(0, 50) + '...' : replyText}`;
            if (repliedMessageId) {
              return `<div class="gm-message-attachment gm-message-reply-attachment" data-reply-id="${repliedMessageId}" style="cursor:pointer;border-left:3px solid #667eea;padding-left:8px;">${content}</div>`;
            }
            break; }
          default:
            content = `📎 ${att.type || 'Attachment'}${att.name ? `: ${att.name}` : ''}`;
            isClickable = !!att.url;
            url = att.url;
        }
        
        if (isClickable && url) {
          return `<div class="gm-message-attachment gm-message-attachment-clickable" data-url="${url}" style="cursor:pointer;text-decoration:underline;">${content}</div>`;
        } else {
          return `<div class="gm-message-attachment">${content}</div>`;
        }
      }).join('');
    };
    
    const renderMessage = (message, index) => {
      const isDeleted = message.text === 'This message was deleted' || message.deleted_at;
      const isSystem = message.system || message.message_type === 'system';
      const isCurrentUser = message.user_id === getCurrentUserId(); // not yet implemented
      const timestamp = formatTimestamp(message.created_at);
      const reactions = renderReactions(message.reactions);
      const attachments = renderAttachments(message.attachments);
      
      // Create unique ID for this message item
      const messageElementId = `gm-msg-${message.id}`;
      
      if (isSystem) {
        return `
          <div class="gm-message-item gm-message-system" id="${messageElementId}" data-message-id="${message.id}" data-index="${index}">
            ${sanitizeText(message.text || message.event || 'System message')}
            <div class="gm-message-timestamp">${timestamp}</div>
          </div>
        `;
      }
      
      return `
        <div class="gm-message-item ${isDeleted ? 'deleted' : ''}" id="${messageElementId}" data-message-id="${message.id}" data-index="${index}">
          ${isCurrentUser ? '<div class="gm-message-pill"></div>' : ''}
          <div class="gm-message-header">
            <div class="gm-message-avatar">
              ${message.avatar_url ? `<img src="${message.avatar_url}" alt="Avatar">` : ''}
            </div>
            <div class="gm-message-nickname">${sanitizeText(message.name || 'Unknown User')}</div>
          </div>
          <div class="gm-message-timestamp">${timestamp}</div>
          <div class="gm-message-body">
            <div class="gm-message-text ${isDeleted ? 'deleted' : ''}">
              ${sanitizeText(message.text || '')}
            </div>
            ${message.updated_at && message.updated_at !== message.created_at ? 
              '<div class="gm-message-edited">(edited)</div>' : ''}
            ${attachments}
            ${reactions ? `<div class="gm-message-reactions">${reactions}</div>` : ''}
          </div>
        </div>
      `;
    };
    
    const getCurrentUserId = () => {
      try {
        const appData = localStorage.getItem('app');
        if (appData) {
          const parsed = JSON.parse(appData);
          return parsed?.user?.id || parsed?.user_id;
        }
      } catch (e) {}
      return null;
    };
    
    const updateVirtualScroll = (container, targetMessageIndex = null) => {
      const viewport = container.querySelector('.gm-messages-viewport');
      const scrollTop = viewport.scrollTop;
      const viewportHeight = viewport.clientHeight;
      
      const itemsPerPage = Math.ceil(viewportHeight / ITEM_HEIGHT);
      let startIndex, endIndex;
      
      if (targetMessageIndex !== null) {
        const contextSize = Math.floor(itemsPerPage / 2);
        startIndex = Math.max(0, targetMessageIndex - contextSize);
        endIndex = Math.min(startIndex + itemsPerPage + (BUFFER_SIZE * 2), allMessages.length);
        
        if (endIndex >= allMessages.length) {
          endIndex = allMessages.length;
          startIndex = Math.max(0, endIndex - itemsPerPage - (BUFFER_SIZE * 2));
        }
      } else {
        startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_SIZE);
        endIndex = Math.min(
          startIndex + itemsPerPage + (BUFFER_SIZE * 2),
          allMessages.length
        );
      }
      
      visibleMessages = allMessages.slice(startIndex, endIndex);
      
      const messagesHtml = visibleMessages.map((msg, i) => 
        renderMessage(msg, startIndex + i)
      ).join('');
      
      const totalHeight = allMessages.length * ITEM_HEIGHT;
      const offsetY = startIndex * ITEM_HEIGHT;
      
      viewport.innerHTML = `
        <div style="height: ${totalHeight + 160}px; position: relative; padding: 40px 0;">
          <div style="transform: translateY(${offsetY}px); min-height: ${ITEM_HEIGHT * visibleMessages.length}px; padding: 0 20px;">
            ${messagesHtml}
          </div>
        </div>
      `;

      
  // Removed internal auto-centering scroll to avoid double-jolt; navigateToMessage handles centering once
      
      // add click handlers for message details
      viewport.querySelectorAll('.gm-message-item').forEach(item => {
        item.addEventListener('click', (e) => {
          // Handle attachment clicks (open in new tab)
          if (e.target.classList.contains('gm-message-attachment-clickable')) {
            e.stopPropagation();
            const url = e.target.getAttribute('data-url');
            if (url) {
              window.open(url, '_blank');
            }
            return;
          }
          
          // Handle reply attachment clicks (navigate to message)
          const replyElem = e.target.closest('.gm-message-reply-attachment');
          if (replyElem && replyElem.hasAttribute('data-reply-id')) {
            e.stopPropagation();
            const replyId = replyElem.getAttribute('data-reply-id');
            if (replyId) {
              navigateToMessage(replyId);
            }
            return;
          }
          
          // Don't show details if clicking on reactions
          if (e.target.closest('.gm-message-reaction')) return;
          
          // Show message details
          const messageId = item.getAttribute('data-message-id');
          const message = allMessages.find(m => m.id === messageId);
          if (message) showMessageDetails(message);
        });
      });
    };
    
    const showMessageDetails = (message) => {
      const details = {
        'ID': message.id,
        'Name': message.name,
        'Message': message.text,
        'Timestamp': new Date(message.created_at * 1000).toISOString(),
        'Group ID': message.group_id,
        'User ID': message.user_id,
        'Sender Type': message.sender_type,
        'System': message.system ? 'Yes' : 'No',
        'Message Type': message.message_type,
        'Likes Count': message.likes_count || message.favorited_by?.length || 0,
        'Reactions': message.reactions ? JSON.stringify(message.reactions, null, 2) : 'None',
        'Pinned At': message.pinned_at ? new Date(message.pinned_at * 1000).toISOString() : 'Not pinned',
        'Pinned By': message.pinned_by || 'N/A',
        'Platform': message.platform,
        'Avatar URL': message.avatar_url,
        'Updated At': message.updated_at ? new Date(message.updated_at * 1000).toISOString() : 'Never',
        'Source GUID': message.source_guid,
        'Attachments': message.attachments ? JSON.stringify(message.attachments, null, 2) : 'None'
      };
      
      const content = Object.entries(details)
        .map(([key, value]) => `${key}: ${value || 'N/A'}`)
        .join('\n');
      
      const detailsModalInstance = Modal.create();
      const { modal, title, body, show } = detailsModalInstance;
      modal.className = 'gm-modal gm-message-details-modal';
      title.textContent = `Message Details - ${message.name}`;
      body.innerHTML = `<div class="gm-message-details-content"><pre style="background-color: #333333">${content}</pre></div>`;
      show();
    };
    
    const loadChatMessages = async (chatId, chatType) => {
      const container = currentModal.modal.querySelector('.gm-messages-container');
      const viewport = container.querySelector('.gm-messages-viewport');
      const messageCount = currentModal.modal.querySelector('.gm-message-count');
      
      viewport.innerHTML = '<div class="gm-loading-spinner">Loading messages...</div>';
      
      try {
        if (chatType === 'group') {
          allMessages = await Cache.getByGroup(chatId);
        } else {
          const allCached = await Cache.all();
          allMessages = allCached.filter(msg => {
            return (msg.is_dm || msg.conversation_id) && (
              msg.user_id === chatId || 
              msg.sender_id === chatId ||
              msg.dm_other_user_id === chatId ||
              (msg.conversation_id && msg.conversation_id.includes(chatId))
            );
          });
        }
        
        // sort by timestamp (newest first)
        allMessages.sort((a, b) => b.created_at - a.created_at);
        
        messageCount.textContent = `${allMessages.length.toLocaleString()} messages`;
        
        if (allMessages.length === 0) {
          viewport.innerHTML = '<div class="gm-no-messages">No messages found in cache</div>';
          return;
        }
        
        const currentFont = localStorage.getItem('gm-selected-font') || 'Poppins';
        viewport.style.fontFamily = FONT_MAP[currentFont] || currentFont;
        
        updateVirtualScroll(container);
        
        viewport.addEventListener('scroll', () => {
          if (!isNavigating) {
            updateVirtualScroll(container);
          }
        });
        
        // Check for pending jump message after loading
        if (pendingJumpMessageId) {
          console.log(`[GM+ Message Viewer] Processing pending jump to message ${pendingJumpMessageId}`);
          
          // Small delay to allow the DOM to update
          setTimeout(() => {
            navigateToMessage(pendingJumpMessageId);
            // Clear the pending message after processing
            pendingJumpMessageId = null;
          }, 500);
        }
        
      } catch (error) {
        console.error('[GM+ Message Viewer] Error loading messages:', error);
        viewport.innerHTML = '<div class="gm-no-messages">Error loading messages</div>';
      }
    };

    if (!document.getElementById('gm-plus-reaction-styles')) {
      const style = document.createElement('style');
      style.id = 'gm-plus-reaction-styles';
      style.textContent = `
        .gm-message-reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
        .gm-message-reaction { background:#2d2d2d; border-radius:16px; padding:2px 6px; display:inline-flex; align-items:center; font-size:12px; line-height:1; }
        .gm-message-reaction-emoji { margin-right:4px; }
      `;
      const append = () => {
        const headEl = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
        if (headEl) {
          headEl.appendChild(style);
        }
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          if (!document.getElementById('gm-plus-reaction-styles')) append();
        });
      } else {
        append();
      }
    }
    
    const populateChatSelector = async (selector) => {
      try {
        while (selector.children.length > 1) {
          selector.removeChild(selector.lastChild);
        }
        
        const [groupMapping, userMapping] = await Promise.all([
          getGroupMapping(),
          getUserMapping()
        ]);
        
        const cachedMessages = await Cache.all();
        const groups = new Map();
        const dms = new Map();
        
        cachedMessages.forEach(msg => {
          if (msg.group_id) {
            if (!groups.has(msg.group_id)) {
              const groupName = groupMapping.get(msg.group_id) || msg.group_name || `Group ${msg.group_id}`;
              groups.set(msg.group_id, {
                id: msg.group_id,
                name: groupName,
                type: 'group',
                lastMessage: msg.created_at
              });
            } else {
              const existing = groups.get(msg.group_id);
              if (msg.created_at > existing.lastMessage) {
                existing.lastMessage = msg.created_at;
              }
              if (msg.group_name && !existing.name.startsWith('Group ')) {
                existing.name = msg.group_name;
              }
            }
          } else if (msg.is_dm || msg.conversation_id) {
            const dmId = msg.dm_other_user_id || msg.user_id || msg.sender_id;
            if (dmId && !dms.has(dmId)) {
              const userName = userMapping.get(dmId) || msg.name || `User ${dmId}`;
              dms.set(dmId, {
                id: dmId,
                name: userName,
                type: 'dm',
                lastMessage: msg.created_at
              });
            } else if (dmId) {
              const existing = dms.get(dmId);
              if (msg.created_at > existing.lastMessage) {
                existing.lastMessage = msg.created_at;
              }
              const betterName = userMapping.get(dmId);
              if (betterName && existing.name.startsWith('User ')) {
                existing.name = betterName;
              }
            }
          }
        });
        
        groupMapping.forEach((name, id) => {
          if (!groups.has(id)) {
            groups.set(id, {
              id: id,
              name: name,
              type: 'group',
              lastMessage: 0
            });
          }
        });
        
        userMapping.forEach((name, id) => {
          if (!dms.has(id)) {
            dms.set(id, {
              id: id,
              name: name,
              type: 'dm',
              lastMessage: 0
            });
          }
        });
        
        const sortedGroups = Array.from(groups.values()).sort((a, b) => b.lastMessage - a.lastMessage);
        const sortedDMs = Array.from(dms.values()).sort((a, b) => b.lastMessage - a.lastMessage);
        
        sortedGroups.forEach(group => {
          const option = document.createElement('option');
          option.value = `group:${group.id}`;
          option.textContent = group.name;
          selector.appendChild(option);
        });
        
        sortedDMs.forEach(dm => {
          const option = document.createElement('option');
          option.value = `dm:${dm.id}`;
          option.textContent = `${dm.name} (DM)`;
          selector.appendChild(option);
        });
        
        console.log(`[GM+ Message Viewer] Populated selector with ${sortedGroups.length} groups and ${sortedDMs.length} DMs`);
        
      } catch (error) {
        console.error('[GM+ Message Viewer] Error populating chat selector:', error);
      }
    };
    
    const show = async () => {
      if (!Cache) {
        Modal.alert('Cache Not Available', 'Message cache is not available. Make sure the extension is properly loaded.', 'error');
        return;
      }
      
      const modalInstance = Modal.create();
      const { modal, title, body, show: showModal } = modalInstance;
      modal.className = 'gm-modal gm-message-viewer-modal';
      modal.style.pointerEvents = 'auto';
      
      currentModal = modalInstance;
      
      title.textContent = 'Message Viewer';
      
    body.innerHTML = `
        <div class="gm-message-viewer-header">
          <select class="gm-chat-selector">
            <option value="">Loading chats...</option>
          </select>
          <div class="gm-message-count">0 messages</div>
        </div>
        <div class="gm-messages-container">
      <div class="gm-messages-viewport">
            <div class="gm-no-messages">Select a chat to view messages</div>
          </div>
        </div>
      `;
      
      body.style.width = '95vw';
      body.style.maxWidth = '2000px';
      body.style.height = '80vh';
      body.style.maxHeight = '1600px';
      body.style.overflow = 'hidden';
      body.style.margin = '0';
      body.style.padding = '20px';
      body.style.boxSizing = 'border-box';
      
      const chatSelector = body.querySelector('.gm-chat-selector');
      
      showModal();
      
      setTimeout(async () => {
        try {
          await populateChatSelector(chatSelector);
          chatSelector.querySelector('option').textContent = 'Select a chat...';
        } catch (error) {
          console.error('[GM+ Message Viewer] Error populating selector:', error);
          chatSelector.innerHTML = '<option value="">Error loading chats</option>';
        }
      }, 10);
      
      chatSelector.addEventListener('change', async (e) => {
        const value = e.target.value;
        if (!value) return;
        const [type, id] = value.split(':');
        currentChat = { type, id };
        await loadChatMessages(id, type);
      });
    };
    
    const setPendingJumpMessage = (messageId) => {
      pendingJumpMessageId = messageId;
    };

    return { show, navigateToMessage, setPendingJumpMessage };
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
    eye: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-eye-icon lucide-eye"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`
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
      
      /* Custom Modal Styles */
      .gm-modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);z-index:2147483500;opacity:0;visibility:hidden;transition:all 0.2s ease}
      .gm-modal-overlay.show{opacity:1;visibility:visible}
      .gm-modal{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.8);background:#1a1a1a;border:1px solid #444;border-radius:12px;box-shadow:0 20px 40px rgba(0,0,0,0.5);max-width:1000px;width:95%;max-height:90vh;overflow:hidden;transition:transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)}
      .gm-modal-overlay.show .gm-modal{transform:translate(-50%,-50%) scale(1)}
      .gm-modal-header{padding:20px 24px 16px;border-bottom:1px solid #333;display:flex;align-items:center;justify-content:between}
      .gm-modal-title{color:#fff;font-size:18px;font-weight:600;margin:0;flex:1}
      .gm-modal-close{background:none;border:none;color:#888;font-size:24px;cursor:pointer;padding:0;width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center}
      .gm-modal-close:hover{background:#333;color:#fff}
      .gm-modal-body{padding:20px 24px;color:#ddd;line-height:1.5;max-height:75vh;overflow-y:auto}
      .gm-modal-footer{padding:16px 24px 20px;border-top:1px solid #333;display:flex;gap:12px;justify-content:flex-end}
      .gm-modal-btn{padding:10px 20px;border-radius:6px;border:none;font-size:14px;font-weight:500;cursor:pointer;transition:all 0.2s ease}
      .gm-modal-btn.primary{background:#667eea;color:#fff}
      .gm-modal-btn.primary:hover{background:#5a6fd8}
      .gm-modal-btn.secondary{background:#444;color:#fff}
      .gm-modal-btn.secondary:hover{background:#555}
      .gm-modal-btn.danger{background:#dc3545;color:#fff}
      .gm-modal-btn.danger:hover{background:#c82333}
      .gm-modal-content{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,'SF Mono',Monaco,Inconsolata,'Roboto Mono',Consolas,'Droid Sans Mono','Liberation Mono',monospace;font-size:13px;background:#0f0f0f;padding:16px;border-radius:6px;border:1px solid #333;margin:8px 0}
      .gm-modal-stats{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0}
      .gm-modal-stat{background:#222;padding:16px;border-radius:8px;text-align:center}
      .gm-modal-stat-value{font-size:24px;font-weight:700;color:#667eea;margin-bottom:4px}
      .gm-modal-stat-label{font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px}
      
      /* Search options styling */
      .gm-cache-pane input[type="checkbox"]{accent-color:#667eea;margin:0;width:14px;height:14px}
      .gm-cache-pane label{user-select:none}
      .gm-cache-pane label:hover{color:#fff}
      
      /* Message Viewer Modal Styles */
      .gm-message-viewer-modal{max-width:95vw;width:2000px;max-height:95vh;height:1400px}
      .gm-message-viewer-header{padding:16px 20px;border-bottom:1px solid #333;display:flex;align-items:center;gap:12px}
      .gm-chat-selector{background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;padding:8px 12px;flex:1;font-size:14px}
      .gm-chat-selector option{background:#2a2a2a;color:#fff}
      .gm-message-count{color:#888;font-size:12px;white-space:nowrap}
      .gm-messages-container{height:calc(100% - 120px);background:#292929;position:relative;overflow:hidden}
      .gm-messages-viewport{height:100%;overflow-y:auto;padding:0;box-sizing:border-box}
      .gm-message-item{position:relative;border-bottom:1px solid rgba(0,0,0,0);padding:12px 20px;transition:opacity 0.25s ease;color:#fff;font-size:14px;line-height:20px;min-height:60px;box-sizing:border-box}
      .gm-message-item:hover{background:rgba(255,255,255,0.02)}
      .gm-message-item.deleted{opacity:0.5}
      .gm-message-header{display:flex;align-items:center;gap:12px;margin-bottom:8px}
      .gm-message-avatar{width:32px;height:32px;border-radius:50%;background:#444;flex-shrink:0;overflow:hidden}
      .gm-message-avatar img{width:100%;height:100%;object-fit:cover}
      .gm-message-nickname{font-weight:500;color:#fff}
      .gm-message-timestamp{position:absolute;right:0;top:12px;color:#888;font-size:11px;opacity:0;transition:opacity 0.2s ease}
      .gm-message-item:hover .gm-message-timestamp{opacity:1}
      .gm-message-body{margin-left:44px}
      .gm-message-text{margin-bottom:4px;word-wrap:break-word}
      .gm-message-text.deleted{font-style:italic;color:#888}
      .gm-message-attachments{margin-top:8px}
      .gm-message-attachment{background:#333;border-radius:4px;padding:8px;margin-bottom:4px;font-size:12px;color:#ccc}
      .gm-message-reactions{margin-top:8px;display:flex;gap:4px;flex-wrap:wrap}
      .gm-message-reaction{background:#444;border-radius:12px;padding:2px 6px;font-size:11px;color:#ddd;display:flex;align-items:center;gap:2px}
      .gm-message-reaction-emoji{width:14px;height:14px;display:inline-block;vertical-align:middle;font-size:14px;line-height:14px}
      .gm-message-pill{position:absolute;left:-8px;top:50%;transform:translateY(-50%);width:4px;height:20px;background:#667eea;border-radius:2px}
      .gm-message-edited{color:#888;font-size:11px;font-style:italic}
      .gm-message-reply{border-left:3px solid #667eea;background:#333;border-radius:0 4px 4px 0;padding:8px 12px;margin-bottom:8px;font-size:12px}
      .gm-message-reply-name{font-weight:500;color:#667eea;margin-bottom:2px}
      .gm-message-reply-text{color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .gm-message-system{text-align:center;color:#888;font-style:italic;background:#1a1a1a;border-radius:4px;padding:8px;margin:4px 0}
      .gm-message-details-modal{max-width:600px;width:90vw}
      .gm-message-details-content{font-family:ui-monospace,SFMono-Regular,'SF Mono',monospace;font-size:12px;background:#0f0f0f;padding:16px;border-radius:6px;white-space:pre-wrap;max-height:60vh;overflow-y:auto}
      .gm-loading-spinner{display:flex;align-items:center;justify-content:center;height:200px;color:#888}
      .gm-no-messages{display:flex;align-items:center;justify-content:center;height:200px;color:#888;font-style:italic}
      
      /* Enhanced Message Highlighting Animations */
      @keyframes messageHighlight {
        0% { opacity: 0; transform: scale(0.95); box-shadow: 0 0 0 rgba(102, 126, 234, 0.4); }
        15% { opacity: 1; transform: scale(1); box-shadow: 0 0 20px rgba(102, 126, 234, 0.6); }
        50% { opacity: 1; transform: scale(1.02); box-shadow: 0 0 30px rgba(102, 126, 234, 0.8); }
        85% { opacity: 1; transform: scale(1); box-shadow: 0 0 20px rgba(102, 126, 234, 0.6); }
        100% { opacity: 0; transform: scale(0.95); box-shadow: 0 0 0 rgba(102, 126, 234, 0.4); }
      }
      @keyframes indicatorPulse {
        0% { opacity: 0; transform: translateY(-10px) scale(0.8); }
        15% { opacity: 1; transform: translateY(0) scale(1); }
        30% { opacity: 1; transform: translateY(0) scale(1.1); }
        50% { opacity: 1; transform: translateY(0) scale(1.05); }
        70% { opacity: 1; transform: translateY(0) scale(1.1); }
        85% { opacity: 1; transform: translateY(0) scale(1); }
        100% { opacity: 0; transform: translateY(-5px) scale(0.9); }
      }
      
      /* Message Found Animation */
      .gm-message-found {
        animation: messageFoundPulse 2s ease-in-out infinite;
      }
      @keyframes messageFoundPulse {
        0% { background: rgba(102, 126, 234, 0.1); }
        50% { background: rgba(102, 126, 234, 0.3); }
        100% { background: rgba(102, 126, 234, 0.1); }
      }
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

  const Stats = (() => {
    const handle = () => {};
    const init = pane => {
      buildStatsPane(pane);
    };
    return { handle, init };
  })();

  function buildStatsPane(pane) {
    pane.classList.add('gm-stats-pane');
    pane.style.cssText = 'padding: 12px;';

    // message analytics section
    const analyticsSection = document.createElement('div');
    analyticsSection.style.cssText = 'margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #333;';
    const analyticsTitle = document.createElement('h4');
    analyticsTitle.textContent = 'Message Analytics';
    analyticsTitle.style.cssText = 'margin:0 0 8px 0;color:#fff;';
    
    const analyticsGrid = document.createElement('div');
    analyticsGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;';
    
    const activityBtn = document.createElement('button');
    activityBtn.textContent = 'User Activity';
    activityBtn.className = 'gm-btn';
    activityBtn.style.cssText = 'background:#9c27b0;font-size:12px;';
    
    const timeAnalysisBtn = document.createElement('button');
    timeAnalysisBtn.textContent = 'Time Analysis';
    timeAnalysisBtn.className = 'gm-btn';
    timeAnalysisBtn.style.cssText = 'background:#ff9800;font-size:12px;';
    
    const wordCloudBtn = document.createElement('button');
    wordCloudBtn.textContent = 'Word Trends';
    wordCloudBtn.className = 'gm-btn';
    wordCloudBtn.style.cssText = 'background:#3f51b5;font-size:12px;';
    
    const exportAnalyticsBtn = document.createElement('button');
    exportAnalyticsBtn.textContent = 'Export Analytics';
    exportAnalyticsBtn.className = 'gm-btn';
    exportAnalyticsBtn.style.cssText = 'background:#00796b;font-size:12px;';
    
    analyticsGrid.append(activityBtn, timeAnalysisBtn, wordCloudBtn, exportAnalyticsBtn);
    analyticsSection.append(analyticsTitle, analyticsGrid);
    pane.appendChild(analyticsSection);

    // Advanced Search section
    const searchSection = document.createElement('div');
    searchSection.style.cssText = 'margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid #333;';
    
    const searchTitle = document.createElement('h4');
    searchTitle.textContent = 'Advanced Search';
    searchTitle.style.cssText = 'margin: 0 0 8px 0; color: #fff;';
    
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search messages...';
    searchInput.className = 'gm-search-input';
    searchInput.style.marginBottom = '8px';
    
    // Advanced filters container
    const filtersContainer = document.createElement('div');
    filtersContainer.style.cssText = 'background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:8px;margin-bottom:8px;';
    
    const filtersTitle = document.createElement('div');
    filtersTitle.textContent = 'Filters';
    filtersTitle.style.cssText = 'font-size:12px;color:#888;margin-bottom:8px;font-weight:600;';
    
    // Date range inputs
    const dateRow = document.createElement('div');
    dateRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;';
    
    const dateFromLabel = document.createElement('div');
    dateFromLabel.textContent = 'From Date:';
    dateFromLabel.style.cssText = 'font-size:11px;color:#888;margin-bottom:2px;';
    
    const dateFromInput = document.createElement('input');
    dateFromInput.type = 'date';
    dateFromInput.style.cssText = 'background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;padding:4px;font-size:12px;';
    dateFromInput.title = 'Start date for search range';
    
    const dateToLabel = document.createElement('div');
    dateToLabel.textContent = 'To Date:';
    dateToLabel.style.cssText = 'font-size:11px;color:#888;margin-bottom:2px;';
    
    const dateToInput = document.createElement('input');
    dateToInput.type = 'date';
    dateToInput.style.cssText = 'background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;padding:4px;font-size:12px;';
    dateToInput.title = 'End date for search range';
    
    const dateFromContainer = document.createElement('div');
    dateFromContainer.append(dateFromLabel, dateFromInput);
    
    const dateToContainer = document.createElement('div');
    dateToContainer.append(dateToLabel, dateToInput);
    
    dateRow.append(dateFromContainer, dateToContainer);
    
    // User filter
    const userInput = document.createElement('input');
    userInput.type = 'text';
    userInput.placeholder = 'Filter by user name...';
    userInput.style.cssText = 'width:100%;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;padding:4px;font-size:12px;margin-bottom:8px;';
    
    // Checkbox options
    const searchOptions = document.createElement('div');
    searchOptions.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; font-size: 12px;';
    
    const caseSensitiveLabel = document.createElement('label');
    caseSensitiveLabel.style.cssText = 'display: flex; align-items: center; gap: 4px; color: #ddd; cursor: pointer;';
    const caseSensitiveCheck = document.createElement('input'); 
    caseSensitiveCheck.type = 'checkbox'; 
    caseSensitiveCheck.id = 'gm-case-sensitive';
    caseSensitiveLabel.append(caseSensitiveCheck, document.createTextNode('Case sensitive'));
    
    const fullWordLabel = document.createElement('label');
    fullWordLabel.style.cssText = 'display: flex; align-items: center; gap: 4px; color: #ddd; cursor: pointer;';
    const fullWordCheck = document.createElement('input'); 
    fullWordCheck.type = 'checkbox'; 
    fullWordCheck.id = 'gm-full-word';
    fullWordLabel.append(fullWordCheck, document.createTextNode('Full word'));
    
    const attachmentsLabel = document.createElement('label');
    attachmentsLabel.style.cssText = 'display: flex; align-items: center; gap: 4px; color: #ddd; cursor: pointer;';
    const attachmentsCheck = document.createElement('input'); 
    attachmentsCheck.type = 'checkbox'; 
    attachmentsCheck.id = 'gm-has-attachments';
    attachmentsLabel.append(attachmentsCheck, document.createTextNode('Has attachments'));
    
    const systemMsgLabel = document.createElement('label');
    systemMsgLabel.style.cssText = 'display: flex; align-items: center; gap: 4px; color: #ddd; cursor: pointer;';
    const systemMsgCheck = document.createElement('input'); 
    systemMsgCheck.type = 'checkbox'; 
    systemMsgCheck.id = 'gm-exclude-system';
    systemMsgCheck.checked = true;
    systemMsgLabel.append(systemMsgCheck, document.createTextNode('Exclude system'));
    
    searchOptions.append(caseSensitiveLabel, fullWordLabel, attachmentsLabel, systemMsgLabel);
    
    filtersContainer.append(filtersTitle, dateRow, userInput, searchOptions);
    
    const searchButtonRow = document.createElement('div');
    searchButtonRow.style.cssText = 'display:flex;gap:8px;';
    
    const searchBtn = document.createElement('button'); 
    searchBtn.textContent = 'Search'; 
    searchBtn.className = 'gm-btn';
    searchBtn.style.cssText = 'background: #28a745; flex: 1;';
    
    const exportResultsBtn = document.createElement('button'); 
    exportResultsBtn.textContent = 'Export Results'; 
    exportResultsBtn.className = 'gm-btn';
    exportResultsBtn.style.cssText = 'background: #17a2b8; flex: 1;';
    exportResultsBtn.disabled = true;
    
    searchButtonRow.append(searchBtn, exportResultsBtn);
    
    const searchResults = document.createElement('div');
    searchResults.style.cssText = 'max-height: 300px; overflow-y: auto; margin-top: 8px; display: none;';
    
  searchSection.append(searchTitle, searchInput, filtersContainer, searchButtonRow, searchResults);
  // Expose for cross-pane handlers (e.g., cache clear)
  window.__gmPlusSearchResultsEl = searchResults;
  window.__gmPlusSearchInputEl = searchInput;
    pane.appendChild(searchSection);

    let currentSearchResults = [];

    const performSearch = async () => {
      Modal.close();
      const q = searchInput.value.trim(); 
      if (!q && !dateFromInput.value && !dateToInput.value && !userInput.value.trim()) { 
        searchResults.style.display = 'none'; 
        exportResultsBtn.disabled = true;
        return; 
      }
      if (!Cache) { 
        Modal.alert('Cache Unavailable','Cache not available','error'); 
        return; 
      }
      
      searchBtn.disabled = true; 
      searchBtn.textContent = 'Searching...';
      
      try {
        const options = {
          limit: 500,
          caseSensitive: caseSensitiveCheck.checked,
          fullWord: fullWordCheck.checked
        };
        
        // Add date filters
        if (dateFromInput.value) {
          const fromDate = new Date(dateFromInput.value + 'T00:00:00'); // Force local timezone at start of day
          options.dateFrom = Math.floor(fromDate.getTime() / 1000);
          console.log(`[GM+ Search] From date: ${dateFromInput.value} -> ${fromDate.toLocaleString()} -> ${options.dateFrom}`);
        }
        if (dateToInput.value) {
          const toDate = new Date(dateToInput.value + 'T23:59:59'); // Force local timezone at end of day
          options.dateTo = Math.floor(toDate.getTime() / 1000);
          console.log(`[GM+ Search] To date: ${dateToInput.value} -> ${toDate.toLocaleString()} -> ${options.dateTo}`);
        }
        
        if (options.dateFrom || options.dateTo) {
          options.limit = 5000;
        }
        
        if (attachmentsCheck.checked) {
          options.hasAttachments = true;
        }
        
        let results = await Cache.search(q, options);
        console.log(`[GM+ Search] Search completed. Query: "${q}", Options:`, options, `Results: ${results.length}`);
        
        if (results.length > 0) {
          console.log(`[GM+ Search] First few results:`, results.slice(0, 5).map(msg => ({
            name: msg.name,
            text: msg.text ? msg.text.substring(0, 50) + '...' : '[no text]',
            created_at: msg.created_at,
            date: new Date(msg.created_at * 1000).toLocaleString()
          })));
        }
        
        if (userInput.value.trim()) {
          const userFilter = userInput.value.trim().toLowerCase();
          results = results.filter(msg => 
            (msg.name || '').toLowerCase().includes(userFilter)
          );
        }

        if (dateFromInput.value || dateToInput.value) {
          results = results.filter(msg => {
            const msgDate = new Date(msg.created_at * 1000);
            let withinRange = true;
            
            if (dateFromInput.value) {
              const fromDate = new Date(dateFromInput.value + 'T00:00:00');
              withinRange = withinRange && msgDate >= fromDate;
            }
            
            if (dateToInput.value) {
              const toDate = new Date(dateToInput.value + 'T23:59:59');
              withinRange = withinRange && msgDate <= toDate;
            }
            
            return withinRange;
          });
          console.log(`[GM+ Search] After additional date filtering: ${results.length} results`);
        }

        if (systemMsgCheck.checked) {
          results = results.filter(msg => !msg.system && !msg.event);
        }
        
        currentSearchResults = results;
        
        if (!results.length) {
          searchResults.innerHTML = '<div style="color:#888;text-align:center;padding:16px;">No messages found matching your criteria</div>';
          exportResultsBtn.disabled = true;
        } else {
          const resultsHtml = results.slice(0, 100).map((msg, index) => {
            const dateStr = new Date(msg.created_at * 1000).toLocaleString();
            const attachmentInfo = msg.attachments?.length ? 
              `<div style="font-size:11px;color:#888;margin-top:4px;">📎 ${msg.attachments.length} attachment(s): ${msg.attachments.map(a => a.type || 'unknown').join(', ')}</div>` : '';
            
            const textContent = msg.text || (msg.system ? '[System Message]' : '[No text content]');
            const truncatedText = textContent.length > 150 ? textContent.substring(0, 150) + '...' : textContent;
            
            // Determine navigation parameters
            const groupId = msg.group_id || '';
            const otherUserId = msg.dm_other_user_id || (msg.is_dm ? msg.user_id : '') || '';
            const conversationId = msg.conversation_id || '';
            
            return `
              <div class="gm-search-result" style="background:#222;margin:4px 0;padding:8px;border-radius:4px;border-left:3px solid #667eea;cursor:pointer;transition:background-color 0.2s;" 
                   data-msg-id="${msg.id}"
                   data-group-id="${groupId}"
                   data-other-user-id="${otherUserId}"
                   data-conversation-id="${conversationId}"
                   onmouseover="this.style.backgroundColor='#333'"
                   onmouseout="this.style.backgroundColor='#222'"
                   title="Click to navigate to this message">
                <div style="font-size:12px;color:#888;margin-bottom:4px;display:flex;justify-content:space-between;">
                  <span>${msg.name || 'Unknown'} • ${dateStr}</span>
                  <span style="color:#667eea;">#${index + 1}</span>
                </div>
                <div style="font-size:14px;color:#ddd;margin-bottom:4px;">${truncatedText}</div>
                ${attachmentInfo}
                ${msg.group_id ? `<div style="font-size:10px;color:#666;">Group: ${msg.group_id}</div>` : ''}
                ${msg.is_dm ? `<div style="font-size:10px;color:#666;">💬 Direct Message</div>` : ''}
                ${msg.likes_count ? `<div style="font-size:10px;color:#666;">❤️ ${msg.likes_count} likes</div>` : ''}
                <div style="font-size:10px;color:#555;margin-top:4px;">🔗 Click to navigate</div>
              </div>
            `;
          }).join('');
          
          const summary = `
            <div style="background:#333;padding:8px;margin-bottom:8px;border-radius:4px;">
              <strong style="color:#fff;">Search Results: ${results.length} messages found</strong>
              ${results.length > 100 ? '<div style="color:#888;font-size:12px;">Showing first 100 results</div>' : ''}
              <div style="color:#667eea;font-size:12px;margin-top:4px;">💡 Click any result to navigate to that message</div>
            </div>
          `;
          
          searchResults.innerHTML = summary + resultsHtml;
          
          // Add event delegation for search result clicks
          searchResults.removeEventListener('click', handleSearchResultClick); // Remove any existing listener
          searchResults.addEventListener('click', handleSearchResultClick);
          
          exportResultsBtn.disabled = false;
        }
  searchResults.style.display = 'block';
  // re-open the stats pane to recalculate position, hacky fix
  open(2);
  pane.scrollTop = pane.scrollHeight;
      } catch (error) {
        console.error('[GM+ Search] Error:', error);
        searchResults.innerHTML = '<div style="color:#dc3545;text-align:center;padding:16px;">Search failed: ' + error.message + '</div>';
  searchResults.style.display = 'block';
  open(2);
  pane.scrollTop = pane.scrollHeight;
  exportResultsBtn.disabled = true;
      } finally {
        searchBtn.disabled = false; 
        searchBtn.textContent = 'Search';
      }
    };

    exportResultsBtn.onclick = async () => {
      if (!currentSearchResults.length) {
        Modal.alert('No Results', 'No search results to export.', 'error');
        return;
      }
      
      try {
        exportResultsBtn.disabled = true;
        exportResultsBtn.textContent = 'Exporting...';
        
        const csvHeaders = ['Index','ID','Name','Message','Timestamp','Group ID','User ID','Likes','Has Attachments','Message Type'];
        const csvRows = currentSearchResults.map((msg, index) => [
          index + 1,
          `"${(msg.id || '').replace(/"/g, '""')}"`,
          `"${(msg.name || '').replace(/"/g, '""')}"`,
          `"${(msg.text || '').replace(/"/g, '""')}"`,
          msg.created_at ? new Date(msg.created_at * 1000).toISOString() : '',
          `"${(msg.group_id || '').replace(/"/g, '""')}"`,
          `"${(msg.user_id || '').replace(/"/g, '""')}"`,
          msg.likes_count || 0,
          msg.attachments?.length > 0 ? 'Yes' : 'No',
          msg.system ? 'System' : (msg.event ? 'Event' : 'User')
        ].join(','));
        const csv = [csvHeaders.join(','), ...csvRows].join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `groupme_search_results_${Date.now()}.csv`;
        a.click();
        
        Modal.alert('Export Complete', `Successfully exported ${currentSearchResults.length} search results to CSV`, 'info');
      } catch (error) {
        console.error('[GM+ Search Export] Error:', error);
        Modal.alert('Export Error', `Error exporting search results: ${error.message}`, 'error');
      } finally {
        exportResultsBtn.disabled = false;
        exportResultsBtn.textContent = 'Export Results';
      }
    };
    
    searchBtn.onclick = performSearch; 
    searchInput.addEventListener('keypress', e => { 
      if (e.key === 'Enter') performSearch(); 
    });

    activityBtn.onclick = async () => {
      if (!Cache) {
        Modal.alert('Cache Unavailable', 'Cache not available for analytics', 'error');
        return;
      }
      
      activityBtn.disabled = true;
      activityBtn.textContent = 'Analyzing...';
      
      try {
        const messages = await Cache.all();
        if (!messages.length) {
          Modal.alert('No Data', 'No messages available for analysis', 'info');
          return;
        }
        
        // User activity analysis
        const userStats = {};
        const hourlyActivity = new Array(24).fill(0);
        const dailyActivity = {};
        
        messages.forEach(msg => {
          if (msg.system || !msg.name) return;
          
          // User stats
          if (!userStats[msg.name]) {
            userStats[msg.name] = { 
              messages: 0, 
              characters: 0, 
              attachments: 0, 
              likes_received: 0,
              first_message: msg.created_at,
              last_message: msg.created_at
            };
          }
          
          const stats = userStats[msg.name];
          stats.messages++;
          stats.characters += (msg.text || '').length;
          stats.attachments += (msg.attachments || []).length;
          stats.likes_received += (msg.likes_count || 0);
          stats.first_message = Math.min(stats.first_message, msg.created_at);
          stats.last_message = Math.max(stats.last_message, msg.created_at);
          
          // Time analysis
          const date = new Date(msg.created_at * 1000);
          const hour = date.getHours();
          const day = date.toDateString();
          
          hourlyActivity[hour]++;
          dailyActivity[day] = (dailyActivity[day] || 0) + 1;
        });
        
        // Sort users by message count
        const topUsers = Object.entries(userStats)
          .sort(([,a], [,b]) => b.messages - a.messages)
          .slice(0, 10);
        
        // Find peak activity times
        const peakHour = hourlyActivity.indexOf(Math.max(...hourlyActivity));
        const peakDay = Object.entries(dailyActivity)
          .sort(([,a], [,b]) => b - a)[0];
        
        const analysisHtml = `
          <div style="max-height:400px;overflow-y:auto;">
            <h3 style="color:#667eea;margin:0 0 16px 0;">User Activity Analysis</h3>
            
            <div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:12px;margin-bottom:16px;">
              <h4 style="color:#fff;margin:0 0 8px 0;">Top Contributors</h4>
              ${topUsers.map(([name, stats], index) => `
                <div style="margin-bottom:8px;padding:8px;background:#222;border-radius:4px;">
                  <div style="font-weight:600;color:#fff;">#${index + 1} ${name}</div>
                  <div style="font-size:12px;color:#888;margin-top:4px;">
                    📝 ${stats.messages.toLocaleString()} messages • 
                    📊 ${Math.round(stats.characters / stats.messages)} avg chars • 
                    📎 ${stats.attachments} attachments • 
                    ❤️ ${stats.likes_received} likes
                  </div>
                  <div style="font-size:11px;color:#666;margin-top:2px;">
                    Active: ${new Date(stats.first_message * 1000).toLocaleDateString()} to ${new Date(stats.last_message * 1000).toLocaleDateString()}
                  </div>
                </div>
              `).join('')}
            </div>
            
            <div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:12px;">
              <h4 style="color:#fff;margin:0 0 8px 0;">Activity Patterns</h4>
              <div style="margin-bottom:8px;">
                <strong style="color:#667eea;">Peak Hour:</strong> ${peakHour}:00 (${hourlyActivity[peakHour]} messages)
              </div>
              <div style="margin-bottom:8px;">
                <strong style="color:#667eea;">Most Active Day:</strong> ${peakDay ? peakDay[0] : 'N/A'} (${peakDay ? peakDay[1] : 0} messages)
              </div>
              <div style="margin-bottom:8px;">
                <strong style="color:#667eea;">Total Messages:</strong> ${messages.length.toLocaleString()}
              </div>
              <div>
                <strong style="color:#667eea;">Average per Day:</strong> ${Math.round(messages.length / Object.keys(dailyActivity).length)} messages
              </div>
            </div>
          </div>
        `;
        
        Modal.analytics('User Activity Analysis', analysisHtml);
        
      } catch (error) {
        console.error('[GM+ Analytics] User activity error:', error);
        Modal.alert('Analysis Error', `Failed to analyze user activity: ${error.message}`, 'error');
      } finally {
        activityBtn.disabled = false;
        activityBtn.textContent = 'User Activity';
      }
    };

    timeAnalysisBtn.onclick = async () => {
      if (!Cache) {
        Modal.alert('Cache Unavailable', 'Cache not available for analytics', 'error');
        return;
      }
      
      timeAnalysisBtn.disabled = true;
      timeAnalysisBtn.textContent = 'Analyzing...';
      
      try {
        const messages = await Cache.all();
        if (!messages.length) {
          Modal.alert('No Data', 'No messages available for analysis', 'info');
          return;
        }
        
        const hourlyData = new Array(24).fill(0);
        const weeklyData = new Array(7).fill(0);
        const monthlyData = {};
        
        messages.forEach(msg => {
          if (msg.system) return;
          
          const date = new Date(msg.created_at * 1000);
          hourlyData[date.getHours()]++;
          weeklyData[date.getDay()]++;
          
          const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          monthlyData[monthKey] = (monthlyData[monthKey] || 0) + 1;
        });
        
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const maxHourly = Math.max(...hourlyData);
        const maxWeekly = Math.max(...weeklyData);
        
        const timeAnalysisHtml = `
          <div style="max-height:400px;overflow-y:auto;">
            <h3 style="color:#667eea;margin:0 0 16px 0;">Time Analysis</h3>
            
            <div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:12px;margin-bottom:16px;">
              <h4 style="color:#fff;margin:0 0 8px 0;">Hourly Activity</h4>
              ${hourlyData.map((count, hour) => {
                const percentage = maxHourly > 0 ? (count / maxHourly) * 100 : 0;
                return `
                  <div style="display:flex;align-items:center;margin-bottom:4px;">
                    <div style="width:40px;color:#888;font-size:12px;">${hour}:00</div>
                    <div style="flex:1;background:#333;height:16px;border-radius:8px;overflow:hidden;margin:0 8px;">
                      <div style="background:#667eea;height:100%;width:${percentage}%;transition:width 0.3s;"></div>
                    </div>
                    <div style="width:40px;color:#ddd;font-size:12px;text-align:right;">${count}</div>
                  </div>
                `;
              }).join('')}
            </div>
            
            <div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:12px;">
              <h4 style="color:#fff;margin:0 0 8px 0;">Weekly Activity</h4>
              ${weeklyData.map((count, day) => {
                const percentage = maxWeekly > 0 ? (count / maxWeekly) * 100 : 0;
                return `
                  <div style="display:flex;align-items:center;margin-bottom:4px;">
                    <div style="width:80px;color:#888;font-size:12px;">${dayNames[day]}</div>
                    <div style="flex:1;background:#333;height:16px;border-radius:8px;overflow:hidden;margin:0 8px;">
                      <div style="background:#28a745;height:100%;width:${percentage}%;transition:width 0.3s;"></div>
                    </div>
                    <div style="width:40px;color:#ddd;font-size:12px;text-align:right;">${count}</div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
        
        Modal.analytics('Time Analysis', timeAnalysisHtml);
        
      } catch (error) {
        console.error('[GM+ Analytics] Time analysis error:', error);
        Modal.alert('Analysis Error', `Failed to analyze time patterns: ${error.message}`, 'error');
      } finally {
        timeAnalysisBtn.disabled = false;
        timeAnalysisBtn.textContent = 'Time Analysis';
      }
    };

    wordCloudBtn.onclick = async () => {
      if (!Cache) {
        Modal.alert('Cache Unavailable', 'Cache not available for analytics', 'error');
        return;
      }
      
      wordCloudBtn.disabled = true;
      wordCloudBtn.textContent = 'Analyzing...';
      
      try {
        const messages = await Cache.all();
        if (!messages.length) {
          Modal.alert('No Data', 'No messages available for analysis', 'info');
          return;
        }
        
        const wordCounts = {};
        const emojis = {};
        const commonWords = new Set(['the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'up', 'about', 'into', 'over', 'after', 'a', 'an', 'as', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'her', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs', 'this', 'that', 'these', 'those', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can', 'cant', 'cannot', 'may', 'might', 'must', 'shall']);
        
        messages.forEach(msg => {
          if (msg.system || !msg.text) return;
          
          // Extract words
          const words = msg.text.toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 2 && !commonWords.has(word));
          
          words.forEach(word => {
            wordCounts[word] = (wordCounts[word] || 0) + 1;
          });
          
          // Extract emojis
          const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
          const foundEmojis = msg.text.match(emojiRegex) || [];
          foundEmojis.forEach(emoji => {
            emojis[emoji] = (emojis[emoji] || 0) + 1;
          });
        });
        
        const topWords = Object.entries(wordCounts)
          .sort(([,a], [,b]) => b - a)
          .slice(0, 20);
        
        const topEmojis = Object.entries(emojis)
          .sort(([,a], [,b]) => b - a)
          .slice(0, 10);
        
        const maxWordCount = topWords[0] ? topWords[0][1] : 1;
        const maxEmojiCount = topEmojis[0] ? topEmojis[0][1] : 1;
        
        const wordTrendsHtml = `
          <div style="max-height:400px;overflow-y:auto;">
            <h3 style="color:#667eea;margin:0 0 16px 0;">Word Trends & Usage</h3>
            
            <div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:12px;margin-bottom:16px;">
              <h4 style="color:#fff;margin:0 0 8px 0;">Most Used Words</h4>
              ${topWords.map(([word, count]) => {
                const percentage = (count / maxWordCount) * 100;
                return `
                  <div style="display:flex;align-items:center;margin-bottom:4px;">
                    <div style="width:100px;color:#888;font-size:12px;text-transform:capitalize;">${word}</div>
                    <div style="flex:1;background:#333;height:16px;border-radius:8px;overflow:hidden;margin:0 8px;">
                      <div style="background:#3f51b5;height:100%;width:${percentage}%;transition:width 0.3s;"></div>
                    </div>
                    <div style="width:40px;color:#ddd;font-size:12px;text-align:right;">${count}</div>
                  </div>
                `;
              }).join('')}
            </div>
            
            ${topEmojis.length > 0 ? `
              <div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:12px;">
                <h4 style="color:#fff;margin:0 0 8px 0;">Popular Emojis</h4>
                ${topEmojis.map(([emoji, count]) => {
                  const percentage = (count / maxEmojiCount) * 100;
                  return `
                    <div style="display:flex;align-items:center;margin-bottom:4px;">
                      <div style="width:40px;font-size:16px;text-align:center;">${emoji}</div>
                      <div style="flex:1;background:#333;height:16px;border-radius:8px;overflow:hidden;margin:0 8px;">
                        <div style="background:#ff9800;height:100%;width:${percentage}%;transition:width 0.3s;"></div>
                      </div>
                      <div style="width:40px;color:#ddd;font-size:12px;text-align:right;">${count}</div>
                    </div>
                  `;
                }).join('')}
              </div>
            ` : ''}
          </div>
        `;
        
        Modal.analytics('Word Trends Analysis', wordTrendsHtml);
        
      } catch (error) {
        console.error('[GM+ Analytics] Word trends error:', error);
        Modal.alert('Analysis Error', `Failed to analyze word trends: ${error.message}`, 'error');
      } finally {
        wordCloudBtn.disabled = false;
        wordCloudBtn.textContent = 'Word Trends';
      }
    };

    exportAnalyticsBtn.onclick = async () => {
      if (!Cache) {
        Modal.alert('Cache Unavailable', 'Cache not available for analytics', 'error');
        return;
      }
      
      exportAnalyticsBtn.disabled = true;
      exportAnalyticsBtn.textContent = 'Generating...';
      
      try {
        const messages = await Cache.all();
        if (!messages.length) {
          Modal.alert('No Data', 'No messages available for analytics export', 'info');
          return;
        }
        
        // Generate comprehensive analytics
        const analytics = {
          summary: {
            total_messages: messages.length,
            date_range: {
              first_message: new Date(Math.min(...messages.map(m => m.created_at)) * 1000).toISOString(),
              last_message: new Date(Math.max(...messages.map(m => m.created_at)) * 1000).toISOString()
            },
            unique_users: new Set(messages.filter(m => !m.system).map(m => m.name)).size,
            total_attachments: messages.reduce((sum, m) => sum + (m.attachments?.length || 0), 0),
            total_likes: messages.reduce((sum, m) => sum + (m.likes_count || 0), 0)
          },
          user_stats: {},
          time_patterns: {
            hourly: new Array(24).fill(0),
            daily: new Array(7).fill(0),
            monthly: {}
          }
        };
        
        // user statistics and time patterns
        messages.forEach(msg => {
          if (!msg.system && msg.name) {
            if (!analytics.user_stats[msg.name]) {
              analytics.user_stats[msg.name] = {
                messages: 0,
                characters: 0,
                attachments: 0,
                likes_received: 0
              };
            }
            analytics.user_stats[msg.name].messages++;
            analytics.user_stats[msg.name].characters += (msg.text || '').length;
            analytics.user_stats[msg.name].attachments += (msg.attachments || []).length;
            analytics.user_stats[msg.name].likes_received += (msg.likes_count || 0);
          }
          
          const date = new Date(msg.created_at * 1000);
          analytics.time_patterns.hourly[date.getHours()]++;
          analytics.time_patterns.daily[date.getDay()]++;
          
          const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          analytics.time_patterns.monthly[monthKey] = (analytics.time_patterns.monthly[monthKey] || 0) + 1;
        });
        
        const analyticsJson = JSON.stringify(analytics, null, 2);
        const blob = new Blob([analyticsJson], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `groupme_analytics_${Date.now()}.json`;
        a.click();
        
        Modal.alert('Analytics Export Complete', `Successfully exported comprehensive analytics for ${messages.length.toLocaleString()} messages`, 'info');
        
      } catch (error) {
        console.error('[GM+ Analytics] Export error:', error);
        Modal.alert('Export Error', `Failed to export analytics: ${error.message}`, 'error');
      } finally {
        exportAnalyticsBtn.disabled = false;
        exportAnalyticsBtn.textContent = 'Export Analytics';
      }
    };
  }

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
    
    // hide dropdown when clicking outside
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
        
        // Use the FontFace API if available for more reliable detection
        if (window.FontFace && CSS && CSS.supports && CSS.supports('font-display', 'swap')) {
          const fontFace = new FontFace(fam, `url(https://fonts.gstatic.com/s/${fontName.toLowerCase()}/v1/${fontName.toLowerCase()}-${weight}.woff2)`);
          fontFace.load().then(() => {
            document.fonts.add(fontFace);
            console.log(`[GM+ Font] Font "${fam}" weight ${weight} loaded via FontFace API`);
          }).catch(error => {
            console.warn(`[GM+ Font] FontFace API failed for "${fam}", using CSS fallback:`, error);
            // Fall back to CSS detection
            checkFontLoadingFallback(fam, weight);
          });
        } else {
          // Fallback to the existing detection method
          checkFontLoadingFallback(fam, weight);
        }

        let st = $('#gm-font-style');
        if (!st) { st = document.createElement('style'); st.id = 'gm-font-style'; document.head.appendChild(st); }
        st.textContent =
          `body,*{font-family:${FONT_MAP[fam]} !important;font-weight:${weight} !important;color:${color} !important}`;
      }

      localStorage.setItem(KEY, JSON.stringify({ family:fam, weight:weightSel.value, color }));
    };

    // Separate function for the fallback font detection method
    const checkFontLoadingFallback = (fam, weight) => {
      setTimeout(() => {
        const testElement = document.createElement('div');
        testElement.style.cssText = `position:absolute;visibility:hidden;font-family:${FONT_MAP[fam]};font-size:72px;font-weight:${weight};`;
        testElement.textContent = 'Test Text 123';
        document.body.appendChild(testElement);
        
        const fallbackElement = document.createElement('div');
        fallbackElement.style.cssText = `position:absolute;visibility:hidden;font-family:serif;font-size:72px;font-weight:${weight};`;
        fallbackElement.textContent = 'Test Text 123';
        document.body.appendChild(fallbackElement);
        
        const fontLoaded = testElement.offsetWidth !== fallbackElement.offsetWidth;
        
        if (fontLoaded) {
          console.log(`[GM+ Font] Font "${fam}" weight ${weight} verified as loaded`);
        }
        
        document.body.removeChild(testElement);
        document.body.removeChild(fallbackElement);
      }, 1500); // 1.5 seconds to allow for slower loading
    };

    const reset = () => {
      selectedFont = defaults.family;
      searchInput.value = defaults.family;
      updateWeightOptions(defaults.family);
      weightSel.value = defaults.weight;
      colorIn.value = defaults.color;
      
      const st = $('#gm-font-style');
      if (st) st.remove();
      
      // clear localstorage
      localStorage.removeItem(KEY);
      
      console.log('[GM+ Font] Reset to defaults');
      apply();
    };

    [weightSel, colorIn].forEach(el => el.addEventListener('input', apply));
    resetBtn.addEventListener('click', reset);
    apply();
  }

  function buildCachePane(pane) {
    pane.classList.add('gm-cache-pane');

    // real-time monitor
    const realtimeSection = document.createElement('div');
    realtimeSection.style.cssText = 'margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #333;';
    
    const realtimeTitle = document.createElement('h4');
    realtimeTitle.textContent = 'Real-time Activity';
    realtimeTitle.style.cssText = 'margin:0 0 8px 0;color:#fff;';
    
    const activityIndicator = document.createElement('div');
    activityIndicator.style.cssText = 'background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:8px;margin-bottom:8px;';
    activityIndicator.innerHTML = '<div style="font-size:12px;color:#888;">Monitoring for new messages...</div>';
    
    const toggleMonitorBtn = document.createElement('button');
    toggleMonitorBtn.textContent = 'Auto-Cache: ON';
    toggleMonitorBtn.className = 'gm-btn';
    toggleMonitorBtn.style.cssText = 'width:100%;background:#28a745;margin-bottom:8px;';
    
    let isMonitoring = true;
    let messageCount = 0;
    let lastMessageTime = null;
    
    toggleMonitorBtn.onclick = () => {
      isMonitoring = !isMonitoring;
      toggleMonitorBtn.textContent = `Auto-Cache: ${isMonitoring ? 'ON' : 'OFF'}`;
      toggleMonitorBtn.style.background = isMonitoring ? '#28a745' : '#6c757d';
      
      if (isMonitoring) {
        activityIndicator.innerHTML = '<div style="font-size:12px;color:#888;">▶️ Monitoring resumed...</div>';
      } else {
        activityIndicator.innerHTML = '<div style="font-size:12px;color:#f57c00;">⏸️ Monitoring paused</div>';
      }
    };
    
    realtimeSection.append(realtimeTitle, activityIndicator, toggleMonitorBtn);
    pane.appendChild(realtimeSection);

    // bulk fetch section
    const bulkSection = document.createElement('div');
    bulkSection.style.cssText = 'margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #333;';
    const bulkTitle = document.createElement('h4');
    bulkTitle.textContent = 'Bulk Fetch';
    bulkTitle.style.cssText = 'margin:0 0 8px 0;color:#fff;';
    const convSelect = document.createElement('select');
    convSelect.style.cssText = 'width:100%;padding:6px;border:1px solid #444;border-radius:4px;background:#2a2a2a;color:#fff;margin-bottom:8px;';
    const defaultOption = document.createElement('option'); defaultOption.value = ''; defaultOption.textContent = 'Select Group or DM...';
    convSelect.appendChild(defaultOption);
    const fetchBtn = document.createElement('button');
    fetchBtn.textContent = 'Smart Fetch Messages';
    fetchBtn.className = 'gm-btn';
    fetchBtn.style.cssText = 'width:100%;background:#17a2b8;margin-bottom:8px;';
    
    const analyzeBtn = document.createElement('button');
    analyzeBtn.textContent = 'Analyze Cache';
    analyzeBtn.className = 'gm-btn';
    analyzeBtn.style.cssText = 'width:100%;background:#28a745;margin-bottom:8px;';
    
    const fullFetchBtn = document.createElement('button');
    fullFetchBtn.textContent = 'Full Fetch (Override)';
    fullFetchBtn.className = 'gm-btn';
    fullFetchBtn.style.cssText = 'width:100%;background:#dc3545;margin-bottom:8px;';
    
    bulkSection.append(bulkTitle, convSelect, fetchBtn, analyzeBtn, fullFetchBtn);
    pane.appendChild(bulkSection);

    convSelect.addEventListener('change', () => {
      fetchBtn.textContent = 'Smart Fetch Messages';
    });
    
    // Populate dropdown with groups and DMs from IndexedDB
    (async () => {
      try {
        console.log('[GM+ Bulk Fetch] Populating conversation selector from IndexedDB...');
        
        // Get groups
        const groupMapping = await getGroupMapping();
        console.log(`[GM+ Bulk Fetch] Found ${groupMapping.size} groups`);
        
        groupMapping.forEach((name, id) => {
          const opt = document.createElement('option');
          opt.value = `group:${id}`;
          opt.textContent = name;
          convSelect.appendChild(opt);
        });
        
        // Get DMs
        const userMapping = await getUserMapping();
        console.log(`[GM+ Bulk Fetch] Found ${userMapping.size} users`);
        
        userMapping.forEach((name, id) => {
          const opt = document.createElement('option');
          opt.value = `dm:${id}`;
          opt.textContent = `${name} (DM)`;
          convSelect.appendChild(opt);
        });
        
        console.log(`[GM+ Bulk Fetch] Populated selector with ${groupMapping.size} groups and ${userMapping.size} DMs`);
      } catch (error) {
        console.error('[GM+ Bulk Fetch] Error populating selector:', error);
      }
    })();

    // Analyze cache button - shows what's cached and what would be fetched
    analyzeBtn.onclick = async () => {
      const sel = convSelect.value;
      if (!sel) return Modal.alert('Select Conversation', 'Please select a group or direct message.', 'error');
      
      if (!SmartFetch) return Modal.alert('Smart Fetch Unavailable', 'Smart fetching requires cache to be enabled.', 'error');
      
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = 'Analyzing...';
      
      try {
        const [type, id] = sel.split(':');
        const boundaries = await SmartFetch.getCacheBoundaries(id, type === 'dm');
        
        let message = '';
        if (!boundaries.hasCache) {
          message = `No cached messages found.\nFull fetch will download all messages.`;
          fetchBtn.textContent = 'Smart Fetch (Full Download)';
        } else {
          const oldestStr = boundaries.oldestDate ? boundaries.oldestDate.toLocaleDateString() : 'Unknown';
          const newestStr = boundaries.newestDate ? boundaries.newestDate.toLocaleDateString() : 'Unknown';
          message = `Cache Analysis:\n\n• ${boundaries.count} messages cached\n• From: ${oldestStr}\n• To: ${newestStr}\n\nSmart fetch will only download new messages since ${newestStr}.`;
          fetchBtn.textContent = `Smart Fetch (New Since ${newestStr})`;
        }
        
        Modal.alert('Cache Analysis', message, 'info');
      } catch (error) {
        console.error('[GM+ Analyze] Error:', error);
        Modal.alert('Analysis Error', `Failed to analyze cache: ${error.message}`, 'error');
      } finally {
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = 'Analyze Cache';
      }
    };

    // Smart fetch button - uses incremental fetching when possible
    fetchBtn.onclick = async () => {
      const sel = convSelect.value;
      if (!sel) return Modal.alert('Select Conversation', 'Please select a group or direct message.', 'error');
      
      fetchBtn.disabled = true;
      const originalText = fetchBtn.textContent;
      let total = 0;
      
      try {
        const [type, id] = sel.split(':');
        
        if (!SmartFetch) {
          // Fallback to original fetch method if smart fetch unavailable
          console.log('[GM+ Bulk Fetch] Smart fetch unavailable, using full fetch');
          fetchBtn.textContent = 'Using full fetch...';
          return await legacyFullFetch(type, id, (count, text) => {
            total = count;
            fetchBtn.textContent = text;
          });
        }
        
        const result = await SmartFetch.smartFetch(type, id, (status) => {
          fetchBtn.textContent = status;
        });
        
        if (result.mode === 'error') {
          throw result.error;
        }
        
        if (result.mode === 'full') {
          // No cache found or gaps detected, do full fetch
          if (result.reason === 'gaps_in_history') {
            fetchBtn.textContent = 'Gaps in cache detected, doing full fetch...';
          } else {
            fetchBtn.textContent = 'No cache found, doing full fetch...';
          }
          await legacyFullFetch(type, id, (count, text) => {
            total = count;
            fetchBtn.textContent = text;
          });
          // Show success for full fetch fallback
          fetchBtn.textContent = 'Fetch Successful';
          setTimeout(() => {
            fetchBtn.textContent = originalText;
          }, 3000);
          return;
        }
        
        if (result.alreadyUpToDate) {
          total = result.boundaries.count;
          fetchBtn.textContent = 'Already Up to Date';
          setTimeout(() => {
            fetchBtn.textContent = originalText;
          }, 3000);
          const latestStr = result.boundaries.newestDate ? result.boundaries.newestDate.toLocaleString() : 'Unknown';
          Modal.alert('Already Up to Date', `Cache is current with ${total} messages.\nLatest message: ${latestStr}`, 'info');
        } else {
          total = result.boundaries.count + result.newMessages.length;
          fetchBtn.textContent = 'Fetch Successful';
          setTimeout(() => {
            fetchBtn.textContent = originalText;
          }, 3000);
          const latestTs = result.newMessages[0]?.created_at || result.boundaries.newest?.created_at;
          const latestStr = latestTs ? new Date(latestTs * 1000).toLocaleString() : 'Unknown';
          Modal.alert('Smart Fetch Complete', `Found ${result.newMessages.length} new messages!\n\nTotal cached: ${total} messages\nLatest: ${latestStr}`, 'info');
        }
        
      } catch (error) {
        console.error('[GM+ Smart Fetch] Error:', error);
        Modal.alert('Fetch Error', `Smart fetch failed: ${error.message}`, 'error');
      } finally {
        fetchBtn.disabled = false;
        // Don't reset text immediately if showing success message
        if (!fetchBtn.textContent.includes('Successful') && !fetchBtn.textContent.includes('Up to Date')) {
          fetchBtn.textContent = originalText;
        }
      }
    };

    fullFetchBtn.onclick = async () => {
      const sel = convSelect.value;
      if (!sel) return Modal.alert('Select Conversation', 'Please select a group or direct message.', 'error');
      
      Modal.confirm(
        'Full Fetch Override',
        'This will download ALL messages, even if they are already cached. This may take a long time and use significant bandwidth. Are you sure?',
        async () => {
          fullFetchBtn.disabled = true;
          const originalText = fullFetchBtn.textContent;
          let total = 0;
          
          try {
            const [type, id] = sel.split(':');
            await legacyFullFetch(type, id, (count, text) => {
              total = count;
              fullFetchBtn.textContent = text;
            });
            Modal.alert('Full Fetch Complete', `Downloaded and cached ${total} messages.`, 'info');
          } catch (error) {
            console.error('[GM+ Full Fetch] Error:', error);
            Modal.alert('Full Fetch Error', `Failed: ${error.message}`, 'error');
          } finally {
            fullFetchBtn.disabled = false;
            fullFetchBtn.textContent = originalText;
          }
        }
      );
    };

    async function legacyFullFetch(type, id, progressCallback) {
      let beforeId = '';
      let total = 0;
      const headers = getAuthHeaders();
      let retryCount = 0;
      const maxRetries = 5;
      
      while (true) {
        let url = '';
        if (type === 'group') {
          url = `https://api.groupme.com/v3/groups/${id}/messages?acceptFiles=1&limit=100${beforeId?`&before_id=${beforeId}`:''}`;
        } else {
          url = `https://api.groupme.com/v3/direct_messages?acceptFiles=1&limit=100&other_user_id=${id}${beforeId?`&before_id=${beforeId}`:''}`;
        }
        
        try {
          console.log(`[GM+ Legacy Fetch] Fetching ${type} messages from:`, url);
          const resp = await fetch(url, { headers, credentials: 'omit' });
          
          if (!resp.ok) {
            if (resp.status === 429) {
              retryCount++;
              if (retryCount > maxRetries) {
                console.error(`[GM+ Legacy Fetch] Rate limit exceeded after ${maxRetries} retries`);
                throw new Error(`Rate limit exceeded after ${maxRetries} retries`);
              }
              
              const backoffTime = Math.pow(1.5, retryCount) * 1000; // 1.5s, 2.25s, 3.375s
              console.warn(`[GM+ Legacy Fetch] Rate limited (429), retrying in ${backoffTime}ms (attempt ${retryCount}/${maxRetries})`);
              
              if (progressCallback) {
                progressCallback(total, `Rate limited, retrying in ${Math.round(backoffTime/1000)}s... (${total} messages so far)`);
              }
              
              await new Promise(resolve => setTimeout(resolve, backoffTime));
              continue;
            } else if (resp.status === 304) {
              console.log(`[GM+ Legacy Fetch] No more messages (304)`);
              break;
            } else {
              console.warn(`[GM+ Legacy Fetch] API request failed: ${resp.status} ${resp.statusText}`);
              throw new Error(`API request failed: ${resp.status} ${resp.statusText}`);
            }
          }
          
          retryCount = 0;
          
          const jd = await resp.json();
          let msgs = [];
          if (type === 'group') {
            msgs = (jd.response && jd.response.messages) || [];
          } else {
            msgs = (jd.response && jd.response.direct_messages) || [];
          }
          
          if (!msgs.length) break;
          
          const batch = Object.fromEntries(msgs.map(m => [m.id, m]));
          await Cache.store(batch);
          total += msgs.length;
          
          if (progressCallback) {
            progressCallback(total, `Fetched ${total} messages...`);
          }
          
          beforeId = msgs[msgs.length - 1].id;
          
          // Small delay to be nice to the silly API
          await new Promise(resolve => setTimeout(resolve, 10));
          
        } catch (error) {
          if (error.name === 'TypeError' && error.message.includes('fetch')) {
            // Network error - treat like rate limit
            retryCount++;
            if (retryCount > maxRetries) {
              console.error(`[GM+ Legacy Fetch] Network error after ${maxRetries} retries:`, error);
              throw error;
            }
            
            const backoffTime = Math.pow(1.5, retryCount) * 1000;
            console.warn(`[GM+ Legacy Fetch] Network error, retrying in ${backoffTime}ms (attempt ${retryCount}/${maxRetries}):`, error.message);
            
            if (progressCallback) {
              progressCallback(total, `Network error, retrying in ${Math.round(backoffTime/1000)}s... (${total} messages so far)`);
            }
            
            await new Promise(resolve => setTimeout(resolve, backoffTime));
            continue; // Retry the same request
          } else {
            // Other errors - rethrow
            throw error;
          }
        }
      }
      
      return total;
    }

    // Enhanced Data Management Section
    const managementSection = document.createElement('div');
    managementSection.style.cssText = 'margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #333;';
    
    const managementTitle = document.createElement('h4');
    managementTitle.textContent = 'Data Management';
    managementTitle.style.cssText = 'margin:0 0 8px 0;color:#fff;';
    
    // Storage usage display
    const storageInfo = document.createElement('div');
    storageInfo.style.cssText = 'background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:8px;margin-bottom:8px;';
    storageInfo.innerHTML = '<div style="font-size:12px;color:#888;">Loading storage usage...</div>';
    
    const managementGrid = document.createElement('div');
    managementGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;';
    
    
    const validateBtn = document.createElement('button'); 
    validateBtn.textContent = 'Validate Cache';
    validateBtn.className = 'gm-btn';
    validateBtn.style.cssText = 'background:#17a2b8;';
    
  const backupBtn = document.createElement('button'); 
  backupBtn.textContent = 'Backup Cache';
  backupBtn.className = 'gm-btn';
  backupBtn.style.cssText = 'background:#28a745;';

  const importBtn = document.createElement('button');
  importBtn.textContent = 'Import Backup';
  importBtn.className = 'gm-btn';
  importBtn.style.cssText = 'background:#007bff;';
    
    const cleanupBtn = document.createElement('button'); 
    cleanupBtn.textContent = 'Smart Cleanup';
    cleanupBtn.className = 'gm-btn';
    cleanupBtn.style.cssText = 'background:#f57c00;color:#000;';
    
  managementGrid.append(validateBtn, backupBtn, importBtn, cleanupBtn);
    
    // Import/Export row
    const importExportRow = document.createElement('div');
    importExportRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;';
    
    const exportBtn = document.createElement('button'); 
    exportBtn.textContent = 'Export Cache';
    exportBtn.className = 'gm-btn';
    exportBtn.style.cssText = 'background:#388e3c;';
    
    const clearBtn = document.createElement('button'); 
    clearBtn.textContent = 'Clear Cache';
    clearBtn.className = 'gm-btn';
    clearBtn.style.cssText = 'background:#dc3545;';
    
    importExportRow.append(exportBtn, clearBtn);
    
    managementSection.append(managementTitle, storageInfo, managementGrid, importExportRow);
    pane.appendChild(managementSection);

    // Enhanced Data Management Functions
    const updateStorageInfo = async () => {
      try {
        if (!Cache) {
          storageInfo.innerHTML = '<div style="font-size:12px;color:#dc3545;">Cache unavailable</div>';
          return;
        }
        
        const stats = await Cache.stats();
        const validation = await Cache.validate();
        
        // Estimate storage usage
        const bytesPerChar = 2; // UTF-16 encoding
        const estimatedSize = validation.totalSize || 0;
        const sizeInMB = (estimatedSize / (1024 * 1024)).toFixed(2);
        
        storageInfo.innerHTML = `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
            <div>
              <div style="color:#667eea;font-weight:600;">${stats.messages.toLocaleString()}</div>
              <div style="color:#888;">Messages</div>
            </div>
            <div>
              <div style="color:#28a745;font-weight:600;">${stats.edits.toLocaleString()}</div>
              <div style="color:#888;">Edits Tracked</div>
            </div>
            <div>
              <div style="color:#ff9800;font-weight:600;">${sizeInMB} MB</div>
              <div style="color:#888;">Storage Used</div>
            </div>
            <div>
              <div style="color:#${validation.invalid > 0 ? 'dc3545' : '28a745'};font-weight:600;">${validation.valid.toLocaleString()}</div>
              <div style="color:#888;">Valid Messages</div>
            </div>
          </div>
          ${validation.invalid > 0 ? `<div style="color:#dc3545;font-size:11px;margin-top:4px;">⚠️ ${validation.invalid} corrupted messages detected</div>` : ''}
        `;
      } catch (error) {
        console.error('[GM+ Storage] Update error:', error);
        storageInfo.innerHTML = '<div style="font-size:12px;color:#dc3545;">Error loading storage info</div>';
      }
    };
    
    // Initialize storage info
    updateStorageInfo();
    

    validateBtn.onclick = async () => {
      if (!Cache) {
        Modal.alert('Cache Unavailable', 'Cache not available', 'error');
        return;
      }
      
      validateBtn.disabled = true;
      validateBtn.textContent = 'Validating...';
      
      try {
        const validation = await Cache.validate();
        
        const validationHtml = `
          <div style="max-height:300px;overflow-y:auto;">
            <h3 style="color:#667eea;margin:0 0 16px 0;">Cache Validation Results</h3>
            
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
              <div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:12px;text-align:center;">
                <div style="font-size:24px;font-weight:700;color:#28a745;">${validation.valid.toLocaleString()}</div>
                <div style="color:#888;font-size:12px;">Valid Messages</div>
              </div>
              <div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:12px;text-align:center;">
                <div style="font-size:24px;font-weight:700;color:${validation.invalid > 0 ? '#dc3545' : '#28a745'};">${validation.invalid.toLocaleString()}</div>
                <div style="color:#888;font-size:12px;">Invalid Messages</div>
              </div>
            </div>
            
            <div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:12px;margin-bottom:16px;">
              <div style="color:#fff;font-weight:600;margin-bottom:8px;">Storage Information</div>
              <div style="color:#ddd;margin-bottom:4px;">Compressed Size: ${(validation.totalSize / (1024 * 1024)).toFixed(2)} MB</div>
              <div style="color:#888;font-size:12px;">Estimated uncompressed: ~${(validation.totalSize * 3 / (1024 * 1024)).toFixed(2)} MB</div>
            </div>
            
            ${validation.issues.length > 0 ? `
              <div style="background:#1a1a1a;border:1px solid #f57c00;border-radius:4px;padding:12px;">
                <div style="color:#f57c00;font-weight:600;margin-bottom:8px;">Issues Found (${validation.issues.length})</div>
                ${validation.issues.slice(0, 10).map(issue => `
                  <div style="color:#ddd;font-size:12px;margin-bottom:4px;padding:4px;background:#333;border-radius:2px;">
                    ${issue}
                  </div>
                `).join('')}
                ${validation.issues.length > 10 ? `
                  <div style="color:#888;font-size:11px;margin-top:8px;">
                    ... and ${validation.issues.length - 10} more issues
                  </div>
                ` : ''}
              </div>
            ` : `
              <div style="background:#1a1a1a;border:1px solid #28a745;border-radius:4px;padding:12px;text-align:center;">
                <div style="color:#28a745;font-size:16px;">✅ Cache is healthy!</div>
                <div style="color:#888;font-size:12px;margin-top:4px;">No issues detected</div>
              </div>
            `}
          </div>
        `;
        
        Modal.alert('Cache Validation', validationHtml, validation.invalid > 0 ? 'error' : 'info');
        
        // Update storage info after validation
        await updateStorageInfo();
        
      } catch (error) {
        console.error('[GM+ Validation] Error:', error);
        Modal.alert('Validation Error', `Failed to validate cache: ${error.message}`, 'error');
      } finally {
        validateBtn.disabled = false;
        validateBtn.textContent = 'Validate Cache';
      }
    };

    backupBtn.onclick = async () => {
      if (!Cache) {
        Modal.alert('Cache Unavailable', 'Cache not available for backup', 'error');
        return;
      }
      
      backupBtn.disabled = true;
      backupBtn.textContent = 'Creating Backup...';
      
      try {
        const [messages, stats] = await Promise.all([
          Cache.all(),
          Cache.stats()
        ]);
        
        if (!messages.length) {
          Modal.alert('No Data', 'No messages to backup', 'info');
          return;
        }
        
        const backup = {
          version: '1.0',
          created_at: new Date().toISOString(),
          stats: stats,
          messages: messages,
          metadata: {
            extension_version: '1.1.1',
            browser: navigator.userAgent,
            total_size_estimate: messages.length * 200 // rough estimate
          }
        };
        
        const backupJson = JSON.stringify(backup, null, 2);
        const blob = new Blob([backupJson], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `groupme_cache_backup_${Date.now()}.json`;
        a.click();
        
        Modal.alert('Backup Complete', `Successfully created backup with ${messages.length.toLocaleString()} messages\n\nFile size: ${(blob.size / (1024 * 1024)).toFixed(2)} MB`, 'info');
        
      } catch (error) {
        console.error('[GM+ Backup] Error:', error);
        Modal.alert('Backup Error', `Failed to create backup: ${error.message}`, 'error');
      } finally {
        backupBtn.disabled = false;
        backupBtn.textContent = 'Backup Cache';
      }
    };

    exportBtn.onclick = async () => {
      if (!Cache) return Modal.alert('Cache Unavailable', 'Cache not available', 'error');
      const modal = Modal.create();
      modal.title.textContent = 'Export Messages';
      const body = document.createElement('div');
      body.style.cssText = 'font-size:12px;color:#ddd;';
      body.innerHTML = `
        <div style="margin-bottom:12px;">
          <label style="display:block;margin-bottom:4px;font-weight:600;color:#fff;">Format</label>
          <select id="gm-export-format" style="width:100%;padding:6px;background:#111;color:#fff;border:1px solid #333;border-radius:4px;">
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:4px;max-height:220px;overflow:auto;border:1px solid #222;padding:6px;border-radius:4px;background:#0f0f0f;margin-bottom:12px;" id="gm-export-fields"></div>
        <div style="margin-bottom:8px;">
          <label style="display:block;margin-bottom:4px;font-weight:600;color:#fff;">Filters (optional)</label>
          <input id="gm-export-group" placeholder="Group ID" style="width:100%;padding:6px;margin-bottom:4px;background:#111;color:#fff;border:1px solid #333;border-radius:4px;" />
          <input id="gm-export-user" placeholder="User ID" style="width:100%;padding:6px;background:#111;color:#fff;border:1px solid #333;border-radius:4px;" />
        </div>
        <div style="color:#888;font-size:11px;">Select the fields to include. Large exports may take time.</div>`;
      const fields = [
        ['id','ID'],['name','Name'],['text','Message'],['created_at','Timestamp'],['group_id','Group ID'],['user_id','User ID'],['sender_type','Sender Type'],['system','System'],['message_type','Message Type'],['likes_count','Likes Count'],['reactions','Reactions'],['pinned_at','Pinned At'],['pinned_by','Pinned By'],['platform','Platform'],['avatar_url','Avatar URL'],['updated_at','Updated At'],['source_guid','Source GUID'],['attachments','Attachments']
      ];
      const fieldContainer = body.querySelector('#gm-export-fields');
      fields.forEach(([key,label]) => {
        const id = 'gm-exp-'+key;
        const wrap = document.createElement('label');
        wrap.style.cssText='display:flex;align-items:center;gap:4px;background:#1a1a1a;padding:4px;border:1px solid #222;border-radius:3px;font-size:11px;';
        wrap.innerHTML = `<input type="checkbox" id="${id}" value="${key}" ${['id','text','created_at'].includes(key)?'checked':''}/> <span>${label}</span>`;
        fieldContainer.appendChild(wrap);
      });
      modal.body.appendChild(body);
      const exportBtnInner = document.createElement('button');
      exportBtnInner.textContent = 'Export';
      exportBtnInner.className = 'gm-btn';
      exportBtnInner.style.cssText='background:#28a745;width:100%;margin-top:8px;';
      modal.footer.appendChild(exportBtnInner);
      exportBtnInner.onclick = async () => {
        try {
          exportBtnInner.disabled = true; exportBtnInner.textContent='Working...';
          const allMsgs = await Cache.all();
          if (!allMsgs.length) return Modal.alert('No Data','No messages to export','info');
          const format = modal.body.querySelector('#gm-export-format').value;
          const groupFilter = modal.body.querySelector('#gm-export-group').value.trim();
          const userFilter = modal.body.querySelector('#gm-export-user').value.trim();
          let msgs = allMsgs;
          if (groupFilter) msgs = msgs.filter(m=>m.group_id===groupFilter);
          if (userFilter) msgs = msgs.filter(m=>m.user_id===userFilter || m.sender_id===userFilter);
          const selected = [...modal.body.querySelectorAll('#gm-export-fields input:checked')].map(i=>i.value);
          if (!selected.length) return Modal.alert('No Fields','Select at least one field to export','error');
          if (format==='json') {
            const simplified = msgs.map(m=>{ const o={}; selected.forEach(k=>{ o[k]=m[k]; }); return o; });
            const blob = new Blob([JSON.stringify(simplified,null,2)],{type:'application/json'});
            const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`groupme_export_${Date.now()}.json`; a.click();
            Modal.alert('Export Complete',`Exported ${simplified.length.toLocaleString()} messages (JSON)`,'info');
          } else {
            const header = selected.map(h=>`"${h.replace(/"/g,'""')}"`).join(',');
            const rows = msgs.map(m=> selected.map(f=> {
              let v = m[f];
              if (f==='created_at' || f==='updated_at' || f==='pinned_at') v = v? new Date(v*1000).toISOString():'';
              if (f==='system') v = !!v;
              if (f==='attachments' || f==='reactions') v = v? JSON.stringify(v):'';
              if (v==null) v='';
              const s = String(v).replace(/"/g,'""');
              return `"${s}"`;
            }).join(','));
            const csv = [header,...rows].join('\r\n');
            const blob = new Blob([csv],{type:'text/csv'});
            const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`groupme_export_${Date.now()}.csv`; a.click();
            Modal.alert('Export Complete',`Exported ${msgs.length.toLocaleString()} messages (CSV)`,'info');
          }
          modal.close();
        } catch(e){
          console.error('[GM+ Export] Error:', e);
          Modal.alert('Export Error', e.message,'error');
        } finally { exportBtnInner.disabled=false; exportBtnInner.textContent='Export'; }
      };
      modal.show();
    };

    importBtn.onclick = () => {
      if (!Cache) return Modal.alert('Cache Unavailable','Cache not available','error');
      const modal = Modal.create();
      modal.title.textContent='Import Backup';
      const body = document.createElement('div');
      body.style.cssText='font-size:12px;color:#ddd;';
      body.innerHTML = `
        <input type="file" id="gm-import-file" accept="application/json" style="width:100%;padding:8px;background:#111;color:#fff;border:1px solid #333;border-radius:4px;margin-bottom:12px;" />
        <div style="margin-bottom:8px;">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" id="gm-import-merge" checked /> <span>Merge with existing cache (uncheck to clear then import)</span>
          </label>
        </div>
        <div style="color:#888;font-size:11px;">Large imports may freeze the tab briefly. Data is stored compressed.</div>`;
      modal.body.appendChild(body);
      const importBtnInner = document.createElement('button');
      importBtnInner.textContent='Start Import';
      importBtnInner.className='gm-btn';
      importBtnInner.style.cssText='background:#28a745;width:100%;margin-top:8px;';
      modal.footer.appendChild(importBtnInner);
      importBtnInner.onclick = async () => {
        const fileInput = modal.body.querySelector('#gm-import-file');
        const merge = modal.body.querySelector('#gm-import-merge').checked;
        const file = fileInput.files?.[0];
        if (!file) return Modal.alert('No File','Choose a backup file first','error');
        try {
          importBtnInner.disabled=true; importBtnInner.textContent='Importing...';
          const text = await file.text();
          const json = JSON.parse(text);
          if (!json.messages || !Array.isArray(json.messages)) throw new Error('Invalid backup file');
          if (!merge) {
            // clear existing cache
            const db = await Cache.open();
            await new Promise((res,rej)=>{ const tx=db.transaction(['messages','edits'],'readwrite'); tx.objectStore('messages').clear(); tx.objectStore('edits').clear?.(); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); });
          }
            // store messages in batches of 500
          const batchSize = 500; let stored = 0;
          for (let i=0;i<json.messages.length;i+=batchSize) {
            const slice = json.messages.slice(i,i+batchSize);
            const batch = Object.fromEntries(slice.map(m=>[m.id,m]));
            await Cache.store(batch); stored += slice.length;
          }
          Modal.alert('Import Complete',`Imported ${json.messages.length.toLocaleString()} messages${merge?' (merged)':''}.`,'info');
          await updateStorageInfo();
          modal.close();
        } catch(e){
          console.error('[GM+ Import] Error:', e);
          Modal.alert('Import Error', e.message,'error');
        } finally { importBtnInner.disabled=false; importBtnInner.textContent='Start Import'; }
      };
      modal.show();
    };
    cleanupBtn.onclick = async () => {
      try {
        if (!Cache) {
          Modal.alert('Cache Unavailable', 'Cache not available - LZString library not loaded', 'error');
          return;
        }
        cleanupBtn.textContent = 'Analyzing...';
        cleanupBtn.disabled = true;
        const dryRun = await Cache.cleanup({ olderThanDays: 30, dryRun: true });
        if (dryRun.deleted === 0) {
          Modal.alert('No Cleanup Needed', 'No old messages found to clean up.', 'info');
          return;
        }
        Modal.confirm(
          'Cleanup Old Data',
          `Found ${dryRun.deleted.toLocaleString()} messages older than 30 days. This action cannot be undone.`,
          async () => {
            try {
              cleanupBtn.textContent = 'Cleaning...';
              const result = await Cache.cleanup({ olderThanDays: 30, dryRun: false });
              Modal.alert('Cleanup Complete', `Successfully deleted ${result.deleted.toLocaleString()} old messages.`, 'info');
            } catch (error) {
              console.error('[GM+ Cache] Cleanup error:', error);
              Modal.alert('Cleanup Error', `Error during cleanup:\n\n${error.message}`, 'error');
            }
          }
        );
      } catch (error) {
        console.error('[GM+ Cache] Cleanup analysis error:', error);
        Modal.alert('Analysis Error', `Error analyzing cache:\n\n${error.message}`, 'error');
      } finally {
        cleanupBtn.textContent = 'Cleanup Old Data';
        cleanupBtn.disabled = false;
      }
    };
    clearBtn.onclick = async () => {
      Modal.confirm(
        'Clear Cache',
        'Are you sure you want to clear all cached messages? This action cannot be undone.',
        async () => {
          try {
            if (!Cache) {
              Modal.alert('Cache Unavailable', 'Cache not available - LZString library not loaded', 'error');
              return;
            }
            const db = await Cache.open();
            const tx = db.transaction(['messages', 'editHistory'], 'readwrite');
            await Promise.all([
              new Promise((resolve, reject) => { const r = tx.objectStore('messages').clear(); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); }),
              new Promise((resolve, reject) => { const r = tx.objectStore('editHistory').clear(); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); })
            ]);
            Modal.alert('Cache Cleared', 'Cache cleared successfully.', 'info');
            if (window.__gmPlusSearchResultsEl) window.__gmPlusSearchResultsEl.style.display = 'none';
            if (window.__gmPlusSearchInputEl) window.__gmPlusSearchInputEl.value = '';
          } catch (error) {
            console.error('[GM+ Cache] Clear error:', error);
            Modal.alert('Clear Error', `Error clearing cache:\n\n${error.message}`, 'error');
          }
        }
      );
    };
  }

  function buildJumpPane(pane) {
    // Add API test section first
    const testSection = document.createElement('div');
    testSection.style.cssText = 'margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid #333;';
    
    const testTitle = document.createElement('h4');
    testTitle.textContent = 'API Test';
    testTitle.style.cssText = 'margin: 0 0 8px 0; color: #fff;';
    
    const testBtn = document.createElement('button');
    testBtn.textContent = 'Test API Access';
    testBtn.className = 'gm-btn';
    testBtn.style.cssText = 'width: 100%; background: #28a745; margin-bottom: 8px;';
    
    const testResults = document.createElement('div');
    testResults.style.cssText = 'font-size: 12px; color: #ddd; background: #1a1a1a; padding: 8px; border-radius: 4px; display: none;';
    
    testBtn.onclick = async () => {
      testBtn.textContent = 'Testing...';
      testBtn.disabled = true;
      testResults.style.display = 'block';
      testResults.innerHTML = 'Testing API access...';
      
      try {
        const headers = getAuthHeaders();
        console.log('[GM+ API Test] Headers:', headers);
        
        // Test with a generic groups endpoint first
        const response = await fetch('https://api.groupme.com/v3/groups', {
          method: 'GET',
          headers: headers,
          credentials: 'omit'
        });
        
        if (response.ok) {
          const data = await response.json();
          const groupCount = data.response?.length || 0;
          let resultText = `✅ API Access Working!<br>Found ${groupCount} groups<br>Status: ${response.status}`;
          
          // Test specific group access if we have groups
          if (groupCount > 0) {
            const firstGroup = data.response[0];
            testResults.innerHTML = resultText + '<br><br>Testing specific group access...';
            
            try {
              const groupResponse = await fetch(`https://api.groupme.com/v3/groups/${firstGroup.id}`, {
                method: 'GET',
                headers: headers,
                credentials: 'omit'
              });
              
              if (groupResponse.ok) {
                const groupData = await groupResponse.json();
                resultText += `<br>✅ Group "${firstGroup.name}" accessible<br>Members: ${groupData.response?.members?.length || 0}`;
                
                // Show navigation capabilities
                resultText += `<br><br>🔗 Navigation Test:<br>Current URL: ${window.location.pathname}<br>History API: ${window.history ? '✅' : '❌'}`;
              } else {
                resultText += `<br>❌ Group access failed: ${groupResponse.status}`;
              }
            } catch (groupError) {
              resultText += `<br>❌ Group test error: ${groupError.message}`;
            }
          }
          
          testResults.innerHTML = resultText;
          testResults.style.color = '#28a745';
        } else {
          testResults.innerHTML = `❌ API Error<br>Status: ${response.status}<br>Response: ${await response.text().catch(() => 'Unable to read response')}`;
          testResults.style.color = '#dc3545';
        }
      } catch (error) {
        testResults.innerHTML = `❌ Network Error<br>${error.message}`;
        testResults.style.color = '#dc3545';
        console.error('[GM+ API Test] Error:', error);
      }
      
      testBtn.textContent = 'Test API Access';
      testBtn.disabled = false;
    };
    
    testSection.append(testTitle, testBtn, testResults);
    
    // Add advanced navigation test
    const navTestBtn = document.createElement('button');
    navTestBtn.textContent = 'Test SPA Navigation';
    navTestBtn.className = 'gm-btn';
    navTestBtn.style.cssText = 'width: 100%; background: #667eea; margin-bottom: 8px;';
    
    const navTestResults = document.createElement('div');
    navTestResults.style.cssText = 'font-size: 12px; color: #ddd; background: #1a1a1a; padding: 8px; border-radius: 4px; display: none; margin-bottom: 8px;';
    
    navTestBtn.onclick = async () => {
      navTestBtn.textContent = 'Testing Navigation...';
      navTestBtn.disabled = true;
      navTestResults.style.display = 'block';
      navTestResults.innerHTML = 'Testing SPA navigation methods...';
      
      try {
        const currentUrl = window.location.href;
        let resultText = `Current URL: ${currentUrl}<br><br>`;
        
        if (window.history && window.history.pushState) {
          resultText += '✅ History API available<br>';
          
          let eventsFired = [];
          
          const testPopState = () => eventsFired.push('popstate');
          const testNavigate = () => eventsFired.push('navigate');
          const testRouteChange = () => eventsFired.push('routechange');
          
          window.addEventListener('popstate', testPopState);
          window.addEventListener('navigate', testNavigate);
          window.addEventListener('routechange', testRouteChange);
          
          const testPath = '/chats/test-navigation';
          window.history.pushState({}, '', testPath);
          window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
          window.dispatchEvent(new CustomEvent('navigate', { 
            detail: { path: testPath } 
          }));
          
          window.dispatchEvent(new CustomEvent('routechange', { detail: { path: testPath } }));
          
          setTimeout(() => {
            window.removeEventListener('popstate', testPopState);
            window.removeEventListener('navigate', testNavigate);
            window.removeEventListener('routechange', testRouteChange);
            
            window.history.pushState({}, '', currentUrl);
            
            resultText += `Events fired: ${eventsFired.length > 0 ? eventsFired.join(', ') : 'none'}<br>`;
            resultText += `URL changed to: ${window.location.pathname}<br>`;
            resultText += `URL restored to original<br><br>`;
            
            const frameworks = [];
            if (window.React) frameworks.push('React');
            if (window.Vue) frameworks.push('Vue');
            if (window.Angular) frameworks.push('Angular');
            if (window.router) frameworks.push('router');
            if (window.Backbone) frameworks.push('Backbone');
            
            resultText += `Detected frameworks: ${frameworks.length > 0 ? frameworks.join(', ') : 'none'}<br>`;
            
            const routerChecks = [
              'window.router',
              'window.app?.router',
              'window.GroupMe?.router',
              'window.__NEXT_DATA__',
              'window.__reactInternalInstance'
            ];
            
            const foundRouters = routerChecks.filter(check => {
              try {
                return eval(check);
              } catch (e) {
                return false;
              }
            });
            
            resultText += `Router objects: ${foundRouters.length > 0 ? foundRouters.join(', ') : 'none'}`;
            
            navTestResults.innerHTML = resultText;
            navTestResults.style.color = '#667eea';
          }, 100);
          
        } else {
          resultText += '❌ History API not available<br>';
          navTestResults.innerHTML = resultText;
          navTestResults.style.color = '#dc3545';
        }
        
      } catch (error) {
        navTestResults.innerHTML = `❌ Navigation Test Error<br>${error.message}`;
        navTestResults.style.color = '#dc3545';
        console.error('[GM+ Nav Test] Error:', error);
      }
      
      navTestBtn.textContent = 'Test SPA Navigation';
      navTestBtn.disabled = false;
    };
    
    testSection.append(navTestBtn, navTestResults);
    
    // Add DM URL investigation tool
    const dmTestBtn = document.createElement('button');
    dmTestBtn.textContent = 'Investigate DM URLs';
    dmTestBtn.className = 'gm-btn';
    dmTestBtn.style.cssText = 'width: 100%; background: #f57c00; margin-bottom: 8px;';
    
    const dmTestResults = document.createElement('div');
    dmTestResults.style.cssText = 'font-size: 12px; color: #ddd; background: #1a1a1a; padding: 8px; border-radius: 4px; display: none; margin-bottom: 8px;';
    
    dmTestBtn.onclick = async () => {
      dmTestBtn.textContent = 'Investigating...';
      dmTestBtn.disabled = true;
      dmTestResults.style.display = 'block';
      dmTestResults.innerHTML = 'Investigating DM URL patterns...';
      
      try {
        let resultText = `Current URL: ${window.location.href}<br><br>`;
        
        // Check if we can access the DMs API
        const headers = getAuthHeaders();
        
        try {
          const chatsResponse = await fetch('https://api.groupme.com/v3/chats', {
            method: 'GET',
            headers: headers,
            credentials: 'omit'
          });
          
          if (chatsResponse.ok) {
            const chatsData = await chatsResponse.json();
            const chats = chatsData.response || [];
            resultText += `✅ Found ${chats.length} DM conversations<br><br>`;
            
            if (chats.length > 0) {
              const firstChat = chats[0];
              resultText += `Sample DM structure:<br>`;
              resultText += `- ID: ${firstChat.id}<br>`;
              resultText += `- Other User: ${firstChat.other_user?.name} (ID: ${firstChat.other_user?.id})<br>`;
              resultText += `- Created: ${new Date(firstChat.created_at * 1000).toLocaleDateString()}<br><br>`;
              
              // Test different URL patterns
              const testUrls = [
                `https://web.groupme.com/chats/${firstChat.id}`,
                `https://web.groupme.com/direct_messages/${firstChat.id}`,
                `https://web.groupme.com/dms/${firstChat.id}`,
                `https://web.groupme.com/conversations/${firstChat.id}`,
                `https://web.groupme.com/chats/${firstChat.other_user?.id}`,
                `https://web.groupme.com/direct_messages/${firstChat.other_user?.id}`
              ];
              
              resultText += `Possible DM URLs to test:<br>`;
              testUrls.forEach((url, i) => {
                resultText += `${i + 1}. <a href="${url}" target="_blank" style="color: #667eea;">${url}</a><br>`;
              });
              
              resultText += `<br>Try clicking the links above to see which one works!`;
            }
          } else {
            resultText += `❌ Chats API failed: ${chatsResponse.status}<br>`;
          }
        } catch (apiError) {
          resultText += `❌ API Error: ${apiError.message}<br>`;
        }
        
        // Also check the current page for hints about URL structure
        const currentPath = window.location.pathname;
        if (currentPath.includes('chats') || currentPath.includes('direct') || currentPath.includes('dm')) {
          resultText += `<br>📍 Current page appears to be a chat/DM page<br>`;
          resultText += `Path pattern: ${currentPath}<br>`;
          
          // Look for DM indicators in the DOM
          const dmIndicators = [
            document.querySelector('[data-chat-id]'),
            document.querySelector('[data-conversation-id]'),
            document.querySelector('[data-dm-id]'),
            document.querySelector('.direct-message'),
            document.querySelector('.dm-conversation')
          ].filter(Boolean);
          
          if (dmIndicators.length > 0) {
            resultText += `Found ${dmIndicators.length} potential DM elements in DOM<br>`;
          }
        }
        
        dmTestResults.innerHTML = resultText;
        dmTestResults.style.color = '#f57c00';
        
      } catch (error) {
        dmTestResults.innerHTML = `❌ Investigation Error<br>${error.message}`;
        dmTestResults.style.color = '#dc3545';
        console.error('[GM+ DM Investigation] Error:', error);
      }
      
      dmTestBtn.textContent = 'Investigate DM URLs';
      dmTestBtn.disabled = false;
    };
    
    testSection.append(dmTestBtn, dmTestResults);
    pane.appendChild(testSection);

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
              b.onclick = async () => {
                try {
                  if (store === 'Groups') {
                    console.log(`[GM+ Quick Jump] Navigating to group ${rec.id}`);
                    try {
                      const response = await fetch(`https://api.groupme.com/v3/groups/${rec.id}`, {
                        method: 'GET',
                        headers: getAuthHeaders(),
                        credentials: 'omit'
                      });
                      
                      if (response.ok) {
                        const groupData = await response.json();
                        console.log(`[GM+ Quick Jump] Group data retrieved:`, groupData.response);
                        
                        const groupId = rec.id;
                        
                        if (window.history && window.history.pushState) {
                          const newUrl = `/chats/${groupId}`;
                          window.history.pushState({}, '', newUrl);
                          
                          window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
                          
                          window.dispatchEvent(new CustomEvent('navigate', { 
                            detail: { path: `/chats/${groupId}`, groupId } 
                          }));
                          
                          console.log(`[GM+ Quick Jump] Attempted programmatic navigation to ${newUrl}`);
                        } else {
                          window.location.href = `https://web.groupme.com/chats/${groupId}`;
                        }
                      } else {
                        console.warn(`[GM+ Quick Jump] Group API returned ${response.status}, using fallback navigation`);
                        window.location.href = `https://web.groupme.com/chats/${rec.id}`;
                      }
                    } catch (apiError) {
                      console.warn(`[GM+ Quick Jump] API call failed: ${apiError.message}, using fallback navigation`);
                      window.location.href = `https://web.groupme.com/chats/${rec.id}`;
                    }
                  } else {
                    console.log(`[GM+ Quick Jump] Navigating to conversation ${rec.id}`);
                    // For DMs, we need to investigate the correct URL pattern
                    console.log(`[GM+ Quick Jump] DM record:`, rec);
                    
                    // Try multiple DM navigation approaches
                    const dmId = rec.id;
                    const otherUserId = rec.other_user?.id || rec.other_user_id;
                    
                    console.log(`[GM+ Quick Jump] DM ID: ${dmId}, Other User ID: ${otherUserId}`);
                    
                    // Method 1: Try the direct chats approach first
                    if (window.history && window.history.pushState) {
                      // Try different URL patterns for DMs
                      const possiblePaths = [
                        `/chats/${dmId}`,
                        `/direct_messages/${dmId}`,
                        `/dms/${dmId}`,
                        `/conversations/${dmId}`,
                        otherUserId ? `/chats/${otherUserId}` : null,
                        otherUserId ? `/direct_messages/${otherUserId}` : null
                      ].filter(Boolean);
                      
                      console.log(`[GM+ Quick Jump] Trying DM navigation paths:`, possiblePaths);
                      
                      // Try the first path
                      const testPath = possiblePaths[0];
                      window.history.pushState({}, '', testPath);
                      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
                      window.dispatchEvent(new CustomEvent('navigate', { 
                        detail: { path: testPath, conversationId: dmId, otherUserId: otherUserId } 
                      }));
                      
                      console.log(`[GM+ Quick Jump] Attempted programmatic DM navigation to ${testPath}`);
                      
                      // If that doesn't work after a short delay, try fallback approaches
                      setTimeout(() => {
                        // Check if we're on the right page by looking for indicators
                        const currentPath = window.location.pathname;
                        console.log(`[GM+ Quick Jump] Current path after navigation attempt: ${currentPath}`);
                        
                        // If we're not on the expected path, try other methods
                        if (!currentPath.includes(dmId) && !currentPath.includes(otherUserId)) {
                          console.log(`[GM+ Quick Jump] Primary DM navigation failed, trying alternative approaches`);
                          
                          // Try direct URL navigation as fallback
                          const fallbackUrls = [
                            `https://web.groupme.com/chats/${dmId}`,
                            `https://web.groupme.com/direct_messages/${dmId}`,
                            otherUserId ? `https://web.groupme.com/chats/${otherUserId}` : null
                          ].filter(Boolean);
                          
                          console.log(`[GM+ Quick Jump] Trying fallback URLs:`, fallbackUrls);
                          window.location.href = fallbackUrls[0];
                        }
                      }, 1000);
                    } else {
                      // Fallback: direct navigation
                      console.log(`[GM+ Quick Jump] No History API, using direct navigation`);
                      window.location.href = `https://web.groupme.com/chats/${dmId}`;
                    }
                  }
                } catch (error) {
                  console.error('[GM+ Quick Jump] Navigation error:', error);
                  console.log(`[GM+ Quick Jump] Attempting direct navigation as fallback`);
                  window.location.href = `https://web.groupme.com/chats/${rec.id}`;
                }
              };
              wrap.appendChild(b);
            });
          };
        };
        render('Groups', 'Groups');
        render('DMs',    'Direct Messages');
      } catch (e) {
        console.error('[GM+ Jump] Error:', e);
        pane.innerHTML = `<div style="color: #dc3545; text-align: center; padding: 20px;">Quick‑jump failed: ${e.message}</div>`;
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
    const statsPane  = paneFactory('stats');   Stats.init(statsPane);

    panes.push({ btn: addTrayBtn(tray, SVGs.font,  'Fonts',        () => open(0)), pane: fontPane  });
    panes.push({ btn: addTrayBtn(tray, SVGs.save,  'MessageCacher', () => open(1)), pane: cachePane });
    panes.push({ btn: addTrayBtn(tray, SVGs.bars,  'Stats',         () => open(2)), pane: statsPane });
    addTrayBtn(tray, SVGs.eye, 'Message Viewer', () => MessageViewer.show());

    let isDragging = false;
    let dragStartTarget = null;
    
    document.addEventListener('mousedown', e => {
      isDragging = false;
      dragStartTarget = e.target;
    });
    
    document.addEventListener('mousemove', e => {
      if (dragStartTarget) {
        isDragging = true;
      }
    });
    
    document.addEventListener('click', e => {
      if (isDragging) {
        isDragging = false;
        dragStartTarget = null;
        return;
      }
      
      if (e.target.closest('.gm-modal-overlay') || e.target.classList.contains('gm-modal-overlay')) {
        return;
      }
      
      if (sidebar && 
          !sidebar.contains(e.target) && 
          !e.target.classList.contains('gm-plus-btn') &&
          !e.target.closest('.gm-plus-btn')) {
        sidebar.classList.add('gm-hidden');
        panes.forEach(p => p.btn.classList.remove('active'));
      }
      
      isDragging = false;
      dragStartTarget = null;
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

  console.log('[GM+ Cache] Setting up message listener...');
  
  // Rate limiting for cache operations
  const rateLimiter = {
    queue: [],
    processing: false,
    maxBatchSize: 100,
    debounceTime: 500,
    
    add(payload) {
      this.queue.push(payload);
      this.process();
    },
    
    async process() {
      if (this.processing || this.queue.length === 0) return;
      
      this.processing = true;
      
      await new Promise(resolve => setTimeout(resolve, this.debounceTime));
      
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.maxBatchSize);
        const combinedPayload = {};
        
        for (const payload of batch) {
          Object.assign(combinedPayload, payload);
        }
        
        if (Object.keys(combinedPayload).length > 0) {
          try {
            const result = await Cache.store(combinedPayload);
            if (result) {
              console.log(`[GM+ Cache] Batch processed: ${result.stored} stored, ${result.edited} edited`);
            }
          } catch (error) {
            console.error('[GM+ Cache] Batch processing failed:', error);
          }
        }
        
        if (this.queue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      this.processing = false;
    }
  };
  
  window.addEventListener('message', ev => {
    if (ev.source !== window) return;
    if (ev.data?.type === 'GM_MESSAGES') {
      const messageCount = Object.keys(ev.data.payload || {}).length;
      console.log(`[GM+ Cache] Received ${messageCount} messages from page script`);
      
      const indicator = document.querySelector('.gm-cache-pane')?.querySelector('[style*="Monitoring"]')?.parentElement;
      if (indicator && messageCount > 0) {
        const isNewMessage = ev.data.metadata?.source === 'realtime' || ev.data.metadata?.new_count > 0;
        const currentTime = new Date().toLocaleTimeString();
        
        if (isNewMessage) {
          indicator.innerHTML = `
            <div style="font-size:12px;color:#28a745;">
              ✅ ${messageCount} new message${messageCount > 1 ? 's' : ''} cached at ${currentTime}
            </div>
            <div style="font-size:11px;color:#666;margin-top:2px;">
              Source: ${ev.data.metadata?.source || 'unknown'} | Batch #${ev.data.metadata?.batch_id || '?'}
            </div>
          `;
          
          setTimeout(() => {
            if (indicator) {
              indicator.innerHTML = '<div style="font-size:12px;color:#888;">Monitoring for new messages...</div>';
            }
          }, 3000);
        }
      }
      
      if (Cache && messageCount > 0) {
        rateLimiter.add(ev.data.payload);
      } else if (!Cache) {
        console.warn('[GM+ Cache] Cache not available, messages not stored');
      } else if (messageCount === 0) {
        console.log('[GM+ Cache] Received empty message payload');
      }
      
      Stats.handle(ev.data.payload);
    }
  });

  const checkForPendingNavigation = () => {
    const targetData = sessionStorage.getItem('gm_plus_target_message');
    if (targetData) {
      try {
        const target = JSON.parse(targetData);
        const age = Date.now() - target.timestamp;
        
        if (age < 30000) {
          console.log('[GM+ Search Navigation] Found pending navigation:', target);
          
          sessionStorage.removeItem('gm_plus_target_message');
          
          setTimeout(() => {
            console.log('[GM+ Search Navigation] Starting context loading from sessionStorage');
            loadMessageContext(target.messageId, target.groupId, target.conversationId || target.otherUserId);
          }, 3000);
        } else {
          console.log('[GM+ Search Navigation] Clearing old navigation intent (age:', age, 'ms)');
          sessionStorage.removeItem('gm_plus_target_message');
        }
      } catch (error) {
        console.error('[GM+ Search Navigation] Error parsing pending navigation:', error);
        sessionStorage.removeItem('gm_plus_target_message');
      }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(checkForPendingNavigation, 1000);
    });
  } else {
    setTimeout(checkForPendingNavigation, 1000);
  }

})();
