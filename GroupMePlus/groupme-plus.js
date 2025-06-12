// GroupMe Plus Extension - Combined Font Picker, Message Cacher, and Message Counter
// Version 2.0
(() => {
  'use strict';

  console.log('🚀 GroupMe Plus Extension - Loading...');

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
    console.warn('[GroupMe Plus] LZString not found; message caching disabled.');
  }
  /*────────────────── SECTION 2: ADVANCED MESSAGE CACHING ──────────────────*/
  const MessageCache = (() => {
    if (!window.LZString) {
      console.warn('[GroupMe Plus] LZString not available, message caching disabled');
      return null;
    }

    // Enhanced database layer with better error handling and versioning
    const DB = (() => {
      const NAME = 'GMCache';
      const VERSION = 2;
      const STORES = {
        messages: 'messages',
        editHistory: 'editHistory',
        metadata: 'metadata'
      };
      let dbPromise = null;

      function open() {
        if (dbPromise) return dbPromise;
        
        dbPromise = new Promise((resolve, reject) => {
          const req = indexedDB.open(NAME, VERSION);
          
          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            const oldVersion = e.oldVersion;
            
            console.log(`📊 Upgrading database from v${oldVersion} to v${VERSION}`);
            
            // Create messages store with compound index
            if (!db.objectStoreNames.contains(STORES.messages)) {
              const msgStore = db.createObjectStore(STORES.messages, { keyPath: 'id' });
              msgStore.createIndex('group_id', 'group_id', { unique: false });
              msgStore.createIndex('timestamp', 'timestamp', { unique: false });
              msgStore.createIndex('user_id', 'user_id', { unique: false });
              msgStore.createIndex('group_timestamp', ['group_id', 'timestamp'], { unique: false });
            }
            
            // Create edit history store  
            if (!db.objectStoreNames.contains(STORES.editHistory)) {
              const editStore = db.createObjectStore(STORES.editHistory, { keyPath: 'edit_id' });
              editStore.createIndex('message_id', 'message_id', { unique: false });
              editStore.createIndex('edit_timestamp', 'edit_timestamp', { unique: false });
            }
            
            // Create metadata store for tracking stats
            if (!db.objectStoreNames.contains(STORES.metadata)) {
              db.createObjectStore(STORES.metadata, { keyPath: 'key' });
            }
          };
          
          req.onsuccess = (e) => {
            const db = e.target.result;
            db.onerror = (err) => console.error('💥 Database error:', err);
            resolve(db);
          };
          
          req.onerror = (e) => {
            console.error('💥 Failed to open database:', e.target.error);
            reject(e.target.error);
          };
          
          req.onblocked = () => {
            console.warn('🚫 Database upgrade blocked - close other tabs');
            reject(new Error('Database upgrade blocked'));
          };
        });
        
        return dbPromise;
      }      // Enhanced message storage with strict deduplication
      async function storeMessages(messages) {
        if (!messages || !Object.keys(messages).length) return;
        
        try {
          const db = await open();
          const tx = db.transaction([STORES.messages], 'readwrite');
          const store = tx.objectStore(STORES.messages);
          
          let stored = 0, updated = 0, skipped = 0;
          const processedIds = new Set();
          
          for (const [key, rawMsg] of Object.entries(messages)) {
            try {
              // Skip messages without proper IDs or with generated IDs
              if (!rawMsg.id || typeof rawMsg.id !== 'string' || rawMsg.id.includes('.')) {
                console.warn(`⚠️ Skipping message with invalid ID: ${rawMsg.id}`);
                skipped++;
                continue;
              }
              
              const messageId = rawMsg.id;
              
              // Skip if we've already processed this ID in this batch
              if (processedIds.has(messageId)) {
                console.warn(`⚠️ Duplicate message ID in batch: ${messageId}`);
                skipped++;
                continue;
              }
              processedIds.add(messageId);
              
              // Skip DOM-extracted messages if they lack essential data
              if (rawMsg.dom_extracted && (!rawMsg.text || rawMsg.name === 'Unknown')) {
                console.warn(`⚠️ Skipping invalid DOM-extracted message: ${messageId}`);
                skipped++;
                continue;
              }
              
              // Check if message already exists
              const existing = await new Promise((resolve, reject) => {
                const req = store.get(messageId);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });
                const processedMsg = processMessage(rawMsg);
              processedMsg.id = messageId;
              processedMsg.cached_at = Date.now();
              
              // Compress the message for storage
              const compressedMsg = compressMessageForStorage(processedMsg);
              
              if (existing) {
                // Decompress existing message to check for edits
                const existingData = decompressMessageFromStorage(existing);
                if (!existingData) {
                  console.warn(`⚠️ Failed to decompress existing message: ${messageId}`);
                  skipped++;
                  continue;
                }
                
                // Only update if this is a more complete version or there's an actual edit
                const hasMoreData = (!existingData.name || existingData.name === 'Unknown') && processedMsg.name && processedMsg.name !== 'Unknown';
                const isEdit = existingData.text !== processedMsg.text && existingData.text && processedMsg.text && existingData.text.length > 0 && processedMsg.text.length > 0;
                
                if (isEdit) {
                  await storeEditHistory(messageId, existingData.text, processedMsg.text);
                  console.log(`📝 Edit detected for message ${messageId}`);
                  
                  // Update with edit info, preserving original cached_at
                  processedMsg.cached_at = existingData.cached_at;
                  processedMsg.last_updated = Date.now();
                  const updatedCompressed = compressMessageForStorage(processedMsg);
                  updated++;
                  
                  await new Promise((resolve, reject) => {
                    const req = store.put(updatedCompressed);
                    req.onsuccess = () => resolve();
                    req.onerror = () => reject(req.error);
                  });
                } else if (hasMoreData) {
                  // Update with more complete data, preserving original text and cached_at
                  processedMsg.cached_at = existingData.cached_at;
                  processedMsg.last_updated = Date.now();
                  processedMsg.text = existingData.text; // Keep original text
                  const updatedCompressed = compressMessageForStorage(processedMsg);
                  updated++;
                  
                  await new Promise((resolve, reject) => {
                    const req = store.put(updatedCompressed);
                    req.onsuccess = () => resolve();
                    req.onerror = () => reject(req.error);
                  });
                } else {
                  // Skip duplicate
                  skipped++;
                  continue;
                }
              } else {
                stored++;
                
                await new Promise((resolve, reject) => {
                  const req = store.put(compressedMsg);
                  req.onsuccess = () => resolve();
                  req.onerror = () => reject(req.error);
                });
              }
              
            } catch (err) {
              console.warn(`⚠️ Failed to store message ${key}:`, err);
              skipped++;
            }
          }
          
          await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          
          if (stored > 0 || updated > 0) {
            console.log(`✅ Message storage: ${stored} new, ${updated} updated, ${skipped} skipped`);
          }
          
          // Update metadata
          await updateMetadata('last_cache_operation', {
            timestamp: Date.now(),
            stored,
            updated,
            skipped
          });
          
        } catch (err) {
          console.error('💥 Failed to store messages:', err);
          throw err;
        }
      }

      // Store edit history
      async function storeEditHistory(messageId, originalText, newText) {
        try {
          const db = await open();
          const tx = db.transaction([STORES.editHistory], 'readwrite');
          const store = tx.objectStore(STORES.editHistory);
          
          const editRecord = {
            edit_id: `${messageId}_${Date.now()}`,
            message_id: messageId,
            original_text: originalText,
            new_text: newText,
            edit_timestamp: Date.now(),
            detected_at: new Date().toISOString()
          };
          
          await new Promise((resolve, reject) => {
            const req = store.add(editRecord);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
          });
          
        } catch (err) {
          console.error('💥 Failed to store edit history:', err);
        }
      }      // Process and optimize message data with compression
      function processMessage(rawMsg) {
        const msg = {
          id: rawMsg.id,
          group_id: rawMsg.group_id,
          text: rawMsg.text || '',
          timestamp: new Date(rawMsg.created_at).getTime(),
          created_at: rawMsg.created_at,
          user_id: rawMsg.user_id || rawMsg.sender_id,
          name: rawMsg.name,
          avatar_url: rawMsg.avatar_url
        };
        
        // Optional fields
        if (rawMsg.attachments?.length) msg.attachments = rawMsg.attachments;
        if (rawMsg.favorited_by?.length) msg.favorited_by = rawMsg.favorited_by;
        if (rawMsg.is_dm) msg.is_dm = true;
        if (rawMsg.dm_other_user_id) msg.dm_other_user_id = rawMsg.dm_other_user_id;
        if (rawMsg.system) msg.system = true;
        if (rawMsg.event) msg.event = rawMsg.event;
        
        return msg;
      }

      // Compress message data for storage
      function compressMessageForStorage(messageData) {
        try {
          const jsonString = JSON.stringify(messageData);
          const compressed = LZString.compressToUTF16(jsonString);
          return {
            id: messageData.id,
            data: compressed,
            compressed: true,
            stored_at: Date.now()
          };
        } catch (err) {
          console.warn('Failed to compress message, storing uncompressed:', err);
          return {
            id: messageData.id,
            data: messageData,
            compressed: false,
            stored_at: Date.now()
          };
        }
      }

      // Decompress message data from storage
      function decompressMessageFromStorage(storedData) {
        try {
          if (!storedData.compressed) {
            // Already uncompressed (fallback case)
            return storedData.data;
          }
          
          const decompressed = LZString.decompressFromUTF16(storedData.data);
          if (!decompressed) {
            console.warn('Failed to decompress message data for ID:', storedData.id);
            return null;
          }
          
          return JSON.parse(decompressed);
        } catch (err) {
          console.warn('Failed to decompress message:', err);
          return null;
        }
      }

      // Update metadata
      async function updateMetadata(key, value) {
        try {
          const db = await open();
          const tx = db.transaction([STORES.metadata], 'readwrite');
          const store = tx.objectStore(STORES.metadata);
          
          await new Promise((resolve, reject) => {
            const req = store.put({ key, value, updated_at: Date.now() });
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
          });
        } catch (err) {
          console.warn('Failed to update metadata:', err);
        }
      }

      // Get statistics
      async function getStats() {
        try {
          const db = await open();
          const msgTx = db.transaction([STORES.messages], 'readonly');
          const editTx = db.transaction([STORES.editHistory], 'readonly');
          
          const [messageCount, editCount] = await Promise.all([
            new Promise((resolve, reject) => {
              const req = msgTx.objectStore(STORES.messages).count();
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            }),
            new Promise((resolve, reject) => {
              const req = editTx.objectStore(STORES.editHistory).count();
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            })
          ]);
          
          return { messageCount, editCount };
        } catch (err) {
          console.error('Failed to get stats:', err);
          return { messageCount: 0, editCount: 0 };
        }
      }      // Export functions with decompression
      async function getAllMessages() {
        try {
          const db = await open();
          const tx = db.transaction([STORES.messages], 'readonly');
          const store = tx.objectStore(STORES.messages);
          
          return new Promise((resolve, reject) => {
            const messages = [];
            const req = store.openCursor();
            
            req.onsuccess = (e) => {
              const cursor = e.target.result;
              if (!cursor) return resolve(messages);
              
              // Decompress the message data
              const decompressed = decompressMessageFromStorage(cursor.value);
              if (decompressed) {
                messages.push(decompressed);
              } else {
                console.warn('Failed to decompress message, skipping:', cursor.value.id);
              }
              
              cursor.continue();
            };
            
            req.onerror = () => reject(req.error);
          });
        } catch (err) {          console.error('Failed to get all messages:', err);
          return [];
        }
      }

      async function getEditHistory() {
        try {
          const db = await open();
          const tx = db.transaction([STORES.editHistory], 'readonly');
          const store = tx.objectStore(STORES.editHistory);
          
          return new Promise((resolve, reject) => {
            const edits = [];
            const req = store.openCursor();
            
            req.onsuccess = (e) => {
              const cursor = e.target.result;
              if (!cursor) return resolve(edits);
              edits.push(cursor.value);
              cursor.continue();
            };
            
            req.onerror = () => reject(req.error);
          });
        } catch (err) {
          console.error('Failed to get edit history:', err);
          return [];
        }
      }      return { 
        storeMessages, 
        getStats, 
        getAllMessages, 
        getEditHistory,
        updateMetadata,
        decompressMessageFromStorage,
        open
      };
    })();    // Live message monitoring - Conservative approach
    const LiveMonitor = (() => {
      let isMonitoring = false;
      let messageObserver = null;
      let lastProcessedMessages = new Set();
      let domExtractionEnabled = false; // Disabled by default due to reliability issues

      function startMonitoring() {
        if (isMonitoring) return;
        isMonitoring = true;
        
        console.log('🔍 Starting live message monitoring (API + WebSocket only)...');
        
        // Only setup WebSocket monitoring by default
        setupRealtimeMonitoring();
        
        // DOM monitoring is disabled by default due to duplication issues
        // Can be enabled via debug interface if needed
        if (domExtractionEnabled) {
          setupDOMObserver();
        }
      }

      function setupDOMObserver() {
        console.warn('⚠️ DOM extraction enabled - this may cause duplicates');
        
        if (messageObserver) messageObserver.disconnect();
        
        messageObserver = new MutationObserver((mutations) => {
          // Only process if we have very few mutations to avoid spam
          if (mutations.length > 5) {
            console.warn('⚠️ Too many DOM mutations, skipping to avoid spam');
            return;
          }
          
          const newMessages = [];
          
          mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                // Be very specific about what we consider a message element
                const messageElements = node.querySelectorAll ? 
                  [...node.querySelectorAll('[data-id][data-created-at], .message[data-id]')] : 
                  [];
                
                messageElements.forEach(el => {
                  const messageData = extractMessageFromDOM(el);
                  if (messageData && messageData.id && !messageData.id.includes('.') && !lastProcessedMessages.has(messageData.id)) {
                    newMessages.push(messageData);
                    lastProcessedMessages.add(messageData.id);
                  }
                });
              }
            });
          });
          
          if (newMessages.length > 0 && newMessages.length < 10) { // Sanity check
            console.log(`📨 DOM captured ${newMessages.length} new messages`);
            const batch = {};
            newMessages.forEach(msg => {
              batch[`msg-${msg.id}`] = msg;
            });
            DB.storeMessages(batch);
          }
        });
        
        // Start observing with more restrictive options
        const targetNode = document.querySelector('[data-testid="chat-container"], .chat-container, .messages-container') || document.body;
        if (targetNode) {
          messageObserver.observe(targetNode, {
            childList: true,
            subtree: true,
            attributes: false
          });
        }
      }

      function extractMessageFromDOM(element) {
        try {
          // Only extract if we have a real message ID from the DOM
          const messageId = element.getAttribute('data-id') || element.getAttribute('data-message-id');
          if (!messageId || messageId.includes('.') || messageId.length < 10) {
            return null; // Skip if no proper ID
          }
          
          const textElement = element.querySelector('[class*="text"], .message-text, [data-testid*="text"]');
          const authorElement = element.querySelector('[class*="author"], .message-author, [data-testid*="author"]');
          const timeElement = element.querySelector('[class*="time"], .message-time, [data-testid*="time"], [data-created-at]');
          
          if (!textElement || !authorElement) return null; // Must have text and author
          
          const text = textElement.textContent?.trim();
          const name = authorElement.textContent?.trim();
          
          if (!text || !name || name === 'Unknown' || text.length < 1) {
            return null; // Skip incomplete messages
          }
          
          return {
            id: messageId,
            text: text,
            name: name,
            created_at: timeElement?.getAttribute('data-created-at') || 
                        timeElement?.getAttribute('datetime') || 
                        new Date().toISOString(),
            captured_live: true,
            dom_extracted: true,
            user_id: element.getAttribute('data-user-id') || 'unknown'
          };
        } catch (err) {
          console.warn('Failed to extract message from DOM:', err);
          return null;
        }
      }

      function setupRealtimeMonitoring() {
        // Hook into WebSocket connections for real-time message capture
        const originalWebSocket = window.WebSocket;
        window.WebSocket = function(...args) {
          const ws = new originalWebSocket(...args);
          
          const originalOnMessage = ws.onmessage;
          ws.onmessage = function(event) {
            try {
              const data = JSON.parse(event.data);
              if (data && (data.type === 'message' || data.message) && data.id) {
                console.log('📡 Real-time message detected via WebSocket');
                const message = data.message || data;
                if (message.id && !message.id.includes('.')) {
                  const batch = { [`msg-${message.id}`]: message };
                  DB.storeMessages(batch);
                }
              }
            } catch (err) {
              // Not JSON or not a message, ignore
            }
            
            if (originalOnMessage) {
              return originalOnMessage.apply(this, arguments);
            }
          };
          
          return ws;
        };
      }

      function stopMonitoring() {
        isMonitoring = false;
        if (messageObserver) {
          messageObserver.disconnect();
          messageObserver = null;
        }
        console.log('⏹️ Live message monitoring stopped');
      }

      function enableDOMExtraction() {
        domExtractionEnabled = true;
        if (isMonitoring) {
          setupDOMObserver();
        }
        console.log('⚠️ DOM extraction enabled - monitor for duplicates');
      }

      function disableDOMExtraction() {
        domExtractionEnabled = false;
        if (messageObserver) {
          messageObserver.disconnect();
          messageObserver = null;
        }
        console.log('✅ DOM extraction disabled');
      }

      return { 
        startMonitoring, 
        stopMonitoring, 
        enableDOMExtraction,
        disableDOMExtraction,
        isMonitoring: () => isMonitoring,
        isDOMEnabled: () => domExtractionEnabled
      };
    })();    // Listen for API-intercepted messages with enhanced feedback
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.data?.type !== 'GM_MESSAGES') return;
      
      const metadata = e.data.metadata || {};
      const payloadSize = Object.keys(e.data.payload).length;
      
      if (payloadSize > 0) {
        console.log(`📥 Received batch: ${metadata.new_count || 0} new, ${metadata.edit_count || 0} edited, ${metadata.skipped_count || 0} skipped from ${metadata.source || 'unknown'}`);
      }
      
      // Show warning if too many duplicates detected
      if (metadata.skipped_count > 50) {
        console.warn(`⚠️ High duplicate rate detected (${metadata.skipped_count} skipped). Consider clearing cache or checking for issues.`);
      }
      
      DB.storeMessages(e.data.payload);
    });

    // Enhanced CSV export with edit history
    async function exportData(format = 'csv') {
      try {
        const [messages, edits] = await Promise.all([
          DB.getAllMessages(),
          DB.getEditHistory()
        ]);
        
        if (!messages.length) {
          alert('No messages cached yet.');
          return;
        }
        
        if (format === 'csv') {
          await exportCSV(messages, edits);
        } else if (format === 'json') {
          await exportJSON(messages, edits);
        }
      } catch (err) {
        console.error('Export failed:', err);
        alert('Export failed: ' + err.message);
      }
    }

    async function exportCSV(messages, edits) {
      const escapeCSV = (str) => `"${(str || '').toString().replace(/"/g, '""')}"`;
      
      // Export messages
      const msgHeaders = ['id', 'group_id', 'text', 'created_at', 'user_id', 'name', 'is_dm', 'cached_at', 'last_updated'];
      const msgRows = messages.map(msg => [
        escapeCSV(msg.id),
        escapeCSV(msg.group_id || ''),
        escapeCSV(msg.text || ''),
        escapeCSV(msg.created_at || ''),
        escapeCSV(msg.user_id || ''),
        escapeCSV(msg.name || ''),
        escapeCSV(msg.is_dm ? 'true' : 'false'),
        escapeCSV(new Date(msg.cached_at).toISOString()),
        escapeCSV(msg.last_updated ? new Date(msg.last_updated).toISOString() : '')
      ].join(','));
      
      const messagesCSV = [msgHeaders.join(','), ...msgRows].join('\r\n');
      
      // Export edit history if exists
      let editsCSV = '';
      if (edits.length > 0) {
        const editHeaders = ['edit_id', 'message_id', 'original_text', 'new_text', 'edit_timestamp', 'detected_at'];
        const editRows = edits.map(edit => [
          escapeCSV(edit.edit_id),
          escapeCSV(edit.message_id),
          escapeCSV(edit.original_text || ''),
          escapeCSV(edit.new_text || ''),
          escapeCSV(edit.edit_timestamp),
          escapeCSV(edit.detected_at)
        ].join(','));
        
        editsCSV = [editHeaders.join(','), ...editRows].join('\r\n');
      }
      
      // Create ZIP file with both CSV files
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      
      if (editsCSV) {
        // If we have edit history, create a ZIP
        const JSZip = await loadJSZip();
        if (JSZip) {
          const zip = new JSZip();
          zip.file(`groupme_messages_${timestamp}.csv`, messagesCSV);
          zip.file(`groupme_edits_${timestamp}.csv`, editsCSV);
          
          const blob = await zip.generateAsync({ type: 'blob' });
          downloadBlob(blob, `groupme_export_${timestamp}.zip`);
        } else {
          // Fallback to just messages CSV
          downloadBlob(new Blob([messagesCSV], { type: 'text/csv' }), `groupme_messages_${timestamp}.csv`);
        }
      } else {
        downloadBlob(new Blob([messagesCSV], { type: 'text/csv' }), `groupme_messages_${timestamp}.csv`);
      }
    }

    async function exportJSON(messages, edits) {
      const data = {
        export_info: {
          timestamp: new Date().toISOString(),
          version: '2.0',
          message_count: messages.length,
          edit_count: edits.length
        },
        messages,
        edit_history: edits
      };
      
      const json = JSON.stringify(data, null, 2);
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      downloadBlob(new Blob([json], { type: 'application/json' }), `groupme_export_${timestamp}.json`);
    }

    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    // Try to load JSZip for advanced exports
    async function loadJSZip() {
      try {
        if (window.JSZip) return window.JSZip;
        
        // Try to load JSZip from CDN
        return new Promise((resolve) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
          script.onload = () => resolve(window.JSZip);
          script.onerror = () => resolve(null);
          document.head.appendChild(script);
        });
      } catch {
        return null;
      }
    }

    // Initialize the cache system
    function initialize() {
      console.log('🚀 Initializing Advanced Message Cache...');
      
      // Start live monitoring
      LiveMonitor.startMonitoring();
      
      // Set up periodic cleanup and optimization
      setInterval(async () => {
        try {
          const stats = await DB.getStats();
          console.log(`📊 Cache stats: ${stats.messageCount} messages, ${stats.editCount} edits`);
        } catch (err) {
          console.warn('Failed to get cache stats:', err);
        }
      }, 60000); // Every minute
    }

    // Auto-initialize
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialize);
    } else {
      setTimeout(initialize, 1000);
    }

    return { 
      DB, 
      LiveMonitor, 
      exportData,
      getStats: DB.getStats,
      initialize
    };
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
  /*────────────────── SECTION 5: ENHANCED UI CONTROLS ──────────────────*/
  const UIControls = (() => {
    const BTN_STYLE = {
      position: 'fixed', 
      right: '10px', 
      zIndex: 99999,
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', 
      color: '#fff', 
      padding: '10px 14px',
      border: 'none', 
      borderRadius: '8px', 
      cursor: 'pointer',
      fontSize: '13px',
      fontWeight: '600',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      transition: 'all 0.2s ease',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    };

    function createButton(label, topPx, handler, icon = '') {
      const btn = document.createElement('button');
      btn.innerHTML = `${icon} ${label}`.trim();
      btn.onclick = handler;
      
      Object.assign(btn.style, BTN_STYLE, { top: `${topPx}px` });
      
      // Add hover effects
      btn.onmouseenter = () => {
        btn.style.transform = 'translateY(-2px)';
        btn.style.boxShadow = '0 6px 16px rgba(0,0,0,0.2)';
      };
      btn.onmouseleave = () => {
        btn.style.transform = 'translateY(0)';
        btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
      };
      
      document.body.appendChild(btn);
      return btn;
    }

    function addCacheButtons() {
      if (!MessageCache) {
        console.log('Message caching not available - buttons disabled');
        return;
      }

      // Cache status button
      createButton('Cache Stats', 150, async () => {
        try {
          const stats = await MessageCache.getStats();
          const isLiveMonitoring = MessageCache.LiveMonitor.isMonitoring();
          
          const message = `
📊 Cache Statistics:
• Messages: ${stats.messageCount.toLocaleString()}
• Edits tracked: ${stats.editCount.toLocaleString()}
• Live monitoring: ${isLiveMonitoring ? '✅ Active' : '❌ Inactive'}

Cache system is running in advanced mode with:
• Real-time message capture
• Edit history tracking
• Automatic deduplication
• Enhanced export options
          `.trim();
          
          alert(message);
          console.log('📊 Cache Stats:', stats);
        } catch (err) {
          console.error('Failed to get cache stats:', err);
          alert('Failed to get cache statistics.');
        }
      }, '📊');

      // Export options button
      createButton('Export Data', 190, () => {
        showExportDialog();
      }, '⬇️');

      // Cache controls button
      createButton('Cache Controls', 230, () => {
        showCacheControlDialog();
      }, '⚙️');
    }

    function showExportDialog() {
      const dialog = document.createElement('div');
      dialog.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: white;
        padding: 24px;
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.3);
        z-index: 1000000;
        min-width: 320px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      `;

      dialog.innerHTML = `
        <h3 style="margin: 0 0 16px; color: #333; font-size: 18px;">📤 Export Cache Data</h3>
        <p style="margin: 0 0 20px; color: #666; font-size: 14px;">
          Choose your preferred export format:
        </p>
        <div style="display: flex; gap: 12px; margin-bottom: 20px;">
          <button id="export-csv" style="flex: 1; padding: 12px; border: 2px solid #667eea; background: #667eea; color: white; border-radius: 8px; cursor: pointer; font-weight: 600;">
            📄 CSV Files
          </button>
          <button id="export-json" style="flex: 1; padding: 12px; border: 2px solid #764ba2; background: #764ba2; color: white; border-radius: 8px; cursor: pointer; font-weight: 600;">
            📋 JSON File
          </button>
        </div>
        <div style="display: flex; gap: 12px;">
          <button id="export-cancel" style="flex: 1; padding: 12px; border: 2px solid #ddd; background: white; color: #666; border-radius: 8px; cursor: pointer;">
            Cancel
          </button>
        </div>
      `;

      // Add backdrop
      const backdrop = document.createElement('div');
      backdrop.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.5);
        z-index: 999999;
      `;

      document.body.appendChild(backdrop);
      document.body.appendChild(dialog);

      // Event handlers
      dialog.querySelector('#export-csv').onclick = async () => {
        document.body.removeChild(backdrop);
        document.body.removeChild(dialog);
        try {
          await MessageCache.exportData('csv');
        } catch (err) {
          alert('Export failed: ' + err.message);
        }
      };

      dialog.querySelector('#export-json').onclick = async () => {
        document.body.removeChild(backdrop);
        document.body.removeChild(dialog);
        try {
          await MessageCache.exportData('json');
        } catch (err) {
          alert('Export failed: ' + err.message);
        }
      };

      dialog.querySelector('#export-cancel').onclick = () => {
        document.body.removeChild(backdrop);
        document.body.removeChild(dialog);
      };

      backdrop.onclick = () => {
        document.body.removeChild(backdrop);
        document.body.removeChild(dialog);
      };
    }

    function showCacheControlDialog() {
      const dialog = document.createElement('div');
      dialog.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: white;
        padding: 24px;
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.3);
        z-index: 1000000;
        min-width: 360px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      `;

      const isMonitoring = MessageCache.LiveMonitor.isMonitoring();

      dialog.innerHTML = `
        <h3 style="margin: 0 0 16px; color: #333; font-size: 18px;">⚙️ Cache Controls</h3>
        <div style="margin-bottom: 20px;">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <span style="color: #666;">Live Monitoring:</span>
            <span style="color: ${isMonitoring ? '#22c55e' : '#ef4444'}; font-weight: 600;">
              ${isMonitoring ? '✅ Active' : '❌ Inactive'}
            </span>
          </div>
          <button id="toggle-monitoring" style="width: 100%; padding: 12px; border: 2px solid #667eea; background: ${isMonitoring ? '#ef4444' : '#22c55e'}; color: white; border-radius: 8px; cursor: pointer; font-weight: 600; margin-bottom: 12px;">
            ${isMonitoring ? '⏹️ Stop Monitoring' : '▶️ Start Monitoring'}
          </button>
        </div>
        <div style="display: flex; gap: 12px;">
          <button id="cache-close" style="flex: 1; padding: 12px; border: 2px solid #ddd; background: white; color: #666; border-radius: 8px; cursor: pointer;">
            Close
          </button>
        </div>
      `;

      // Add backdrop
      const backdrop = document.createElement('div');
      backdrop.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.5);
        z-index: 999999;
      `;

      document.body.appendChild(backdrop);
      document.body.appendChild(dialog);

      // Event handlers
      dialog.querySelector('#toggle-monitoring').onclick = () => {
        if (MessageCache.LiveMonitor.isMonitoring()) {
          MessageCache.LiveMonitor.stopMonitoring();
        } else {
          MessageCache.LiveMonitor.startMonitoring();
        }
        document.body.removeChild(backdrop);
        document.body.removeChild(dialog);
        
        // Show confirmation
        setTimeout(() => {
          const newStatus = MessageCache.LiveMonitor.isMonitoring();
          alert(`Live monitoring ${newStatus ? 'started' : 'stopped'} successfully!`);
        }, 100);
      };

      dialog.querySelector('#cache-close').onclick = () => {
        document.body.removeChild(backdrop);
        document.body.removeChild(dialog);
      };

      backdrop.onclick = () => {
        document.body.removeChild(backdrop);
        document.body.removeChild(dialog);
      };
    }

    // Initialize buttons when DOM is ready
    function initialize() {
      if (document.body) {
        addCacheButtons();
      } else {
        window.addEventListener('DOMContentLoaded', addCacheButtons);
      }
    }

    return { initialize };
  })();

  // Initialize UI controls
  UIControls.initialize();

  /*────────────────── SECTION 6: GLOBAL DEBUG & UTILITIES ──────────────────*/
  // Expose debugging functions globally for easier testing
  window.GM_PLUS_DEBUG = {
    // Message Cache debugging
    async getCacheStats() {
      if (!MessageCache) return { error: 'MessageCache not available' };
      return await MessageCache.getStats();
    },
    
    async exportCacheData(format = 'json') {
      if (!MessageCache) return { error: 'MessageCache not available' };
      return await MessageCache.exportData(format);
    },
    
    toggleLiveMonitoring() {
      if (!MessageCache) return { error: 'MessageCache not available' };
      
      if (MessageCache.LiveMonitor.isMonitoring()) {
        MessageCache.LiveMonitor.stopMonitoring();
        return { status: 'stopped' };
      } else {
        MessageCache.LiveMonitor.startMonitoring();
        return { status: 'started' };
      }
    },
    
    // Font system debugging
    getCurrentFont() {
      const styleEl = document.getElementById('gm-font-style');
      return {
        hasStyle: !!styleEl,
        content: styleEl?.textContent || null,
        activeFont: window.localStorage.getItem('gmFont') || 'default'
      };
    },
    
    // Message counter debugging
    getCounterInfo() {
      return window.debugGroupCounter?.() || { error: 'Counter not available' };
    },
    
    // System info
    getSystemInfo() {
      return {
        version: '2.0',
        timestamp: new Date().toISOString(),
        url: window.location.href,
        userAgent: navigator.userAgent,
        features: {
          messageCache: !!MessageCache,
          lzString: !!window.LZString,
          indexedDB: !!window.indexedDB,
          webSocket: !!window.WebSocket
        }
      };
    },
      // Advanced cache operations
    async getCachedMessagesPreview(limit = 10) {
      if (!MessageCache) return { error: 'MessageCache not available' };
      
      try {
        const messages = await MessageCache.DB.getAllMessages();
        return {
          total: messages.length,
          preview: messages.slice(0, limit).map(msg => ({
            id: msg.id,
            text: msg.text?.substring(0, 100) + (msg.text?.length > 100 ? '...' : ''),
            created_at: msg.created_at,
            name: msg.name,
            group_id: msg.group_id,
            dom_extracted: msg.dom_extracted || false
          }))
        };
      } catch (err) {
        return { error: err.message };
      }
    },

    // DOM extraction controls
    enableDOMExtraction() {
      if (!MessageCache) return { error: 'MessageCache not available' };
      MessageCache.LiveMonitor.enableDOMExtraction();
      return { status: 'DOM extraction enabled - monitor for duplicates!' };
    },

    disableDOMExtraction() {
      if (!MessageCache) return { error: 'MessageCache not available' };
      MessageCache.LiveMonitor.disableDOMExtraction();
      return { status: 'DOM extraction disabled' };
    },

    isDOMExtractionEnabled() {
      if (!MessageCache) return { error: 'MessageCache not available' };
      return { enabled: MessageCache.LiveMonitor.isDOMEnabled() };
    },

    // Cleanup functions
    async cleanupDuplicates() {
      if (!MessageCache) return { error: 'MessageCache not available' };
      
      try {
        const messages = await MessageCache.DB.getAllMessages();
        const seenTexts = new Map();
        const duplicates = [];
        
        messages.forEach(msg => {
          const key = `${msg.text}_${msg.group_id}_${msg.created_at}`;
          if (seenTexts.has(key)) {
            // This is a duplicate
            if (msg.dom_extracted || msg.name === 'Unknown' || msg.id.includes('.')) {
              duplicates.push(msg.id);
            }
          } else {
            seenTexts.set(key, msg.id);
          }
        });
        
        console.log(`Found ${duplicates.length} potential duplicates to clean`);
        return { 
          found: duplicates.length,
          message: `Found ${duplicates.length} potential duplicates. Use cleanupDuplicatesConfirm() to remove them.`,
          duplicateIds: duplicates.slice(0, 10) // Show first 10 as preview
        };
      } catch (err) {
        return { error: err.message };
      }
    },
    
    async getEditHistory(limit = 10) {
      if (!MessageCache) return { error: 'MessageCache not available' };
      
      try {
        const edits = await MessageCache.DB.getEditHistory();
        return {
          total: edits.length,
          recent: edits.slice(-limit).map(edit => ({
            message_id: edit.message_id,
            original: edit.original_text?.substring(0, 50) + '...',
            new: edit.new_text?.substring(0, 50) + '...',
            timestamp: new Date(edit.edit_timestamp).toLocaleString()
          }))
        };
      } catch (err) {
        return { error: err.message };
      }
    },
    
    // Compression statistics
    async getCompressionStats() {
      if (!MessageCache) return { error: 'MessageCache not available' };
      
      try {
        const db = await MessageCache.DB.open();
        const tx = db.transaction(['messages'], 'readonly');
        const store = tx.objectStore('messages');
        
        return new Promise((resolve, reject) => {
          let totalMessages = 0;
          let compressedMessages = 0;
          let totalUncompressedEstimate = 0;
          let totalCompressedSize = 0;
          
          const req = store.openCursor();
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) {
              const compressionRatio = totalCompressedSize > 0 ? 
                ((totalUncompressedEstimate - totalCompressedSize) / totalUncompressedEstimate * 100).toFixed(1) : 0;
              
              return resolve({
                total_messages: totalMessages,
                compressed_messages: compressedMessages,
                uncompressed_messages: totalMessages - compressedMessages,
                estimated_uncompressed_size: `${(totalUncompressedEstimate / 1024 / 1024).toFixed(2)} MB`,
                actual_compressed_size: `${(totalCompressedSize / 1024 / 1024).toFixed(2)} MB`,
                compression_ratio: `${compressionRatio}%`,
                space_saved: `${((totalUncompressedEstimate - totalCompressedSize) / 1024 / 1024).toFixed(2)} MB`
              });
            }
            
            totalMessages++;
            const record = cursor.value;
            
            if (record.compressed) {
              compressedMessages++;
              totalCompressedSize += record.data.length * 2; // UTF-16 approx
              
              // Estimate original size by decompressing and measuring
              try {
                const decompressed = MessageCache.DB.decompressMessageFromStorage(record);
                if (decompressed) {
                  totalUncompressedEstimate += JSON.stringify(decompressed).length * 2;
                }
              } catch (err) {
                // Fallback estimate
                totalUncompressedEstimate += record.data.length * 3; // Rough estimate
              }
            } else {
              // Uncompressed fallback
              const jsonSize = JSON.stringify(record.data).length * 2;
              totalUncompressedEstimate += jsonSize;
              totalCompressedSize += jsonSize;
            }
            
            cursor.continue();
          };
          
          req.onerror = () => reject(req.error);
        });
      } catch (err) {
        return { error: err.message };
      }
    },
    
    // Performance monitoring
    getPerformanceMetrics() {
      return {
        memory: performance.memory ? {
          used: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) + ' MB',
          total: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024) + ' MB',
          limit: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024) + ' MB'
        } : 'Not available',
        timing: performance.timing ? {
          pageLoad: performance.timing.loadEventEnd - performance.timing.navigationStart + ' ms',
          domReady: performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart + ' ms'
        } : 'Not available'
      };
    }
  };

  // Enhanced console logging with better formatting
  const Logger = {
    info: (msg, ...args) => console.log(`%c[GM Plus]%c ${msg}`, 'color: #667eea; font-weight: bold', 'color: inherit', ...args),
    warn: (msg, ...args) => console.warn(`%c[GM Plus]%c ${msg}`, 'color: #f59e0b; font-weight: bold', 'color: inherit', ...args),
    error: (msg, ...args) => console.error(`%c[GM Plus]%c ${msg}`, 'color: #ef4444; font-weight: bold', 'color: inherit', ...args),
    success: (msg, ...args) => console.log(`%c[GM Plus]%c ${msg}`, 'color: #22c55e; font-weight: bold', 'color: inherit', ...args)
  };

  // Replace existing console.log calls with enhanced logger
  Logger.success('Extension loaded successfully! 🚀');
  Logger.info('Available debug commands:', Object.keys(window.GM_PLUS_DEBUG));
  Logger.info('Use GM_PLUS_DEBUG.getSystemInfo() to see system status');
})();
