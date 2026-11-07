"""Multi-gigabyte tests. Run with: uv run pytest -m slow

The input zips are sparse files, so they take almost no disk space, but each downloaded result is
written out in full (about 4.3 GB), so allow roughly 5 GB of free space per browser.
"""

import os
import threading
import time

import psutil
import pytest

from conftest import clean
from ziptools import assert_clean_copy, assert_zero_entries, write_sparse_stored_zip

pytestmark = [pytest.mark.slow, pytest.mark.timeout(1800)]

GiB = 1 << 30
BIG = [('big-1.bin', int(2.2 * GiB)), ('Thumbs.db', 1000), ('big-2.bin', int(2.2 * GiB)), ('.DS_Store', 10), ('small.txt', 5)]


class PeakMemory:
    """Tracks the peak memory of the browser processes that this test run started."""

    def __init__(self):
        self.peak = 0
        self.running = True
        self.thread = threading.Thread(target=self.watch, daemon=True)

    def total(self):
        # Playwright's WebKit runs its content and networking processes as macOS services rather than as our
        # children. They're named *.Development, which keeps the user's own Safari out of the count
        processes = psutil.Process(os.getpid()).children(recursive=True)
        processes += [p for p in psutil.process_iter(['name'])
                      if (p.info['name'] or '').startswith('com.apple.WebKit.') and p.info['name'].endswith('.Development')]
        total = 0
        for process in processes:
            try:
                total += process.memory_info().rss
            except psutil.Error:
                pass
        return total

    def watch(self):
        while self.running:
            self.peak = max(self.peak, self.total())
            time.sleep(0.05)

    def __enter__(self):
        self.start = self.total()
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.running = False
        self.thread.join()


@pytest.fixture(scope='module')
def big_zip(tmp_path_factory):
    path = tmp_path_factory.mktemp('big') / 'big.zip'
    write_sparse_stored_zip(path, BIG)
    return path


def test_zip_over_4_gb_with_little_memory(app, big_zip):
    assert big_zip.stat().st_size > 4 * GiB
    with PeakMemory() as memory:
        started = time.monotonic()
        output, status = clean(app, big_zip, timeout=600_000)
        seconds = time.monotonic() - started
    try:
        assert status.startswith('Removed 2 of 5 items')
        kept = [(name, size) for name, size in BIG if name not in ('Thumbs.db', '.DS_Store')]
        # big-2.bin now starts past 4 GiB in the output, so its offset has to be in a zip64 field
        assert_zero_entries(output, kept)
        assert_clean_copy(big_zip, output, [name for name, _ in kept], compare_data=False)
        grew = (memory.peak - memory.start) / (1 << 20)
        print(f'\n{app.context.browser.browser_type.name}: {seconds:.1f}s, browser memory grew by {grew:.0f} MB at most')
        # the old version needed several times the zip's size; anything near that means the zip was read into memory
        assert grew < 1024
    finally:
        output.unlink(missing_ok=True)


def test_folder_over_4_gb_with_little_memory(app, tmp_path):
    root = tmp_path / 'Big Folder'
    root.mkdir()
    # a sparse file reads back as zeros without using disk space
    with open(root / 'huge.bin', 'wb') as f:
        f.truncate(int(4.5 * GiB))
    (root / 'notes.txt').write_text('little file ' * 100)
    (root / '.DS_Store').write_bytes(b'junk')
    with PeakMemory() as memory:
        started = time.monotonic()
        with app.expect_download(timeout=1_500_000) as download:
            app.set_input_files('#folderElem', str(root))
        seconds = time.monotonic() - started
    output = download.value.path()
    try:
        # browsers list a picked folder's files in their own order
        assert_zero_entries(output, [('Big Folder/huge.bin', int(4.5 * GiB)), ('Big Folder/notes.txt', 1200)], any_order=True)
        import zipfile
        with zipfile.ZipFile(output) as z:
            assert z.testzip() is None
        grew = (memory.peak - memory.start) / (1 << 20)
        print(f'\n{app.context.browser.browser_type.name}: {seconds:.1f}s, browser memory grew by {grew:.0f} MB at most')
        assert grew < 1024
    finally:
        output.unlink(missing_ok=True)


def test_folder_with_70000_files(app, tmp_path):
    root = tmp_path / 'Many'
    root.mkdir()
    for i in range(70_000):
        (root / f'{i:05}.txt').write_bytes(b'x')
    with app.expect_download(timeout=1_500_000) as download:
        app.set_input_files('#folderElem', str(root))
    import zipfile
    with zipfile.ZipFile(download.value.path()) as z:
        assert len(z.infolist()) == 70_000
        assert z.testzip() is None


def test_folder_with_1500_large_files(app, tmp_path):
    # Safari can only read about 2,000 files into one blob, so past 1,000 large files the rest are copied in
    root = tmp_path / 'Photos'
    root.mkdir()
    for i in range(1500):
        with open(root / f'{i:04}.jpg', 'wb') as f:
            f.truncate(1_100_000)
    with app.expect_download(timeout=1_500_000) as download:
        app.set_input_files('#folderElem', str(root))
    output = download.value.path()
    try:
        assert_zero_entries(output, [(f'Photos/{i:04}.jpg', 1_100_000) for i in range(1500)], any_order=True)
        import zipfile
        with zipfile.ZipFile(output) as z:
            assert z.testzip() is None
    finally:
        output.unlink(missing_ok=True)
