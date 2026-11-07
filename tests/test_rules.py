import pytest

from conftest import RULES


@pytest.fixture
def app(app):
    # clean.js normally only runs in the worker, so load it into the page to call it directly
    app.add_script_tag(url='clean.js')
    return app


def test_every_rule(app):
    cases = [{'path': path, 'dir': path.endswith('/')} for path, _ in RULES]
    reasons = app.evaluate('cases => cases.map(c => hiddenReason(c.path, c.dir, false))', cases)
    assert dict(zip([c['path'] for c in cases], reasons)) == dict(RULES)


def test_names_are_matched_regardless_of_capitals(app):
    assert app.evaluate('hiddenReason("A/THUMBS.DB", false, false)') == 'Windows thumbnail cache'
    assert app.evaluate('hiddenReason("A/.ds_store", false, false)') == 'macOS Finder settings'


def test_appledouble_only_applies_to_files(app):
    assert app.evaluate('hiddenReason("a/._thing/", true, false)') is None
    assert app.evaluate('hiddenReason("a/._thing", false, false)') == 'macOS resource fork'


def test_hidden_attribute(app):
    assert app.evaluate('hiddenReason("a/secret.txt", false, true)') == 'Hidden on Windows'


def test_legacy_name_decoding(app):
    decoded = app.evaluate('''() => [
        decodeFileName(new Uint8Array([0x52, 0x82, 0x73, 0x75, 0x6d, 0x82])),
        decodeFileName(new TextEncoder().encode('Cafés')),
        decodeFileName(new TextEncoder().encode('plain.txt')),
    ]''')
    assert decoded == ['Résumé', 'Cafés', 'plain.txt']
