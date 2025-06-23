(() => {
  const css = `
    :root {
      --gm-accent-1:#667eea;
      --gm-accent-2:#764ba2;
      --gm-bg-1:#141419;
      --gm-bg-2:#1e1e24;
      --gm-fg-1:#f3f4f6;
      --gm-fg-2:#a1a1aa;
      --gm-radius:8px;
    }
    html, body {
      background:var(--gm-bg-1) !important;
      color:var(--gm-fg-1) !important;
    }
    .gm-card {
      background:var(--gm-bg-2);
      border:1px solid #2a2a31;
      border-radius:var(--gm-radius);
      box-shadow:0 6px 18px rgba(0,0,0,.45);
    }
  `;

  function injectStyle() {
    const s = document.createElement('style');
    s.id = 'gm-plus-theme';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectStyleWhenReady() {
    if (document.head) {
      injectStyle();
    } else {
      window.addEventListener('DOMContentLoaded', injectStyle);
    }
  }

  injectStyleWhenReady();
})();
