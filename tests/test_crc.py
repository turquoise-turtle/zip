import random
import zlib

import pytest


@pytest.fixture
def app(app):
    # clean.js normally only runs in the worker, so load it into the page to call it directly
    app.add_script_tag(url='clean.js')
    return app


def test_crc32_matches_zlib(app):
    rnd = random.Random(7)
    # lengths around the 8-byte steps, plus one big buffer
    for length in [0, 1, 7, 8, 9, 15, 16, 17, 1000, 1 << 20]:
        data = rnd.randbytes(length)
        assert app.evaluate('b => crc32(new Uint8Array(b))', list(data)) == zlib.crc32(data), length


def test_crc32_carries_on_across_chunks(app):
    data = random.Random(8).randbytes(10_001)
    result = app.evaluate('''b => {
        const bytes = new Uint8Array(b);
        let crc = 0;
        for (const [from, to] of [[0, 3], [3, 4100], [4100, 4101], [4101, 10001]]) crc = crc32(bytes.subarray(from, to), crc);
        return crc;
    }''', list(data))
    assert result == zlib.crc32(data)


def test_crc32_speed(app, browser_name):
    mb_per_second = app.evaluate('''() => {
        const bytes = new Uint8Array(64 << 20);
        for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 0xFF;
        const started = performance.now();
        crc32(bytes);
        return 64 / ((performance.now() - started) / 1000);
    }''')
    print(f'\n{browser_name}: CRC-32 at {mb_per_second:.0f} MB/s')
