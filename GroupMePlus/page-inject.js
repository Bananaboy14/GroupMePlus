(function () {
  'use strict';
  
  const messageStore = new Map();
  let interceptCount = 0;

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = args[0];
    
    if (isGroupMeAPI(url)) {
      try {
        const clonedResponse = response.clone();
        await handleAPIResponse(clonedResponse, url, 'fetch');
      } catch (err) {
        console.warn('📡 Fetch intercept processing failed:', err);
      }
    }
    
    return response;
  };

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

  const originalWebSocket = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new originalWebSocket(...args);
    
    console.log('📡 WebSocket connection established:', args[0]);
    
    const originalOnMessage = ws.onmessage;
    ws.onmessage = function(event) {
      try {
        const data = JSON.parse(event.data);
        if (isRealtimeMessage(data)) {
          console.log('📡 Real-time message intercepted:', data);
          handleRealtimeMessage(data);
        }
      } catch (err) {
        console.warn('📡 WebSocket message parsing failed:', err);
      }
      
      if (originalOnMessage) {
        return originalOnMessage.call(this, event);
      }
    };
    
    ws.addEventListener('message', function (event) {
      try {
        const data = JSON.parse(event.data);
        if (isRealtimeMessage(data)) {
          console.log('📡 Real-time message via addEventListener:', data);
          handleRealtimeMessage(data);
        }
      } catch (err) {
        console.warn('📡 WebSocket addEventListener parsing failed:', err);
      }
    });
    
    return ws;
  };

  function isGroupMeAPI(url) {
    if (typeof url !== 'string') return false;
    
    return url.includes('groupme.com') && (
      (url.includes('/v3/') && (
        (url.includes('/groups/') && url.includes('/messages')) ||
        url.includes('/direct_messages') ||
        url.includes('/chats') ||
        url.includes('/likes') ||
        url.includes('/destroy')
      )) ||
      url.includes('/push/')
    );
  }

  function isRealtimeMessage(data) {
    return data && (
      data.type === 'message' ||
      data.subject === 'group.message' ||
      data.subject === 'direct_message.create' ||
      (data.data && data.data.type === 'message')
    );
  }
  async function handleAPIResponse(responseOrData, url, source) {
    try {
      const data = responseOrData.json ? await responseOrData.json() : responseOrData;

      // Look for access token and username in API responses
      let accessToken = null, username = null;
      if (data && data.meta && data.meta.access_token) {
        accessToken = data.meta.access_token;
      }
      if (data && data.response && data.response.user && data.response.user.name) {
        username = data.response.user.name;
      }
      // Fallback: try to find token in headers or other fields
      if (!accessToken && data && data.access_token) {
        accessToken = data.access_token;
      }
      if (!username && data && data.user && data.user.name) {
        username = data.user.name;
      }
      // If found, encrypt token and store in chrome.storage.sync
      if (accessToken && username) {
        // Simple numeric encoding (not secure, just obfuscation)
        function encryptToken(token) {
          return token.split('').map(c => c.charCodeAt(0)).join('-');
        }
        const encryptedToken = encryptToken(accessToken);
        chrome.storage.sync.set({
          'gmplus_diag_hidden': JSON.stringify({ token: encryptedToken, username: username, ts: Date.now() })
        }, function() {
          window.dispatchEvent(new CustomEvent('gmplus-token-update', { detail: { token: encryptedToken, username: username } }));
        });
      }

      if (!data || !data.response) return;

      const messages = data.response.messages ||
                       data.response.direct_messages ||
                       data.response ||
                       (Array.isArray(data.response) ? data.response : []);
      if (!Array.isArray(messages) || messages.length === 0) return;
      
      const processedMessages = {};
      let newCount = 0;
      let editCount = 0;
      let skippedCount = 0;
      
      for (const message of messages) {
        // skip messages without proper IDs
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
        
        // Check for edits
        if (messageStore.has(processed.id)) {
          const stored = messageStore.get(processed.id);
          if (stored.text !== processed.text && stored.text && processed.text && 
              stored.text.length > 0 && processed.text.length > 0) {
            processed.original_text = stored.text;
            processed.edit_detected = true;
            processed.edit_timestamp = Date.now();
            editCount++;
          } else {
            // Same message, skip
            skippedCount++;
            continue;
          }
        } else {
          newCount++;
        }
        
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
        
        // Debug: Show sample message structure for first message
        if (interceptCount === 1 && Object.keys(processedMessages).length > 0) {
          const sampleMsg = Object.values(processedMessages)[0];
          console.log('📋 Sample cached message structure:', {
            id: sampleMsg.id,
            fields: Object.keys(sampleMsg),
            hasAttachments: !!sampleMsg.attachments?.length,
            hasReactions: !!sampleMsg.reactions?.length,
            messageType: sampleMsg.message_type
          });
        }
        
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
      }
      
    } catch (err) {
      console.error('📡 API response handling failed:', err);
    }
  }

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
        } else { return;
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
      sender_type: rawMessage.sender_type,
      name: rawMessage.name,
      avatar_url: rawMessage.avatar_url,
      
      // Group/DM context
      group_id: rawMessage.group_id,
      conversation_id: rawMessage.conversation_id,
      
      // System and event fields
      system: rawMessage.system,
      event: rawMessage.event,
      
      // Social engagement fields
      favorited_by: rawMessage.favorited_by,
      reactions: rawMessage.reactions,
      
      // Pinning information
      pinned_at: rawMessage.pinned_at,
      pinned_by: rawMessage.pinned_by,
      
      // Technical fields
      source_guid: rawMessage.source_guid,
      platform: rawMessage.platform || 'web',
      
      // Message metadata
      source_url: url,
      intercepted_at: Date.now()
    };
    
    // Handle DMs
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
    
    // Handle attachments with full detail preservation
    if (rawMessage.attachments && Array.isArray(rawMessage.attachments)) {
      message.attachments = rawMessage.attachments.map(att => {
        const attachment = {
          type: att.type
        };
        
        // Copy all attachment properties
        const attachmentFields = [
          'url', 'preview_url', 'name', 'size', 'width', 'height',
          'user_id', 'reply_id', 'base_reply_id', 'latitude', 'longitude',
          'name', 'foursquare_venue_id', 'video_url', 'video_preview_url',
          'title', 'description', 'image_url', 'emoji', 'charmap'
        ];
        
        attachmentFields.forEach(field => {
          if (att[field] !== undefined && att[field] !== null) {
            attachment[field] = att[field];
          }
        });
        
        return attachment;
      }).filter(att => att.type); // Only keep attachments with a type
    }
    
    // Handle likes count (derived from favorited_by)
    if (message.favorited_by && Array.isArray(message.favorited_by)) {
      message.likes_count = message.favorited_by.length;
    }
    
    // Handle message type classification
    if (rawMessage.system) {
      message.message_type = 'system';
    } else if (rawMessage.event) {
      message.message_type = 'event';
    } else {
      message.message_type = 'user';
    }
    
    // Copy any additional fields that might be present
    const additionalFields = [
      'mentions', 'location', 'subject', 'poll', 'calendar_event',
      'image_url', 'video_url', 'audio_url', 'file_url'
    ];
    
    additionalFields.forEach(field => {
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
    
    return message;
  }

  setInterval(() => {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
    let cleaned = 0;
    
    for (const [id, data] of messageStore.entries()) {
      if (data.updated_at < cutoff) {
        messageStore.delete(id);
        cleaned++;
      }
    }
    
  }, 60 * 60 * 1000); // Once per hour

  window.GM_DEBUG = {
    getMessageStore: () => messageStore,
    getInterceptCount: () => interceptCount,
    clearMessageStore: () => {
      messageStore.clear();
    },
    getStats: () => ({
      stored_messages: messageStore.size,
      intercept_count: interceptCount,
      uptime: Date.now() - startTime
    })
  };

  const startTime = Date.now();
  
  console.log('[GM+ Page Script] Page injection script loaded and API interception active');
})();
