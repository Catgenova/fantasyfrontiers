/* Fantasy Frontiers service worker.
 *
 * THE ONE RULE THAT MUST SURVIVE EVERY FUTURE EDIT: the page is NETWORK-FIRST and version.json is
 * NEVER TOUCHED. The game already updates itself on every push (index.html polls version.json and
 * reloads the moment the deployed build id changes), and a cache-first worker here would pin the old
 * build and fight that loop -- the classic PWA bug where players stay one release behind forever.
 * seamcheck CHECK 10 enforces both properties structurally; do not weaken it to make an edit pass.
 *
 * A service worker is STICKY for returning players (it persists until a byte-different sw.js is
 * fetched), so this one is deliberately tiny and fails open: any error falls back to the network.
 *
 * Exactly TWO interceptions, everything else (Supabase, Turnstile, Discord, version.json) passes
 * through untouched by never calling respondWith:
 *   1. Page navigations: network first, so a push is picked up on the very next load; the last good
 *      copy is kept only as an OFFLINE fallback.
 *   2. Static art (art/, icons/, the favicon): stale-while-revalidate, cached copy served instantly
 *      while a background fetch refreshes it for next time.
 */
var CACHE_PAGE = 'ff-page-v1';
var CACHE_ART = 'ff-art-v1';
var OFFLINE_KEY = 'ff-offline-shell';

self.addEventListener('install', function(){ self.skipWaiting(); });

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if(k !== CACHE_PAGE && k !== CACHE_ART) return caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  var req = e.request;
  if(req.method !== 'GET') return;
  var url = new URL(req.url);
  if(url.origin !== self.location.origin) return;

  // 1. NAVIGATIONS: network first. Only the clean shell URL is stored as the offline fallback, so a
  // visit carrying a query string can never overwrite the copy an offline player would receive.
  if(req.mode === 'navigate'){
    e.respondWith(
      fetch(req).then(function(res){
        if(res && res.ok && url.search === '' && (url.pathname === '/' || url.pathname === '/index.html')){
          var copy = res.clone();
          caches.open(CACHE_PAGE).then(function(c){ c.put(OFFLINE_KEY, copy); });
        }
        return res;
      }).catch(function(){
        return caches.open(CACHE_PAGE).then(function(c){ return c.match(OFFLINE_KEY); }).then(function(hit){
          return hit || Response.error();
        });
      })
    );
    return;
  }

  // 2. STATIC ART: stale-while-revalidate.
  var isArt = url.pathname.indexOf('/art/') === 0 || url.pathname.indexOf('/icons/') === 0 || url.pathname === '/favicon.svg';
  if(isArt){
    e.respondWith(
      caches.open(CACHE_ART).then(function(c){
        return c.match(req).then(function(hit){
          var net = fetch(req).then(function(res){
            if(res && res.ok) c.put(req, res.clone());
            return res;
          }).catch(function(){ return hit || Response.error(); });
          return hit || net;
        });
      })
    );
  }
  // Everything else falls through untouched: version.json stays the live wire the updater needs.
});
