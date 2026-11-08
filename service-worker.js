// Every cache this app makes starts with PREFIX. Other apps on turquoise-turtle.github.io (like /pdf/) share
// the same cache storage, so this worker only ever touches caches with its own prefix.
// Bump the version whenever any of the files below change, so everyone gets the new copy.
var PREFIX = 'zip-';
var CACHE = PREFIX + 'v5';
// The cache name this app used before versioning
var OLD_CACHE = 'cache-and-update-zip';

// Relative to this file, so they stay inside /zip/
var FILES = [
  './',
  'index.html',
  'alt.js',
  'clean.js',
  'manifest.json',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'favicon.ico',
  'zip.png',
  'icon-192.png',
  'icon-512.png'
];

// On install, cache everything the page needs to work offline, then take over straight away
// instead of waiting for every open tab to close.
self.addEventListener('install', function(evt) {
  evt.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(FILES);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// On activate, delete this app's old caches (and nobody else's), then start handling open pages.
self.addEventListener('activate', function(evt) {
  evt.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(key) {
        return (key.indexOf(PREFIX) === 0 && key !== CACHE) || key === OLD_CACHE;
      }).map(function(key) {
        return caches.delete(key);
      }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Streamed folder zips. The page hands over two ports: the zip arrives on the first as it's made, and the
// second is told once the browser has started the download, so the page can fall back to making the zip
// in memory if it never does. The browser then fetches download/<id>, which is answered with the zip.
var downloads = {};

self.addEventListener('message', function(evt) {
  // Any message counts as activity, so the page's 'keepalive' messages while a zip streams stop this worker
  // being stopped for looking idle. They need nothing else doing
  // The page gave up waiting for the download to start, so stop making the zip
  if (evt.data && evt.data.type === 'forget') {
    var forgotten = downloads[evt.data.id];
    if (forgotten) {
      forgotten.zip.postMessage('cancelled');
      delete downloads[evt.data.id];
    }
    return;
  }
  if (!evt.data || evt.data.type !== 'download') {
    return;
  }
  var id = evt.data.id;
  var zip = evt.ports[0];
  var waiting = null;
  function resume() {
    if (waiting) {
      waiting();
      waiting = null;
    }
  }
  var stream = new ReadableStream({
    start: function(controller) {
      zip.onmessage = function(message) {
        var data = message.data;
        if (data === 'end') {
          controller.close();
        } else if (data && data.error) {
          controller.error(new Error(data.error));
        } else {
          controller.enqueue(data);
        }
        resume();
      };
    },
    // Ask for one piece at a time, only as the download takes them, so nothing piles up in memory
    pull: function() {
      zip.postMessage('pull');
      return new Promise(function(resolve) {
        waiting = resolve;
      });
    },
    cancel: function() {
      zip.postMessage('cancelled');
    }
  }, {highWaterMark: 4});
  downloads[id] = {stream: stream, name: evt.data.name, page: evt.ports[1], zip: zip};
  evt.ports[1].postMessage('ready');
  // Forget it if the browser never asks for it
  setTimeout(function() {
    delete downloads[id];
  }, 60000);
});

// On fetch, answer from the cache straight away if we can, and refresh the cached copy from the
// network in the background so the next visit is up to date.
self.addEventListener('fetch', function(evt) {
  var request = evt.request;
  // Leave anything that isn't ours (other apps on this domain, other sites, non-GET requests) to the browser
  if (request.method !== 'GET' || request.url.indexOf(self.registration.scope) !== 0) {
    return;
  }

  var download = /\/download\/(\w+)$/.exec(new URL(request.url).pathname);
  if (download) {
    var started = downloads[download[1]];
    if (!started) {
      evt.respondWith(new Response('That download has expired.', {status: 404}));
      return;
    }
    delete downloads[download[1]];
    started.page.postMessage('started');
    evt.respondWith(new Response(started.stream, {headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(started.name)
    }}));
    return;
  }

  var network = fetch(request);
  // Only keep good responses, so a 404 or server error never replaces a working copy
  var saved = network.then(function(response) {
    if (response.ok) {
      var copy = response.clone();
      return caches.open(CACHE).then(function(cache) {
        return cache.put(request, copy);
      });
    }
  }).catch(function() {
    // Offline, so there's nothing to update
  });

  evt.respondWith(
    caches.open(CACHE).then(function(cache) {
      return cache.match(request).then(function(matching) {
        if (matching) {
          return matching;
        }
        return network.catch(function(error) {
          // Offline and not cached (like /zip/?something), so show the page if that's what was asked for
          if (request.mode === 'navigate') {
            return cache.match('index.html');
          }
          throw error;
        });
      });
    })
  );
  evt.waitUntil(saved);
});
