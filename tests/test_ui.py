import pytest
from playwright.sync_api import expect

from conftest import RULES, clean, wait_for_result
from test_clean import MIXED_REMOVED


def test_page_basics(app):
    assert app.title() == 'Remove hidden files from zip'
    assert app.get_attribute('html', 'lang') == 'en-AU'
    expect(app.locator('#lists')).to_be_hidden()
    assert not app.errors


def test_lists_show_what_was_removed(app, zips):
    clean(app, zips['mixed'])
    removed = app.locator('#left li.removed')
    expect(removed).to_have_count(len(MIXED_REMOVED))
    expect(app.locator('#left li[title="Hidden on Windows"]')).to_have_count(3)
    total = len(RULES) + 4
    expect(app.locator('#itemsleft')).to_have_text(f'{total} items')
    expect(app.locator('#itemsright')).to_have_text(f'{total - len(MIXED_REMOVED)} items')
    # the reason is spelt out for screen readers, not just shown as a strike-through
    expect(removed.first.locator('.visually-hidden')).to_contain_text('(removed:')


# force=True below skips Playwright's wait for elements to stop moving, which stalls for 30 seconds in
# headless WebKit on macOS (even on a blank page)


def test_rename_option_and_settings_are_remembered(app, zips, app_url):
    app.check('#remc', force=True)
    app.fill('#rem', '-raw')
    with app.expect_download() as download:
        app.set_input_files('#fileElem', str(zips['mixed']))
    assert download.value.suggested_filename == 'mixed.zip'

    app.goto(app_url)
    expect(app.locator('#remc')).to_be_checked()
    expect(app.locator('#rem')).to_have_value('-raw')
    keys = app.evaluate('Object.keys(localStorage)')
    assert keys and all(key.startswith('zip:') for key in keys)


def test_rename_only_strips_the_end(app):
    app.check('#remc', force=True)
    app.fill('#rem', ' -raw ')
    names = app.evaluate('["my-raw-files-raw.zip", "-raw.zip", "holiday-raw.ZIP", "Photos-RAW.zip"].map(newName)')
    assert names == ['my-raw-files.zip', '-raw.zip', 'holiday.ZIP', 'Photos-RAW.zip']


def test_download_again(app, zips):
    clean(app, zips['mixed'])
    with app.expect_download() as again:
        app.click('#status a', force=True)
    assert again.value.suggested_filename == 'mixed-raw.zip'


def drop(page, files):
    """Drops files (name -> text) on the drop zone, as dragging them in from the desktop would."""
    data = page.evaluate_handle('''files => {
        const dt = new DataTransfer();
        for (const [name, text] of Object.entries(files)) dt.items.add(new File([text], name));
        return dt;
    }''', files)
    page.dispatch_event('.container', 'drop', {'dataTransfer': data})


def test_one_zip_at_a_time(app):
    drop(app, {'a.zip': 'a', 'b.zip': 'b'})
    assert wait_for_result(app) == 'Please choose one zip or folder at a time.'


def test_dropping_something_else(app):
    drop(app, {'notes.txt': 'hello'})
    assert wait_for_result(app) == '"notes.txt" isn\'t a zip file.'


def test_works_without_web_workers(page, app_url, zips):
    page.add_init_script('delete window.Worker')
    page.goto(app_url)
    output, status = clean(page, zips['methods'])
    assert status.startswith('Removed 2 of 7 items')


def test_keyboard_reaches_the_zip_picker(app, browser_name):
    if browser_name == 'webkit':
        pytest.skip('Safari only tabs to text fields unless "Press Tab to highlight each item" is turned on')
    app.locator('h2').click(force=True)
    app.keyboard.press('Tab')
    assert app.evaluate('document.activeElement.id') == 'fileElem'


def test_phone_layout_has_no_sideways_scrolling(app, zips):
    app.set_viewport_size({'width': 375, 'height': 812})
    clean(app, zips['mixed'])
    assert app.evaluate('document.documentElement.scrollWidth') <= 375
    assert app.evaluate('getComputedStyle(document.querySelector("#lists")).flexDirection') == 'column'
