# Bill Prints Download

A ready-to-load Chrome Manifest V3 extension for the eLGCD Water Print Bills list shown in the reference screenshots. The packaged extension needs no Node.js installation or build step.

## Install

1. Extract `Bill-Prints-Download-v1.0.1.zip` to a permanent folder.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the extracted folder containing `manifest.json` (or this repository's `extension` folder).
4. Log in to the portal, display the bill list, click the extension icon, then **Scan billing page → Start download**.

The detailed operating guide is in [extension/INSTALL.txt](extension/INSTALL.txt).

## Included behavior

- Local-date folder: `DDMMYY Bill Prints Download` under Chrome's configured Downloads directory. Chrome creates it when saving the first file.
- Locality filenames, safe Windows characters, and numbered suffixes for duplicate names.
- Persistent separate window, Minimize/Close, Pause/Resume/Stop, elapsed timer and configurable 1–300 second delay.
- Local IndexedDB PDF cache and saved progress; browser restarts recover in paused mode.
- Individual PDFs, `Localities.csv` (locality, sector, file number, bill count, PDF filename, status, page count and errors), and `All Bills.pdf`, in queue order.
- Failed downloads remain visible and can be retried. Partial merges include successful PDFs only.
- Original icon at 16, 32, 48 and 128 pixels, plus editable SVG source.
- Bundled pdf-lib; no CDN scripts, uploads, tracking or build tools in the distributable.

The scanner reads plain tables and all loaded, filtered client-side DataTables rows. For server-side pagination, collect each page using **Add another list page**. The scan summary identifies server-side pagination. Only `https://elgcd.punjab.gov.pk` is permitted. Literal href, data-url/data-href, window.open and location assignment links are supported. Framework click handlers without an HTML link show **View action ready** and are selected automatically. At download time the extension clicks View and temporarily intercepts `window.open` or an anchor navigation to capture the portal PDF address, without opening a PDF tab. Synchronous/asynchronous opens and blank popups followed by a location assignment are supported. Keep the billing page open for these actions; if its nodes are recreated, the resolver matches the locality, sector, file number and bill count. Ambiguous or missing rows produce an actionable error rather than guessing. Unsupported actions such as generating a blob or navigating the existing tab directly are reported as failures. With server pagination, dynamic rows must be visible on their original list page when resolved.

Minimizing or closing the controls leaves processing running. Use Pause or Stop to halt work; an active disk download finishes before the processor becomes idle. Closing Chrome requires reopening the extension and pressing Resume. Starting a new batch replaces the previous batch's temporary data. Existing downloaded files are preserved; repeated exports on the same day receive Chrome's numeric filename suffixes. Encrypted PDFs are unsupported; large merges are limited by Chrome's available memory. A valid portal login is required.

## Verification

`npm ci`, then `npx playwright install chromium` to prepare the development tests. Run:

```sh
npm test
npm run test:extension
```

An existing compatible Chromium executable can be supplied using `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. `npm run build:icons` regenerates PNGs from the SVG.

The end-to-end test loads the actual extension into Chromium and uses a local HTTPS fixture server with the billing host mapped to localhost. It checks scanning normal and JavaScript links, downloads, duplicate locality names, pause, recovery after a browser restart, resume, final PDF page counts, CSV contents, login-page rejection, partial merging, retry, Stop, and cache clearing. It also tests event-listener-only View buttons, asynchronous opens, blank popups assigned a URL later, row recovery without temporary tokens, restoration of window.open and absence of extra PDF tabs. The test certificate/private key in `tests` are public test fixtures for localhost only; they are not production credentials and are not packaged.

The authenticated production portal has **not** been tested: access was supplied through screenshots only. Its live HTML and login-cookie behavior may differ from the fixture. Tests and preview screenshots are in `tests/artifacts` after running the test.

## Structure

`background.js` handles the toolbar, page scanning and Chrome downloads. `runner.js` runs in an offscreen document to fetch/cache PDFs and merge them without depending on the control window. `panel.*` implements the controls, and `core.js` contains filename/CSV rules. PDF bytes stay in IndexedDB until cleared or replaced by a new batch.

Chrome permissions are limited to the billing host, active-tab script access, downloads, local settings, an offscreen processor and storage for the temporary PDF cache. pdf-lib's MIT license is included in `extension/vendor`.
