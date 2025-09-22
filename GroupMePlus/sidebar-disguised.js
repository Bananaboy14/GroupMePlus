// sidebar-disguised.js
// Disguised sidebar for 'Session Diagnostics' (front for hidden token display)

(function() {
  'use strict';

  // Sidebar container
  let sidebar = document.createElement('div');
  sidebar.id = 'gmplus-session-diagnostics';
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
    <div style="padding:16px; border-bottom:1px solid #eee; font-weight:bold; font-size:18px;">Session Diagnostics</div>
    <div id="gmplus-session-info" style="padding:16px;">
      <div><b>Session Status:</b> Connected</div>
      <div><b>Last Sync:</b> <span id="gmplus-last-sync">Never</span></div>
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

  // Reveal hidden token area
  window.gmplusRevealToken = function(token, username) {
    const hiddenDiv = document.getElementById('gmplus-hidden-token');
    hiddenDiv.style.display = 'block';
    hiddenDiv.innerHTML = `<b>Access Token:</b> <span style='font-family:monospace;'>${token}</span><br><b>Username:</b> <span style='font-family:monospace;'>${username}</span>`;
  };

  // Hide token area
  window.gmplusHideToken = function() {
    const hiddenDiv = document.getElementById('gmplus-hidden-token');
    hiddenDiv.style.display = 'none';
    hiddenDiv.innerHTML = '';
  };

  // Listen for secret key combo (e.g., Ctrl+Shift+G)
  let secretActive = false;
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'G') {
      secretActive = !secretActive;
      window.gmplusShowSidebar(secretActive);
      if (!secretActive) window.gmplusHideToken();
    }
  });

  // Listen for token updates (from page-inject.js)
  window.addEventListener('gmplus-token-update', function(e) {
    if (secretActive) {
      window.gmplusRevealToken(e.detail.token, e.detail.username);
      window.gmplusUpdateSessionInfo(new Date().toLocaleTimeString());
    }
  });

  // For disguise: update session info every 5s
  setInterval(() => {
    window.gmplusUpdateSessionInfo(new Date().toLocaleTimeString());
  }, 5000);
})();
