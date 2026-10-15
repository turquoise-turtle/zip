# zip
Get rid of hidden files inside a zip folder: https://turquoise-turtle.github.io/zip/

Pick or drop a zip and a cleaned copy downloads straight away. Everything happens in your browser, so your files never leave your device, and it works offline once you've visited it (you can also install it as an app).

## what gets removed
Any file or folder with one of these names, anywhere in the zip (names are matched regardless of capitals):

| From | Names |
| --- | --- |
| macOS | `__MACOSX/`, `.DS_Store`, `._*` (AppleDouble files), `.Spotlight-V100/`, `.Trashes/`, `.fseventsd/`, `.TemporaryItems/`, `Icon\r` |
| Windows | `Thumbs.db`, `ehthumbs.db`, `ehthumbs_vista.db`, `desktop.ini`, `$RECYCLE.BIN/`, `System Volume Information/` |
| Linux | `.Trash-1000/` (any user number), `.directory` (KDE), `.nfs*` leftovers |

It also removes anything marked hidden in a zip made on Windows, including everything inside a hidden folder. Other dotfiles (like `.gitignore`) are kept, because they're often wanted.

Hover over a crossed-out item in the Original list to see why it was removed.

## contributing
Just make a pull request. The rules for what counts as hidden live in `clean.js`.

## licence
The project is AGPLv3 and JSZip is being used as GPLv3.
