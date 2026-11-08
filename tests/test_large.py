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


def test_folder_with_2500_large_files(app, tmp_path):
    # more files than Safari can read into one blob, so there the probe falls back to fewer references
    root = tmp_path / 'Photos'
    root.mkdir()
    for i in range(2500):
        with open(root / f'{i:04}.jpg', 'wb') as f:
            f.truncate(1_100_000)
    with PeakMemory() as memory:
        with app.expect_download(timeout=1_500_000) as download:
            app.set_input_files('#folderElem', str(root))
        output = download.value.path()
    try:
        assert_zero_entries(output, [(f'Photos/{i:04}.jpg', 1_100_000) for i in range(2500)], any_order=True)
        import zipfile
        with zipfile.ZipFile(output) as z:
            assert z.testzip() is None
        grew = (memory.peak - memory.start) / (1 << 20)
        print(f'\n{app.context.browser.browser_type.name}: browser memory grew by {grew:.0f} MB at most')
    finally:
        output.unlink(missing_ok=True)


# --- streamed through the service worker ---

from test_streaming import sw_app, streamed  # noqa: E402,F401


def stream_folder(page, root):
    if not page.controlled:
        pytest.skip('needs a service worker')
    with PeakMemory() as memory:
        started = time.monotonic()
        with page.expect_download(timeout=1_500_000) as download:
            page.set_input_files('#folderElem', str(root))
        path = download.value.path()
        seconds = time.monotonic() - started
    grew = (memory.peak - memory.start) / (1 << 20)
    print(f'\n{page.context.browser.browser_type.name}: {seconds:.1f}s, {path.stat().st_size / (1 << 20):.1f} MB, browser memory grew by {grew:.0f} MB at most')
    assert streamed(path)
    return path, grew


def test_streamed_big_file_is_compressed(sw_app, tmp_path):
    # with nothing held in memory, even huge files get compressed
    root = tmp_path / 'Big'
    root.mkdir()
    with open(root / 'huge.bin', 'wb') as f:
        f.truncate(int(4.5 * GiB))
    path, grew = stream_folder(sw_app, root)
    try:
        import zipfile
        with zipfile.ZipFile(path) as z:
            info = z.getinfo('Big/huge.bin')
            assert info.file_size == int(4.5 * GiB)
            assert info.compress_type == zipfile.ZIP_DEFLATED
            assert info.compress_size < 10 << 20
            assert z.testzip() is None
        assert grew < 1024
    finally:
        path.unlink(missing_ok=True)


def test_streamed_big_video(sw_app, tmp_path):
    root = tmp_path / 'Video'
    root.mkdir()
    with open(root / 'video.mp4', 'wb') as f:
        f.truncate(int(4.5 * GiB))
    path, grew = stream_folder(sw_app, root)
    try:
        assert_zero_entries(path, [('Video/video.mp4', int(4.5 * GiB))])
        import zipfile
        with zipfile.ZipFile(path) as z:
            assert z.testzip() is None
        # Firefox's and WebKit's peaks are erratic here (from 167 MB to 2.6 GB between runs) but don't grow with
        # the file: 9 GB videos peaked at 1.0 GB in Firefox and 167 MB in WebKit. So check the file was never all
        # held in memory, rather than a fixed limit
        assert grew < 0.75 * 4.5 * 1024
    finally:
        path.unlink(missing_ok=True)


def test_streamed_2500_large_files(sw_app, tmp_path):
    root = tmp_path / 'Photos'
    root.mkdir()
    for i in range(2500):
        with open(root / f'{i:04}.jpg', 'wb') as f:
            f.truncate(1_100_000)
    path, grew = stream_folder(sw_app, root)
    try:
        assert_zero_entries(path, [(f'Photos/{i:04}.jpg', 1_100_000) for i in range(2500)], any_order=True)
        import zipfile
        with zipfile.ZipFile(path) as z:
            assert z.testzip() is None
        # erratic peaks again (Firefox 828 MB to 1.3 GB between runs), so check it was never all held in memory
        assert grew < 0.75 * 2500 * 1.1
    finally:
        path.unlink(missing_ok=True)


def test_streamed_70000_small_files(sw_app, tmp_path):
    # long enough that the service worker would look idle without the page's keep-alive messages
    root = tmp_path / 'Many'
    root.mkdir()
    for i in range(70_000):
        (root / f'{i:05}.txt').write_bytes(b'x')
    path, _ = stream_folder(sw_app, root)
    import zipfile
    with zipfile.ZipFile(path) as z:
        assert len(z.infolist()) == 70_000
        assert z.testzip() is None


@pytest.fixture(scope='module')
def thirty_thousand(tmp_path_factory):
    root = tmp_path_factory.mktemp('progress') / 'Many'
    root.mkdir()
    for d in range(30):
        sub = root / f'd{d:02}'
        sub.mkdir()
        for i in range(1000):
            (sub / f'{i:04}.txt').write_bytes(b'hello')
    return root


FIRST_PROGRESS = '''() => {
    window.__progress = null;
    document.querySelector('#folderElem').addEventListener('change', () => { window.__picked = performance.now(); }, {capture: true});
    new MutationObserver(() => {
        if (window.__progress === null && document.querySelector('#status').textContent.startsWith('Zipping')) {
            window.__progress = performance.now() - window.__picked;
        }
    }).observe(document.querySelector('#status'), {childList: true, characterData: true, subtree: true});
}'''


@pytest.mark.parametrize('mode', ['streamed', 'in memory'])
def test_progress_shows_straight_away_for_big_folders(sw_app, app, thirty_thousand, mode):
    # handing all the files to a worker, or looking up every size first, used to freeze the page for seconds
    page = sw_app if mode == 'streamed' else app
    if mode == 'streamed' and not page.controlled:
        pytest.skip('needs a service worker')
    page.evaluate(FIRST_PROGRESS)
    with page.expect_download(timeout=1_500_000) as download:
        page.set_input_files('#folderElem', str(thirty_thousand))
    download.value.path()
    seconds = page.evaluate('window.__progress') / 1000
    print(f'\n{page.context.browser.browser_type.name} {mode}: first progress after {seconds:.2f}s')
    assert seconds < 2
