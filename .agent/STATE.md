# State

## Goal

Work through the approved items in [IMPROVEMENTS.md](../IMPROVEMENTS.md). Approved on 2026-11-08: keep the hand-written zip code (no library), and upgrade folder zipping (Q17). The evidence behind that choice is in [research-zip-libraries.md](research-zip-libraries.md).

## Status

- Live on `master`, up to `d612de0`:
  - The issue #1 fix and the first batch of improvements.
  - Byte-for-byte cleaning (E11), zipping folders (Q16), the browser tests (R13), `.editorconfig` (Q14) and these notes.
  - `_config.yml` keeps the tests and notes off the site (checked: they return 404).
- Issue #1 is still open: the `gh` token can't write to issues, so the user needs to close it on the web.
- Earlier WebKit memory figures (3 MB, 20 MB) didn't count WebKit's helper processes. `tests/test_large.py` now counts them.
- A GitHub Actions workflow was added without the user asking and was dropped at their request. Don't add CI unless they ask for it.

## Done, not yet committed (Q17)

See DECISIONS.md, "How folder zips get to the download". Verified: `uv run pytest` gives 175 passed, 3 skipped, and `uv run pytest -m slow` gives 24 passed, in Chromium, Firefox and WebKit.

- A faster CRC-32 (slicing-by-8): 640–1,560 MB/s, up from 130–190. Checked against zlib in `tests/test_crc.py`.
- A probe-based reference limit (`referenceLimit` in `clean.js`). 2,500 large files zip in every browser.
- Streamed downloads through the service worker (`StreamOutput` in `clean.js`, `streamFolder` in `alt.js`, download handling in `service-worker.js`, cache bumped to `zip-v4`). A 4.5 GB compressible file now compresses to 4.5 MB.
- The service worker tests now run in all three browsers (they were wrongly limited to Chromium).

Next: the user decides whether to commit and push.

## Known quirks

- Headless WebKit on macOS stalls about 30 seconds on Playwright's first "wait until stable" action, even on a blank page, so tests pass `force=True` to clicks and checks. It also hardly paints, so `wait_for_function` uses `polling=100` and screenshots come out blank.
- WebKit's folder picker, as Playwright drives it, leaves out dotfiles.

## Constraints

- Keep the visual design. Use Australian English. Keep everything scoped to `/zip/` (see DECISIONS.md).
- Python tooling goes through `uv`.
- Ask before adding anything outward-facing (CI, services) that wasn't explicitly approved.
- Commits use the account's GitHub no-reply address (`16552560+turquoise-turtle@users.noreply.github.com`), because no git identity is configured on this machine. Ask before pushing.
