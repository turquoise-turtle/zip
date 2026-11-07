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
