import re
from pathlib import Path

import pytest

from conftest import OVERRIDES, ROOT, clean

# Playwright only drives service workers in Chromium
pytestmark = pytest.mark.only_browser('chromium')

CACHE = re.search(r"var CACHE = PREFIX \+ '(v\d+)'", (ROOT / 'service-worker.js').read_text()).group(1)
FILES = re.findall(r"^\s+'([^']*)',?$", (ROOT / 'service-worker.js').read_text().split('var FILES = [')[1].split('];')[0], re.M)


@pytest.fixture
def sw_page(browser, app_url):
    context = browser.new_context(accept_downloads=True, service_workers='allow')
    page = context.new_page()
    page.goto(app_url)
    page.evaluate('navigator.serviceWorker.ready')
    page.wait_for_function('navigator.serviceWorker.controller !== null', polling=100)
    yield page
    context.close()


def test_every_precached_file_exists():
    for name in FILES:
        assert name == './' or (ROOT / name).is_file(), name


def test_registers_for_zip_only_and_precaches(sw_page, server):
    scope = sw_page.evaluate('navigator.serviceWorker.getRegistration().then(r => r.scope)')
    assert scope == server + '/zip/'
    assert sw_page.evaluate('caches.keys()') == [f'zip-{CACHE}']
    cached = sw_page.evaluate(f'caches.open("zip-{CACHE}").then(c => c.keys()).then(rs => rs.map(r => new URL(r.url).pathname))')
    assert sorted(cached) == sorted('/zip/' + ('' if name == './' else name) for name in FILES)


def test_update_only_deletes_its_own_old_caches(sw_page, server):
    sw_page.evaluate('''async () => {
        for (const name of ['cache-and-update-zip', 'zip-v1', 'cache-and-update-pdf', 'pdf-v3']) {
            await (await caches.open(name)).put(name.includes('pdf') ? '/pdf/index.html' : '/zip/old', new Response('x'));
        }
    }''')
    # serve a newer service worker, as the next deploy would
    source = (ROOT / 'service-worker.js').read_text().replace(f"PREFIX + '{CACHE}'", "PREFIX + 'v999'")
    OVERRIDES['/zip/service-worker.js'] = ('text/javascript', source.encode())
    try:
        sw_page.evaluate('''() => new Promise(async resolve => {
            navigator.serviceWorker.addEventListener('controllerchange', resolve, {once: true});
            (await navigator.serviceWorker.getRegistration()).update();
        })''')
    finally:
        del OVERRIDES['/zip/service-worker.js']
    # the new worker cleans up in its activate step, which can finish just after it takes over
    sw_page.evaluate('''async () => {
        for (let i = 0; i < 100 && (await caches.keys()).includes('zip-v1'); i++) await new Promise(r => setTimeout(r, 50));
    }''')
    assert sorted(sw_page.evaluate('caches.keys()')) == ['cache-and-update-pdf', 'pdf-v3', 'zip-v999']


def test_other_apps_are_never_cached(sw_page, server):
    sw_page.evaluate(f'fetch("{server}/pdf/index.html").then(r => r.text())')
    sw_page.evaluate('fetch("/zip/index.html", {method: "HEAD"})')
    sw_page.wait_for_timeout(300)
    paths = sw_page.evaluate(f'caches.open("zip-{CACHE}").then(c => c.keys()).then(rs => rs.map(r => new URL(r.url).pathname))')
    assert not [p for p in paths if not p.startswith('/zip/')]


def test_bad_responses_are_not_cached(sw_page):
    status = sw_page.evaluate('fetch("/zip/missing.txt").then(r => r.status)')
    assert status == 404
    sw_page.wait_for_timeout(300)
    assert not sw_page.evaluate(f'caches.open("zip-{CACHE}").then(c => c.match("/zip/missing.txt"))')


def test_works_offline(sw_page, app_url, zips):
    sw_page.context.set_offline(True)
    # an address that was never cached still gets the page
    sw_page.goto(app_url + '?from=offline')
    assert sw_page.title() == 'Remove hidden files from zip'
    _, status = clean(sw_page, zips['mixed'])
    assert status.startswith('Removed')
