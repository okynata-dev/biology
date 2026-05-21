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

  // === Wallet flow ===
  async function connectWallet(btn) {
    if (!window.ethereum) {
      // No injected provider. Open a quick help link in a new tab.
      // (Mobile WalletConnect support deferred — keeps this file tiny.)
      window.open('https://metamask.io/download/', '_blank', 'noopener');
      return;
    }
    btn.classList.add('connecting');
    const orig = btn.innerHTML;
    btn.innerHTML = '<span class="nav-wallet-label">Connecting…</span>';
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const addr = (accounts && accounts[0]) ? accounts[0].toLowerCase() : null;
      if (!addr) throw new Error('No account returned');
      // Best-effort chain switch to mainnet (silent fail if user declines)
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: CHAIN_ID_HEX }],
        });
      } catch (_) { /* user declined — keep going, lab UI will warn if relevant */ }
      setStoredAddr(addr);
    } catch (err) {
      // User rejected, or no permission — silently restore prior state
      console.warn('[nav-wallet] connect cancelled:', err && err.message);
      btn.innerHTML = orig;
    } finally {
      btn.classList.remove('connecting');
    }
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
    if (!navLinks) return;

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
