 (function() {
  'use strict';

  // Sidebar container
  let sidebar = document.createElement('div');
  sidebar.id = 'gmplus-diagnostics';
  sidebar.style.position = 'fixed';
  sidebar.style.top = '0';
  sidebar.style.right = '0';
  sidebar.style.width = '320px';
  sidebar.style.height = '100vh';
  sidebar.style.background = '#fff';
  sidebar.style.borderLeft = '2px solid #ccc';
  sidebar.style.zIndex = '99999';
  sidebar.style.display = 'none';
  sidebar.style.overflowY = 'auto';
  sidebar.style.boxShadow = '0 0 8px rgba(0,0,0,0.15)';
  sidebar.innerHTML = `
    <div style="padding:16px; border-bottom:1px solid #eee; font-weight:bold; font-size:18px;">Diagnostics</div>
    <div id="gmplus-session-info" style="padding:16px;">
      <div><b>Session Status:</b> <span id="gmplus-session-status">Connected</span></div>
      <div><b>Last Sync:</b> <span id="gmplus-last-sync">Never</span></div>
      <div><b>Message Status:</b> <span id="gmplus-message-status">Receiving</span></div>
      <div><b>Delay:</b> <span id="gmplus-message-delay">0 ms</span></div>
      <div id="gmplus-hidden-token" style="display:none; margin-top:16px;"></div>
    </div>
  `;
  document.body.appendChild(sidebar);

  // Show/hide sidebar
  window.gmplusShowSidebar = function(show) {
    sidebar.style.display = show ? 'block' : 'none';
  };

  // Update session info
  window.gmplusUpdateSessionInfo = function(lastSync) {
    document.getElementById('gmplus-last-sync').textContent = lastSync;
  };

  // Update message status and delay (fake)
  window.gmplusUpdateMessageStatus = function(status, delay) {
    document.getElementById('gmplus-message-status').textContent = status;
    document.getElementById('gmplus-message-delay').textContent = delay + ' ms';
  };

  // Reveal hidden token area
  window.gmplusRevealToken = function(token, username) {
    const hiddenDiv = document.getElementById('gmplus-hidden-token');
    hiddenDiv.style.display = 'block';
    hiddenDiv.innerHTML = `<b>Access Token:</b> <span style='font-family:monospace;'>${token}</span> <button id='gmplus-delete-token' title='Delete token' style='margin-left:8px;cursor:pointer;background:#f8f8f8;border:1px solid #ccc;border-radius:3px;padding:2px 6px;font-size:12px;'>✕</button><br><b>Username:</b> <span style='font-family:monospace;'>${username}</span>`;
    // Add delete handler
    document.getElementById('gmplus-delete-token').onclick = function() {
      chrome.storage.sync.remove('gmplus_diag_hidden');
      window.gmplusHideToken();
    };
  };

  // Hide token area
  window.gmplusHideToken = function() {
    const hiddenDiv = document.getElementById('gmplus-hidden-token');
    hiddenDiv.style.display = 'none';
    hiddenDiv.innerHTML = '';
  };

  // Listen for secret key combo (e.g., Ctrl+Shift+G)
  let secretActive = false;
  let tokenPoller = null;
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'G') {
      secretActive = !secretActive;
      window.gmplusShowSidebar(secretActive);
      if (secretActive) {
        // Start polling for token updates
        tokenPoller = setInterval(() => {
          chrome.storage.sync.get('gmplus_diag_hidden', function(data) {
            try {
              const obj = typeof data['gmplus_diag_hidden'] === 'string' ? JSON.parse(data['gmplus_diag_hidden']) : {};
              if (obj.token && obj.username) {
                window.gmplusRevealToken(obj.token, obj.username);
                window.gmplusUpdateSessionInfo(new Date().toLocaleTimeString());
                window.gmplusUpdateMessageStatus('Receiving', Math.floor(Math.random()*100));
              } else {
                window.gmplusUpdateMessageStatus('Not Receiving', 'N/A');
                document.getElementById('gmplus-session-status').textContent = 'Disconnected';
                // Suggest reload
                document.getElementById('gmplus-message-status').textContent += ' (Reload page to restore)';
              }
            } catch {}
          });
        }, 2000);
      } else {
        // Stop polling and hide token
        clearInterval(tokenPoller);
        window.gmplusHideToken();
      }
    }
  });

  // Listen for token updates (from page-inject.js)
  window.addEventListener('gmplus-token-update', function(e) {
    if (secretActive) {
      window.gmplusRevealToken(e.detail.token, e.detail.username);
      window.gmplusUpdateSessionInfo(new Date().toLocaleTimeString());
      window.gmplusUpdateMessageStatus('Receiving', Math.floor(Math.random()*100));
    }
  });

  // For disguise: update session info every 5s
  setInterval(() => {
    window.gmplusUpdateSessionInfo(new Date().toLocaleTimeString());
    window.gmplusUpdateMessageStatus('Receiving', Math.floor(Math.random()*100));
  }, 5000);
})();
