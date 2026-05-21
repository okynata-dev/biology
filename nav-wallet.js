/**
 * Bioms · Shared nav-wallet pill
 *
 * EIP-6963 multi-wallet picker (modelled on dustopia.xyz): clicking
 * the pill opens a modal listing EVERY injected wallet — MetaMask,
 * Rabby, Coinbase, Phantom, Brave, Frame, etc. The user picks one
 * and we connect via that specific provider, bypassing the legacy
 * window.ethereum hijack wars that single-provider apps get stuck in.
 *
 * Architecture:
 *   - Boot: announce/request EIP-6963 providers, collect list
 *   - Click pill: open modal with list (icon + name)
 *   - User picks: call provider.request({eth_requestAccounts})
 *   - On success: pill flips to connected state, modal closes, address
 *     persists to localStorage as 'bioms-wallet-addr' (+ rdns for
 *     reconnect)
 *   - Silent reconnect on next page-load via eth_accounts (no prompt)
 *
 * Persistence:
 *   - bioms-wallet-addr  (lowercased address)
 *   - bioms-wallet-rdns  (e.g. "io.metamask" — to find same provider
 *                         on reload)
 *   Cross-tab sync via the native `storage` event; same-tab via
 *   the synthetic `bioms-wallet-change` CustomEvent.
 *
 * Lab integration:
 *   lab.html's Wallet.connect() also writes to these keys so the pill
 *   stays in sync whether the user connects from the header or from
 *   inside the Lab.
 */
(function () {
  'use strict';

  const ADDR_KEY = 'bioms-wallet-addr';
  const RDNS_KEY = 'bioms-wallet-rdns';
  const CHAIN_ID_HEX = '0x1';                  // Ethereum mainnet
  const DISCOVERY_WINDOW_MS = 350;             // wallets respond fast; 350ms covers slow ones

  // === State ===
  const providers = [];                        // [{ info, provider }]
  let activeProvider = null;                   // raw EIP-1193 provider that's currently bound
  let modalEl = null;
  let dropdownEl = null;

  // === Storage helpers ===
  function getAddr() {
    try {
      const a = localStorage.getItem(ADDR_KEY);
      return (a && /^0x[a-fA-F0-9]{40}$/.test(a)) ? a.toLowerCase() : null;
    } catch (_) { return null; }
  }
  function getRdns() { try { return localStorage.getItem(RDNS_KEY) || null; } catch (_) { return null; } }
  function setStoredWallet(addr, rdns) {
    try {
      if (addr) localStorage.setItem(ADDR_KEY, addr.toLowerCase());
      else localStorage.removeItem(ADDR_KEY);
      if (rdns) localStorage.setItem(RDNS_KEY, rdns);
      else localStorage.removeItem(RDNS_KEY);
    } catch (_) {}
    window.dispatchEvent(new CustomEvent('bioms-wallet-change', { detail: { addr: addr || null } }));
  }

  function shortAddr(a) {
    return a ? (a.slice(0, 6) + '…' + a.slice(-4)) : '';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // === EIP-6963 discovery ===
  // Listen for announcements + dispatch request. Wallets reply
  // synchronously with their info+provider. We collect and dedupe.
  function startDiscovery() {
    const seen = new Set();
    window.addEventListener('eip6963:announceProvider', (e) => {
      if (!e || !e.detail || !e.detail.provider || !e.detail.info) return;
      const uuid = e.detail.info.uuid;
      if (uuid && seen.has(uuid)) return;
      if (uuid) seen.add(uuid);
      providers.push({ info: e.detail.info, provider: e.detail.provider });
    });
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
  }

  // === Pill DOM ===
  function buildPill() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-wallet';
    btn.setAttribute('aria-label', 'Connect wallet');
    btn.innerHTML = '<span class="nav-wallet-label">Connect</span>';
    return btn;
  }

  function updatePill(btn, addr) {
    if (addr) {
      btn.classList.add('connected');
      btn.classList.remove('connecting');
      btn.removeAttribute('disabled');
      btn.setAttribute('aria-label', `Wallet connected: ${shortAddr(addr)}. Click for options.`);
      btn.innerHTML = '<span class="nav-wallet-dot" aria-hidden="true"></span><span class="nav-wallet-label">' + shortAddr(addr) + '</span>';
    } else {
      btn.classList.remove('connected', 'connecting');
      btn.removeAttribute('disabled');
      btn.setAttribute('aria-label', 'Connect wallet');
      btn.innerHTML = '<span class="nav-wallet-label">Connect</span>';
    }
  }

  // === Modal (wallet picker) ===
  function closeModal() {
    if (modalEl) {
      modalEl.remove();
      modalEl = null;
      document.removeEventListener('keydown', onModalKey);
    }
  }
  function onModalKey(e) { if (e.key === 'Escape') closeModal(); }

  // Detect mobile so we can surface the right CTAs. Modern mobile
  // wallets accept universal-link redirects that open the dapp inside
  // their in-app browser, where window.ethereum is injected and the
  // standard EIP-6963 flow works. This is the cheapest "any popular
  // wallet" solution short of integrating WalletConnect v2 (which
  // needs a Reown project ID — separate task).
  const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const HERE = encodeURIComponent(location.host + location.pathname + location.search);

  // Mobile deep-links. Each opens the dapp inside the wallet's
  // in-app browser. Universal links handle "is the app installed?"
  // automatically — installed → app opens; not installed → wallet's
  // landing page in the browser.
  //
  // Inline brand icons: data-URI SVGs so they ship in this file with
  // no extra HTTP requests. Each is a simplified mark that captures
  // the brand's primary identity (fox snout, Coinbase circle, Rainbow
  // arc, Trust shield) — enough to read at 28px against the cream
  // paper background.
  const ICON_METAMASK = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><defs><linearGradient id='m' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%23f6851b'/><stop offset='1' stop-color='%23e2761b'/></linearGradient></defs><rect width='48' height='48' rx='12' fill='url(%23m)'/><path d='M14 13l8 6-2-4-6-2zm20 0l-8 6 2-4 6-2zM16 30l-2 4 4 1-2-5zm16 0l2 4-4 1 2-5zm-12 5l4 2 4-2-2 3h-4l-2-3z' fill='%23fff'/></svg>";
  const ICON_COINBASE = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect width='48' height='48' rx='12' fill='%230052ff'/><circle cx='24' cy='24' r='10' fill='none' stroke='%23fff' stroke-width='3'/><rect x='20' y='20' width='8' height='8' rx='1' fill='%23fff'/></svg>";
  const ICON_RAINBOW = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><defs><linearGradient id='r' x1='0' y1='1' x2='1' y2='0'><stop offset='0' stop-color='%23174299'/><stop offset='0.25' stop-color='%23001e59'/><stop offset='0.5' stop-color='%23001e59'/><stop offset='0.75' stop-color='%23174299'/><stop offset='1' stop-color='%23174299'/></linearGradient></defs><rect width='48' height='48' rx='12' fill='url(%23r)'/><path d='M10 38v-5a16 16 0 0116-16h5' stroke='%23ff4000' stroke-width='3' fill='none'/><path d='M10 38v-9a12 12 0 0112-12h9' stroke='%23ffb800' stroke-width='3' fill='none'/><path d='M10 38v-13a8 8 0 018-8h13' stroke='%2300d4ff' stroke-width='3' fill='none'/><circle cx='12' cy='36' r='2.5' fill='%23ff4000'/></svg>";
  const ICON_TRUST = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect width='48' height='48' rx='12' fill='%230500ff'/><path d='M24 10l-10 4v8c0 7 4 13 10 16 6-3 10-9 10-16v-8l-10-4z' fill='%23fff'/><path d='M19 23l4 4 7-7' fill='none' stroke='%230500ff' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/></svg>";
  const MOBILE_WALLETS = [
    { name: 'MetaMask',        rdns: 'io.metamask', icon: ICON_METAMASK,
      url: `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.search}` },
    { name: 'Coinbase Wallet', rdns: 'com.coinbase.wallet', icon: ICON_COINBASE,
      url: `https://go.cb-w.com/dapp?cb_url=https%3A%2F%2F${HERE}` },
    { name: 'Rainbow',         rdns: 'me.rainbow', icon: ICON_RAINBOW,
      url: `https://rnbwapp.com/dapp/${location.host}${location.pathname}${location.search}` },
    { name: 'Trust Wallet',    rdns: 'com.trustwallet.app', icon: ICON_TRUST,
      url: `https://link.trustwallet.com/open_url?coin_id=60&url=https%3A%2F%2F${HERE}` },
  ];

  function openModal(pillBtn) {
    closeModal();
    // Re-announce in case wallets were slow on initial boot
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}

    const installedList = providers.length
      ? providers.map((p, i) => `
          <button type="button" class="nav-wallet-modal-option" data-i="${i}">
            ${p.info.icon ? `<img class="nav-wallet-modal-icon" src="${esc(p.info.icon)}" alt="" width="28" height="28">` : '<span class="nav-wallet-modal-icon-blank"></span>'}
            <span class="nav-wallet-modal-name">${esc(p.info.name)}</span>
            <span class="nav-wallet-modal-arrow" aria-hidden="true">→</span>
          </button>
        `).join('')
      : '';

    // Mobile wallet links — but only for wallets the user DOESN'T
    // already have as a desktop extension. No point showing
    // "MetaMask Mobile" if MetaMask extension is right there in the
    // Installed section — that confused users. Match by rdns first
    // (canonical) then by name (fallback for legacy injectors).
    const installedRdns = new Set(providers.map(p => (p.info.rdns || '').toLowerCase()));
    const installedNames = new Set(providers.map(p => (p.info.name || '').toLowerCase()));
    const filteredMobile = MOBILE_WALLETS.filter(w =>
      !installedRdns.has(w.rdns.toLowerCase()) &&
      !installedNames.has(w.name.toLowerCase())
    );
    const mobileList = filteredMobile.map(w => `
      <a class="nav-wallet-modal-option nav-wallet-modal-mobile" href="${esc(w.url)}" target="_blank" rel="noopener">
        <img class="nav-wallet-modal-icon" src="${w.icon}" alt="" width="28" height="28">
        <span class="nav-wallet-modal-name">${esc(w.name)}</span>
        <span class="nav-wallet-modal-arrow" aria-hidden="true">↗</span>
      </a>
    `).join('');

    // Composition:
    //   - If any EIP-6963 providers detected → show them as primary
    //   - Always show mobile deep-link section (collapsible label on desktop)
    //   - Empty fallback if nothing detected AND user is on desktop with
    //     no wallets — direct install links
    let body = '';
    if (installedList) {
      body += `
        <div class="nav-wallet-modal-section-label">Installed</div>
        <div class="nav-wallet-modal-list">${installedList}</div>
      `;
    } else if (!IS_MOBILE) {
      body += `
        <div class="nav-wallet-modal-empty">
          <p>No wallet extensions detected in this browser.</p>
          <p class="nav-wallet-modal-empty-sub">Install
            <a href="https://metamask.io" target="_blank" rel="noopener">MetaMask</a>,
            <a href="https://rabby.io" target="_blank" rel="noopener">Rabby</a>, or
            <a href="https://www.coinbase.com/wallet" target="_blank" rel="noopener">Coinbase Wallet</a>,
            then reload this page.</p>
        </div>
      `;
    }
    // Mobile section: skip entirely if filtered list is empty (e.g.
    // user has all 4 mobile wallets installed as extensions, which
    // is rare but possible)
    if (filteredMobile.length > 0) {
      body += `
        <div class="nav-wallet-modal-section-label">${installedList ? 'Or open in a mobile wallet' : 'Open in a mobile wallet'}</div>
        <div class="nav-wallet-modal-list">${mobileList}</div>
      `;
    }

    modalEl = document.createElement('div');
    modalEl.className = 'nav-wallet-modal-backdrop';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.setAttribute('aria-labelledby', 'nav-wallet-modal-title');
    modalEl.innerHTML = `
      <div class="nav-wallet-modal" role="document">
        <div class="nav-wallet-modal-head">
          <h2 id="nav-wallet-modal-title">Connect a wallet</h2>
          <button type="button" class="nav-wallet-modal-close" aria-label="Close">×</button>
        </div>
        <p class="nav-wallet-modal-sub">${installedList ? 'Pick a wallet to continue.' : 'Pick where you want to connect.'}</p>
        ${body}
      </div>
    `;
    document.body.appendChild(modalEl);

    // Backdrop click closes
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
    modalEl.querySelector('.nav-wallet-modal-close').addEventListener('click', closeModal);
    document.addEventListener('keydown', onModalKey);
    // Wire wallet options
    modalEl.querySelectorAll('.nav-wallet-modal-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.i, 10);
        connectViaProvider(pillBtn, providers[i]);
      });
    });
  }

  // === Connect flow (per-provider) ===
  async function connectViaProvider(pillBtn, entry) {
    if (!entry || !entry.provider) return;
    console.info('[nav-wallet] picked', entry.info.name, entry.info.rdns);
    // Synchronously start the request so the user-gesture chain is preserved
    const reqPromise = entry.provider.request({ method: 'eth_requestAccounts' });
    // Optimistic UI in modal: mark this option as connecting
    const buttons = modalEl ? modalEl.querySelectorAll('.nav-wallet-modal-option') : null;
    if (buttons) buttons.forEach(b => b.setAttribute('disabled', 'disabled'));
    let accounts;
    try {
      accounts = await reqPromise;
    } catch (err) {
      console.warn('[nav-wallet] eth_requestAccounts failed:', err && (err.code + ' ' + err.message));
      if (buttons) buttons.forEach(b => b.removeAttribute('disabled'));
      if (err && err.code === -32002) {
        // Pending request elsewhere — flash a hint
        const sub = modalEl && modalEl.querySelector('.nav-wallet-modal-sub');
        if (sub) {
          const orig = sub.textContent;
          sub.textContent = 'A request is already pending in your wallet — check it.';
          setTimeout(() => { if (sub) sub.textContent = orig; }, 3500);
        }
      }
      return;
    }
    const addr = (accounts && accounts[0] || '').toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(addr)) {
      console.warn('[nav-wallet] no account returned from', entry.info.name);
      if (buttons) buttons.forEach(b => b.removeAttribute('disabled'));
      return;
    }
    // Best-effort chain switch to mainnet
    try {
      await entry.provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: CHAIN_ID_HEX }],
      });
    } catch (_) { /* user declined — leave them where they were */ }

    activeProvider = entry.provider;
    setStoredWallet(addr, entry.info.rdns || '');
    // Expose the picked provider globally so lab.html (and any other
    // page-level wallet flow) can talk to the same EIP-1193 instance
    // we just connected to, instead of fighting over window.ethereum.
    window.biomsWalletProvider     = entry.provider;
    window.biomsWalletProviderInfo = entry.info;
    updatePill(pillBtn, addr);
    bindProviderEvents(entry.provider, pillBtn);
    closeModal();
    console.info('[nav-wallet] connected via', entry.info.name, addr);
  }

  // === Provider event sync (account changed externally) ===
  function bindProviderEvents(provider, pillBtn) {
    if (!provider || !provider.on || provider.__biomsWired) return;
    provider.__biomsWired = true;
    provider.on('accountsChanged', (accs) => {
      const next = ((accs && accs[0]) || '').toLowerCase();
      if (!next || !/^0x[a-f0-9]{40}$/.test(next)) {
        // Wallet disconnected externally
        activeProvider = null;
        setStoredWallet(null, null);
        updatePill(pillBtn, null);
      } else if (next !== getAddr()) {
        setStoredWallet(next, getRdns() || '');
        updatePill(pillBtn, next);
      }
    });
    provider.on('chainChanged', () => { /* mainnet-only; no-op */ });
  }

  // === Connected-pill dropdown ===
  function closeDropdown() {
    if (dropdownEl) {
      dropdownEl.remove();
      dropdownEl = null;
      document.removeEventListener('click', onDropdownOutside, true);
      document.removeEventListener('keydown', onDropdownKey);
    }
  }
  function onDropdownOutside(e) {
    if (dropdownEl && !dropdownEl.contains(e.target)) closeDropdown();
  }
  function onDropdownKey(e) { if (e.key === 'Escape') closeDropdown(); }

  function openDropdown(pillBtn, addr) {
    closeDropdown();
    dropdownEl = document.createElement('div');
    dropdownEl.className = 'nav-wallet-dropdown';
    dropdownEl.setAttribute('role', 'menu');
    dropdownEl.innerHTML = `
      <div class="nav-wallet-dd-addr">${esc(addr)}</div>
      <a href="https://etherscan.io/address/${esc(addr)}" target="_blank" rel="noopener" role="menuitem">View on Etherscan ↗</a>
      <button type="button" class="nav-wallet-dd-copy" role="menuitem">Copy address</button>
      <button type="button" class="nav-wallet-dd-disconnect" role="menuitem">Disconnect</button>
    `;
    const r = pillBtn.getBoundingClientRect();
    dropdownEl.style.position = 'fixed';
    dropdownEl.style.top  = (r.bottom + 6) + 'px';
    dropdownEl.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    document.body.appendChild(dropdownEl);
    dropdownEl.querySelector('.nav-wallet-dd-disconnect').addEventListener('click', () => {
      activeProvider = null;
      window.biomsWalletProvider     = null;
      window.biomsWalletProviderInfo = null;
      setStoredWallet(null, null);
      updatePill(pillBtn, null);
      closeDropdown();
    });
    dropdownEl.querySelector('.nav-wallet-dd-copy').addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText(addr);
        const b = e.currentTarget; const orig = b.textContent;
        b.textContent = 'Copied ✓';
        setTimeout(() => { if (b) b.textContent = orig; }, 1400);
      } catch (_) {}
    });
    setTimeout(() => {
      document.addEventListener('click', onDropdownOutside, true);
      document.addEventListener('keydown', onDropdownKey);
    }, 0);
  }

  // === Silent reconnect on page load ===
  // If the user previously connected, we DON'T trigger a popup — we
  // just call eth_accounts which returns already-authorized addresses
  // silently. Then we re-bind state without UX disruption.
  async function tryReconnect(pillBtn) {
    const savedAddr = getAddr();
    const savedRdns = getRdns();
    if (!savedAddr) return;
    // Try by saved rdns first, fall back to any provider
    const entry = providers.find(p => p.info.rdns === savedRdns) || providers[0];
    if (!entry) return;  // wallet uninstalled / not announced this time
    try {
      const accs = await entry.provider.request({ method: 'eth_accounts' });
      const addr = (accs && accs[0] || '').toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(addr)) {
        // Wallet no longer authorizing us — clear stale state
        setStoredWallet(null, null);
        return;
      }
      activeProvider = entry.provider;
      setStoredWallet(addr, entry.info.rdns || '');
      // Same as fresh connect: expose for lab.html and other consumers
      window.biomsWalletProvider     = entry.provider;
      window.biomsWalletProviderInfo = entry.info;
      updatePill(pillBtn, addr);
      bindProviderEvents(entry.provider, pillBtn);
    } catch (_) {
      // Wallet is locked, errored, etc — leave pill as Connect
    }
  }

  // === Boot ===
  startDiscovery();

  function boot() {
    const navLinks = document.querySelector('nav .nav-links');
    if (!navLinks) {
      console.warn('[nav-wallet] no nav .nav-links on this page — pill not mounted');
      return;
    }
    const pill = buildPill();
    navLinks.insertBefore(pill, navLinks.firstChild);

    // Render initial state from localStorage (might be stale; tryReconnect refines)
    updatePill(pill, getAddr());

    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const addr = getAddr();
      if (addr) {
        if (dropdownEl) closeDropdown();
        else openDropdown(pill, addr);
      } else {
        openModal(pill);
      }
    });

    window.addEventListener('storage', (e) => {
      if (e.key === ADDR_KEY) updatePill(pill, getAddr());
    });
    window.addEventListener('bioms-wallet-change', () => {
      updatePill(pill, getAddr());
      closeDropdown();
    });

    // Give wallets a beat to announce, then attempt silent reconnect.
    setTimeout(() => tryReconnect(pill), DISCOVERY_WINDOW_MS);

    // Expose a global so other parts of the page (lab.html in
    // particular) can open the same picker modal instead of
    // re-implementing wallet UX. The pill is captured in closure here.
    window.biomsOpenWalletPicker = () => openModal(pill);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
