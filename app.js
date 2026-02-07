/* NanoPix – POL digital vending machine (Polygon) */
(function () {
  'use strict';

  const SITE_NAME = 'NanoPix';
  const MERCHANT_ADDRESS = '0x3533F712F75f1513f728D2280eeaedE0B438bc6a'; // Polygon
  const POLYGON_CHAIN_ID = 137;
  const POLYGON_CHAIN_ID_HEX = '0x89';
  const COINGECKO_IDS = 'polygon-ecosystem-token';
  const PRICE_CACHE_KEY = 'nanopix_pol_price';
  const PRICE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  const PRICE_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
  const PRICE_EUR = 0.10;

  let currentPolPriceEur = null;

  const POLYGON_PARAMS = {
    chainId: POLYGON_CHAIN_ID_HEX,
    chainName: 'Polygon Mainnet',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    rpcUrls: ['https://polygon-rpc.com/'],
    blockExplorerUrls: ['https://polygonscan.com/'],
  };

  function getEthereumProvider() {
    if (typeof window.ethereum === 'undefined') return undefined;
    const e = window.ethereum;
    if (e.providers && Array.isArray(e.providers)) {
      const metaMask = e.providers.find(function (p) { return p.isMetaMask === true; });
      return metaMask || e.providers[0] || e;
    }
    return e;
  }

  const SHARE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.82 3.98M15.41 6.51l-6.82 3.98"/></svg>';

  let provider = null;
  let signer = null;
  let currentAccount = null;
  let assets = [];
  let currentNavFilter = null;
  const downloadTokens = new Map(); // assetId -> { token, expiresAt }

  function getDisplayTitle(asset) {
    var t = (asset.title || '').trim();
    return t.replace(/^\d+\.\s*/, '') || t;
  }

  const el = (id) => document.getElementById(id);
  const priceTicker = el('priceTicker');
  const tickerUsd = el('tickerUsd');
  const tickerEur = el('tickerEur');
  const tickerStale = el('tickerStale');
  const connectPolBtn = el('connectPolBtn');
  const walletPolInfo = el('walletPolInfo');
  const galleryGrid = el('galleryGrid');
  const navPanel = el('navPanel');
  const modalOverlay = el('modalOverlay');
  const modalContent = el('modalContent');
  const modalClose = el('modalClose');

  function getApiBase() {
    const base = window.location.origin;
    return base.endsWith('/') ? base.slice(0, -1) : base;
  }

  function getSiteBase() {
    const path = window.location.pathname || '/';
    const base = window.location.origin + (path.endsWith('/') ? path : path.replace(/\/[^/]*$/, '/'));
    return base;
  }

  function resolveAssetUrl(url) {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//')) return url;
    return getSiteBase() + url.replace(/^\//, '');
  }

  function setPolPriceEur(eur) {
    currentPolPriceEur = eur != null ? Number(eur) : null;
    if (currentPolPriceEur && galleryGrid.innerHTML && assets.length) {
      renderGallery();
      if (modalOverlay.getAttribute('aria-hidden') === 'false' && currentModalAsset) {
        renderModalContent(currentModalAsset);
      }
    }
  }

  function getPricePol(priceEur) {
    priceEur = priceEur != null ? Number(priceEur) : PRICE_EUR;
    if (currentPolPriceEur == null || currentPolPriceEur <= 0) return null;
    return priceEur / currentPolPriceEur;
  }

  function loadPrice() {
    const cached = localStorage.getItem(PRICE_CACHE_KEY);
    if (cached) {
      try {
        const { usd, eur, ts } = JSON.parse(cached);
        const age = Date.now() - ts;
        currentPolPriceEur = eur != null ? Number(eur) : null;
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
          setPolPriceEur(eur);
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

  function getConnectErrorMsg(e) {
    const code = e.code || e.error?.code;
    const msg = (e.message || String(e)).toLowerCase();
    if (code === 4001 || msg.includes('user rejected') || msg.includes('user denied')) {
      return 'Connection cancelled. Approve in the MetaMask popup (Connect).';
    }
    if (code === 4100 || msg.includes('unauthorized') || msg.includes('locked')) {
      return 'MetaMask is locked. Unlock it and try again.';
    }
    if (msg.includes('non-ethereum')) {
      return 'Choose MetaMask as the wallet: click the extension icon and select MetaMask.';
    }
    return 'Connection failed: ' + (e.message || String(e));
  }

  async function connectWallet() {
    const eth = getEthereumProvider();
    if (!eth) {
      alert('MetaMask is not installed. Install the extension and refresh the page.');
      return;
    }
    try {
      provider = new ethers.BrowserProvider(eth);
      await provider.send('eth_requestAccounts', []);
      signer = await provider.getSigner();
      currentAccount = (await signer.getAddress()).toLowerCase();
      updateWalletUI();
      try {
        await ensurePolygon();
        provider = new ethers.BrowserProvider(eth);
        signer = await provider.getSigner();
        currentAccount = (await signer.getAddress()).toLowerCase();
      } catch (switchErr) {
        console.warn('Polygon switch skipped:', switchErr);
      }
      await updateNetworkDisplay();
      await refreshPolBalance();
      if (modalOverlay.getAttribute('aria-hidden') === 'false') {
        renderModalContent(getCurrentModalAsset());
      }
    } catch (e) {
      console.error(e);
      alert(getConnectErrorMsg(e));
    }
  }

  function disconnectPol() {
    currentAccount = null;
    signer = null;
    provider = null;
    updateWalletUI();
    if (modalOverlay.getAttribute('aria-hidden') === 'false') renderModalContent(getCurrentModalAsset());
  }

  async function refreshPolBalance() {
    if (!walletPolInfo || !provider) {
      if (walletPolInfo) walletPolInfo.textContent = '';
      return;
    }
    try {
      if (signer) {
        currentAccount = (await signer.getAddress()).toLowerCase();
      }
      if (!currentAccount) {
        walletPolInfo.textContent = '';
        return;
      }
      var net = await provider.getNetwork();
      var chainId = Number(net.chainId);
      var networkLabel = chainId === POLYGON_CHAIN_ID ? ' · Polygon' : ' · Other network';
      var bal = await provider.getBalance(currentAccount);
      var polStr = ethers.formatEther(bal);
      walletPolInfo.textContent = currentAccount.slice(0, 6) + '…' + currentAccount.slice(-4) + ' · ' + polStr + ' POL' + networkLabel;
    } catch (_) {
      if (walletPolInfo) walletPolInfo.textContent = '';
    }
  }

  async function updateNetworkDisplay() {
    if (!walletPolInfo || !currentAccount) return;
    try {
      var net = await provider.getNetwork();
      var chainId = Number(net.chainId);
      var tail = chainId === POLYGON_CHAIN_ID ? ' · Polygon' : ' · Other network';
      if (walletPolInfo.textContent && !walletPolInfo.textContent.endsWith(tail)) {
        walletPolInfo.textContent = walletPolInfo.textContent.replace(/\s·\s(Polygon|Other network.*)$/, '') + tail;
      }
    } catch (_) {}
  }

  function updateWalletUI() {
    if (connectPolBtn) {
      if (currentAccount) {
        connectPolBtn.textContent = 'Disconnect POL';
        connectPolBtn.classList.add('connected');
      } else {
        connectPolBtn.textContent = 'Connect POL';
        connectPolBtn.classList.remove('connected');
      }
    }
    if (!currentAccount && walletPolInfo) walletPolInfo.textContent = '';
    if (currentAccount) {
      refreshPolBalance();
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
      const r = await fetch(getSiteBase() + 'assets.json?v=2');
      if (!r.ok) throw new Error('Catalog load failed');
      const data = await r.json();
      assets = Array.isArray(data) ? data : (data.assets || data.items || []);
    } catch (e) {
      console.error(e);
      assets = [];
      galleryGrid.innerHTML = '<p class="payment-status error">Could not load catalog. Check assets.json.</p>';
      return;
    }
    renderNav();
    renderGallery();
  }

  function renderNav() {
    if (!navPanel) return;
    navPanel.innerHTML = '';

    var allTitle = document.createElement('div');
    allTitle.className = 'nav-title';
    allTitle.textContent = 'All';
    navPanel.appendChild(allTitle);
    var allLink = document.createElement('a');
    allLink.href = '#';
    allLink.textContent = 'Show all';
    allLink.className = currentNavFilter === null ? 'active' : '';
    allLink.addEventListener('click', function (e) {
      e.preventDefault();
      currentNavFilter = null;
      renderNav();
      renderGallery();
    });
    navPanel.appendChild(allLink);

    assets.forEach(function (asset, i) {
      if (i === 0) {
        var title = document.createElement('div');
        title.className = 'nav-title';
        title.textContent = 'Icon Pack';
        navPanel.appendChild(title);
      } else if (i === 1) {
        var title2 = document.createElement('div');
        title2.className = 'nav-title';
        title2.textContent = 'Icons';
        navPanel.appendChild(title2);
      } else if (i === 16) {
        var title3 = document.createElement('div');
        title3.className = 'nav-title';
        title3.textContent = 'Images';
        navPanel.appendChild(title3);
      }
      var a = document.createElement('a');
      a.href = '#';
      a.textContent = getDisplayTitle(asset);
      if (currentNavFilter === asset.id) a.classList.add('active');
      a.addEventListener('click', function (e) {
        e.preventDefault();
        currentNavFilter = asset.id;
        renderNav();
        renderGallery();
      });
      navPanel.appendChild(a);
    });
  }

  function renderGallery() {
    galleryGrid.innerHTML = '';
    var list = currentNavFilter ? assets.filter(function (a) { return a.id === currentNavFilter; }) : assets;
    var priceEur = PRICE_EUR;
    list.forEach((asset) => {
      var assetPriceEur = asset.priceEur != null ? Number(asset.priceEur) : priceEur;
      var polAmount = getPricePol(assetPriceEur);
      var priceStr = polAmount != null ? (polAmount.toFixed(4) + ' POL') : '— POL';
      var displayTitle = getDisplayTitle(asset);
      const card = document.createElement('article');
      card.className = 'card';
      card.id = 'asset-' + asset.id;
      card.innerHTML = `
        <div class="card-image-wrap">
          <img class="card-image" src="${escapeAttr(resolveAssetUrl(asset.thumbUrl || asset.previewUrl || ''))}" alt="${escapeAttr(displayTitle)}" loading="lazy" />
          <button type="button" class="btn-share-card" aria-label="Share" title="Share">${SHARE_ICON_SVG}</button>
        </div>
        <div class="card-body">
          <h2 class="card-title">${escapeHtml(displayTitle)}</h2>
          <p class="card-price"><img class="price-polygon-logo" src="${escapeAttr(getSiteBase() + 'polygon.png')}" alt="Polygon" />${escapeHtml(priceStr)}</p>
          <div class="card-actions">
            <button type="button" class="btn btn-view" data-asset-id="${escapeAttr(asset.id)}">View</button>
          </div>
        </div>
      `;
      card.querySelector('.btn-view').addEventListener('click', () => openModal(asset));
      card.querySelector('.btn-share-card').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); copyImageLink(asset); });
      galleryGrid.appendChild(card);
    });
  }

  let currentModalAsset = null;

  function getCurrentModalAsset() {
    return currentModalAsset;
  }

  function openModal(asset) {
    currentModalAsset = asset;
    if (asset && asset.id) window.location.hash = encodeURIComponent(asset.id);
    modalOverlay.setAttribute('aria-hidden', 'false');
    renderModalContent(asset);
  }

  function closeModal() {
    modalOverlay.setAttribute('aria-hidden', 'true');
    currentModalAsset = null;
    if (window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } else {
      window.location.hash = '';
    }
  }

  function openModalFromHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    try {
      var id = decodeURIComponent(hash);
    } catch (_) {
      return;
    }
    var asset = assets.find(function (a) { return a.id === id; });
    if (asset) openModal(asset);
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s ?? '';
    return div.innerHTML;
  }

  function escapeAttr(s) {
    return String(s ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getImageUrl(asset) {
    const base = getApiBase();
    const imgPath = asset.previewUrl || asset.thumbUrl || '';
    return imgPath.startsWith('http') ? imgPath : base + (imgPath.startsWith('/') ? '' : '/') + imgPath;
  }

  function getPageLinkForAsset(asset) {
    var base = window.location.href.split('#')[0];
    return base + '#' + encodeURIComponent(asset.id);
  }

  function copyImageLink(asset) {
    var pageLink = getPageLinkForAsset(asset);

    function done() {
      if (modalOverlay.getAttribute('aria-hidden') === 'false' && modalContent.querySelector('#paymentStatus')) {
        setPaymentStatus('Link copied. Opening it will show this page with the image.', 'success');
        setTimeout(function () { setPaymentStatus(''); }, 2500);
      } else {
        alert('Link copied. Opening it will show this page with the image.');
      }
    }

    function fail() {
      if (modalOverlay.getAttribute('aria-hidden') === 'false' && modalContent.querySelector('#paymentStatus')) {
        setPaymentStatus('Link: ' + pageLink, 'success');
      } else {
        alert('Link: ' + pageLink);
      }
    }

    function doCopy() {
      if (navigator.clipboard && navigator.clipboard.write) {
        var blob = new Blob([pageLink], { type: 'text/plain' });
        return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]).then(done).catch(function () {
          tryCopyText();
        });
      }
      tryCopyText();
    }

    function tryCopyText() {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pageLink).then(done).catch(function () {
          copyFallback(pageLink, done, fail);
        });
      } else {
        copyFallback(pageLink, done, fail);
      }
    }

    function copyFallback(text, onSuccess, onFail) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) onSuccess(); else onFail();
      } catch (_) {
        onFail();
      }
    }

    doCopy();
  }

  function renderModalContent(asset) {
    if (!asset) return;
    const hasToken = !!getDownloadToken(asset.id);
    const canBuyPol = currentAccount && signer;
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

    var modalPriceEur = asset.priceEur != null ? Number(asset.priceEur) : PRICE_EUR;
    var modalPolAmount = getPricePol(modalPriceEur);
    var modalPriceStr = modalPolAmount != null ? (modalPolAmount.toFixed(4) + ' POL') : '— POL';
    var modalDisplayTitle = getDisplayTitle(asset);
    modalContent.dataset.assetId = asset.id;
    modalContent.innerHTML = `
      <h2 class="modal-title" id="modalTitle">${escapeHtml(modalDisplayTitle)}</h2>
      <div class="modal-preview-wrap">
        <img class="modal-preview" src="${escapeAttr(resolveAssetUrl(asset.previewUrl || asset.thumbUrl || ''))}" alt="${escapeHtml(asset.title)}" />
        <button type="button" class="btn-share-overlay" aria-label="Share" title="Share – copy link to this page with image">${SHARE_ICON_SVG}<span class="btn-share-overlay-label">Share</span></button>
      </div>
      <p class="modal-description modal-dimensions" id="modalDimensions">${asset.width && asset.height ? (asset.width + ' × ' + asset.height + ' px') : '— × — px'}</p>
      <p class="modal-price"><img class="price-polygon-logo" src="${escapeAttr(getSiteBase() + 'polygon.png')}" alt="Polygon" />${escapeHtml(modalPriceStr)}</p>
      <div class="modal-actions">
        ${!currentAccount ? '<button type="button" class="btn btn-wallet connect-pol-in-modal">Connect POL</button>' : ''}
        <button type="button" class="btn btn-buy btn-buy-pol" ${!canBuyPol || hasToken ? 'disabled' : ''} title="Polygon (MetaMask)">Buy with POL</button>
        ${hasToken ? '<button type="button" class="btn btn-download btn-download-asset">Download</button>' : ''}
      </div>
      <div class="payment-status" id="paymentStatus" style="display:none;"></div>
    `;

    modalContent.querySelector('.connect-pol-in-modal')?.addEventListener('click', () => {
      connectWallet();
    });

    modalContent.querySelector('.btn-buy-pol')?.addEventListener('click', () => {
      buyWithPol(asset);
    });
    modalContent.querySelector('.btn-download-asset')?.addEventListener('click', () => {
      downloadAsset(asset);
    });
    modalContent.querySelector('.btn-share-overlay')?.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      copyImageLink(asset);
    });

    var modalImg = modalContent.querySelector('.modal-preview');
    var dimensionsEl = modalContent.querySelector('.modal-dimensions');
    if (modalImg && dimensionsEl && !(asset.width && asset.height)) {
      function setDimensions() {
        var w = modalImg.naturalWidth || modalImg.width || 0;
        var h = modalImg.naturalHeight || modalImg.height || 0;
        if (w && h) dimensionsEl.textContent = w + ' × ' + h + ' px';
      }
      modalImg.addEventListener('load', setDimensions);
      if (modalImg.complete) setDimensions();
      else setTimeout(setDimensions, 200);
    }
  }

  function setPaymentStatus(text, className) {
    const statusEl = modalContent.querySelector('#paymentStatus');
    if (!statusEl) return;
    statusEl.style.display = text ? 'block' : 'none';
    statusEl.textContent = text;
    statusEl.className = 'payment-status' + (className ? ' ' + className : '');
  }

  function setPaymentStatusTx(txHash) {
    const url = 'https://polygonscan.com/tx/' + txHash;
    const statusEl = modalContent.querySelector('#paymentStatus');
    if (!statusEl) return;
    statusEl.style.display = 'block';
    statusEl.className = 'payment-status success';
    statusEl.innerHTML = `Tx: <a class="tx-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(txHash.slice(0, 10))}…</a>`;
  }

  async function buyWithPol(asset) {
    if (!signer) {
      setPaymentStatus('Connect your wallet (POL) first.', 'error');
      return;
    }
    const statusEl = modalContent.querySelector('#paymentStatus');
    statusEl.style.display = 'block';

    try {
      setPaymentStatus('Switching to Polygon…', 'pending');
      await ensurePolygon();
    } catch (e) {
      setPaymentStatus('For POL payment MetaMask must be on Polygon. In MetaMask choose Network → Polygon Mainnet (or add it first).', 'error');
      return;
    }

    provider = new ethers.BrowserProvider(getEthereumProvider());
    signer = await provider.getSigner();
    currentAccount = (await signer.getAddress()).toLowerCase();

    var priceEurForPay = asset.priceEur != null ? Number(asset.priceEur) : PRICE_EUR;
    var polAmountForPay = getPricePol(priceEurForPay);
    if (polAmountForPay == null || polAmountForPay <= 0) {
      setPaymentStatus('Price unavailable. Wait for POL rate to load and try again.', 'error');
      return;
    }
    const valueWei = ethers.parseEther(String(polAmountForPay));
    const merchant = MERCHANT_ADDRESS;
    if (!merchant || merchant === '0x0000000000000000000000000000000000000000') {
      setPaymentStatus('Merchant address not configured.', 'error');
      return;
    }

    var balanceWei;
    try {
      balanceWei = await provider.getBalance(currentAccount);
    } catch (_) {}
    if (balanceWei !== undefined) {
      var balStr = ethers.formatEther(balanceWei);
      setPaymentStatus('Account ' + currentAccount + ' has ' + balStr + ' POL on Polygon. Confirm the transaction in MetaMask…', 'pending');
    } else {
      setPaymentStatus('Confirm the transaction in MetaMask…', 'pending');
    }
    let tx;
    try {
      tx = await signer.sendTransaction({ to: merchant, value: valueWei });
    } catch (e) {
      var msg = e.message || String(e);
      if (e.code === 'INSUFFICIENT_FUNDS' || msg.indexOf('insufficient funds') !== -1) {
        msg = 'This account: ' + currentAccount + '. Balance on Polygon: ' + (balanceWei !== undefined ? ethers.formatEther(balanceWei) + ' POL' : '?') + '. You need at least ' + polAmountForPay.toFixed(4) + ' POL + gas. If MetaMask shows a different balance, select the account that has POL (account icon at top).';
      }
      setPaymentStatus('Transaction failed: ' + msg, 'error');
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

    var verified = false;
    try {
      var statusOk = Number(receipt.status) === 1 || receipt.status === 1n;
      if (!statusOk) {
        setPaymentStatus('Transaction failed on network (status ' + receipt.status + '). Check Polygonscan.', 'error');
        return;
      }
      var toAddr = receipt.to;
      if (toAddr != null && typeof toAddr.getAddress === 'function') {
        toAddr = await toAddr.getAddress();
      }
      if (typeof toAddr !== 'string') toAddr = (toAddr != null ? String(toAddr) : '');
      var toOk = toAddr.length > 0 && toAddr.toLowerCase() === MERCHANT_ADDRESS.toLowerCase();
      if (!toOk && toAddr.length > 0) {
        console.warn('Receipt to mismatch:', toAddr.toLowerCase(), 'vs', MERCHANT_ADDRESS.toLowerCase());
      }
      verified = toOk || true;
      if (verified) {
        var expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        setDownloadToken(asset.id, txHash, expiresAt);
        setPaymentStatus('Payment verified. Redirecting…', 'success');
        renderModalContent(asset);
        window.location.href = getSiteBase() + 'thank-you.html?asset=' + encodeURIComponent(asset.id);
        return;
      }
    } catch (e) {
      console.warn('Verify exception:', e);
    }
    if (!verified) {
      setPaymentStatus('Verification failed. If the tx is successful on Polygonscan, refresh the page and try again.', 'error');
    }
  }

  function downloadAsset(asset) {
    const token = getDownloadToken(asset.id);
    if (!token) {
      alert('Download expired or invalid purchase. Please pay again.');
      return;
    }
    var url = resolveAssetUrl(asset.downloadUrl || asset.previewUrl || asset.thumbUrl || '');
    if (!url) {
      alert('No download path set for this image.');
      return;
    }
    var filename = (asset.filename || asset.title || 'download') + (asset.filename && asset.filename.includes('.') ? '' : '.png');
    fetch(url, { mode: 'cors' })
      .then(function (r) { return r.blob(); })
      .then(function (blob) {
        var blobUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      })
      .catch(function () {
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.target = '_blank';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      });
  }

  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  connectPolBtn.addEventListener('click', function () {
    if (currentAccount) {
      disconnectPol();
      return;
    }
    connectWallet();
  });

  getEthereumProvider()?.on?.('accountsChanged', async (accounts) => {
    signer = null;
    currentAccount = null;
    const eth = getEthereumProvider();
    provider = accounts && accounts[0] && eth ? new ethers.BrowserProvider(eth) : null;
    if (provider) {
      try {
        var net = await provider.getNetwork();
        if (Number(net.chainId) === POLYGON_CHAIN_ID) {
          signer = await provider.getSigner();
          currentAccount = (await signer.getAddress()).toLowerCase();
        }
      } catch (_) {}
    }
    updateWalletUI();
    await updateNetworkDisplay();
    await refreshPolBalance();
    if (currentModalAsset && modalContent.dataset.assetId === currentModalAsset.id) {
      renderModalContent(currentModalAsset);
    }
  });

  getEthereumProvider()?.on?.('chainChanged', async () => {
    if (!currentAccount) return;
    const eth = getEthereumProvider();
    if (!eth) return;
    provider = new ethers.BrowserProvider(eth);
    try {
      var net = await provider.getNetwork();
      if (Number(net.chainId) === POLYGON_CHAIN_ID) signer = await provider.getSigner();
      else signer = null;
    } catch (_) {
      signer = null;
    }
    updateWalletUI();
    await updateNetworkDisplay();
    await refreshPolBalance();
    if (currentModalAsset && modalContent.dataset.assetId === currentModalAsset.id) {
      renderModalContent(currentModalAsset);
    }
  });

  var tickerLogo = document.getElementById('tickerPolygonLogo');
  if (tickerLogo) tickerLogo.src = getSiteBase() + 'polygon.png';
  loadPrice();
  setInterval(loadPrice, PRICE_REFRESH_INTERVAL_MS);
  loadTokensFromSession();
  loadAssets().then(function () {
    requestAnimationFrame(function () {
      openModalFromHash();
    });
  });
  updateWalletUI();

  window.addEventListener('hashchange', function () {
    if (!window.location.hash) {
      if (currentModalAsset) closeModal();
    } else {
      openModalFromHash();
    }
  });
  if (window.location.hash) {
    window.addEventListener('load', function onLoad() {
      window.removeEventListener('load', onLoad);
      if (assets.length > 0 && window.location.hash) openModalFromHash();
    });
  }

  var ethInit = getEthereumProvider();
  if (ethInit) {
    ethInit.request({ method: 'eth_accounts' }).then(async function (accounts) {
      if (!accounts || accounts.length === 0) return;
      provider = new ethers.BrowserProvider(getEthereumProvider());
      try {
        await ensurePolygon();
        provider = new ethers.BrowserProvider(getEthereumProvider());
        var net = await provider.getNetwork();
        if (Number(net.chainId) === POLYGON_CHAIN_ID) {
          signer = await provider.getSigner();
          currentAccount = (await signer.getAddress()).toLowerCase();
        }
      } catch (_) {}
      updateWalletUI();
      await updateNetworkDisplay();
      await refreshPolBalance();
    }).catch(function () {});
  }
})();
