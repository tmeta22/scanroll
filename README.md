# ScanRoll

Live camera QR scanning with automatic duplicate detection. Point your phone
at a sheet of QR codes, and every unique code gets saved to a running list —
duplicates are recognized and ignored. Export the results as CSV, JSON, or
plain text when you're done.

- Multi-code detection per frame on Android/Chrome (native `BarcodeDetector`
  API), with an automatic fallback to a bundled scanner (`jsQR`) on browsers
  that don't support it (notably iOS Safari) — on the fallback, pan across
  the sheet and each code is caught as it's centered.
- Results are grouped by detected content type (links, emails, phone numbers,
  WiFi, contacts, locations, JSON, numeric codes, text), with a filter box,
  sort order, and per-row copy / edit / delete.
- Works fully offline once installed (service worker caches all assets).
- No backend, no accounts, no data leaves the phone. The session is kept in
  the browser's `localStorage` on your device, so a reload doesn't lose your
  scans, and nothing is written to a file unless you export.

## Why you can't just open index.html directly

Camera access (`getUserMedia`) and installable PWAs both require **HTTPS**
(or `localhost`) — phones won't grant camera permission to a page opened
from a local file. You need to serve these files from a real HTTPS URL.
The easiest free option is GitHub Pages.

## Deploy to GitHub Pages (free)

This repo is already set up to deploy. The live site is:

**https://tmeta22.github.io/scanroll/**

Deployment is automatic: GitHub Pages is configured to publish from the
`main` branch, `/ (root)` folder, so **every push to `main` redeploys the
site**. The `.nojekyll` file at the repo root disables Jekyll processing so
every file (including `vendor/`) is served byte-for-byte. A build usually
takes about a minute — watch it under the repo's **Actions → pages-build-deployment**.

To replicate this for your own fork:

1. Push the files to a GitHub repository — `index.html`, `style.css`,
   `app.js`, `manifest.json`, `sw.js`, `.nojekyll`, the `vendor/` folder,
   and the `icons/` folder, all at the repo root.
2. In the repo, go to **Settings → Pages**.
3. Under "Build and deployment", set **Source** to `Deploy from a branch`,
   branch `main`, folder `/ (root)`. Save.
4. GitHub gives you a URL like `https://yourname.github.io/your-repo/`.
   Wait ~1 minute for the first deploy.

## Install it on your phone

**Android (Chrome):**
1. Open the GitHub Pages URL in Chrome.
2. Tap the **⋮** menu → **Add to Home screen** (Chrome may also prompt you
   automatically after a few seconds).
3. Launch it from the home screen icon — it opens full-screen, no browser
   chrome, like a native app.
4. Multi-code-per-frame detection works here automatically.

**iPhone (Safari):**
1. Open the GitHub Pages URL in Safari (must be Safari, not Chrome, for
   the install option to appear).
2. Tap the **Share** icon → **Add to Home Screen**.
3. Launch from the home screen icon.
4. Uses the jsQR fallback — one code detected per frame, so pan slowly
   across the sheet to catch each one.

## Alternative: quick local test without deploying

If you just want to try it on your laptop first:

```bash
cd project
npx serve .
```

This serves over `http://localhost`, where camera access is allowed without
HTTPS. Open the printed `localhost` URL in your desktop browser to test the
scanning logic before deploying to your phone.

## Using it

- The counter top-left shows how many **unique** codes you've captured.
- New code → short buzz + green toast, added to the list.
- Same code again → short buzz + amber toast, "seen ×N" updates on that row.

Drag the sheet at the bottom up to work with the list:

- **Grouped by type.** Each code is classified as you scan it and filed under
  a collapsible group with a live count — Links, Emails, Phone numbers,
  Messages, WiFi networks, Contacts, Locations, JSON, Numeric codes, Text.
  Tap a group heading to collapse it, or its copy icon to copy just that
  group's codes.
- **Filter** box narrows the list as you type (groups with no match drop out).
  While a filter is active, groups stay expanded so you can see the matches.
- **Sort** applies inside each group: by most recent, most seen, or A–Z.
- Each row has **copy**, **edit** (pencil, fixes a typo without rescanning),
  and **delete** (trash, asks first) buttons.
- The **+** button adds a code by hand — useful for a code the camera missed.
- The **copy-all** button copies every code, one per line.
- **Export** gives you CSV, JSON, or plain text. CSV and JSON include the
  detected `type` for each code; all codes are exported in group order, even
  if a filter is active, so an export never silently drops scans.
- Your session survives a reload and a full app restart.

Outside the sheet:

- The flashlight icon (top-right, shown only if your device supports it)
  toggles the torch for scanning in low light.
- **Clear** (top-right, trash icon) wipes the whole session after confirming.

## Customizing

- `DETECT_INTERVAL` in `app.js` controls scan frequency (ms) — lower is
  faster but uses more battery.
- Grouping rules live in `TYPES` and `detectType()` in `app.js`. Add an
  entry to `TYPES` and a matching pattern in `detectType()` to get a new
  group; the order of `TYPES` is the order groups appear in.
- If your QR codes encode structured data (e.g. `id|name|value`), you can
  extend `handleResult()` in `app.js` to parse and display fields instead
  of the raw string.

## License

MIT — see [LICENSE](LICENSE). Bundled third-party components are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
