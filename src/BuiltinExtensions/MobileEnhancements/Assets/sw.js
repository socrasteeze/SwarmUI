// SwarmUI PWA service worker (fork MobileEnhancements extension).
// Served at root scope from C# (/sw.js), with `const SWARM_VARY = "<version>";` prepended so cache
// names roll on every server version. Strategy is deliberately conservative: the app is entirely
// server-dependent (WebSocket + REST), so this worker only makes the app installable and adds an
// offline fallback + public static asset caching. Navigations are never cached. Unversioned scripts/styles
// use the network first; versioned (`?vary=`) assets use the cache first unless an explicit reload bypasses it.

// v2 intentionally changes the static-cache name. Earlier workers stored successful navigation documents in
// this cache, including authenticated /simple and Genpage HTML. Activation removes that old namespace even
// when SWARM_VARY has not changed, so a fixed worker cannot fall back to a previously stored user document.
const CACHE_STATIC = `swarm-static-v2-${SWARM_VARY}`;
const CACHE_ASSET = `swarm-asset-v2-${SWARM_VARY}`;
const OFFLINE_URL = '/ExtensionFile/MobileEnhancementsExtension/Assets/offline.html';

// Leave live API calls, generated media, and protected TagDex assets to ordinary HTTP handling. TagDex uses
// permission-aware ETag revalidation; worker cache hits must not bypass that check or retain private previews.
const PASS_THROUGH = ['/api/', '/view/', '/viewspecial/', '/output/', '/audio/', '/tagdexindex/', '/tagdexthumb/'];

// Bound runtime cache growth across large catalogues and asset requests. These are entry counts rather than
// bytes because Cache Storage does not expose each entry's stored size.
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
            const request = new Request(new URL(OFFLINE_URL, self.location.origin), { cache: 'reload', redirect: 'error' });
            const response = await fetch(request);
            if (!response.ok || response.redirected) {
                throw new Error(`offline fallback returned ${response.status}`);
            }
            await cache.put(request, response);
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
        await Promise.all(names.map(n => isWorkerCacheName(n) && !keep.includes(n) ? caches.delete(n) : null));
        await self.clients.claim();
    })());
});

/** True for a Cache Storage name that this worker owns. Cache Storage is shared by the whole origin, so activation
 * must never delete an unrelated extension's cache just because the name is not in this worker's current set. */
function isWorkerCacheName(name) {
    return name.startsWith('swarm-static-') || name.startsWith('swarm-asset-') || name.startsWith('swarm-thumb-');
}

/** True if the request should be left entirely to the network (API, generated media, cross-origin). */
function isPassThrough(url) {
    if (url.origin != self.location.origin) {
        return true;
    }
    let path;
    try {
        path = decodeURIComponent(url.pathname).toLowerCase();
    }
    catch (err) {
        return true;
    }
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

/** Keeps a cache write alive after the response is returned. Cache writes are not awaited by the response path, but
 * FetchEvent.waitUntil prevents the browser from stopping the worker before the write and bounded trim complete. */
function queueCacheWrite(event, cache, request, response, cacheName, maxEntries, failureMessage) {
    let write = cache.put(request, response)
        .then(() => trimCache(cacheName, maxEntries))
        .catch(err => console.log(`${failureMessage} (${err})`));
    event.waitUntil(write);
}

/** True when a response is safe for the generic static cache. Navigation documents can contain session-derived
 * markup, so only the dedicated offline page is allowed to store HTML. Cache Storage does not enforce HTTP
 * cache directives on our behalf. */
function isGenericStaticResponse(response) {
    const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
    const cacheControl = (response.headers.get('Cache-Control') || '').toLowerCase();
    return !contentType.startsWith('text/html') && !cacheControl.includes('private') && !cacheControl.includes('no-store') && !cacheControl.includes('no-cache');
}

/** Network-first: prefer fresh, fall back to cache only when the network fails (fully offline). */
async function networkFirst(event, request, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok && request.method == 'GET' && isGenericStaticResponse(fresh)) {
            queueCacheWrite(event, cache, request, fresh.clone(), cacheName, MAX_STATIC_ENTRIES, 'SwarmUI SW: cache put failed');
        }
        return fresh;
    }
    catch (err) {
        const cached = await cache.match(request);
        if (cached && isGenericStaticResponse(cached)) {
            return cached;
        }
        throw err;
    }
}

/** Cache-first: serve cache immediately, fetch+store on miss. For assets that never change per version.
 * `maxEntries` is explicit rather than a fixed constant because this is now called for two different caches:
 * hardcoding one cache's ceiling here meant CACHE_STATIC was trimmed to 120 down this path and to 80 down
 * networkFirst's, so the two strategies fought over one cache and eviction came in bursts of 40. */
async function cacheFirst(event, request, cacheName, maxEntries) {
    const cache = await caches.open(cacheName);
    if (request.cache != 'reload') {
        const cached = await cache.match(request);
        if (cached && isGenericStaticResponse(cached)) {
            return cached;
        }
    }
    const fresh = await fetch(request);
    if (fresh && fresh.ok && isGenericStaticResponse(fresh)) {
        queueCacheWrite(event, cache, request, fresh.clone(), cacheName, maxEntries, 'SwarmUI SW: asset cache put failed');
    }
    return fresh;
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method != 'GET') {
        return;
    }
    // An explicit no-store request must remain entirely network-owned. In particular, it must not turn a
    // failed navigation into a cached offline page: callers use no-store when they need to know what the
    // network can serve now, such as update recovery and diagnostics.
    if (request.cache == 'no-store') {
        return;
    }
    const url = new URL(request.url);
    if (isPassThrough(url)) {
        return;
    }
    // Full-page navigations are never cached. They can include authenticated template substitutions, and an
    // offline cache fallback must therefore be the dedicated, non-sensitive offline page only.
    if (request.mode == 'navigate') {
        event.respondWith((async () => {
            try {
                // Use the preloaded response when navigation preload kicked it off already (see activate).
                // Do not store it: this can be /simple or Genpage HTML for the current authenticated user.
                const preload = await event.preloadResponse;
                if (preload) {
                    return preload;
                }
                return await fetch(request);
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
        event.respondWith(cacheFirst(event, request, CACHE_ASSET, MAX_ASSET_ENTRIES));
        return;
    }
    // Fingerprinted URLs (?vary=<version>): cache-first is safe here because the URL itself changes
    // whenever the content does, so a cache hit can never be stale - and it saves a network round trip
    // for every script/style load once the version is cached.
    if (url.searchParams.has('vary')) {
        event.respondWith(cacheFirst(event, request, CACHE_STATIC, MAX_STATIC_ENTRIES));
        return;
    }
    // Everything else same-origin (unfingerprinted scripts/styles/etc): network-first so a server update
    // is picked up immediately; cache only rescues a fully-offline reload.
    event.respondWith(networkFirst(event, request, CACHE_STATIC));
});
