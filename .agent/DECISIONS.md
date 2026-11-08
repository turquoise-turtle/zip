# Decisions

## The site shares its origin with other apps

The app is served from `turquoise-turtle.github.io/zip/`, and other apps (such as `/pdf/`) live on the same origin. Cache Storage, `localStorage` and IndexedDB are per-origin, so a careless cache cleanup or an unprefixed storage key would break or wipe the other apps.

- The service worker is registered with `{scope: './'}` and only handles requests under its own scope.
- Cache names start with `zip-`, and the activate handler only deletes caches with that prefix (plus the pre-versioning `cache-and-update-zip`).
- `localStorage` keys start with `zip:`.
- The web app manifest's `id`, `start_url` and `scope` are `./`, which resolves to `/zip/`.

## Cleaning copies entries byte for byte (E11)

Cleaning only removes entries, so `clean.js` never decompresses anything. It reads the central directory with `File.slice()`, copies each kept entry's local header and data unchanged, and writes a new central directory with updated offsets. The output is a `Blob` built from slices of the original `File`, which browsers keep as references to the file on disk, so memory use doesn't grow with the zip's size.

This lifts the old memory and 4 GB limits, keeps names in any encoding, permissions, dates, comments and encrypted entries exactly as they were, and removed the JSZip dependency. The trade-off is hand-written zip format code, which is why the test suite in `tests/` checks every output with Python's `zipfile` and Info-ZIP's `unzip`.

## Australian English

User-facing text, comments, commit messages and the README use Australian English, and the page is `lang="en-AU"` (see the shared `AGENTS.md`).

## How folder zips get to the download

The library comparison is in [research-zip-libraries.md](research-zip-libraries.md). zip.js and client-zip build the whole zip in memory, so big folders fail in Chromium and WebKit. The user chose to keep the hand-written code (2026-11-08), with three upgrades:

- Streaming (preferred, `StreamOutput` in `clean.js`):
  - The worker sends the zip through a `MessagePort` to the service worker, which serves it as `download/<id>` to a hidden iframe.
  - Each piece is only sent when the download asks for it (`pull`), so memory stays flat.
  - Entries use data descriptors (flag bit 3), because a stream can't go back to fill in sizes. Every compressible file is compressed, whatever its size.
  - The service worker tells the page when the browser actually requests the download. If that doesn't happen within `streamStartTimeout` (5 s), the page cancels and builds a blob instead. This is detection rather than browser sniffing.
  - The page creates the download's iframe only after the service worker answers 'ready'. Nothing makes the service worker handle the page's message before the iframe's request, and that race made re-downloads fall back intermittently.
  - "Download again" starts the download straight away, while the click still counts as user activation. Otherwise browsers may block it as a second automatic download.
  - Under Playwright it works in Chromium, Firefox and WebKit. The real Safari and Firefox are untested.
  - Peak memory in Firefox and WebKit is erratic, up to about 2.6 GB, but doesn't grow with the file: a 9 GB video peaked at 1.0 GB in Firefox and 167 MB in WebKit.
- Blob (fallback, `BlobOutput`):
  - Big files go in as references to the original files.
  - Some browsers can only read so many files into one blob: WebKit fails after about 2,040, Chromium and Firefox were fine at 15,000.
  - A probe (`referenceLimit`) first reads 1 byte from each big file as one blob, which fails at the same point. If it fails, it tries 1,000, 500 and so on, and files that don't fit are copied in.
  - Files over 256 MB aren't compressed, because the compressed copy would have to be held in memory.
- CRC-32 uses slicing-by-8: 640–1,560 MB/s, up from 130–190.

## Big folders: show progress straight away (2026-11-08)

The user reported 10–15 seconds before any progress on a folder of 130,000 files. Measured with Playwright:

- **Handing the files to the worker:** `postMessage` of 130,000 `File` objects blocks Chromium's page for 13 s (WebKit 2.2 s, Firefox instant). So folders are zipped on the page (`runOnPage` in `alt.js`). The slow parts, reading and `CompressionStream`, don't run on the page's thread anyway. Cleaning a zip still uses the worker, because one `File` is cheap to hand over.
- **Looking up sizes:** the first `file.size` or `lastModified` on a picked file costs about 0.1 ms in Chromium (and `size` about 0.05 ms in WebKit), synchronously. That's 13 s for 130,000 files when done up front. So:
  - Sizes are only looked up as each file is zipped.
  - Progress counts files rather than bytes above 2,000 files (`sizesUpFrontUnder`).
  - The in-memory mode decides at the end how many files can stay as references (`BlobOutput.finish`), instead of before starting.
- **Reading files:** reading files one at a time costs about 0.3–0.7 ms each. Small files are read 512 at a time as one blob, with the next batch read ahead (`readBatch`, `preload`). Files under 128 bytes aren't compressed.

- **Page memory:** zipping on the page made WebKit's page crash when building 2,500 large files in memory, because the copies it needs past its file limit (1.65 GB) sat in the page's memory. In-memory zips now turn each 4 MB block, and each copied file, into a `Blob` straight away (`Pieces(true)`), which hands the data to the browser to keep outside the page.

Result for 130,000 files: the first progress appears within 0.1–1.7 s, against 7–24 s before. Streaming finishes in 64 s (Chromium), 28 s (Firefox) or 37 s (WebKit). `test_progress_shows_straight_away_for_big_folders` (slow) requires progress within 2 s for 30,000 files.
