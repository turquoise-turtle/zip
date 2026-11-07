import re
import zipfile

import pytest

from conftest import RULES, clean, clean_without_download
from ziptools import assert_clean_copy

MIXED_REMOVED = {name for name, reason in RULES if reason} | {'project/secret.txt', 'project/.hiddendir/', 'project/.hiddendir/inside.txt'}

# which entries each zip should lose (as Python decodes the names)
REMOVED = {
    'mixed': MIXED_REMOVED,
    'methods': {'Thumbs.db', '.DS_Store'},
    'descriptors': {'.DS_Store', 'Thumbs.db'},
    'zip64': {'.DS_Store'},
    'comments': {'desktop.ini'},
    'names': {'Thumbs.db'},
    'unix': {'tool/.DS_Store'},
    'prefixed': {'Thumbs.db'},
    'duplicates': {'.DS_Store'},
    'all-junk': {'__MACOSX/', '__MACOSX/._a', '.DS_Store'},
}


def expected_kept(path, removed):
    with zipfile.ZipFile(path) as z:
        return [zi.filename for zi in z.infolist() if zi.filename not in removed]


@pytest.mark.parametrize('name', REMOVED)
def test_cleaned_zip_is_a_byte_for_byte_copy(app, zips, name):
    output, status = clean(app, zips[name])
    kept = expected_kept(zips[name], REMOVED[name])
    assert_clean_copy(zips[name], output, kept)
    total = len(kept) + len(REMOVED[name])
    assert re.match(rf'Removed {total - len(kept)} of {total} items?\b', status), status
    assert not app.errors


def test_many_entries(app, zips):
    output, status = clean(app, zips['many'])
    kept = [f'files/{i:05}.txt' for i in range(70_000)]
    assert_clean_copy(zips['many'], output, kept)
    assert status.startswith('Removed 7000 of 77000 items')


def test_password_protected_zip_keeps_its_password(app, zips):
    if 'encrypted' not in zips:
        pytest.skip('needs the zip command')
    output, _ = clean(app, zips['encrypted'])
    kept = expected_kept(zips['encrypted'], {'folder/.DS_Store'})
    assert_clean_copy(zips['encrypted'], output, kept, pwd=b'hunter2')
    with zipfile.ZipFile(output) as z:
        assert z.read('folder/secret.txt', pwd=b'hunter2') == b'top secret ' * 50


def test_download_keeps_the_name(app, zips):
    with app.expect_download() as download:
        app.set_input_files('#fileElem', str(zips['methods']))
    assert download.value.suggested_filename == 'methods.zip'


@pytest.mark.parametrize('name', ['clean', 'empty'])
def test_nothing_to_remove(app, zips, name):
    downloads = []
    app.on('download', lambda d: downloads.append(d))
    assert clean_without_download(app, zips[name]) == 'Nothing to remove. This zip is already clean.'
    assert not downloads


@pytest.mark.parametrize('name, message', [
    ('truncated', 'Couldn\'t open this zip. It may be damaged, or not really a zip.'),
    ('random', 'Couldn\'t open this zip. It may be damaged, or not really a zip.'),
    ('multidisk', 'This zip is split into parts, which isn\'t supported.'),
    ('photo', '"photo.png" isn\'t a zip file.'),
])
def test_errors(app, zips, name, message):
    assert clean_without_download(app, zips[name]) == message
    assert not app.errors
