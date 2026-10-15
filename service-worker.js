// Every cache this app makes starts with PREFIX. Other apps on turquoise-turtle.github.io (like /pdf/) share
// the same cache storage, so this worker only ever touches caches with its own prefix.
// Bump the version whenever any of the files below change, so everyone gets the new copy.
var PREFIX = 'zip-';
var CACHE = PREFIX + 'v2';
// The cache name this app used before versioning
var OLD_CACHE = 'cache-and-update-zip';

// Relative to this file, so they stay inside /zip/
var FILES = [
  './',
  'index.html',
  'alt.js',
  'clean.js',
  'jszip.js',
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

// On fetch, answer from the cache straight away if we can, and refresh the cached copy from the
// network in the background so the next visit is up to date.
self.addEventListener('fetch', function(evt) {
  var request = evt.request;
  // Leave anything that isn't ours (other apps on this domain, other sites, non-GET requests) to the browser
  if (request.method !== 'GET' || request.url.indexOf(self.registration.scope) !== 0) {
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
