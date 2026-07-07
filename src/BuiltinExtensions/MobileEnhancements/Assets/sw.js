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
const PASS_THROUGH = ['/api/', '/view/', '/viewspecial/', '/output/', '/audio/'];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_STATIC);
        await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
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
            cache.put(request, fresh.clone());
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
        cache.put(request, fresh.clone());
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
