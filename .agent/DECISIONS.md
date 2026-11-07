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

## Folder zips reference at most 1,000 files

When zipping a folder, big files go into the output `Blob` as references to the original files, so they're never copied into memory. Measured on 2026-11-07 with Playwright: Chromium and Firefox read a blob of 15,000 file references (16.5 GB) without trouble, but WebKit fails with `NotReadableError` after about 2,040 files. That looks like an open-file limit, because a single 4.5 GB file reads fine, and nesting blobs doesn't help. So only the 1,000 largest files over 1 MB go in by reference, and every other file goes in as the bytes already read for its checksum. A folder with more than 1,000 large files therefore uses memory for the rest. Cleaning a zip isn't affected, because all of its slices come from one file.
