// SwarmUI PWA service worker (fork MobileEnhancements extension).
// Served at root scope from C# (/sw.js), with `const SWARM_VARY = "<version>";` prepended so cache
// names roll on every server version. Strategy is deliberately conservative: the app is entirely
// server-dependent (WebSocket + REST), so this worker only makes the app installable and adds an
// offline fallback + static asset caching. It never serves stale UNfingerprinted HTML/JS/CSS
// (network-first) - a server update can't get "stuck" behind the cache. Fingerprinted (`?vary=`) URLs
// are the exception: they're served cache-first, because the URL itself carries the version, so a
// cache hit can never be stale.

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

// Thumbnail runtime cache (/View?...&preview=true). Deliberately NOT versioned with SWARM_VARY -
// thumbnails are content-addressed by the image itself, not by server version, so they outlive server
// upgrades and there is no reason to throw them away on every deploy.
const CACHE_THUMB = 'swarm-thumb-v1';
const MAX_THUMB_ENTRIES = 50;

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
        const keep = [CACHE_STATIC, CACHE_ASSET, CACHE_THUMB];
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

/** Cache-first: serve cache immediately, fetch+store on miss. For assets that never change per version.
 * `maxEntries` is explicit rather than a fixed constant because this is now called for two different caches:
 * hardcoding one cache's ceiling here meant CACHE_STATIC was trimmed to 120 down this path and to 80 down
 * networkFirst's, so the two strategies fought over one cache and eviction came in bursts of 40. */
async function cacheFirst(request, cacheName, maxEntries) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) {
        return cached;
    }
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
        cache.put(request, fresh.clone())
            .then(() => trimCache(cacheName, maxEntries))
            .catch(err => console.log(`SwarmUI SW: asset cache put failed (${err})`));
    }
    return fresh;
}

/** True for a thumbnail request (/View?...&preview=true) - the only /View/ traffic this worker caches.
 * This branch runs before isPassThrough (which is what normally rejects /view/ AND cross-origin), so the
 * origin check has to be repeated here: without it a cross-origin /view/...?preview=true would be pulled
 * into the worker and answered with an opaque response instead of being left alone. */
function isThumbnailRequest(url) {
    return url.origin == self.location.origin && url.pathname.toLowerCase().startsWith('/view/') && url.searchParams.get('preview') == 'true';
}

/** Stores a thumbnail response, if it is really an image. Consumes `response` - pass a clone if you also
 * intend to return it. Only caches responses that are ok AND image/*: a logged-out /View request returns a
 * JSON error and a video that has no server-side preview returns the video itself, and caching either would
 * poison the grid (or, for a video, hand a cached 200 back to a Range request and break seeking).
 * Never throws: on the cache-miss path this runs alongside the response the page is waiting on, and iOS's
 * small origin budget makes QuotaExceededError a routine outcome, not an exotic one. */
async function storeThumbnail(cache, request, response) {
    try {
        if (response && response.ok && (response.headers.get('Content-Type') || '').startsWith('image/')) {
            await cache.put(request, response);
            await trimCache(CACHE_THUMB, MAX_THUMB_ENTRIES);
        }
    }
    catch (err) {
        console.log(`SwarmUI SW: thumbnail cache put failed (${err})`);
    }
}

/** Stale-while-revalidate for thumbnails: serve any cached match immediately and refresh in the background;
 * a cache miss goes straight to the network and stores on the way past. Both the store and the background
 * refresh go through event.waitUntil - they outlive the response, and without waitUntil the browser is free
 * to kill the worker the moment respondWith settles, which on iOS it readily does. */
async function thumbnailCacheStrategy(event, request) {
    const cache = await caches.open(CACHE_THUMB);
    const cached = await cache.match(request);
    if (cached) {
        event.waitUntil((async () => {
            try {
                await storeThumbnail(cache, request, await fetch(request));
            }
            catch (err) {
                console.log(`SwarmUI SW: thumbnail revalidate failed (${err})`);
            }
        })());
        return cached;
    }
    const fresh = await fetch(request);
    // Clone before returning: the page reads `fresh`'s body, and a body can only be read once.
    event.waitUntil(storeThumbnail(cache, request, fresh.clone()));
    return fresh;
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method != 'GET') {
        return;
    }
    const url = new URL(request.url);
    if (isThumbnailRequest(url)) {
        event.respondWith(thumbnailCacheStrategy(event, request));
        return;
    }
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
                    if (preload.ok && request.method == 'GET') {
                        const cache = await caches.open(CACHE_STATIC);
                        // Same shape as networkFirst's put, and for the same reasons: not awaited so the
                        // navigation never waits on disk, but .catch'd so a QuotaExceededError cannot become
                        // an unhandled rejection, and trimmed so the cache does not stay full. This is the
                        // primary navigation path on Chromium, so it is the one that must not skip either.
                        cache.put(request, preload.clone())
                            .then(() => trimCache(CACHE_STATIC, MAX_STATIC_ENTRIES))
                            .catch(err => console.log(`SwarmUI SW: preload cache put failed (${err})`));
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
        event.respondWith(cacheFirst(request, CACHE_ASSET, MAX_ASSET_ENTRIES));
        return;
    }
    // Fingerprinted URLs (?vary=<version>): cache-first is safe here because the URL itself changes
    // whenever the content does, so a cache hit can never be stale - and it saves a network round trip
    // for every script/style load once the version is cached.
    if (url.searchParams.has('vary')) {
        event.respondWith(cacheFirst(request, CACHE_STATIC, MAX_STATIC_ENTRIES));
        return;
    }
    // Everything else same-origin (unfingerprinted scripts/styles/etc): network-first so a server update
    // is picked up immediately; cache only rescues a fully-offline reload.
    event.respondWith(networkFirst(request, CACHE_STATIC));
});
