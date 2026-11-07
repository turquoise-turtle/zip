# zip
Get rid of hidden files inside a zip folder: https://turquoise-turtle.github.io/zip/

Pick or drop a zip and a cleaned copy downloads straight away. On a computer you can also pick or drop a folder, and it's zipped without its hidden files. Everything happens in your browser, so your files never leave your device, and it works offline once you've visited it (you can also install it as an app).

## what gets removed
Any file or folder with one of these names, anywhere in the zip (names are matched regardless of capitals):

| From | Names |
| --- | --- |
| macOS | `__MACOSX/`, `.DS_Store`, `._*` (AppleDouble files), `.Spotlight-V100/`, `.Trashes/`, `.fseventsd/`, `.TemporaryItems/`, `Icon\r` |
| Windows | `Thumbs.db`, `ehthumbs.db`, `ehthumbs_vista.db`, `desktop.ini`, `$RECYCLE.BIN/`, `System Volume Information/` |
| Linux | `.Trash-1000/` (any user number), `.directory` (KDE), `.nfs*` leftovers |

It also removes anything marked hidden in a zip made on Windows, including everything inside a hidden folder. Other dotfiles (like `.gitignore`) are kept, because they're often wanted.

Hover over a crossed-out item in the Original list to see why it was removed.

## big zips
Cleaning never unpacks anything: every file that's kept is copied byte for byte, and only the zip's index is rewritten. So zips of any size (including over 4 GB) clean in seconds without using much memory, and names, dates, permissions, comments and passwords stay exactly as they were. Keep the original zip where it is until the download finishes, because the cleaned copy is read from it.

## zipping folders
Folders can be picked in desktop browsers (phones and tablets can't pick folders, so the option isn't shown there). Text-like files are compressed and files that are already compressed (photos, videos, zips and so on) are stored as they are. Browsers don't show whether a file is hidden on Windows or whether it's executable, so hidden files are only recognised by name, and every file is given ordinary read/write permissions.

Where the browser allows it, once the site has been visited (tested with the engines behind Chrome, Edge, Firefox and Safari), the zip streams straight into the download as it's made, so even huge folders don't use much memory. Otherwise it's built in memory first: big files go in as references to themselves rather than copies, and files over 256 MB aren't compressed, to keep memory down.

## contributing
Just make a pull request. The rules for what counts as hidden, and all the zip reading and writing, live in `clean.js`. There's no build step: the site is the files in this folder.

The tests drive the page in Chromium, Firefox and WebKit with [Playwright](https://playwright.dev/python/), and check every zip it makes with Python's `zipfile` and Info-ZIP's `unzip`. They need [uv](https://docs.astral.sh/uv/):

```bash
uv sync
uv run playwright install chromium firefox webkit
uv run pytest
```

`uv run pytest -m slow` also runs the multi-gigabyte tests, which need about 5 GB of free disk space.

## licence
The project is AGPLv3.
