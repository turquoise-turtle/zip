import functools
import http.server
import threading
import zipfile
from pathlib import Path

import pytest

# so failed checks in ziptools show their values, like asserts in the tests do
pytest.register_assert_rewrite('ziptools')

from ziptools import DOS, UNIX, HIDDEN_ATTR, DIR_ATTR, FILE_ATTR, Unseekable, add, have, patch_bytes

ROOT = Path(__file__).resolve().parent.parent


# path -> (content type, body) to serve instead of the real file, e.g. a newer service worker
OVERRIDES = {}


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serves the repo at /zip/ like GitHub Pages does, plus a stand-in for the other apps on the same origin."""

    def translate_path(self, path):
        path = path.split('?', 1)[0].split('#', 1)[0]
        if path.startswith('/zip/'):
            return super().translate_path(path[len('/zip'):])
        return str(ROOT / 'does-not-exist')

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path in OVERRIDES or path.startswith('/pdf/'):
            content_type, body = OVERRIDES.get(path, ('text/html', b'<!doctype html><title>pdf</title>'))
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture(scope='session')
def server():
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{httpd.server_address[1]}'
    httpd.shutdown()


@pytest.fixture(scope='session')
def app_url(server):
    return server + '/zip/'


@pytest.fixture(scope='session')
def browser_context_args(browser_context_args):
    # most tests don't want the service worker caching files between runs; test_service_worker.py turns it on
    return {**browser_context_args, 'accept_downloads': True, 'service_workers': 'block'}


@pytest.fixture
def app(page, app_url):
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(app_url)
    page.wait_for_function('typeof handleFiles === "function"')
    page.errors = errors
    return page


def wait_for_result(page):
    # polls on a timer because headless WebKit hardly ever paints, which stalls the default animation-frame polling
    page.wait_for_function('''() => {
        const s = document.querySelector('#status');
        return s.textContent && s.getAttribute('aria-busy') === 'false';
    }''', timeout=120_000, polling=100)
    return page.locator('#status').text_content()


def clean(page, path, timeout=120_000):
    """Picks a zip and returns (path to the downloaded result, status text)."""
    with page.expect_download(timeout=timeout) as download:
        page.set_input_files('#fileElem', str(path))
    return Path(download.value.path()), wait_for_result(page)


def clean_without_download(page, path):
    page.set_input_files('#fileElem', str(path))
    return wait_for_result(page)


# --- test zips ----------------------------------------------------------------------------------

# what every rule should do: (path in the zip, reason it's removed, or None to keep it)
RULES = [
    ('project/', None),
    ('project/readme.txt', None),
    ('project/Thumbs.db', 'Windows thumbnail cache'),
    ('project/sub/DESKTOP.INI', 'Windows folder settings'),
    ('project/ehthumbs_vista.db', 'Windows thumbnail cache'),
    ('project/$RECYCLE.BIN/S-1-5/old.txt', 'Windows Recycle Bin'),
    ('project/System Volume Information/x', 'Windows system folder'),
    ('project/.DS_Store', 'macOS Finder settings'),
    ('__MACOSX/project/._readme.txt', 'macOS resource forks'),
    ('project/._readme.txt', 'macOS resource fork'),
    ('project/.Spotlight-V100/store.db', 'macOS Spotlight index'),
    ('project/.Trashes/501/x', 'macOS Bin folder'),
    ('project/.fseventsd/0000', 'macOS file system log'),
    ('project/.TemporaryItems/x', 'macOS temporary files'),
    ('project/Icon\r', 'macOS custom folder icon'),
    ('project/.Trash-1000/files/x.txt', 'Linux Bin folder'),
    ('project/.directory', 'KDE folder settings'),
    ('project/.nfs0000000012345678abcd', 'Linux network drive leftover'),
    # lookalikes that must be kept
    ('project/myThumbs.db.txt', None),
    ('project/notes.DS_Store.txt', None),
    ('project/my__MACOSX/file.txt', None),
    ('project/.gitignore', None),
    ('project/._folder_lookalike/real.txt', None),
    ('project/.Trash-abc/x', None),
    ('project/.nfsrc', None),
    ('project/constructor', None),
    ('project/__proto__', None),
]


@pytest.fixture(scope='session')
def zips(tmp_path_factory):
    d = tmp_path_factory.mktemp('zips')
    z = {}

    p = z['mixed'] = d / 'mixed-raw.zip'
    with zipfile.ZipFile(p, 'w') as f:
        for name, _ in RULES:
            add(f, name)
        add(f, 'project/secret.txt', attr=FILE_ATTR | HIDDEN_ATTR)
        add(f, 'project/.hiddendir/', attr=DIR_ATTR | HIDDEN_ATTR)
        add(f, 'project/.hiddendir/inside.txt')
        # unix zips can't mark files hidden that way, so a set bit there means nothing
        add(f, 'project/unix-bit.txt', system=UNIX, attr=(0o100644 << 16) | HIDDEN_ATTR)

    p = z['methods'] = d / 'methods.zip'
    text = b'The quick brown fox jumps over the lazy dog. ' * 2000
    with zipfile.ZipFile(p, 'w') as f:
        add(f, 'stored.txt', text, compress=zipfile.ZIP_STORED)
        add(f, 'Thumbs.db', text)
        add(f, 'deflated.txt', text, compress=zipfile.ZIP_DEFLATED)
        add(f, 'bzip2.txt', text, compress=zipfile.ZIP_BZIP2)
        add(f, '.DS_Store', text, compress=zipfile.ZIP_BZIP2)
        add(f, 'lzma.txt', text, compress=zipfile.ZIP_LZMA)
        add(f, 'empty.txt', b'')

    p = z['descriptors'] = d / 'descriptors.zip'
    with open(p, 'wb') as raw, zipfile.ZipFile(Unseekable(raw), 'w') as f:
        add(f, 'a.txt', b'first file ' * 100)
        add(f, '.DS_Store', b'junk')
        add(f, 'b.txt', b'second file ' * 100, compress=zipfile.ZIP_STORED)
        add(f, 'Thumbs.db', b'junk')

    p = z['zip64'] = d / 'zip64.zip'
    with zipfile.ZipFile(p, 'w') as f:
        add(f, 'a.txt', b'a' * 5000, force_zip64=True)
        add(f, '.DS_Store', b'junk', force_zip64=True)
        add(f, 'b.txt', b'b' * 5000, force_zip64=True)

    p = z['comments'] = d / 'comments.zip'
    with zipfile.ZipFile(p, 'w') as f:
        f.comment = b'Archive comment, kept as is'
        add(f, 'a.txt', comment=b'entry comment', extra=b'\xfe\xca\x04\x00abcd')
        add(f, 'desktop.ini', comment=b'junk comment')
        add(f, 'b.txt', extra=b'\x55\x54\x05\x00\x01\x00\x00\x00\x00')

    p = z['names'] = d / 'names.zip'
    with zipfile.ZipFile(p, 'w') as f:
        add(f, 'RXsumX.txt')
        add(f, 'CYYfYY.txt')
        add(f, 'JJJJJJ.txt')
        add(f, 'Thumbs.db')
        add(f, 'flagged-ünïcode.txt')
    patch_bytes(p, {
        b'RXsumX.txt': 'Résumé.txt'.encode('cp437'),
        b'CYYfYY.txt': 'Cafés.txt'.encode('utf-8'),
        b'JJJJJJ.txt': '日本語.txt'.encode('shift_jis'),
    })

    p = z['unix'] = d / 'unix.zip'
    with zipfile.ZipFile(p, 'w') as f:
        add(f, 'tool/', system=UNIX)
        add(f, 'tool/run.sh', b'#!/bin/sh\necho hi\n', system=UNIX, attr=(0o100755 << 16))
        add(f, 'tool/link', b'run.sh', system=UNIX, attr=(0o120777 << 16), compress=zipfile.ZIP_STORED)
        add(f, 'tool/.DS_Store', system=UNIX)

    p = z['prefixed'] = d / 'prefixed.zip'
    inner = d / 'inner.zip'
    with zipfile.ZipFile(inner, 'w') as f:
        add(f, 'a.txt', b'a' * 300)
        add(f, 'Thumbs.db')
        add(f, 'b.txt', b'b' * 300)
    # like a self-extracting archive: other data in front, and offsets that don't account for it
    p.write_bytes(b'MZ' + bytes(3000) + inner.read_bytes())

    p = z['all-junk'] = d / 'all-junk.zip'
    with zipfile.ZipFile(p, 'w') as f:
        add(f, '__MACOSX/')
        add(f, '__MACOSX/._a')
        add(f, '.DS_Store')

    p = z['clean'] = d / 'clean.zip'
    with zipfile.ZipFile(p, 'w') as f:
        add(f, 'a.txt')
        add(f, 'b/c.txt')

    p = z['empty'] = d / 'empty.zip'
    with zipfile.ZipFile(p, 'w'):
        pass

    p = z['duplicates'] = d / 'duplicates.zip'
    with zipfile.ZipFile(p, 'w') as f:
        add(f, 'same.txt', b'one')
        add(f, '.DS_Store')
        add(f, 'same.txt', b'two')

    p = z['many'] = d / 'many.zip'
    # more than 65,535 entries needs zip64 records just for the count
    with zipfile.ZipFile(p, 'w', compression=zipfile.ZIP_STORED) as f:
        for i in range(70_000):
            f.writestr(f'files/{i:05}.txt', b'x')
            if i % 10 == 0:
                f.writestr(f'__MACOSX/files/._{i:05}.txt', b'x')

    if have('zip'):
        work = d / 'encrypted'
        (work / 'folder').mkdir(parents=True)
        (work / 'folder' / 'secret.txt').write_text('top secret ' * 50)
        (work / 'folder' / '.DS_Store').write_text('junk')
        (work / 'folder' / 'other.txt').write_text('more')
        z['encrypted'] = d / 'encrypted.zip'
        import subprocess
        subprocess.run(['zip', '-q', '-r', '-P', 'hunter2', str(z['encrypted']), 'folder'], cwd=work, check=True)

    p = z['truncated'] = d / 'truncated.zip'
    p.write_bytes(z['methods'].read_bytes()[:-30])
    p = z['random'] = d / 'random.zip'
    p.write_bytes(bytes(range(256)) * 20)
    p = z['photo'] = d / 'photo.png'
    p.write_bytes(b'\x89PNG\r\n\x1a\n' + bytes(100))

    p = z['multidisk'] = d / 'multidisk.zip'
    b = bytearray(z['clean'].read_bytes())
    eocd = b.rfind(b'PK\x05\x06')
    b[eocd + 4:eocd + 6] = (1).to_bytes(2, 'little')
    p.write_bytes(bytes(b))

    return z
