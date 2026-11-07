"""Folder zips streamed through the service worker, which browsers that can start a download from it get."""

import zipfile

import pytest

from conftest import wait_for_result
from test_folder import FOLDER, JUNK, junk_seen, make_folder

STREAMED = 0x08


@pytest.fixture
def sw_app(browser, app_url):
    context = browser.new_context(accept_downloads=True, service_workers='allow')
    page = context.new_page()
    page.goto(app_url)
    page.wait_for_function('typeof handleFiles === "function"', polling=100)
    # a browser without service workers never gets a controlled page, and should still get a zip
    page.evaluate('navigator.serviceWorker && navigator.serviceWorker.ready')
    page.controlled = page.evaluate('''async () => {
        for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i++) await new Promise(r => setTimeout(r, 50));
        return !!navigator.serviceWorker.controller;
    }''')
    yield page
    context.close()


def zip_folder(page, root):
    with page.expect_download(timeout=120_000) as download:
        page.set_input_files('#folderElem', str(root))
    return download.value, wait_for_result(page)


def streamed(path):
    with zipfile.ZipFile(path) as z:
        files = [zi for zi in z.infolist() if zi.file_size]
        return all(zi.flag_bits & STREAMED for zi in files)


def test_folder_is_streamed_where_possible(sw_app, tmp_path):
    # all three engines run the service worker under Playwright
    assert sw_app.controlled
    download, status = zip_folder(sw_app, make_folder(tmp_path))
    assert download.suggested_filename == 'My Folder.zip'
    kept = [path for path, _ in FOLDER if path not in JUNK]
    assert status.startswith(f'Zipped {len(kept)} items and left out ')
    path = download.path()
    assert streamed(path) == sw_app.controlled
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None
        assert sorted(z.namelist()) == sorted('My Folder/' + p for p in kept)
        for p in kept:
            assert z.read('My Folder/' + p) == (tmp_path / 'My Folder' / p).read_bytes()
        assert z.getinfo('My Folder/notes.txt').compress_type == zipfile.ZIP_DEFLATED
        assert z.getinfo('My Folder/photo.jpg').compress_type == zipfile.ZIP_STORED
    from ziptools import have
    if have('unzip'):
        import subprocess
        result = subprocess.run(['unzip', '-tqq', str(path)], capture_output=True)
        assert result.returncode == 0, result.stdout + result.stderr


def test_streamed_size_is_reported(sw_app, tmp_path):
    download, status = zip_folder(sw_app, make_folder(tmp_path))
    size = download.path().stat().st_size
    # the size in the summary is the real size of what was downloaded
    assert f'({sw_app.evaluate("formatSize", size)})' in status


def test_download_again_makes_it_again(sw_app, tmp_path):
    download, _ = zip_folder(sw_app, make_folder(tmp_path))
    first = download.path().read_bytes()
    with sw_app.expect_download(timeout=120_000) as again:
        sw_app.click('#status a', force=True)
    with zipfile.ZipFile(again.value.path()) as z:
        assert z.testzip() is None
    assert len(again.value.path().read_bytes()) == len(first)


def test_falls_back_when_the_download_never_starts(sw_app, tmp_path):
    if not sw_app.controlled:
        pytest.skip('needs a service worker')
    # the service worker never hears about the download, so the browser can't start it
    sw_app.evaluate('''() => {
        streamStartTimeout = 500;
        const controller = navigator.serviceWorker.controller;
        const send = controller.postMessage.bind(controller);
        controller.postMessage = (message, transfer) => message.type === 'download' ? undefined : send(message, transfer);
    }''')
    download, status = zip_folder(sw_app, make_folder(tmp_path))
    assert not streamed(download.path())
    with zipfile.ZipFile(download.path()) as z:
        assert z.testzip() is None


def test_folder_of_only_junk_starts_no_download(sw_app, tmp_path):
    downloads = []
    sw_app.on('download', lambda d: downloads.append(d))
    root = make_folder(tmp_path, files=[('Thumbs.db', b'x'), ('System Volume Information/a', b'y')])
    sw_app.set_input_files('#folderElem', str(root))
    assert wait_for_result(sw_app) == 'Everything in this folder is hidden junk, so there\'s nothing to zip.'
    sw_app.wait_for_timeout(500)
    assert not downloads
