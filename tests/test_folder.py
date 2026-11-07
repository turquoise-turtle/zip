import os
import time
import zipfile

import pytest
from playwright.sync_api import expect

from conftest import wait_for_result
from ziptools import have

# (path inside the picked folder, contents); None makes an empty folder
FOLDER = [
    ('notes.txt', b'Some notes that compress well. ' * 500),
    ('photo.jpg', b'\xff\xd8\xff' + bytes(range(256)) * 40),
    ('empty.txt', b''),
    ('Résumé ü.txt', 'unicode name'.encode()),
    ('sub/deeper/data.csv', b'a,b,c\n1,2,3\n' * 300),
    ('sub/.DS_Store', b'junk'),
    ('sub/._notes.txt', b'junk'),
    ('Thumbs.db', b'junk'),
    ('.Spotlight-V100/store.db', b'junk'),
    ('old.txt', b'from 2001'),
]
JUNK = {'sub/.DS_Store', 'sub/._notes.txt', 'Thumbs.db', '.Spotlight-V100/store.db'}
# 2001-02-03 04:05:06 local time
OLD = time.mktime((2001, 2, 3, 4, 5, 6, 0, 0, -1))


def make_folder(base, name='My Folder', files=FOLDER):
    root = base / name
    for path, data in files:
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    if (root / 'old.txt').exists():
        os.utime(root / 'old.txt', (OLD, OLD))
    return root


def folder_link(page):
    return page.locator('label[for="folderElem"]')


def zip_folder(page, root, timeout=120_000):
    with page.expect_download(timeout=timeout) as download:
        page.set_input_files('#folderElem', str(root))
    return download.value, wait_for_result(page)


def test_folder_option_is_offered_on_desktop(app):
    expect(folder_link(app)).to_be_visible()


def test_folder_option_is_hidden_without_folder_support(page, app_url):
    page.add_init_script('delete HTMLInputElement.prototype.webkitdirectory')
    page.goto(app_url)
    page.wait_for_function('typeof handleFiles === "function"', polling=100)
    expect(folder_link(page)).to_be_hidden()


@pytest.mark.only_browser('chromium')
def test_folder_option_is_hidden_on_phones(playwright, browser, app_url):
    # phones claim folder support but can't actually pick folders
    for device in ('Pixel 7', 'iPhone 15'):
        context = browser.new_context(**playwright.devices[device], service_workers='block')
        page = context.new_page()
        page.goto(app_url)
        page.wait_for_function('typeof handleFiles === "function"', polling=100)
        expect(folder_link(page)).to_be_hidden()
        context.close()


def junk_seen(browser_name):
    # WebKit's folder picker (as Playwright drives it) leaves out dotfiles, so those never reach the page
    if browser_name == 'webkit':
        return {path for path in JUNK if not any(part.startswith('.') for part in path.split('/'))}
    return JUNK


def test_picked_folder_becomes_a_clean_zip(app, tmp_path, browser_name):
    root = make_folder(tmp_path)
    download, status = zip_folder(app, root)
    assert download.suggested_filename == 'My Folder.zip'
    kept = [path for path, _ in FOLDER if path not in JUNK]
    seen = junk_seen(browser_name)
    left_out = f'{len(seen)} hidden ones' if len(seen) > 1 else '1 hidden one'
    assert status.startswith(f'Zipped {len(kept)} items and left out {left_out} (')

    output = download.path()
    with zipfile.ZipFile(output) as z:
        assert z.testzip() is None
        infos = {zi.filename: zi for zi in z.infolist()}
        assert sorted(infos) == sorted('My Folder/' + path for path in kept)
        for path in kept:
            zi = infos['My Folder/' + path]
            assert z.read(zi) == (root / path).read_bytes(), path
            assert zi.external_attr >> 16 == 0o100644
            assert zi.create_system == 3
        assert infos['My Folder/notes.txt'].compress_type == zipfile.ZIP_DEFLATED
        assert infos['My Folder/notes.txt'].compress_size < 2000
        # already compressed, so stored as is
        assert infos['My Folder/photo.jpg'].compress_type == zipfile.ZIP_STORED
        assert infos['My Folder/Résumé ü.txt'].flag_bits & 0x800
        assert infos['My Folder/old.txt'].date_time == (2001, 2, 3, 4, 5, 6)
    if have('unzip'):
        import subprocess
        result = subprocess.run(['unzip', '-tqq', str(output)], capture_output=True)
        assert result.returncode == 0, result.stdout + result.stderr

    removed = app.locator('#left li.removed')
    expect(removed).to_have_count(len(seen))
    expect(app.locator('#itemsright')).to_have_text(f'{len(kept)} items')


def test_rename_option_applies_to_folders(app, tmp_path):
    root = make_folder(tmp_path, 'Photos-raw')
    app.check('#remc', force=True)
    app.fill('#rem', '-raw')
    download, _ = zip_folder(app, root)
    assert download.suggested_filename == 'Photos.zip'


def test_folder_with_nothing_to_leave_out(app, tmp_path):
    root = make_folder(tmp_path, files=[('a.txt', b'a'), ('b.txt', b'b')])
    _, status = zip_folder(app, root)
    assert status.startswith('Zipped 2 items, nothing hidden to leave out (')


def test_folder_of_only_junk(app, tmp_path):
    root = make_folder(tmp_path, files=[('Thumbs.db', b'x'), ('System Volume Information/a', b'y')])
    app.set_input_files('#folderElem', str(root))
    assert wait_for_result(app) == 'Everything in this folder is hidden junk, so there\'s nothing to zip.'


def test_without_compression_support_files_are_stored(page, app_url, tmp_path):
    # without workers everything runs on the page, so removing CompressionStream here reaches the zip code
    page.add_init_script('delete window.Worker; delete window.CompressionStream')
    page.goto(app_url)
    page.wait_for_function('typeof handleFiles === "function"', polling=100)
    download, _ = zip_folder(page, make_folder(tmp_path))
    with zipfile.ZipFile(download.path()) as z:
        assert z.testzip() is None
        assert {zi.compress_type for zi in z.infolist()} == {zipfile.ZIP_STORED}


FAKE_ENTRIES = '''
// stands in for the FileSystemEntry objects a dropped folder gives, handing out at most 100 children
// per readEntries call like Chrome does
function fakeFile(path) {
    const name = path.split('/').pop();
    return {isFile: true, isDirectory: false, name, fullPath: '/' + path, file: done => done(new File([path], name))};
}
function fakeDir(path, children) {
    return {isFile: false, isDirectory: true, name: path.split('/').pop(), fullPath: '/' + path, createReader() {
        let i = 0;
        return {readEntries(done) { setTimeout(() => { done(children.slice(i, i + 100)); i += 100; }); }};
    }};
}
'''


def test_dropped_folders_are_read_completely(app):
    paths = app.evaluate(FAKE_ENTRIES + '''
    const many = Array.from({length: 250}, (_, i) => fakeFile(`Drop/many/${i}.txt`));
    const root = fakeDir('Drop', [
        fakeFile('Drop/a.txt'),
        fakeDir('Drop/many', many),
        fakeDir('Drop/empty', []),
        fakeDir('Drop/x', [fakeDir('Drop/x/y', [fakeFile('Drop/x/y/z.txt')])]),
    ]);
    readFolder(root).then(items => items.map(item => item.path + (item.file ? '' : ' (folder)')).sort())
    ''')
    expected = sorted(['Drop/a.txt', 'Drop/empty/ (folder)', 'Drop/x/y/z.txt'] + [f'Drop/many/{i}.txt' for i in range(250)])
    assert paths == expected


def test_dropping_a_folder(app):
    with app.expect_download() as download:
        app.evaluate(FAKE_ENTRIES + '''
        const root = fakeDir('Dropped', [fakeFile('Dropped/a.txt'), fakeFile('Dropped/.DS_Store')]);
        handleDrop({items: [{webkitGetAsEntry: () => root}], files: []});
        ''')
    assert download.value.suggested_filename == 'Dropped.zip'
    with zipfile.ZipFile(download.value.path()) as z:
        assert z.namelist() == ['Dropped/a.txt']
        assert z.read('Dropped/a.txt') == b'Dropped/a.txt'


def test_dropping_several_things(app):
    app.evaluate(FAKE_ENTRIES + '''
    handleDrop({items: [{webkitGetAsEntry: () => fakeDir('A', [])}, {webkitGetAsEntry: () => fakeFile('b.zip')}], files: []});
    ''')
    assert wait_for_result(app) == 'Please choose one zip or folder at a time.'


def test_reference_limit_falls_back_in_steps(app):
    # clean.js normally only runs in the worker, so load it into the page to call it directly
    app.add_script_tag(url='clean.js')
    # pretend the browser can only read so many files into one blob, like Safari
    limits = app.evaluate('''async () => {
        const files = Array.from({length: 3000}, (_, i) => new File(['x'], `${i}.bin`));
        const results = {};
        for (const most of [5000, 2040, 700, 0]) {
            const real = canRead;
            canRead = list => Promise.resolve(list.length <= most);
            results[most] = await referenceLimit(files);
            canRead = real;
        }
        return results;
    }''')
    assert limits == {'5000': 3000, '2040': 1000, '700': 500, '0': 0}
