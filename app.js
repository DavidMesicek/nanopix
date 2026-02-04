/* NanoPix – POL digital vending machine (Polygon) */
(function () {
  'use strict';

  const SITE_NAME = 'NanoPix';
  const MERCHANT_ADDRESS = '0x0000000000000000000000000000000000000000'; // TODO: set your Polygon address
  const POLYGON_CHAIN_ID = 137;
  const POLYGON_CHAIN_ID_HEX = '0x89';
  const COINGECKO_IDS = 'polygon-ecosystem-token';
  const PRICE_CACHE_KEY = 'nanopix_pol_price';
  const PRICE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  const POLYGON_PARAMS = {
    chainId: POLYGON_CHAIN_ID_HEX,
    chainName: 'Polygon Mainnet',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    rpcUrls: ['https://polygon-rpc.com/'],
    blockExplorerUrls: ['https://polygonscan.com/'],
  };

  let provider = null;
  let signer = null;
  let currentAccount = null;
  let assets = [];
  const downloadTokens = new Map(); // assetId -> { token, expiresAt }

  const el = (id) => document.getElementById(id);
  const priceTicker = el('priceTicker');
  const tickerUsd = el('tickerUsd');
  const tickerEur = el('tickerEur');
  const tickerStale = el('tickerStale');
  const connectWalletBtn = el('connectWalletBtn');
  const walletInfo = el('walletInfo');
  const galleryGrid = el('galleryGrid');
  const modalOverlay = el('modalOverlay');
  const modalContent = el('modalContent');
  const modalClose = el('modalClose');

  function getApiBase() {
    const base = window.location.origin;
    return base.endsWith('/') ? base.slice(0, -1) : base;
  }

  function loadPrice() {
    const cached = localStorage.getItem(PRICE_CACHE_KEY);
    if (cached) {
      try {
        const { usd, eur, ts } = JSON.parse(cached);
        const age = Date.now() - ts;
        tickerUsd.textContent = usd != null ? `$${Number(usd).toFixed(4)}` : '—';
        tickerEur.textContent = eur != null ? `€${Number(eur).toFixed(4)}` : '—';
        if (age > PRICE_CACHE_MAX_AGE_MS) {
          tickerStale.textContent = '(stale)';
        } else {
          tickerStale.textContent = '';
        }
      } catch (_) {}
    } else {
      tickerUsd.textContent = '—';
      tickerEur.textContent = '—';
    }

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_IDS},matic-network&vs_currencies=usd,eur`;
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        const pet = data['polygon-ecosystem-token'] || data['matic-network'];
        if (pet && (pet.usd != null || pet.eur != null)) {
          const usd = pet.usd ?? null;
          const eur = pet.eur ?? null;
          localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify({ usd, eur, ts: Date.now() }));
          tickerUsd.textContent = usd != null ? `$${Number(usd).toFixed(4)}` : '—';
          tickerEur.textContent = eur != null ? `€${Number(eur).toFixed(4)}` : '—';
          tickerStale.textContent = '';
        }
      })
      .catch(() => {
        if (!tickerUsd.textContent || tickerUsd.textContent === '—') {
          tickerStale.textContent = '(unavailable)';
        }
      });
  }

  async function ensurePolygon() {
    if (!provider) throw new Error('Wallet not connected');
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    if (chainId === POLYGON_CHAIN_ID) return;

    try {
      await provider.send('wallet_switchEthereumChain', [{ chainId: POLYGON_CHAIN_ID_HEX }]);
    } catch (e) {
      if (e.code === 4902 || e.message?.includes('Unrecognized chain')) {
        await provider.send('wallet_addEthereumChain', [POLYGON_PARAMS]);
      } else {
        throw e;
      }
    }
  }

  async function connectWallet() {
    if (typeof window.ethereum === 'undefined') {
      alert('MetaMask (or another Web3 wallet) is required. Please install it.');
      return;
    }
    try {
      provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      if (!accounts || accounts.length === 0) throw new Error('No accounts');
      currentAccount = accounts[0];
      signer = await provider.getSigner();
      await ensurePolygon();
      updateWalletUI();
      if (modalOverlay.getAttribute('aria-hidden') === 'false') {
        renderModalContent(getCurrentModalAsset());
      }
    } catch (e) {
      console.error(e);
      alert('Failed to connect: ' + (e.message || String(e)));
    }
  }

  function updateWalletUI() {
    if (currentAccount) {
      connectWalletBtn.textContent = 'Connected';
      connectWalletBtn.classList.add('connected');
      walletInfo.textContent = currentAccount.slice(0, 6) + '…' + currentAccount.slice(-4);
    } else {
      connectWalletBtn.textContent = 'Connect Wallet';
      connectWalletBtn.classList.remove('connected');
      walletInfo.textContent = '';
    }
  }

  function loadTokensFromSession() {
    try {
      const raw = sessionStorage.getItem('nanopix_download_tokens');
      if (raw) {
        const arr = JSON.parse(raw);
        arr.forEach(({ assetId, token, expiresAt }) => {
          if (expiresAt && new Date(expiresAt).getTime() > Date.now()) {
            downloadTokens.set(assetId, { token, expiresAt });
          }
        });
      }
    } catch (_) {}
  }

  function saveTokensToSession() {
    const arr = [];
    downloadTokens.forEach((v, assetId) => arr.push({ assetId, token: v.token, expiresAt: v.expiresAt }));
    sessionStorage.setItem('nanopix_download_tokens', JSON.stringify(arr));
  }

  function setDownloadToken(assetId, token, expiresAt) {
    downloadTokens.set(assetId, { token, expiresAt });
    saveTokensToSession();
  }

  function getDownloadToken(assetId) {
    const v = downloadTokens.get(assetId);
    if (!v || (v.expiresAt && new Date(v.expiresAt).getTime() <= Date.now())) return null;
    return v.token;
  }

  async function loadAssets() {
    try {
      const r = await fetch('assets.json');
      if (!r.ok) throw new Error('Catalog load failed');
      const data = await r.json();
      assets = Array.isArray(data) ? data : (data.assets || data.items || []);
    } catch (e) {
      console.error(e);
      assets = [];
      galleryGrid.innerHTML = '<p class="payment-status error">Could not load catalog. Check assets.json.</p>';
      return;
    }
    renderGallery();
  }

  function renderGallery() {
    galleryGrid.innerHTML = '';
    assets.forEach((asset) => {
      const card = document.createElement('article');
      card.className = 'card';
      card.innerHTML = `
        <img class="card-image" src="${escapeAttr(asset.thumbUrl || asset.previewUrl || '')}" alt="${escapeAttr(asset.title)}" loading="lazy" />
        <div class="card-body">
          <h2 class="card-title">${escapeHtml(asset.title)}</h2>
          <p class="card-price">${escapeHtml(asset.pricePol)} POL</p>
          <div class="card-actions">
            <button type="button" class="btn btn-view" data-asset-id="${escapeAttr(asset.id)}">View</button>
          </div>
        </div>
      `;
      card.querySelector('.btn-view').addEventListener('click', () => openModal(asset));
      galleryGrid.appendChild(card);
    });
  }

  let currentModalAsset = null;

  function getCurrentModalAsset() {
    return currentModalAsset;
  }

  function openModal(asset) {
    currentModalAsset = asset;
    modalOverlay.setAttribute('aria-hidden', 'false');
    renderModalContent(asset);
  }

  function closeModal() {
    modalOverlay.setAttribute('aria-hidden', 'true');
    currentModalAsset = null;
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s ?? '';
    return div.innerHTML;
  }

  function escapeAttr(s) {
    return String(s ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderModalContent(asset) {
    if (!asset) return;
    const hasToken = !!getDownloadToken(asset.id);
    const canBuy = currentAccount && signer;
    let networkOk = false;
    if (provider) {
      provider.getNetwork().then((n) => {
        networkOk = Number(n.chainId) === POLYGON_CHAIN_ID;
        if (modalContent.dataset.assetId === asset.id) {
          const buyBtn = modalContent.querySelector('.btn-buy');
          if (buyBtn) buyBtn.disabled = !networkOk || hasToken;
        }
      }).catch(() => {});
    }

    modalContent.dataset.assetId = asset.id;
    modalContent.innerHTML = `
      <h2 class="modal-title" id="modalTitle">${escapeHtml(asset.title)}</h2>
      <img class="modal-preview" src="${escapeAttr(asset.previewUrl || asset.thumbUrl || '')}" alt="${escapeHtml(asset.title)}" />
      <p class="modal-description">${escapeHtml(asset.description || '')}</p>
      <p class="modal-price">${escapeHtml(asset.pricePol)} POL</p>
      <div class="modal-actions">
        ${!currentAccount ? '<button type="button" class="btn btn-wallet connect-in-modal">Connect Wallet</button>' : ''}
        <button type="button" class="btn btn-buy btn-buy-pol" ${!canBuy || hasToken ? 'disabled' : ''}>Buy with POL</button>
        ${hasToken ? '<button type="button" class="btn btn-download btn-download-asset">Download</button>' : ''}
      </div>
      <div class="payment-status" id="paymentStatus" style="display:none;"></div>
    `;

    modalContent.querySelector('.connect-in-modal')?.addEventListener('click', () => {
      connectWallet();
    });

    modalContent.querySelector('.btn-buy-pol')?.addEventListener('click', () => {
      buyWithPol(asset);
    });

    modalContent.querySelector('.btn-download-asset')?.addEventListener('click', () => {
      downloadAsset(asset);
    });
  }

  function setPaymentStatus(text, className) {
    const statusEl = modalContent.querySelector('#paymentStatus');
    if (!statusEl) return;
    statusEl.style.display = text ? 'block' : 'none';
    statusEl.textContent = text;
    statusEl.className = 'payment-status' + (className ? ' ' + className : '');
  }

  function setPaymentStatusTx(txHash) {
    const url = `https://polygonscan.com/tx/${txHash}`;
    const statusEl = modalContent.querySelector('#paymentStatus');
    if (!statusEl) return;
    statusEl.style.display = 'block';
    statusEl.className = 'payment-status success';
    statusEl.innerHTML = `Tx: <a class="tx-link" href="${url}" target="_blank" rel="noopener">${txHash.slice(0, 10)}…</a>`;
  }

  async function buyWithPol(asset) {
    if (!signer || !currentAccount) {
      setPaymentStatus('Please connect your wallet first.', 'error');
      return;
    }
    const statusEl = modalContent.querySelector('#paymentStatus');
    statusEl.style.display = 'block';

    try {
      setPaymentStatus('Switching network…', 'pending');
      await ensurePolygon();
    } catch (e) {
      setPaymentStatus('Wrong network. Please switch to Polygon.', 'error');
      return;
    }

    const valueWei = ethers.parseEther(String(asset.pricePol));
    const merchant = MERCHANT_ADDRESS;
    if (!merchant || merchant === '0x0000000000000000000000000000000000000000') {
      setPaymentStatus('Merchant address not configured.', 'error');
      return;
    }

    setPaymentStatus('Confirm transaction in your wallet…', 'pending');
    let tx;
    try {
      tx = await signer.sendTransaction({ to: merchant, value: valueWei });
    } catch (e) {
      setPaymentStatus('Transaction rejected or failed: ' + (e.message || String(e)), 'error');
      return;
    }

    setPaymentStatus('Waiting for confirmation…', 'pending');
    let receipt;
    try {
      receipt = await tx.wait(1);
    } catch (e) {
      setPaymentStatus('Confirmation failed: ' + (e.message || String(e)), 'error');
      return;
    }

    const txHash = receipt.hash;
    setPaymentStatusTx(txHash);

    setPaymentStatus('Verifying payment with server…', 'pending');
    const base = getApiBase();
    let res;
    try {
      res = await fetch(base + '/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash,
          assetId: asset.id,
          walletAddress: currentAccount,
          chainId: POLYGON_CHAIN_ID,
        }),
      });
    } catch (e) {
      setPaymentStatus('Backend unavailable. Please try again later.', 'error');
      return;
    }

    if (!res.ok) {
      const errText = await res.text();
      setPaymentStatus('Verification failed: ' + (errText || res.status), 'error');
      return;
    }

    let data;
    try {
      data = await res.json();
    } catch (_) {
      setPaymentStatus('Invalid response from server.', 'error');
      return;
    }

    const token = data.downloadToken;
    const expiresAt = data.expiresAt || null;
    if (!token) {
      setPaymentStatus('Server did not return a download token.', 'error');
      return;
    }

    setDownloadToken(asset.id, token, expiresAt);
    setPaymentStatus('Purchase confirmed. You can download below.', 'success');
    renderModalContent(asset);
  }

  function downloadAsset(asset) {
    const token = getDownloadToken(asset.id);
    if (!token) {
      alert('Download link expired or invalid. Please purchase again.');
      return;
    }
    const base = getApiBase();
    const url = base + '/api/download?token=' + encodeURIComponent(token);
    window.open(url, '_self');
  }

  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  connectWalletBtn.addEventListener('click', connectWallet);

  window.ethereum?.on?.('accountsChanged', async (accounts) => {
    currentAccount = accounts && accounts[0] ? accounts[0] : null;
    signer = null;
    provider = currentAccount ? new ethers.BrowserProvider(window.ethereum) : null;
    if (provider && currentAccount) signer = await provider.getSigner();
    updateWalletUI();
    if (currentModalAsset && modalContent.dataset.assetId === currentModalAsset.id) {
      renderModalContent(currentModalAsset);
    }
  });

  window.ethereum?.on?.('chainChanged', () => {
    if (currentModalAsset && modalContent.dataset.assetId === currentModalAsset.id) {
      renderModalContent(currentModalAsset);
    }
  });

  loadPrice();
  loadTokensFromSession();
  loadAssets();
  updateWalletUI();
})();
