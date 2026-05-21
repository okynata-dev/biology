/**
 * Bioms · Shared nav-wallet pill
 *
 * Drop-in connect/disconnect button for every page that has a nav.
 * Persists the wallet address in localStorage under 'bioms-wallet-addr'
 * so lab.html and any other wallet-aware code can read the same key
 * (sync across tabs via `storage` events).
 *
 * Render contract:
 *   - looks for `.nav-links` in the current page's nav
 *   - injects a <button class="nav-wallet"> just before the first child
 *     (so it sits at the LEFT of the existing nav links)
 *   - if already connected, shows truncated address
 *   - if not, shows "Connect"
 *
 * State machine:
 *   disconnected → click → request accounts → connected
 *   connected    → click → show dropdown (Etherscan link, Disconnect)
 *   disconnected → no wallet provider → click → modal-ish prompt with
 *                  link to MetaMask
 *
 * Defensive:
 *   - if window.ethereum is missing (mobile non-dapp browser) clicking
 *     opens a help link
 *   - wraps everything in try/catch so a bad eth response doesn't break
 *     the rest of the page
 *   - never throws to the page-level handler
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'bioms-wallet-addr';
  const CHAIN_ID_HEX = '0x1';  // Ethereum mainnet

  function getStoredAddr() {
    try {
      const a = localStorage.getItem(STORAGE_KEY);
      return (a && /^0x[a-fA-F0-9]{40}$/.test(a)) ? a.toLowerCase() : null;
    } catch (_) { return null; }
  }

  function setStoredAddr(a) {
    try {
      if (a) localStorage.setItem(STORAGE_KEY, a.toLowerCase());
      else localStorage.removeItem(STORAGE_KEY);
      // Fire a synthetic storage event for same-tab listeners (the
      // native one only fires across tabs).
      window.dispatchEvent(new CustomEvent('bioms-wallet-change', { detail: { addr: a || null } }));
    } catch (_) {}
  }

  function shortAddr(addr) {
    if (!addr) return '';
    return addr.slice(0, 6) + '…' + addr.slice(-4);
  }

  // === Build the pill DOM ===
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
      btn.setAttribute('aria-label', `Wallet connected: ${shortAddr(addr)}. Click for options.`);
      btn.innerHTML = '<span class="nav-wallet-dot" aria-hidden="true"></span><span class="nav-wallet-label">' + shortAddr(addr) + '</span>';
    } else {
      btn.classList.remove('connected');
      btn.setAttribute('aria-label', 'Connect wallet');
      btn.innerHTML = '<span class="nav-wallet-label">Connect</span>';
    }
  }

  // === Dropdown (shown when connected pill is clicked) ===
  let openDropdown = null;
  function closeDropdown() {
    if (openDropdown) {
      openDropdown.remove();
      openDropdown = null;
      document.removeEventListener('click', onOutsideClick, true);
      document.removeEventListener('keydown', onEsc);
    }
  }
  function onOutsideClick(e) {
    if (openDropdown && !openDropdown.contains(e.target)) closeDropdown();
  }
  function onEsc(e) { if (e.key === 'Escape') closeDropdown(); }

  function showDropdown(anchorBtn, addr) {
    closeDropdown();
    const dd = document.createElement('div');
    dd.className = 'nav-wallet-dropdown';
    dd.setAttribute('role', 'menu');
    dd.innerHTML = `
      <div class="nav-wallet-dd-addr">${addr}</div>
      <a href="https://etherscan.io/address/${addr}" target="_blank" rel="noopener" role="menuitem">View on Etherscan ↗</a>
      <button type="button" class="nav-wallet-dd-copy" role="menuitem">Copy address</button>
      <button type="button" class="nav-wallet-dd-disconnect" role="menuitem">Disconnect</button>
    `;
    // Position under the button
    const r = anchorBtn.getBoundingClientRect();
    dd.style.position = 'fixed';
    dd.style.top  = (r.bottom + 6) + 'px';
    dd.style.right = (window.innerWidth - r.right) + 'px';
    document.body.appendChild(dd);
    openDropdown = dd;

    // Wire actions
    dd.querySelector('.nav-wallet-dd-disconnect').addEventListener('click', () => {
      setStoredAddr(null);
      closeDropdown();
    });
    dd.querySelector('.nav-wallet-dd-copy').addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText(addr);
        e.currentTarget.textContent = 'Copied ✓';
        setTimeout(() => { if (e.currentTarget) e.currentTarget.textContent = 'Copy address'; }, 1400);
      } catch (_) {}
    });

    // Defer outside-click handler so the same click that opened doesn't close it
    setTimeout(() => {
      document.addEventListener('click', onOutsideClick, true);
      document.addEventListener('keydown', onEsc);
    }, 0);
  }

  // === EIP-6963 multi-wallet discovery ===
  // Modern wallet standard: every wallet extension announces itself
  // via an 'eip6963:announceProvider' event. We collect all and let
  // the user (or our default rule) pick one, instead of fighting over
  // window.ethereum where the last-installed wallet wins.
  //
  // Real-world problem we hit: user had OKX Wallet + MetaMask both
  // installed. OKX hijacked window.ethereum, masqueraded as MetaMask
  // (isMetaMask: true), and threw "Unexpected error at selectExtension"
  // when we called eth_requestAccounts. EIP-6963 sidesteps the
  // hijack by talking to MetaMask directly.
  const _eip6963Providers = [];
  if (typeof window !== 'undefined') {
    window.addEventListener('eip6963:announceProvider', (e) => {
      if (!e || !e.detail || !e.detail.provider) return;
      // Dedupe by uuid (some wallets re-announce on every request)
      const uuid = e.detail.info && e.detail.info.uuid;
      if (uuid && _eip6963Providers.some(p => p.info && p.info.uuid === uuid)) return;
      _eip6963Providers.push(e.detail);
    });
    // Ask wallets to announce themselves (idempotent — wallets debounce internally)
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
  }

  // Pick the best provider:
  //   1. MetaMask by rdns (most common, our primary integration target)
  //   2. First EIP-6963 provider
  //   3. Fallback to window.ethereum (legacy single-injection)
  function pickProvider() {
    // Re-announce in case extensions just finished initialising
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
    const mm = _eip6963Providers.find(p => p.info && p.info.rdns === 'io.metamask');
    if (mm) return { provider: mm.provider, name: mm.info.name };
    if (_eip6963Providers.length > 0) return { provider: _eip6963Providers[0].provider, name: _eip6963Providers[0].info.name };
    if (window.ethereum) return { provider: window.ethereum, name: 'window.ethereum (legacy)' };
    return null;
  }

  // === Wallet flow ===
  async function connectWallet(btn) {
    const picked = pickProvider();
    console.info('[nav-wallet] connect click', {
      eip6963Count: _eip6963Providers.length,
      eip6963Names: _eip6963Providers.map(p => p.info && p.info.name),
      picked: picked ? picked.name : 'NONE',
    });
    if (!picked) {
      console.warn('[nav-wallet] no wallet provider found — opening MetaMask download');
      window.open('https://metamask.io/download/', '_blank', 'noopener');
      return;
    }
    const provider = picked.provider;
    // CRITICAL: fire eth_requestAccounts BEFORE any DOM mutation. Some
    // wallet builds ignore the call if the user-gesture chain is broken
    // by intervening DOM work (innerHTML / classList changes count).
    // We capture the promise SYNCHRONOUSLY here, then update UI safely
    // in the next microtask.
    const reqPromise = provider.request({ method: 'eth_requestAccounts' });
    // Now (post-gesture) we can mutate the DOM freely. Tell the user
    // to look at their wallet — MetaMask opens a separate popup window
    // and people miss it constantly.
    const origLabel = btn.querySelector('.nav-wallet-label');
    if (origLabel) origLabel.textContent = 'Approve in wallet…';
    btn.classList.add('connecting');
    btn.setAttribute('disabled', 'disabled');

    let accounts;
    try {
      accounts = await reqPromise;
    } catch (err) {
      btn.classList.remove('connecting');
      btn.removeAttribute('disabled');
      if (origLabel) origLabel.textContent = 'Connect';
      // Code -32002 = already-pending request. MetaMask is sitting on
      // an unresolved popup. Give the user a clear hint.
      if (err && err.code === -32002) {
        if (origLabel) origLabel.textContent = 'Check wallet';
        setTimeout(() => { if (origLabel) origLabel.textContent = 'Connect'; }, 3500);
        console.warn('[nav-wallet] previous request still pending in wallet — open MetaMask to resolve');
      } else {
        // User rejected (4001), wallet locked, etc.
        console.warn('[nav-wallet] eth_requestAccounts failed:', err && (err.code + ' ' + err.message));
      }
      return;
    }
    btn.classList.remove('connecting');
    btn.removeAttribute('disabled');
    const addr = (accounts && accounts[0]) ? accounts[0].toLowerCase() : null;
    if (!addr) {
      console.warn('[nav-wallet] no account returned from provider');
      return;
    }
    // Best-effort chain switch to mainnet (silent fail if user declines)
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: CHAIN_ID_HEX }],
      });
    } catch (_) { /* user declined — keep going, lab UI will warn if relevant */ }
    setStoredAddr(addr);
    console.info('[nav-wallet] connected:', addr, 'via', picked.name);
  }

  // === Watch injected provider for external changes ===
  function bindProviderEvents(btn) {
    if (!window.ethereum || !window.ethereum.on) return;
    // User changes account in MetaMask
    window.ethereum.on('accountsChanged', (accounts) => {
      const next = accounts && accounts[0];
      if (!next) setStoredAddr(null);
      else if (next.toLowerCase() !== getStoredAddr()) setStoredAddr(next);
    });
    // Chain changed — for now we just keep the address; pages that
    // care about chain do their own check
    window.ethereum.on('chainChanged', () => {
      // no-op — leave UI as is
    });
  }

  // === Boot ===
  function boot() {
    // Find nav-links container on this page. If the page doesn't have
    // one (e.g. soup.html with its custom HUD-only nav, or admin), bail.
    const navLinks = document.querySelector('nav .nav-links');
    if (!navLinks) {
      console.warn('[nav-wallet] no nav .nav-links on this page — pill not mounted');
      return;
    }
    console.info('[nav-wallet] mounting pill');

    const pill = buildPill();
    // Insert as the FIRST child of nav-links so it appears to the left
    // of the existing links (visual hierarchy: action > navigation).
    navLinks.insertBefore(pill, navLinks.firstChild);

    // Initial render from localStorage
    updatePill(pill, getStoredAddr());

    // Click handling
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const addr = getStoredAddr();
      if (addr) {
        // Connected → toggle dropdown
        if (openDropdown) closeDropdown();
        else showDropdown(pill, addr);
      } else {
        connectWallet(pill);
      }
    });

    // Cross-tab + lab-side updates
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) updatePill(pill, getStoredAddr());
    });
    window.addEventListener('bioms-wallet-change', () => {
      updatePill(pill, getStoredAddr());
      closeDropdown();
    });

    bindProviderEvents(pill);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
