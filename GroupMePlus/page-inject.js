// page-inject.js - Enhanced API interception for comprehensive message caching
(function () {
  'use strict';
  
  console.log('🚀 GroupMe Plus page script initializing...');
  
  // Store for tracking message state and detecting edits
  const messageStore = new Map();
  let interceptCount = 0;

  // Enhanced fetch interception
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = args[0];
    
    if (isGroupMeAPI(url)) {
      try {
        // Clone response for processing without affecting original
        const clonedResponse = response.clone();
        await handleAPIResponse(clonedResponse, url, 'fetch');
      } catch (err) {
        console.warn('📡 Fetch intercept processing failed:', err);
      }
    }
    
    return response;
  };

  // Enhanced XMLHttpRequest interception
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (isGroupMeAPI(url)) {
      this.addEventListener('load', () => {
        if (this.status >= 200 && this.status < 300) {
          try {
            const data = this.responseText ? JSON.parse(this.responseText) : {};
            handleAPIResponse(data, url, 'xhr');
          } catch (err) {
            console.warn('📡 XHR intercept processing failed:', err);
          }
        }
      });
    }
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  // WebSocket interception for real-time messages
  const originalWebSocket = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new originalWebSocket(...args);
    
    // Intercept WebSocket messages
    const originalOnMessage = ws.onmessage;
    ws.addEventListener('message', function (event) {
      try {
        const data = JSON.parse(event.data);
        if (isRealtimeMessage(data)) {
          console.log('📡 Real-time message intercepted via WebSocket');
          handleRealtimeMessage(data);
        }
      } catch (err) {
        // Not JSON or not relevant, ignore
      }
    });
    
    return ws;
  };

  // Improved API detection
  function isGroupMeAPI(url) {
    if (typeof url !== 'string') return false;
    
    return url.includes('groupme.com') && (
      (url.includes('/v3/') && (
        (url.includes('/groups/') && url.includes('/messages')) ||
        url.includes('/direct_messages') ||
        url.includes('/likes') ||
        url.includes('/destroy') // For message deletions
      )) ||
      url.includes('/push/') // Real-time endpoints
    );
  }

  // Check if data contains real-time message updates
  function isRealtimeMessage(data) {
    return data && (
      data.type === 'message' ||
      data.subject === 'group.message' ||
      data.subject === 'direct_message.create' ||
      (data.data && data.data.type === 'message')
    );
  }
  // Enhanced message processing with strict validation
  async function handleAPIResponse(responseOrData, url, source) {
    try {
      const data = responseOrData.json ? await responseOrData.json() : responseOrData;
      
      if (!data || !data.response) return;
      
      const messages = data.response.messages || data.response.direct_messages || [];
      if (!Array.isArray(messages) || messages.length === 0) return;
      
      const processedMessages = {};
      let newCount = 0;
      let editCount = 0;
      let skippedCount = 0;
      
      for (const message of messages) {
        // Strict validation - skip messages without proper IDs
        if (!message.id || typeof message.id !== 'string' || message.id.length < 10) {
          console.warn('📡 Skipping message with invalid ID:', message.id);
          skippedCount++;
          continue;
        }
        
        // Skip messages without essential data
        if (!message.text && !message.attachments?.length && !message.event) {
          console.warn('📡 Skipping message without content:', message.id);
          skippedCount++;
          continue;
        }
        
        const processed = enhanceMessage(message, url);
        const messageKey = `msg-${processed.id}`;
        
        // Check for edits by comparing with stored version
        if (messageStore.has(processed.id)) {
          const stored = messageStore.get(processed.id);
          if (stored.text !== processed.text && stored.text && processed.text && 
              stored.text.length > 0 && processed.text.length > 0) {
            processed.original_text = stored.text;
            processed.edit_detected = true;
            processed.edit_timestamp = Date.now();
            editCount++;
            console.log(`📝 Edit detected for message ${processed.id}`);
          } else {
            // Same message, skip
            skippedCount++;
            continue;
          }
        } else {
          newCount++;
        }
        
        // Update our local store
        messageStore.set(processed.id, {
          text: processed.text,
          name: processed.name,
          updated_at: Date.now()
        });
        
        processedMessages[messageKey] = processed;
      }
      
      if (Object.keys(processedMessages).length > 0) {
        interceptCount++;
        console.log(`📥 ${source.toUpperCase()}: ${newCount} new, ${editCount} edited, ${skippedCount} skipped (batch #${interceptCount})`);
        
        // Send to content script
        window.postMessage({
          type: 'GM_MESSAGES',
          payload: processedMessages,
          metadata: {
            source,
            url,
            timestamp: Date.now(),
            new_count: newCount,
            edit_count: editCount,
            skipped_count: skippedCount,
            batch_id: interceptCount
          }
        }, '*');
      } else if (skippedCount > 0) {
        console.log(`📥 ${source.toUpperCase()}: All ${skippedCount} messages skipped (duplicates/invalid)`);
      }
      
    } catch (err) {
      console.error('📡 API response handling failed:', err);
    }
  }

  // Handle real-time messages with validation
  function handleRealtimeMessage(data) {
    try {
      const message = data.data || data.message || data;
      if (!message || !message.id || typeof message.id !== 'string' || message.id.length < 10) {
        console.warn('📡 Skipping real-time message with invalid ID:', message?.id);
        return;
      }
      
      const processed = enhanceMessage(message, 'websocket');
      processed.realtime = true;
      processed.received_at = Date.now();
      
      const messageKey = `msg-${processed.id}`;
      const payload = { [messageKey]: processed };
      
      // Check for edit in real-time
      if (messageStore.has(processed.id)) {
        const stored = messageStore.get(processed.id);
        if (stored.text !== processed.text && stored.text && processed.text &&
            stored.text.length > 0 && processed.text.length > 0) {
          processed.original_text = stored.text;
          processed.edit_detected = true;
          processed.edit_timestamp = Date.now();
          console.log(`📝 Real-time edit detected for message ${processed.id}`);
        } else {
          // Same message, skip
          console.log(`📡 Skipping duplicate real-time message: ${processed.id}`);
          return;
        }
      }
      
      messageStore.set(processed.id, {
        text: processed.text,
        name: processed.name,
        updated_at: Date.now()
      });
      
      console.log('📡 Real-time message processed:', processed.id);
      
      window.postMessage({
        type: 'GM_MESSAGES',
        payload,
        metadata: {
          source: 'realtime',
          url: 'websocket',
          timestamp: Date.now(),
          new_count: 1,
          edit_count: processed.edit_detected ? 1 : 0
        }
      }, '*');
      
    } catch (err) {
      console.error('📡 Real-time message handling failed:', err);
    }
  }

  // Enhanced message data extraction and enrichment
  function enhanceMessage(rawMessage, url) {
    const message = {
      // Core fields
      id: rawMessage.id,
      text: rawMessage.text || '',
      created_at: rawMessage.created_at,
      updated_at: rawMessage.updated_at,
      
      // User information
      user_id: rawMessage.user_id || rawMessage.sender_id,
      sender_id: rawMessage.sender_id || rawMessage.user_id,
      name: rawMessage.name,
      avatar_url: rawMessage.avatar_url,
      
      // Group/DM context
      group_id: rawMessage.group_id,
      conversation_id: rawMessage.conversation_id,
      
      // Message metadata
      source_url: url,
      intercepted_at: Date.now(),
      platform: rawMessage.platform || 'web'
    };
    
    // Handle DM context
    if (url && url.includes('/direct_messages')) {
      message.is_dm = true;
      const otherUserMatch = url.match(/other_user_id=(\d+)/);
      if (otherUserMatch) {
        message.dm_other_user_id = otherUserMatch[1];
      }
    } else if (rawMessage.is_dm || rawMessage.direct_message) {
      message.is_dm = true;
      if (rawMessage.dm_other_user_id || rawMessage.other_user_id) {
        message.dm_other_user_id = rawMessage.dm_other_user_id || rawMessage.other_user_id;
      }
    }
    
    // Optional fields (only include if present)
    const optionalFields = [
      'attachments', 'favorited_by', 'likes_count', 'mentions',
      'system', 'event', 'subject', 'location'
    ];
    
    optionalFields.forEach(field => {
      if (rawMessage[field] !== undefined && rawMessage[field] !== null) {
        if (Array.isArray(rawMessage[field])) {
          if (rawMessage[field].length > 0) {
            message[field] = rawMessage[field];
          }
        } else {
          message[field] = rawMessage[field];
        }
      }
    });
    
    // Handle special message types
    if (rawMessage.system) {
      message.system = true;
      message.message_type = 'system';
    } else if (rawMessage.event) {
      message.event = rawMessage.event;
      message.message_type = 'event';
    } else {
      message.message_type = 'user';
    }
    
    // Parse attachments for better structure
    if (message.attachments && Array.isArray(message.attachments)) {
      message.attachments = message.attachments.map(att => ({
        type: att.type,
        url: att.url,
        preview_url: att.preview_url,
        name: att.name,
        size: att.size
      })).filter(att => att.type && att.url);
    }
    
    return message;
  }

  // Periodic cleanup of message store to prevent memory leaks
  setInterval(() => {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
    let cleaned = 0;
    
    for (const [id, data] of messageStore.entries()) {
      if (data.updated_at < cutoff) {
        messageStore.delete(id);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`🧹 Cleaned ${cleaned} old message entries from memory`);
    }
  }, 60 * 60 * 1000); // Run every hour

  // Expose debugging interface
  window.GM_DEBUG = {
    getMessageStore: () => messageStore,
    getInterceptCount: () => interceptCount,
    clearMessageStore: () => {
      messageStore.clear();
      console.log('🧹 Message store cleared');
    },
    getStats: () => ({
      stored_messages: messageStore.size,
      intercept_count: interceptCount,
      uptime: Date.now() - startTime
    })
  };

  const startTime = Date.now();
  console.log('✅ GroupMe Plus page script active - Enhanced message interception enabled');
})();
