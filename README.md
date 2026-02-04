# NanoPix

Static front-end for **nanopix.site**: a crypto “digital vending machine” that sells individual images for micro-prices using **POL** on **Polygon** (chainId 137).

- No accounts, no emails, no public file URLs.
- Connect MetaMask → pay in POL → verify on backend → download via token.

## Run locally

1. **Serve the project with a local static server** (required so `fetch('assets.json')` and same-origin API work):

   ```bash
   # Python 3
   python -m http.server 8080

   # Or Python 2
   python -m SimpleHTTPServer 8080

   # Or Node (npx)
   npx serve -l 8080
   ```

2. Open **http://localhost:8080** in a browser (with MetaMask or another Web3 wallet installed).

3. Backend is optional for the MVP: the UI works without it. Connect wallet, switch to Polygon, and “Buy with POL” will send the tx; verification and download will show friendly errors if `/api/verify` and `/api/download` are not available.

## Configuration

### Merchant address

Edit **`app.js`** and set the Polygon address that receives POL payments:

```js
const MERCHANT_ADDRESS = '0xYourPolygonAddressHere';
```

Do **not** leave the placeholder `0x0000...0000` in production.

### Other constants

In `app.js` you can also adjust:

- `SITE_NAME` – used in the UI.
- `POLYGON_CHAIN_ID` (137) and `POLYGON_CHAIN_ID_HEX` ('0x89') – used for network checks and RPC/explorer links.

## Backend endpoints

The front-end expects a backend (same origin or CORS-enabled) with two endpoints. Until they exist, the app still runs and shows clear errors when they are missing.

### 1. `POST /api/verify`

Called after a POL transaction has 1 confirmation.

- **Request body (JSON):**
  - `txHash` (string)
  - `assetId` (string)
  - `walletAddress` (string)
  - `chainId` (number, e.g. 137)

- **Expected response (JSON):**
  - `downloadToken` (string) – one-time token for the download endpoint.
  - `expiresAt` (string, optional) – ISO date when the token expires.

- **Backend should:** Validate the tx on Polygon, ensure payment amount and recipient match the asset, then issue a short-lived download token. Never expose the actual file URL; only return a token.

### 2. `GET /api/download?token=...`

Serves the purchased file when the user has a valid token.

- **Query:** `token` – value of `downloadToken` from `/api/verify`.
- **Response:** File bytes (e.g. `Content-Disposition: attachment`) or redirect to a signed URL that expires quickly.
- **Errors:** 401/403 for invalid or expired token; the front-end will show a message and may ask the user to purchase again.

**Security (backend):**

- Do not unlock downloads based only on `txHash` on the client. Always verify on the server.
- Do not put paid asset files under `/public`. All downloads must go through `/api/download?token=...`.

## Deploy (static host)

1. Set `MERCHANT_ADDRESS` in `app.js` as above.
2. Build no step required: the site is static (HTML, CSS, JS, JSON).
3. Upload the project root to any static host:
   - **GitHub Pages:** push to a repo and enable Pages (branch or `gh-pages`).
   - **Netlify / Vercel:** connect repo or drag-and-drop the folder; use default static settings.
   - **Cloudflare Pages:** connect repo or upload; document root = project root.
   - **Any static host:** upload `index.html`, `styles.css`, `app.js`, `assets.json`, and optionally `/img/` (for thumbnails only).

4. If the backend is on another origin, configure CORS so the browser can call `/api/verify` and follow `/api/download` from your front-end origin.

5. **Optional:** Replace placeholder thumbnails in `assets.json` with your own; put low-res previews in `/img/` and point `thumbUrl` / `previewUrl` to them. Paid files must **never** be in `/public`; they must be served only via the backend download endpoint.

## File layout

```
/
  index.html      # Single page: header, ticker, gallery, modal
  styles.css      # Minimal dark-friendly layout
  app.js          # Wallet, Polygon, payment, verify, download logic
  assets.json     # Product catalog (id, title, pricePol, thumbUrl, …)
  README.md       # This file
  img/            # (optional) Preview thumbnails only – not paid assets
```

## Tech

- Vanilla HTML, CSS, and JavaScript (no React/Next).
- **ethers.js** from CDN (v6).
- POL price from CoinGecko (cached in `localStorage` for 24h).
- MetaMask: connect, switch/add Polygon, send POL, then verify and download via backend.
