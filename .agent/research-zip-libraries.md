# Zip libraries and per-browser limits (2026-11-07)

Measured with Playwright on an Apple Silicon Mac. Times run to the finished download. Memory is the peak growth of the browser's processes, including WebKit's helper processes, which macOS starts itself. Every output was checked with Python's `zipfile`, including CRCs. Scripts: the scratchpad `bench_driver.py` and `exp_driver.py` (not kept in the repo).

## Libraries

| | zip.js 2.24 | client-zip 2.5 | fflate 0.8 | JSZip 3.10 |
| --- | --- | --- | --- | --- |
| Weekly npm downloads | 8.6 M | 0.9 M | 152 M (mostly as a dependency) | 71 M |
| GitHub stars, open issues | 3.9k, 1 | 450, 8 | 3.1k, 58 | 10.4k, 391 |
| Size, minified / gzipped | 108 / 39 KB (`zip-core`) | 6.5 / 2.7 KB | about 8 KB | 98 KB |
| Zip64 (over 4 GB) | yes | yes | no | reads only |
| Compression | yes (native `CompressionStream`) | no, by design | yes | yes |
| Copies entries without recompressing | yes (`passThrough`) | n/a (writer only) | no | no |

conflux (`@transcend-io/conflux`) writes Zip64 but doesn't compress, and has far fewer users than client-zip.

## Benchmarks

Cleaning a 4.4 GB zip:

| | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Ours | 3.7 s, 9 MB | 4.2 s, 60 MB | 1.5 s, 4 MB |
| zip.js `passThrough` | fails (rejects with no error) | 20.4 s, 1.6 GB | browser crashed |

zip.js also rewrote header fields (`extract_version`), while ours only changed offsets.

Zipping a folder with a 4.5 GB video (doesn't compress):

| | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Ours | 28.6 s, 782 MB | 39.7 s, 693 MB | 24.3 s, 51 MB |
| zip.js | fails | 21.0 s, 167 MB | browser crashed |
| client-zip | fails ("Failed to fetch") | 42.6 s, 192 MB | browser crashed |

Zipping a folder with 4.5 GB of zeros (compresses): ours stores the file because it's over 256 MB (32 / 41 / 24 s, 4.6 GB out). zip.js compresses it to 4.5 MB in 9.5 / 5.8 / 10.8 s. client-zip fails / 42 s / crashes.

Zipping 1,500 files of 1.1 MB each, in Chromium / Firefox / WebKit:

- **Ours:** 11.6 s, 1.1 GB / 15.5 s, 1.3 GB / 10.2 s, 2.1 GB.
- **zip.js:** 5.3 s, 1.7 GB / 6.5 s, 372 MB / 7.0 s, 2.6 GB.
- **client-zip:** 8.6 s, 1.5 GB / 16.2 s, 168 MB / 8.5 s, 2.6 GB.

A mixed folder of 57 MB (7 MB of text plus 50 MB of photos): ours and zip.js both produce 49.3 MB, with text compressed and photos stored. client-zip produces 57 MB, uncompressed. All took under 1.5 s.

Takeaways:

- The libraries build the whole zip in memory, so big outputs fail in Chromium and WebKit.
- Ours is slower at folders because its CRC-32 is a simple byte-at-a-time loop, about 150 MB/s.

## Per-browser limits

The file-reference limit, measured with a folder of 3,000 files at 1.1 MB each:

| | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Read a blob of N file references | fine at 3,000 | fine at 3,000 | fine at 1,900, fails at 2,100 |
| Probe (1 byte from each of N files) | fine at 3,000 | fine at 3,000 | fine at 1,900, fails at 2,100 |
| Stream through a service worker as a download, one file at a time | 3.3 GB downloaded | download never started under Playwright | 3.3 GB downloaded |
| `FileSystemWritableFileStream` (private file system as a stand-in for a save picker) | quota error | wrote 3.3 GB | failed |

- **The probe predicts the limit exactly,** so it can decide per browser how many files go in by reference.
- **Service-worker streaming got past WebKit's limit,** and would also remove the 256 MB compression cutoff, since nothing is held in memory.
- **Unverified:** real Safari and real Firefox weren't tested; Playwright's WebKit and Firefox builds stand in for them.
