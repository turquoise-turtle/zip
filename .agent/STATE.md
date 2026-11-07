# State

## Goal

Work through the approved items in [IMPROVEMENTS.md](../IMPROVEMENTS.md). Current batch, approved on 2026-11-07: full automated testing (R13), byte-for-byte cleaning for large zips (E11, see [DECISIONS.md](DECISIONS.md)), zipping a folder as a progressive enhancement (Q16), and `.editorconfig` (Q14).

## Status (all uncommitted)

- Done and live (commits `5171a3b`, `8abb8af` on `master`): the issue #1 fix and the first batch of improvements.
- Issue #1 is still open: the `gh` token can't write to issues, so the user needs to close it on the web.
- R13: `tests/`, a Playwright suite across Chromium, Firefox and WebKit. `uv run pytest` gives 138 passed, 13 skipped (service worker tests are Chromium-only, and Safari's Tab key skips the file picker).
- E11: `clean.js` copies kept entries byte for byte, and JSZip is removed. Verified by the regular tests and by `uv run pytest -m slow`: a 4.4 GB zip cleaned in 2–5 s per browser, with browser memory growing by at most 108 MB.
- Q16: folder picking and dropping in `alt.js`, and the zip writer in `clean.js`. Regular tests pass in all three browsers, and a 4.5 GB folder zips correctly in all three. WebKit can only read about 2,000 file references in one blob, so file references are capped at 1,000 (see DECISIONS.md). After that fix, all nine slow folder tests pass in all three browsers (4.5 GB, 70,000 small files, 1,500 large files).
- Q14 `.editorconfig`, CI (`.github/workflows/tests.yml`), and `_config.yml` (keeps tests out of GitHub Pages) are written. CI hasn't run yet.
- Open question from the user: whether to use a popular library instead of the hand-written zip code, and how the reference cap and the 256 MB compression cutoff could adapt to each browser. Investigated and benchmarked in [research-zip-libraries.md](research-zip-libraries.md). Awaiting their decision.
- Earlier WebKit memory figures (3 MB, 20 MB) didn't count WebKit's helper processes. `tests/test_large.py` now counts them.

## Known quirks

- Headless WebKit on macOS stalls about 30 seconds on Playwright's first "wait until stable" action, even on a blank page, so tests pass `force=True` to clicks and checks. It also hardly paints, so `wait_for_function` uses `polling=100` and screenshots come out blank.
- WebKit's folder picker, as Playwright drives it, leaves out dotfiles.

## Next steps

1. Decide on the library question.
2. Commit (ask first). Pushing `.github/workflows/` may need the token's Workflows permission.
3. After pushing, check that the Pages build excludes `tests/` and that CI passes.

## Constraints

- Keep the visual design. Use Australian English. Keep everything scoped to `/zip/` (see DECISIONS.md).
- Python tooling goes through `uv`.
- Commits use the account's GitHub no-reply address (`16552560+turquoise-turtle@users.noreply.github.com`), because no git identity is configured on this machine. Ask before pushing.
