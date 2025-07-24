(() => {
  'use strict';

  // Inject the page script to intercept API calls
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

  // Wait for DOM and inject
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectPageScript);
  } else {
    injectPageScript();
  }

  // helpers
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
    l.onerror = (error) => {
      console.error(`[GM+ Font] CSS failed to load: ${href}`, error);
      // Check if it's a CSP issue
      if (href.includes('fonts.googleapis.com')) {
        console.warn('[GM+ Font] Google Fonts blocked by CSP - check manifest.json content_security_policy');
      }
    };
    l.onload = () => {
      console.log(`[GM+ Font] CSS loaded successfully: ${href}`);
    };
    document.head.appendChild(l);
  };

  // IndexedDB cache
  const Cache = (() => {
    if (!window.LZString) {
      console.warn('[GM+ Cache] LZString not available, cache disabled');
      return null;
    }

    console.log('[GM+ Cache] Initializing cache system...');

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

    const validateMessage = (msg) => {
      if (!msg || typeof msg !== 'object') {
        console.warn('[GM+ Cache] Invalid message object:', msg);
        return false;
      }
      if (!msg.id || typeof msg.id !== 'string') {
        console.warn('[GM+ Cache] Missing or invalid message ID:', msg.id, msg);
        return false;
      }
      if (String(msg.id).includes('.')) {
        console.warn('[GM+ Cache] Message ID contains dots:', msg.id);
        return false;
      }
      if (!msg.created_at && !msg.text && !msg.attachments?.length) {
        console.warn('[GM+ Cache] Message missing essential content:', {
          created_at: msg.created_at,
          text: msg.text,
          attachments: msg.attachments?.length
        }, msg);
        return false;
      }
      return true;
    };

    async function store(batch) {
      if (!batch || typeof batch !== 'object') {
        console.warn('[GM+ Cache] Invalid batch object:', batch);
        return;
      }
      
      const allMessages = Object.values(batch);
  // Filter and store valid messages
  const messages = Object.values(batch).filter(validateMessage);
  if (messages.length === 0) return;

      try {
        const db = await open();
        const tx = db.transaction([STORE, EDITS], 'readwrite');
        const st = tx.objectStore(STORE);
        const eh = tx.objectStore(EDITS);

        const messageIds = messages.map(m => m.id);
        const existingMessages = new Map();
        
  // Identify existing messages
        
        await Promise.all(messageIds.map(id => 
          new Promise((resolve, reject) => {
            const req = st.get(id);
            req.onsuccess = () => {
              if (req.result) {
                existingMessages.set(id, req.result);
                console.log(`[GM+ Cache] Found existing message: ${id}`);
              }
              resolve();
            };
            req.onerror = () => reject(req.error);
          })
        ));

  // Prepare put and edit operations

        const putPromises = [];
        const editPromises = [];
        let newCount = 0;
        let editCount = 0;

        for (const m of messages) {
          const existing = existingMessages.get(m.id);
          
          if (!existing) {
            console.log(`[GM+ Cache] Message ${m.id} is new, will store`);
            putPromises.push(
              new Promise((resolve, reject) => {
                const req = st.put({
                  id: m.id,
                  group_id: m.group_id,
                  created_at: m.created_at,
                  data: C(m),
                  stored_at: Date.now()
                });
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              })
            );
            newCount++;
          } else {
            console.log(`[GM+ Cache] Message ${m.id} already exists, checking for edits`);
            const old = D(existing.data);
            if (old.text !== m.text && old.text && m.text && 
                old.text.trim() !== m.text.trim()) {
              
              console.log(`[GM+ Cache] Message ${m.id} has been edited`);
              editPromises.push(
                new Promise((resolve, reject) => {
                  const req = eh.put({
                    edit_id: `${m.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    message_id: m.id,
                    original_text: old.text,
                    new_text: m.text,
                    edit_timestamp: Date.now(),
                    original_updated_at: old.updated_at,
                    new_updated_at: m.updated_at
                  });
                  req.onsuccess = () => resolve(req.result);
                  req.onerror = () => reject(req.error);
                })
              );
              
              putPromises.push(
                new Promise((resolve, reject) => {
                  const req = st.put({
                    id: m.id,
                    group_id: m.group_id,
                    created_at: m.created_at,
                    data: C(m),
                    updated_at: Date.now()
                  });
                  req.onsuccess = () => resolve(req.result);
                  req.onerror = () => reject(req.error);
                })
              );
              editCount++;
            } else {
              console.log(`[GM+ Cache] Message ${m.id} unchanged, skipping`);
            }
          }
        }

        console.log(`[GM+ Cache] About to execute ${putPromises.length} put operations and ${editPromises.length} edit operations`);
        await Promise.all([...putPromises, ...editPromises]);
        
        console.log(`[GM+ Cache] Batch stored: ${newCount} new, ${editCount} edited`);
        
        return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve({ stored: newCount, edited: editCount });
          tx.onerror = () => reject(tx.error);
        });
      } catch (error) {
        console.error('[GM+ Cache] Store error:', error);
        throw error;
      }
    }

    const stats = async () => {
      try {
        const db = await open();
        
        const messageCount = await new Promise((resolve, reject) => {
          const req = db.transaction(STORE).objectStore(STORE).count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        
        const editCount = await new Promise((resolve, reject) => {
          const req = db.transaction(EDITS).objectStore(EDITS).count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        
        return { messages: messageCount, edits: editCount };
      } catch (error) {
        console.error('[GM+ Cache] Stats error:', error);
        return { messages: 0, edits: 0 };
      }
    };

    const all = async () => {
      try {
        const db = await open();
        const out = [];
        
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE);
          const cursor = tx.objectStore(STORE).openCursor();
          
          cursor.onsuccess = (event) => {
            const cur = event.target.result;
            if (!cur) {
              resolve(out);
              return;
            }
            
            try {
              const decompressed = D(cur.value.data);
              out.push(decompressed);
            } catch (error) {
              console.error('[GM+ Cache] Error decompressing data for ID:', cur.value.id, error);
            }
            
            cur.continue();
          };
          
          cursor.onerror = () => reject(cursor.error);
          tx.onerror = () => reject(tx.error);
        });
      } catch (error) {
        console.error('[GM+ Cache] All messages error:', error);
        return [];
      }
    };

    const search = async (query, options = {}) => {
      try {
        const db = await open();
        const results = [];
        const {
          limit = 100,
          groupId = null,
          userId = null,
          dateFrom = null,
          dateTo = null,
          hasAttachments = null,
          caseSensitive = false,
          fullWord = false
        } = options;
        
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE);
          const store = tx.objectStore(STORE);
          let cursor;
          let processedCount = 0;
          
          // Use index if filtering by group
          if (groupId) {
            cursor = store.index('group_id').openCursor(IDBKeyRange.only(groupId));
          } else {
            cursor = store.openCursor();
          }
          
          cursor.onsuccess = (event) => {
            const cur = event.target.result;
            if (!cur || results.length >= limit) {
              console.log(`[GM+ Search Debug] Processed ${processedCount} total messages, found ${results.length} matching results`);
              resolve(results);
              return;
            }
            
            processedCount++;
            
            try {
              const msg = D(cur.value.data);
              let matches = true;
              
              if (query && query.trim()) {
                const searchTerm = caseSensitive ? query : query.toLowerCase();
                const searchText = caseSensitive ? (msg.text || '') : (msg.text || '').toLowerCase();
                const searchName = caseSensitive ? (msg.name || '') : (msg.name || '').toLowerCase();
                
                if (fullWord) {
                  const regex = new RegExp(`\\b${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, caseSensitive ? 'g' : 'gi');
                  matches = matches && (
                    regex.test(msg.text || '') ||
                    regex.test(msg.name || '')
                  );
                } else {
                  matches = matches && (
                    searchText.includes(searchTerm) ||
                    searchName.includes(searchTerm)
                  );
                }
              }
              
              if (userId && matches) {
                matches = msg.user_id === userId || msg.sender_id === userId;
              }
              
              if (dateFrom && matches) {
                matches = msg.created_at >= dateFrom;
              }
              if (dateTo && matches) {
                matches = msg.created_at <= dateTo;
              }
              
              if (hasAttachments !== null && matches) {
                matches = hasAttachments ? 
                  (msg.attachments && msg.attachments.length > 0) :
                  (!msg.attachments || msg.attachments.length === 0);
              }
              
              if (matches) {
                results.push(msg);
              }
            } catch (error) {
              console.error('[GM+ Cache] Error processing search result:', error);
            }
            
            cur.continue();
          };
          
          cursor.onerror = () => reject(cursor.error);
          tx.onerror = () => reject(tx.error);
        });
      } catch (error) {
        console.error('[GM+ Cache] Search error:', error);
        return [];
      }
    };

    const getByGroup = async (groupId, limit = 1000) => {
      try {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE);
          const index = tx.objectStore(STORE).index('group_ts');
          const range = IDBKeyRange.bound([groupId, 0], [groupId, Date.now()]);
          const results = [];
          
          const cursor = index.openCursor(range, 'prev');
          
          cursor.onsuccess = (event) => {
            const cur = event.target.result;
            if (!cur || results.length >= limit) {
              resolve(results);
              return;
            }
            
            try {
              const msg = D(cur.value.data);
              results.push(msg);
            } catch (error) {
              console.error('[GM+ Cache] Error decompressing message:', error);
            }
            
            cur.continue();
          };
          
          cursor.onerror = () => reject(cursor.error);
        });
      } catch (error) {
        console.error('[GM+ Cache] GetByGroup error:', error);
        return [];
      }
    };

    const getEditHistory = async (messageId) => {
      try {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(EDITS);
          const index = tx.objectStore(EDITS).index('msg');
          const results = [];
          
          const cursor = index.openCursor(IDBKeyRange.only(messageId));
          
          cursor.onsuccess = (event) => {
            const cur = event.target.result;
            if (!cur) {
              results.sort((a, b) => a.edit_timestamp - b.edit_timestamp);
              resolve(results);
              return;
            }
            
            results.push(cur.value);
            cur.continue();
          };
          
          cursor.onerror = () => reject(cursor.error);
        });
      } catch (error) {
        console.error('[GM+ Cache] Edit history error:', error);
        return [];
      }
    };

    const cleanup = async (options = {}) => {
      try {
        const db = await open();
        const {
          olderThanDays = 30,
          keepEditHistory = true,
          dryRun = false
        } = options;
        
        const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
        let deletedCount = 0;
        let checkedCount = 0;
        
        return new Promise((resolve, reject) => {
          const tx = db.transaction([STORE, ...(keepEditHistory ? [] : [EDITS])], dryRun ? 'readonly' : 'readwrite');
          const store = tx.objectStore(STORE);
          const cursor = store.openCursor();
          
          cursor.onsuccess = (event) => {
            const cur = event.target.result;
            if (!cur) {
              resolve({ deleted: deletedCount, checked: checkedCount });
              return;
            }
            
            try {
              const msg = D(cur.value.data);
              checkedCount++;
              
              if (msg.created_at && msg.created_at * 1000 < cutoffTime) {
                if (!dryRun) {
                  cur.delete();
                }
                deletedCount++;
              }
            } catch (error) {
              console.warn('[GM+ Cache] Cleanup: Error processing message:', error);
              if (!dryRun) {
                cur.delete();
                deletedCount++;
              }
            }
            
            cur.continue();
          };
          
          cursor.onerror = () => reject(cursor.error);
          tx.onerror = () => reject(tx.error);
        });
      } catch (error) {
        console.error('[GM+ Cache] Cleanup error:', error);
        throw error;
      }
    };

    const validate = async () => {
      try {
        const db = await open();
        let validCount = 0;
        let invalidCount = 0;
        let compressedSize = 0;
        const issues = [];
        
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE);
          const cursor = tx.objectStore(STORE).openCursor();
          
          cursor.onsuccess = (event) => {
            const cur = event.target.result;
            if (!cur) {
              resolve({
                valid: validCount,
                invalid: invalidCount,
                totalSize: compressedSize,
                issues: issues.slice(0, 10)
              });
              return;
            }
            
            try {
              compressedSize += cur.value.data.length * 2;
              const msg = D(cur.value.data);
              
              if (!msg.id || !msg.created_at) {
                issues.push(`Missing required fields: ${cur.key}`);
                invalidCount++;
              } else {
                validCount++;
              }
            } catch (error) {
              issues.push(`Decompression failed: ${cur.key}`);
              invalidCount++;
            }
            
            cur.continue();
          };
          
          cursor.onerror = () => reject(cursor.error);
        });
      } catch (error) {
        console.error('[GM+ Cache] Validation error:', error);
        throw error;
      }
    };

    return { store, stats, all, search, getByGroup, getEditHistory, cleanup, validate, open };
  })();

  console.log('[GM+ Cache] Cache system initialized:', Cache ? 'enabled' : 'disabled');

  const SmartFetch = (() => {
    if (!Cache) {
      console.warn('[GM+ SmartFetch] Cache not available, smart fetching disabled');
      return null;
    }

    const getCacheBoundaries = async (chatId, isDM = false) => {
      try {
        console.log(`[GM+ SmartFetch] Analyzing cache boundaries for ${isDM ? 'DM' : 'group'} ${chatId}`);
        
        let cached = [];
        if (isDM) {
          const allMessages = await Cache.all();
          cached = allMessages.filter(msg => {
            return (msg.is_dm || msg.conversation_id) && (
              msg.user_id === chatId || 
              msg.sender_id === chatId ||
              msg.dm_other_user_id === chatId ||
              (msg.conversation_id && msg.conversation_id.includes(chatId))
            );
          });
        } else {
          try {
            const allMsgs = await Cache.all();
            cached = allMsgs.filter(msg => msg.group_id === chatId);
          } catch (e) {
            console.error('[GM+ SmartFetch] Error loading full cache for group boundaries:', e);
            cached = [];
          }
        }

        if (!cached.length) {
          console.log(`[GM+ SmartFetch] No cached messages found`);
          return { newest: null, oldest: null, count: 0, hasCache: false };
        }

        const sorted = cached.sort((a, b) => b.created_at - a.created_at);
        const newest = sorted[0];
        const oldest = sorted[sorted.length - 1];

        console.log(`[GM+ SmartFetch] Cache boundaries: ${cached.length} messages from ${new Date(oldest.created_at * 1000).toLocaleDateString()} to ${new Date(newest.created_at * 1000).toLocaleDateString()}`);
        
        return {
          newest,
          oldest, 
          count: cached.length,
          hasCache: true,
          newestDate: new Date(newest.created_at * 1000),
          oldestDate: new Date(oldest.created_at * 1000)
        };
      } catch (error) {
        console.error('[GM+ SmartFetch] Error analyzing cache boundaries:', error);
        return { newest: null, oldest: null, count: 0, hasCache: false };
      }
    };

    const fetchSince = async (type, chatId, sinceMessageId, sinceTimestamp) => {
      const headers = getAuthHeaders();
      let beforeId = null;
      let newMessages = [];
      let totalFetched = 0;
      let batchCount = 0;
      let retryCount = 0;
      const maxRetries = 5;

      console.log(`[GM+ SmartFetch] Fetching new messages since ID ${sinceMessageId} (${new Date(sinceTimestamp * 1000).toLocaleString()})`);

      try {
        while (true) {
          batchCount++;
          let url = '';
          if (type === 'group') {
            url = `https://api.groupme.com/v3/groups/${chatId}/messages?acceptFiles=1&limit=100${beforeId ? `&before_id=${beforeId}` : ''}`;
          } else {
            url = `https://api.groupme.com/v3/direct_messages?acceptFiles=1&limit=100&other_user_id=${chatId}${beforeId ? `&before_id=${beforeId}` : ''}`;
          }

          try {
            console.log(`[GM+ SmartFetch] Batch ${batchCount}: ${url}`);
            const resp = await fetch(url, { headers, credentials: 'omit' });
            
            if (!resp.ok) {
              if (resp.status === 429) {
                retryCount++;
                if (retryCount > maxRetries) {
                  console.error(`[GM+ SmartFetch] Rate limit exceeded after ${maxRetries} retries`);
                  throw new Error(`Rate limit exceeded after ${maxRetries} retries`);
                }
                
                const backoffTime = Math.pow(1.5, retryCount) * 1000;
                console.warn(`[GM+ SmartFetch] Rate limited (429), retrying in ${backoffTime}ms (attempt ${retryCount}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, backoffTime));
                batchCount--;
                continue;
              } else if (resp.status === 304) {
                console.log(`[GM+ SmartFetch] No more messages (304)`);
                break;
              } else {
                console.warn(`[GM+ SmartFetch] API request failed: ${resp.status} ${resp.statusText}`);
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

            if (!msgs.length) {
              console.log(`[GM+ SmartFetch] No more messages in batch ${batchCount}`);
              break;
            }

            totalFetched += msgs.length;
            console.log(`[GM+ SmartFetch] Batch ${batchCount}: ${msgs.length} messages (total: ${totalFetched})`);

            let hitBoundary = false;
            let newBatchMessages = [];

            for (const msg of msgs) {
              if (msg.id === sinceMessageId || msg.created_at <= sinceTimestamp) {
                console.log(`[GM+ SmartFetch] Hit cache boundary at message ${msg.id}`);
                hitBoundary = true;
                break;
              }
              newBatchMessages.push(msg);
            }

            newMessages.push(...newBatchMessages);

            if (hitBoundary) {
              console.log(`[GM+ SmartFetch] Reached cache boundary. Found ${newMessages.length} new messages.`);
              break;
            }

            beforeId = msgs[msgs.length - 1].id;

            if (batchCount > 500) {
              console.warn(`[GM+ SmartFetch] Hit safety limit of 500 batches`);
              break;
            }

            await new Promise(resolve => setTimeout(resolve, 10));
            
          } catch (error) {
            if (error.name === 'TypeError' && error.message.includes('fetch')) {
              retryCount++;
              if (retryCount > maxRetries) {
                console.error(`[GM+ SmartFetch] Network error after ${maxRetries} retries:`, error);
                throw error;
              }
              
              const backoffTime = Math.pow(1.5, retryCount) * 1000;
              console.warn(`[GM+ SmartFetch] Network error, retrying in ${backoffTime}ms (attempt ${retryCount}/${maxRetries}):`, error.message);
              await new Promise(resolve => setTimeout(resolve, backoffTime));
              batchCount--;
              continue;
            } else {
              throw error;
            }
          }
        }

        console.log(`[GM+ SmartFetch] Incremental fetch complete: ${newMessages.length} new messages in ${batchCount} batches`);
        return newMessages;

      } catch (error) {
        console.error('[GM+ SmartFetch] Error in fetchSince:', error);
        throw error;
      }
    };

    // Main smart fetch function
    const smartFetch = async (type, chatId, progressCallback) => {
      try {
        const boundaries = await getCacheBoundaries(chatId, type === 'dm');
        
        if (!boundaries.hasCache) {
          console.log(`[GM+ SmartFetch] No cache found, falling back to full fetch`);
          return { mode: 'full', boundaries };
        }

        console.log(`[GM+ SmartFetch] Found cache with ${boundaries.count} messages. Newest: ${boundaries.newestDate.toLocaleString()}`);
        
        // Step 1: Check for newer messages
        if (progressCallback) {
          progressCallback(`Checking for new messages since ${boundaries.newestDate.toLocaleDateString()}...`);
        }

        const newMessages = await fetchSince(type, chatId, boundaries.newest.id, boundaries.newest.created_at);
        
        let totalNewMessages = newMessages.length;
        
        if (newMessages.length > 0) {
          // store new messages
          const batch = Object.fromEntries(newMessages.map(m => [m.id, m]));
          await Cache.store(batch);
          console.log(`[GM+ SmartFetch] Stored ${newMessages.length} newer messages`);
        }
        
        // check for older messages
        if (progressCallback) {
          progressCallback(`Checking for older messages before ${boundaries.oldestDate.toLocaleDateString()}...`);
        }
        
        // fetch one batch of older messages to check for gaps
        const headers = getAuthHeaders();
        let olderUrl = '';
        if (type === 'group') {
          olderUrl = `https://api.groupme.com/v3/groups/${chatId}/messages?acceptFiles=1&limit=100&before_id=${boundaries.oldest.id}`;
        } else {
          olderUrl = `https://api.groupme.com/v3/direct_messages?acceptFiles=1&limit=100&other_user_id=${chatId}&before_id=${boundaries.oldest.id}`;
        }
        
        try {
          console.log(`[GM+ SmartFetch] Checking for older messages: ${olderUrl}`);
          const olderResp = await fetch(olderUrl, { headers, credentials: 'omit' });
          
          let olderMessages = [];
          if (olderResp.ok) {
            const olderData = await olderResp.json();
            if (type === 'group') {
              olderMessages = (olderData.response && olderData.response.messages) || [];
            } else {
              olderMessages = (olderData.response && olderData.response.direct_messages) || [];
            }
          }
          
          if (olderMessages.length > 0) {
            console.log(`[GM+ SmartFetch] Found ${olderMessages.length} older messages - cache has gaps. Falling back to full fetch for complete history.`);
            return { mode: 'full', boundaries, reason: 'gaps_in_history' };
          } else {
            console.log(`[GM+ SmartFetch] No older messages found - cache appears complete.`);
          }
          
        } catch (error) {
          console.warn(`[GM+ SmartFetch] Could not check for older messages:`, error);
        }
        
        if (totalNewMessages === 0) {
          console.log(`[GM+ SmartFetch] No new messages found. Cache is up to date.`);
          return { 
            mode: 'incremental', 
            newMessages: [], 
            boundaries,
            alreadyUpToDate: true 
          };
        }

        return { 
          mode: 'incremental', 
          newMessages, 
          boundaries,
          alreadyUpToDate: false 
        };

      } catch (error) {
        console.error('[GM+ SmartFetch] Error in smart fetch:', error);
        return { mode: 'error', error, boundaries: null };
      }
    };

    return { getCacheBoundaries, fetchSince, smartFetch };
  })();

  console.log('[GM+ SmartFetch] Smart fetching system initialized:', SmartFetch ? 'enabled' : 'disabled');

  function getAuthHeaders() {
    // Try to extract the access token from various sources
    let accessToken = null;
    
    // Method 1: Check for token in localStorage
    try {
      const appData = localStorage.getItem('app');
      if (appData) {
        const parsed = JSON.parse(appData);
        accessToken = parsed?.access_token || parsed?.token;
      }
    } catch (e) {}
    
    // Method 2: Check for token in sessionStorage
    if (!accessToken) {
      try {
        const sessionData = sessionStorage.getItem('access_token') || sessionStorage.getItem('token');
        if (sessionData) {
          accessToken = sessionData;
        }
      } catch (e) {}
    }
    
    // Method 3: Try to extract from page context/window
    if (!accessToken) {
      try {
        accessToken = window.GroupMe?.accessToken || 
                     window.app?.access_token || 
                     window.ACCESS_TOKEN ||
                     window._gm_access_token;
      } catch (e) {}
    }
    
    // Method 4: Check for token in cookies
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
      console.log(`[GM+ Jump] Searching for message ${messageId}...`);
      
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
      
      let beforeId = getCurrentOldestMessageId();
      let attempts = 0;
      const maxAttempts = 250;
      
      while (attempts < maxAttempts) {
        attempts++;
        console.log(`[GM+ Jump] Loading batch ${attempts}, before_id: ${beforeId}`);
        
        try {
          const response = await fetch(`/api/${chatType}/${chatId}/messages?acceptFiles=1&before_id=${beforeId}&limit=100`, {
            method: 'GET',
            headers: getAuthHeaders(),
            credentials: 'include'
          });
          
          if (!response.ok) {
            throw new Error(`API request failed: ${response.status}`);
          }
          
          const data = await response.json();
          console.log(`[GM+ Jump] Loaded ${data.response?.messages?.length || 0} messages`);
          
          if (!data.response?.messages?.length) {
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
          
          const messages = data.response.messages;
          const oldestMessage = messages[messages.length - 1];
          if (oldestMessage && oldestMessage.id !== beforeId) {
            beforeId = oldestMessage.id;
          } else {
            console.log('[GM+ Jump] No new messages loaded, stopping');
            break;
          }
          
        } catch (error) {
          console.error('[GM+ Jump] Error loading messages:', error);
          break;
        }
      }
      
      if (attempts >= maxAttempts) {
        Modal.alert('Search Timeout', 'Could not find the message after loading many batches. The message might be very old or deleted.', 'error');
      } else {
        Modal.alert('Message Not Found', 'Could not find the specified message. It may have been deleted or is in a different conversation.', 'error');
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
    const originalStyle = messageElement.style.cssText;
    messageElement.style.cssText += '; background: rgba(102, 126, 234, 0.3) !important; transition: background 0.3s ease;';
    
    setTimeout(() => {
      messageElement.style.cssText = originalStyle;
    }, 2000);
  }

  const Modal = (() => {
    let currentModal = null;

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

    const setupModalRepositioning = (modal) => {
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
      
      const originalClose = currentModal?.close;
      if (originalClose) {
        currentModal.close = () => {
          observer.disconnect();
          originalClose();
        };
      }
      
      const handleResize = () => repositionModal(modal);
      window.addEventListener('resize', handleResize);
      
      setTimeout(() => {
        if (currentModal?.close) {
          const originalClose = currentModal.close;
          currentModal.close = () => {
            window.removeEventListener('resize', handleResize);
            observer.disconnect();
            originalClose();
          };
        }
      }, 50);
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
      closeBtn.onclick = () => close();
      
      const body = document.createElement('div');
      body.className = 'gm-modal-body';
      
      const footer = document.createElement('div');
      footer.className = 'gm-modal-footer';
      
      header.append(title, closeBtn);
      modal.append(header, body, footer);
      overlay.appendChild(modal);
      
      overlay.onclick = (e) => {
        if (e.target === overlay) close();
      };
      
      const handleEscape = (e) => {
        if (e.key === 'Escape') close();
      };
      
      const show = () => {
        document.body.appendChild(overlay);
        document.addEventListener('keydown', handleEscape);
        overlay.offsetHeight;
        setTimeout(() => {
          overlay.classList.add('show');
          // Set up modal repositioning observer
          setupModalRepositioning(modal);
        }, 10);
        currentModal = { 
          overlay, 
          modal,
          close: () => {
            document.removeEventListener('keydown', handleEscape);
            overlay.classList.remove('show');
            setTimeout(() => {
              if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 200);
            currentModal = null;
          }
        };
      };
      
      return { overlay, modal, header, title, closeBtn, body, footer, show };
    };

    const close = () => {
      if (currentModal) {
        currentModal.close();
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
      body.innerHTML = content; // Direct content without wrapper
      
      const okBtn = document.createElement('button');
      okBtn.className = 'gm-modal-btn primary';
      okBtn.textContent = 'Close';
      okBtn.onclick = close;
      
      footer.appendChild(okBtn);
      show();
      
      setTimeout(() => okBtn.focus(), 100);
    };

    return { alert, confirm, stats, analytics, close };
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
    // Quick Jump SVG removed
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
        
        // If we have date filters, increase the limit since we're filtering a lot
        if (options.dateFrom || options.dateTo) {
          options.limit = 5000; // Much higher limit for date-based searches
        }
        
        if (attachmentsCheck.checked) {
          options.hasAttachments = true;
        }
        
        let results = await Cache.search(q, options);
        console.log(`[GM+ Search] Search completed. Query: "${q}", Options:`, options, `Results: ${results.length}`);
        
        // Log first few results to see what we got
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
            
            return `
              <div style="background:#222;margin:4px 0;padding:8px;border-radius:4px;border-left:3px solid #667eea;" data-msg-id="${msg.id}">
                <div style="font-size:12px;color:#888;margin-bottom:4px;display:flex;justify-content:space-between;">
                  <span>${msg.name || 'Unknown'} • ${dateStr}</span>
                  <span style="color:#667eea;">#${index + 1}</span>
                </div>
                <div style="font-size:14px;color:#ddd;margin-bottom:4px;">${truncatedText}</div>
                ${attachmentInfo}
                ${msg.group_id ? `<div style="font-size:10px;color:#666;">Group: ${msg.group_id}</div>` : ''}
                ${msg.likes_count ? `<div style="font-size:10px;color:#666;">❤️ ${msg.likes_count} likes</div>` : ''}
              </div>
            `;
          }).join('');
          
          const summary = `
            <div style="background:#333;padding:8px;margin-bottom:8px;border-radius:4px;">
              <strong style="color:#fff;">Search Results: ${results.length} messages found</strong>
              ${results.length > 100 ? '<div style="color:#888;font-size:12px;">Showing first 100 results</div>' : ''}
            </div>
          `;
          
          searchResults.innerHTML = summary + resultsHtml;
          exportResultsBtn.disabled = false;
        }
  searchResults.style.display = 'block';
  // re-open the stats pane to recalculate position
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
        
        // Calculate user statistics and time patterns
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
    activityIndicator.innerHTML = '<div style="font-size:12px;color:#888;">📡 Monitoring for new messages...</div>';
    
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
        activityIndicator.innerHTML = '<div style="font-size:12px;color:#888;">📡 Monitoring resumed...</div>';
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
    });    (async () => {
      const headers = getAuthHeaders();
      try {
        const gResp = await fetch('https://api.groupme.com/v3/groups', { headers, credentials: 'omit' });
        if (gResp.ok) {
          const gd = await gResp.json();
          (gd.response || []).forEach(g => {
            const opt = document.createElement('option');
            opt.value = `group:${g.id}`;
            opt.textContent = g.name;
            convSelect.appendChild(opt);
          });
        }
      } catch (e) { console.warn('Bulk Fetch: failed to load groups', e); }
      try {
        const dResp = await fetch('https://api.groupme.com/v3/chats', { headers, credentials: 'omit' });
        if (dResp.ok) {
          const dd = await dResp.json();
          console.log('[GM+ Bulk Fetch] DM conversations response:', dd);
          (dd.response || []).forEach(dm => {
            const opt = document.createElement('option');
            opt.value = `dm:${dm.other_user.id}`;
            opt.textContent = `${dm.other_user.name} (DM)`;
            convSelect.appendChild(opt);
          });
        } else {
          console.warn('[GM+ Bulk Fetch] Chats API failed, trying direct_messages fallback');
          // Fallback to direct_messages endpoint if chats fails
          const fallbackResp = await fetch('https://api.groupme.com/v3/direct_messages?acceptFiles=1&limit=100', { headers, credentials: 'omit' });
          if (fallbackResp.ok) {
            const fallbackData = await fallbackResp.json();
            console.log('[GM+ Bulk Fetch] Direct messages fallback response:', fallbackData);
            // Extract unique users from direct messages
            const users = new Map();
            (fallbackData.response || []).forEach(msg => {
              if (msg.user_id && msg.name && !users.has(msg.user_id)) {
                users.set(msg.user_id, msg.name);
              }
            });
            users.forEach((name, userId) => {
              const opt = document.createElement('option');
              opt.value = `dm:${userId}`;
              opt.textContent = `${name} (DM)`;
              convSelect.appendChild(opt);
            });
          }
        }
      } catch (e) { 
        console.warn('Bulk Fetch: failed to load DMs', e); 
        console.log('[GM+ Bulk Fetch] Error details:', e);
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
          message = `Cache Analysis:\n\n• ${boundaries.count} messages cached\n• From: ${boundaries.oldestDate.toLocaleDateString()}\n• To: ${boundaries.newestDate.toLocaleDateString()}\n\nSmart fetch will only download new messages since ${boundaries.newestDate.toLocaleDateString()}.`;
          fetchBtn.textContent = `Smart Fetch (New Since ${boundaries.newestDate.toLocaleDateString()})`;
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
          Modal.alert('Already Up to Date', `Cache is current with ${total} messages.\nLatest message: ${result.boundaries.newestDate.toLocaleString()}`, 'info');
        } else {
          total = result.boundaries.count + result.newMessages.length;
          fetchBtn.textContent = 'Fetch Successful';
          setTimeout(() => {
            fetchBtn.textContent = originalText;
          }, 3000);
          Modal.alert('Smart Fetch Complete', `Found ${result.newMessages.length} new messages!\n\nTotal cached: ${total} messages\nLatest: ${new Date(result.newMessages[0]?.created_at * 1000 || result.boundaries.newest.created_at * 1000).toLocaleString()}`, 'info');
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
              continue; // Retry the same request
            } else if (resp.status === 304) {
              // No more messages
              console.log(`[GM+ Legacy Fetch] No more messages (304)`);
              break;
            } else {
              console.warn(`[GM+ Legacy Fetch] API request failed: ${resp.status} ${resp.statusText}`);
              throw new Error(`API request failed: ${resp.status} ${resp.statusText}`);
            }
          }
          
          // Reset retry count on success
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
          
          // Small delay to be nice to the API
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
    
    const statsBtn = document.createElement('button'); 
    statsBtn.textContent = 'Cache Stats';
    statsBtn.className = 'gm-btn';
    statsBtn.style.cssText = 'background:#6c757d;';
    
    const validateBtn = document.createElement('button'); 
    validateBtn.textContent = 'Validate Cache';
    validateBtn.className = 'gm-btn';
    validateBtn.style.cssText = 'background:#17a2b8;';
    
    const backupBtn = document.createElement('button'); 
    backupBtn.textContent = 'Backup Cache';
    backupBtn.className = 'gm-btn';
    backupBtn.style.cssText = 'background:#28a745;';
    
    const cleanupBtn = document.createElement('button'); 
    cleanupBtn.textContent = 'Smart Cleanup';
    cleanupBtn.className = 'gm-btn';
    cleanupBtn.style.cssText = 'background:#f57c00;color:#000;';
    
    managementGrid.append(statsBtn, validateBtn, backupBtn, cleanupBtn);
    
    // Import/Export row
    const importExportRow = document.createElement('div');
    importExportRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;';
    
    const exportBtn = document.createElement('button'); 
    exportBtn.textContent = 'Export CSV';
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
    
    statsBtn.onclick = async () => {
      try {
        if (!Cache) {
          Modal.alert('Cache Unavailable', 'Cache not available', 'error');
          return;
        }
        
        const [stats, validation] = await Promise.all([
          Cache.stats(),
          Cache.validate()
        ]);
        
        const sizeInMB = (validation.totalSize / (1024 * 1024)).toFixed(2);
        
        const statsHtml = `
          <div class="gm-modal-stats">
            <div class="gm-modal-stat">
              <div class="gm-modal-stat-value">${stats.messages.toLocaleString()}</div>
              <div class="gm-modal-stat-label">Messages Cached</div>
            </div>
            <div class="gm-modal-stat">
              <div class="gm-modal-stat-value">${stats.edits.toLocaleString()}</div>
              <div class="gm-modal-stat-label">Edits Tracked</div>
            </div>
            <div class="gm-modal-stat">
              <div class="gm-modal-stat-value">${sizeInMB} MB</div>
              <div class="gm-modal-stat-label">Storage Used</div>
            </div>
            <div class="gm-modal-stat">
              <div class="gm-modal-stat-value">${validation.valid.toLocaleString()}</div>
              <div class="gm-modal-stat-label">Valid Messages</div>
            </div>
          </div>
          <div style="margin-top: 16px;">
            <div style="background:#222;padding:8px;border-radius:4px;margin-bottom:8px;">
              <strong style="color:#667eea;">Cache Health:</strong> 
              <span style="color:${validation.invalid === 0 ? '#28a745' : '#f57c00'};">
                ${validation.invalid === 0 ? 'Excellent' : `${validation.invalid} issues found`}
              </span>
            </div>
            ${validation.issues.length > 0 ? `
              <div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:8px;">
                <div style="color:#f57c00;font-size:12px;margin-bottom:4px;font-weight:600;">Cache Issues:</div>
                ${validation.issues.slice(0, 5).map(issue => `<div style="color:#888;font-size:11px;">• ${issue}</div>`).join('')}
                ${validation.issues.length > 5 ? `<div style="color:#666;font-size:11px;">... and ${validation.issues.length - 5} more</div>` : ''}
              </div>
            ` : ''}
            <div style="color:#888;font-size:14px;margin-top:12px;">
              Messages are compressed using LZString for efficient storage.
            </div>
          </div>
        `;
        
        Modal.alert('Detailed Cache Statistics', statsHtml, 'info');
        
      } catch (error) {
        console.error('[GM+ Stats] Error:', error);
        Modal.alert('Stats Error', `Failed to generate statistics: ${error.message}`, 'error');
      }
    };

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
      try {
        if (!Cache) {
          Modal.alert('Cache Unavailable', 'Cache not available - LZString library not loaded', 'error');
          return;
        }
        exportBtn.textContent = 'Exporting...';
        exportBtn.disabled = true;
        const msgs = await Cache.all();
        if (!msgs.length) {
          Modal.alert('No Data', 'Cache is empty. No messages to export.', 'info');
          return;
        }
        const csvHeaders = ['ID','Name','Message','Timestamp','Group ID','User ID','Sender Type','System','Message Type','Likes Count','Reactions','Pinned At','Pinned By','Platform','Avatar URL','Updated At','Source GUID','Attachments'];
        const csvRows = msgs.map(m => [
          `"${(m.id||'').replace(/"/g,'""')}"`,
          `"${(m.name||'').replace(/"/g,'""')}"`,
          `"${(m.text||'').replace(/"/g,'""')}"`,
          m.created_at ? new Date(m.created_at*1000).toISOString() : '',
          `"${(m.group_id||'').replace(/"/g,'""')}"`,
          `"${(m.user_id||'').replace(/"/g,'""')}"`,
          `"${(m.sender_type||'').replace(/"/g,'""')}"`,
          m.system ? 'true' : 'false',
          `"${(m.message_type||'').replace(/"/g,'""')}"`,
          (m.likes_count||0).toString(),
          `"${m.reactions?JSON.stringify(m.reactions).replace(/"/g,'""'):''}"`,
          m.pinned_at?new Date(m.pinned_at*1000).toISOString():'',
          `"${(m.pinned_by||'').replace(/"/g,'""')}"`,
          `"${(m.platform||'').replace(/"/g,'""')}"`,
          `"${(m.avatar_url||'').replace(/"/g,'""')}"`,
          m.updated_at?new Date(m.updated_at*1000).toISOString():'',
          `"${(m.source_guid||'').replace(/"/g,'""')}"`,
          `"${m.attachments?JSON.stringify(m.attachments).replace(/"/g,'""'):''}"`
        ].join(','));
        const csv = [csvHeaders.join(','), ...csvRows].join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `groupme_export_${Date.now()}.csv`;
        a.click();
        Modal.alert('Export Complete', `Successfully exported ${msgs.length.toLocaleString()} messages to CSV`, 'info');
      } catch (error) {
        console.error('[GM+ Cache] Export error:', error);
        Modal.alert('Export Error', `Error exporting cache:\n\n${error.message}`, 'error');
      } finally {
        exportBtn.textContent = 'Export CSV';
        exportBtn.disabled = false;
      }
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
            searchResults.style.display = 'none';
            searchInput.value = '';
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
          window.dispatchEvent(new CustomEvent('navigate', { detail: { path: testPath } }));
          window.dispatchEvent(new CustomEvent('routechange', { detail: { path: testPath } }));
          
          setTimeout(() => {
            window.removeEventListener('popstate', testPopState);
            window.removeEventListener('navigate', testNavigate);
            window.removeEventListener('routechange', testRouteChange);
            
            window.history.pushState({}, '', currentUrl);
            
            resultText += `Events fired: ${eventsFired.length > 0 ? eventsFired.join(', ') : 'none'}<br>`;
            resultText += `URL changed to: ${window.location.pathname}<br>`;
            resultText += 'URL restored to original<br><br>';
            
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
      
      // Update real-time activity indicator if it exists
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
          
          // Reset indicator after 3 seconds
          setTimeout(() => {
            if (indicator) {
              indicator.innerHTML = '<div style="font-size:12px;color:#888;">📡 Monitoring for new messages...</div>';
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

})();
