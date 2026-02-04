/* NanoPix – POL digital vending machine (Polygon) */
(function () {
  'use strict';

  const SITE_NAME = 'NanoPix';
  const MERCHANT_ADDRESS = '0x3533F712F75f1513f728D2280eeaedE0B438bc6a'; // Polygon
  const MERCHANT_SOL_ADDRESS = '6bursz7njR3RjXLRMsjamJoNjf6pigtMjPC6KpLycGSd'; // Solana
  const MERCHANT_TRX_ADDRESS = 'TAhKGQVs5sXNGQrxbCqucHf23rezkwAo7X'; // Tron
  const POLYGON_CHAIN_ID = 137;
  const POLYGON_CHAIN_ID_HEX = '0x89';
  const SOLANA_MAINNET = 'https://solana.publicnode.com';
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
  let solanaPublicKey = null;
  let tronAddress = null;
  let tronWeb = null;
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
    const hasAny = currentAccount || solanaPublicKey || tronAddress;
    if (currentAccount) {
      connectWalletBtn.textContent = 'Connected (EVM)';
      connectWalletBtn.classList.add('connected');
      walletInfo.textContent = currentAccount.slice(0, 6) + '…' + currentAccount.slice(-4);
    } else if (solanaPublicKey) {
      connectWalletBtn.textContent = 'Connected (Solana)';
      connectWalletBtn.classList.add('connected');
      walletInfo.textContent = solanaPublicKey.slice(0, 6) + '…' + solanaPublicKey.slice(-4);
    } else if (tronAddress) {
      connectWalletBtn.textContent = 'Connected (Tron)';
      connectWalletBtn.classList.add('connected');
      walletInfo.textContent = tronAddress.slice(0, 6) + '…' + tronAddress.slice(-4);
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
          <p class="card-price">${escapeHtml(asset.pricePol)} POL / ${escapeHtml(asset.priceSol)} SOL / ${escapeHtml(asset.priceTrx)} TRX</p>
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
    const canBuyPol = currentAccount && signer;
    const hasSolana = typeof window.solana !== 'undefined';
    const hasTron = typeof window.tronLink !== 'undefined';
    let networkOk = false;
    if (provider) {
      provider.getNetwork().then((n) => {
        networkOk = Number(n.chainId) === POLYGON_CHAIN_ID;
        if (modalContent.dataset.assetId === asset.id) {
          const btn = modalContent.querySelector('.btn-buy-pol');
          if (btn) btn.disabled = !canBuyPol || !networkOk || hasToken;
        }
      }).catch(() => {});
    }

    modalContent.dataset.assetId = asset.id;
    modalContent.innerHTML = `
      <h2 class="modal-title" id="modalTitle">${escapeHtml(asset.title)}</h2>
      <img class="modal-preview" src="${escapeAttr(asset.previewUrl || asset.thumbUrl || '')}" alt="${escapeHtml(asset.title)}" />
      <p class="modal-description">${escapeHtml(asset.description || '')}</p>
      <p class="modal-price">${escapeHtml(asset.pricePol)} POL &nbsp;|&nbsp; ${escapeHtml(asset.priceSol)} SOL &nbsp;|&nbsp; ${escapeHtml(asset.priceTrx)} TRX</p>
      <div class="modal-actions">
        ${!currentAccount && !solanaPublicKey && !tronAddress ? '<button type="button" class="btn btn-wallet connect-in-modal">Connect Wallet</button>' : ''}
        <button type="button" class="btn btn-buy btn-buy-pol" ${!canBuyPol || hasToken ? 'disabled' : ''} title="Polygon (MetaMask)">Buy with POL</button>
        <button type="button" class="btn btn-buy btn-buy-sol" ${hasToken ? 'disabled' : ''} title="Solana (Phantom)">Buy with SOL</button>
        <button type="button" class="btn btn-buy btn-buy-trx" ${hasToken ? 'disabled' : ''} title="Tron (TronLink)">Buy with TRX</button>
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
    modalContent.querySelector('.btn-buy-sol')?.addEventListener('click', () => {
      buyWithSol(asset);
    });
    modalContent.querySelector('.btn-buy-trx')?.addEventListener('click', () => {
      buyWithTrx(asset);
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

  function setPaymentStatusTx(txHash, network) {
    network = network || 'polygon';
    const explorerUrls = {
      polygon: 'https://polygonscan.com/tx/',
      solana: 'https://solscan.io/tx/',
      tron: 'https://tronscan.org/#/transaction/',
    };
    const url = (explorerUrls[network] || explorerUrls.polygon) + txHash;
    const statusEl = modalContent.querySelector('#paymentStatus');
    if (!statusEl) return;
    statusEl.style.display = 'block';
    statusEl.className = 'payment-status success';
    statusEl.innerHTML = `Tx: <a class="tx-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(txHash.slice(0, 10))}…</a>`;
  }

  async function connectSolana() {
    if (typeof window.solana === 'undefined') {
      alert('Phantom (Solana wallet) is required. Please install it.');
      return false;
    }
    try {
      const resp = await window.solana.connect();
      solanaPublicKey = resp.publicKey ? resp.publicKey.toString() : null;
      updateWalletUI();
      if (modalOverlay.getAttribute('aria-hidden') === 'false') renderModalContent(getCurrentModalAsset());
      return !!solanaPublicKey;
    } catch (e) {
      console.error(e);
      alert('Failed to connect Phantom: ' + (e.message || String(e)));
      return false;
    }
  }

  async function connectTron() {
    if (typeof window.tronLink === 'undefined') {
      alert('TronLink is required. Please install it.');
      return false;
    }
    try {
      const res = await window.tronLink.request({ method: 'tron_requestAccounts' });
      if (res.code === 200 && res.address) {
        tronAddress = res.address;
        tronWeb = window.tronLink.tronWeb || null;
        updateWalletUI();
        if (modalOverlay.getAttribute('aria-hidden') === 'false') renderModalContent(getCurrentModalAsset());
        return true;
      }
      throw new Error(res.message || 'TronLink connection failed');
    } catch (e) {
      console.error(e);
      alert('Failed to connect TronLink: ' + (e.message || String(e)));
      return false;
    }
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
      setPaymentStatus('Pre platbu POL musí byť MetaMask na sieti Polygon. V MetaMaske zvoľ sieť → Polygon Mainnet (prípadne ju najprv pridaj).', 'error');
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
    setPaymentStatusTx(txHash, 'polygon');
    setPaymentStatus('Verifying payment with server…', 'pending');
    await callVerifyAndApplyToken(asset, txHash, currentAccount, 'polygon', POLYGON_CHAIN_ID);
  }

  async function buyWithSol(asset) {
    if (typeof window.solana === 'undefined') {
      setPaymentStatus('Pre platbu SOL nainštaluj peňaženku Phantom (phantom.app) a obnov stránku.', 'error');
      return;
    }
    if (!solanaPublicKey) {
      const ok = await connectSolana();
      if (!ok) return;
    }
    const merchant = MERCHANT_SOL_ADDRESS;
    if (!merchant || !merchant.trim()) {
      setPaymentStatus('Merchant Solana address not configured.', 'error');
      return;
    }
    const statusEl = modalContent.querySelector('#paymentStatus');
    statusEl.style.display = 'block';

    const amountSol = parseFloat(String(asset.priceSol || '0'));
    const lamports = Math.floor(amountSol * 1e9);
    if (lamports <= 0) {
      setPaymentStatus('Invalid SOL amount.', 'error');
      return;
    }

    const connection = new solanaWeb3.Connection(SOLANA_MAINNET);
    const fromPubkey = new solanaWeb3.PublicKey(solanaPublicKey);
    const toPubkey = new solanaWeb3.PublicKey(merchant);

    setPaymentStatus('Preparing transaction…', 'pending');
    let tx;
    try {
      const { blockhash } = await connection.getLatestBlockhash();
      tx = new solanaWeb3.Transaction().add(
        solanaWeb3.SystemProgram.transfer({
          fromPubkey,
          toPubkey,
          lamports,
        })
      );
      tx.feePayer = fromPubkey;
      tx.recentBlockhash = blockhash;
    } catch (e) {
      setPaymentStatus('Failed to prepare tx: ' + (e.message || String(e)), 'error');
      return;
    }

    setPaymentStatus('Confirm transaction in Phantom…', 'pending');
    let txHash;
    try {
      const signed = await window.solana.signTransaction(tx);
      txHash = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    } catch (e) {
      setPaymentStatus('Transaction rejected or failed: ' + (e.message || String(e)), 'error');
      return;
    }

    setPaymentStatusTx(txHash, 'solana');
    setPaymentStatus('Verifying payment with server…', 'pending');
    await callVerifyAndApplyToken(asset, txHash, solanaPublicKey, 'solana', 0);
  }

  async function buyWithTrx(asset) {
    if (typeof window.tronLink === 'undefined') {
      setPaymentStatus('Pre platbu TRX nainštaluj rozšírenie TronLink (tronlink.org) a obnov stránku.', 'error');
      return;
    }
    if (!tronAddress || !tronWeb) {
      const ok = await connectTron();
      if (!ok) return;
    }
    const merchant = MERCHANT_TRX_ADDRESS;
    if (!merchant || !merchant.trim()) {
      setPaymentStatus('Merchant Tron address not configured.', 'error');
      return;
    }
    const statusEl = modalContent.querySelector('#paymentStatus');
    statusEl.style.display = 'block';

    const amountTrx = parseFloat(String(asset.priceTrx || '0'));
    const amountSun = Math.floor(amountTrx * 1e6);
    if (amountSun <= 0) {
      setPaymentStatus('Invalid TRX amount.', 'error');
      return;
    }

    setPaymentStatus('Confirm transaction in TronLink…', 'pending');
    let txHash;
    try {
      const tx = await tronWeb.transactionBuilder.sendTrx(merchant, amountSun, tronAddress);
      const signed = await tronWeb.trx.sign(tx);
      const result = await tronWeb.trx.sendRawTransaction(signed);
      if (!result.result || result.result !== true) {
        throw new Error(result.message || 'Broadcast failed');
      }
      txHash = result.txid || result.transaction?.txID;
      if (!txHash) throw new Error('No tx id returned');
    } catch (e) {
      setPaymentStatus('Transaction rejected or failed: ' + (e.message || String(e)), 'error');
      return;
    }

    setPaymentStatusTx(txHash, 'tron');
    setPaymentStatus('Verifying payment with server…', 'pending');
    await callVerifyAndApplyToken(asset, txHash, tronAddress, 'tron', 0);
  }

  async function callVerifyAndApplyToken(asset, txHash, walletAddress, network, chainId) {
    const base = getApiBase();
    let res;
    try {
      res = await fetch(base + '/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash,
          assetId: asset.id,
          walletAddress,
          chainId: chainId || (network === 'polygon' ? POLYGON_CHAIN_ID : 0),
          network: network,
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

  window.solana?.on?.('accountChanged', (key) => {
    solanaPublicKey = key ? key.toString() : null;
    updateWalletUI();
    if (currentModalAsset && modalContent.dataset.assetId === currentModalAsset.id) {
      renderModalContent(currentModalAsset);
    }
  });

  window.solana?.on?.('disconnect', () => {
    solanaPublicKey = null;
    updateWalletUI();
    if (currentModalAsset && modalContent.dataset.assetId === currentModalAsset.id) {
      renderModalContent(currentModalAsset);
    }
  });

  loadPrice();
  loadTokensFromSession();
  loadAssets();
  updateWalletUI();
})();
