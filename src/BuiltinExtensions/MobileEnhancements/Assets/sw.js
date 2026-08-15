// SwarmUI PWA service worker (fork MobileEnhancements extension).
// Served at root scope from C# (/sw.js), with `const SWARM_VARY = "<version>";` prepended so cache
// names roll on every server version. Strategy is deliberately conservative: the app is entirely
// server-dependent (WebSocket + REST), so this worker only makes the app installable and adds an
// offline fallback + static asset caching. It NEVER serves stale HTML/JS/CSS (network-first), so a
// server update can't get "stuck" behind the cache.

const CACHE_STATIC = `swarm-static-${SWARM_VARY}`;
const CACHE_ASSET = `swarm-asset-${SWARM_VARY}`;
const OFFLINE_URL = '/ExtensionFile/MobileEnhancementsExtension/Assets/offline.html';

// Paths the worker must never touch - live API, generated media, websockets. Let the network own these.
// /tagdexindex/ is here for a storage reason rather than a correctness one: it is a few-hundred-KB blob served
// from a fingerprinted, effectively immutable URL, so the browser's ordinary HTTP cache already serves repeat
// visits with zero network. Copying it into Cache Storage as well bought nothing and spent a large slice of
// iOS's small (~50MB) origin budget - and because the URL carries a version, every version ever loaded stayed
// resident forever. Thumbnails (/tagdexthumb/) are deliberately NOT here: they are small, individually useful
// offline, and now bounded by MAX_ASSET_ENTRIES.
const PASS_THROUGH = ['/api/', '/view/', '/viewspecial/', '/output/', '/audio/', '/tagdexindex/'];

// Hard ceilings on the runtime caches. iOS Safari's Cache Storage budget is small (~50MB is the commonly
// reported figure) and it evicts the WHOLE origin's storage when exceeded rather than trimming - so an
// unbounded cache does not degrade, it wipes everything including the offline fallback. These are entry counts
// rather than bytes because the Cache API exposes no size, and entry count is the thing we can actually check.
const MAX_ASSET_ENTRIES = 120;
const MAX_STATIC_ENTRIES = 80;

/** Trims a cache to a maximum entry count, oldest-first (Cache Storage keys are insertion-ordered). */
async function trimCache(cacheName, maxEntries) {
    try {
        const cache = await caches.open(cacheName);
        const keys = await cache.keys();
        if (keys.length <= maxEntries) {
            return;
        }
        // Delete sequentially from the oldest end; keys() order is insertion order, so this is a crude LRU
        // (really FIFO, since a cache hit does not reorder). Good enough: the goal is a ceiling, not optimality.
        const excess = keys.length - maxEntries;
        for (let i = 0; i < excess; i++) {
            await cache.delete(keys[i]);
        }
    }
    catch (err) {
        // Trimming is maintenance, never the point of the request that triggered it.
    }
}

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        // The offline page is best-effort, NOT a precondition of installing. It used to be awaited bare, so if
        // that one GET ever 404'd (asset rename) or redirected to a login page, the install event rejected and
        // NO service worker installed at all - trading a missing offline page for having no worker whatsoever.
        try {
            const cache = await caches.open(CACHE_STATIC);
            await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
        }
        catch (err) {
            console.log(`SwarmUI SW: offline fallback not cached (${err}) - continuing install anyway.`);
        }
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        // Let the browser start the navigation fetch in parallel with worker startup, instead of the page
        // request waiting on this worker to boot first. No-op where unsupported (e.g. Safari).
        if (self.registration.navigationPreload) {
            await self.registration.navigationPreload.enable();
        }
        const keep = [CACHE_STATIC, CACHE_ASSET];
        const names = await caches.keys();
        await Promise.all(names.map(n => keep.includes(n) ? null : caches.delete(n)));
        await self.clients.claim();
    })());
});

/** True if the request should be left entirely to the network (API, generated media, cross-origin). */
function isPassThrough(url, request) {
    if (url.origin != self.location.origin) {
        return true;
    }
    const path = url.pathname.toLowerCase();
    for (let i = 0; i < PASS_THROUGH.length; i++) {
        if (path.startsWith(PASS_THROUGH[i])) {
            return true;
        }
    }
    return false;
}

/** True for long-lived static assets that are safe to serve cache-first (icons, images, fonts). */
function isStaticAsset(url) {
    const path = url.pathname.toLowerCase();
    if (path.startsWith('/imgs/') || path.startsWith('/fonts/')) {
        return true;
    }
    if (path.startsWith('/extensionfile/') && path.includes('/icons/')) {
        return true;
    }
    return /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf)$/.test(path);
}

/** Network-first: prefer fresh, fall back to cache only when the network fails (fully offline). */
async function networkFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok && request.method == 'GET') {
            // Not awaited (the response must not wait on disk), but .catch'd: an unhandled QuotaExceededError
            // here was previously an unhandled rejection inside the worker, which tells nobody anything and
            // leaves the cache full. Trimming afterwards is what keeps it from getting there again.
            cache.put(request, fresh.clone())
                .then(() => trimCache(cacheName, MAX_STATIC_ENTRIES))
                .catch(err => console.log(`SwarmUI SW: cache put failed (${err})`));
        }
        return fresh;
    }
    catch (err) {
        const cached = await cache.match(request);
        if (cached) {
            return cached;
        }
        throw err;
    }
}

/** Cache-first: serve cache immediately, fetch+store on miss. For assets that never change per version. */
async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) {
        return cached;
    }
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
        cache.put(request, fresh.clone())
            .then(() => trimCache(cacheName, MAX_ASSET_ENTRIES))
            .catch(err => console.log(`SwarmUI SW: asset cache put failed (${err})`));
    }
    return fresh;
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method != 'GET') {
        return;
    }
    const url = new URL(request.url);
    if (isPassThrough(url, request)) {
        return;
    }
    // Full-page navigations: network-first, offline.html when the network is gone.
    if (request.mode == 'navigate') {
        event.respondWith((async () => {
            try {
                // Use the preloaded response when navigation preload kicked it off already (see activate);
                // cache it under the same rules networkFirst would so the offline fallback stays in sync.
                const preload = await event.preloadResponse;
                if (preload) {
                    if (preload.ok) {
                        const cache = await caches.open(CACHE_STATIC);
                        cache.put(request, preload.clone());
                    }
                    return preload;
                }
                return await networkFirst(request, CACHE_STATIC);
            }
            catch (err) {
                const cache = await caches.open(CACHE_STATIC);
                const offline = await cache.match(OFFLINE_URL);
                return offline || Response.error();
            }
        })());
        return;
    }
    if (isStaticAsset(url)) {
        event.respondWith(cacheFirst(request, CACHE_ASSET));
        return;
    }
    // Scripts / styles / other same-origin GETs (including ?vary= busted files): network-first so a
    // server update is picked up immediately; cache only rescues a fully-offline reload.
    event.respondWith(networkFirst(request, CACHE_STATIC));
});
