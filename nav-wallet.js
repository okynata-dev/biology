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

  function openModal(pillBtn) {
    closeModal();
    // Re-announce in case wallets were slow on initial boot
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}

    const list = providers.length
      ? providers.map((p, i) => `
          <button type="button" class="nav-wallet-modal-option" data-i="${i}">
            ${p.info.icon ? `<img class="nav-wallet-modal-icon" src="${esc(p.info.icon)}" alt="" width="28" height="28">` : '<span class="nav-wallet-modal-icon-blank"></span>'}
            <span class="nav-wallet-modal-name">${esc(p.info.name)}</span>
            <span class="nav-wallet-modal-arrow" aria-hidden="true">→</span>
          </button>
        `).join('')
      : `<div class="nav-wallet-modal-empty">
           <p>No wallets detected in this browser.</p>
           <p class="nav-wallet-modal-empty-sub">Install
             <a href="https://metamask.io" target="_blank" rel="noopener">MetaMask</a>,
             <a href="https://rabby.io" target="_blank" rel="noopener">Rabby</a>, or
             <a href="https://www.coinbase.com/wallet" target="_blank" rel="noopener">Coinbase Wallet</a>
             and reload this page.</p>
         </div>`;

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
        <p class="nav-wallet-modal-sub">Pick any wallet you have installed.</p>
        <div class="nav-wallet-modal-list">${list}</div>
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
