/**
 * Deterministic service-worker cache lifecycle harness.
 *
 * This runs the shipped worker in a VM with Cache Storage, fetch, and ExtendableEvent stand-ins. It verifies
 * cache behavior that a page-level Playwright run cannot make deterministic: the response must not wait for a
 * cache write, but the worker must retain that write with waitUntil; explicit browser cache modes must win;
 * activation must not remove unrelated origin caches.
 *
 * Run from the repository root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-pwa-cache.mjs
 */
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

let repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
let source = await readFile(`${repo}/src/BuiltinExtensions/MobileEnhancements/Assets/sw.js`, 'utf8');
let results = [];

/** Records one assertion and lets the script finish every independent check before failing. */
function check(name, pass, detail = '') {
    results.push(pass);
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** Gives Cache Storage's request matching a stable, query-aware key. */
function cacheKey(request) {
    if (typeof request == 'string') {
        return new URL(request, 'https://swarm.test').href;
    }
    return request.url;
}

/** In-memory Cache API stand-in with an optional delayed or failed write hook. */
class FakeCache {
    constructor() {
        this.entries = new Map();
        this.beforePut = null;
    }

    async match(request) {
        let response = this.entries.get(cacheKey(request));
        return response ? response.clone() : undefined;
    }

    async put(request, response) {
        if (this.beforePut) {
            await this.beforePut(request, response);
        }
        this.entries.set(cacheKey(request), response.clone());
    }

    async keys() {
        return [...this.entries.keys()].map(url => new Request(url));
    }

    async delete(request) {
        return this.entries.delete(cacheKey(request));
    }

    async add(request) {
        let response = await this.fetch(request);
        if (!response.ok) {
            throw new Error(`cache.add failed with ${response.status}`);
        }
        await this.put(request, response);
    }
}

/** Builds a fresh, isolated worker host for one test case. */
function makeWorker(fetchHandler) {
    let handlers = new Map();
    let cacheMap = new Map();
    let fetchCalls = [];
    let navigationPreloadEnabled = 0;
    let clientsClaimed = 0;
    let cacheStorage = {
        async open(name) {
            if (!cacheMap.has(name)) {
                let cache = new FakeCache();
                cache.fetch = request => hostFetch(request);
                cacheMap.set(name, cache);
            }
            return cacheMap.get(name);
        },
        async keys() {
            return [...cacheMap.keys()];
        },
        async delete(name) {
            return cacheMap.delete(name);
        }
    };
    let hostFetch = async request => {
        fetchCalls.push(request);
        return await fetchHandler(request, fetchCalls.length);
    };
    let self = {
        location: { origin: 'https://swarm.test' },
        registration: { navigationPreload: { async enable() { navigationPreloadEnabled++; } } },
        clients: { async claim() { clientsClaimed++; } },
        addEventListener(name, handler) {
            handlers.set(name, handler);
        },
        async skipWaiting() {
        }
    };
    let context = vm.createContext({
        self,
        caches: cacheStorage,
        fetch: hostFetch,
        Request,
        Response,
        URL,
        Promise,
        Map,
        console,
    });
    vm.runInContext(`const SWARM_VARY = "test";\n${source}`, context, { filename: 'sw.js' });
    return {
        caches: cacheStorage,
        fetchCalls,
        get navigationPreloadEnabled() {
            return navigationPreloadEnabled;
        },
        get clientsClaimed() {
            return clientsClaimed;
        },
        async fetch(request, preloadResponse = undefined) {
            let event = {
                request,
                preloadResponse: Promise.resolve(preloadResponse),
                waits: [],
                response: null,
                waitUntil(work) {
                    this.waits.push(Promise.resolve(work));
                },
                respondWith(response) {
                    this.response = Promise.resolve(response);
                }
            };
            handlers.get('fetch')(event);
            return event;
        },
        async activate() {
            let event = { waits: [], waitUntil(work) { this.waits.push(Promise.resolve(work)); } };
            handlers.get('activate')(event);
            await Promise.all(event.waits);
        },
        async install() {
            let event = { waits: [], waitUntil(work) { this.waits.push(Promise.resolve(work)); } };
            handlers.get('install')(event);
            await Promise.all(event.waits);
        }
    };
}

/** Waits for the worker-owned background tasks after the response assertion has completed. */
async function flush(event) {
    await Promise.all(event.waits);
}

{
    let worker = makeWorker(async () => new Response('network'));
    let cache = await worker.caches.open('swarm-asset-v2-test');
    let request = new Request('https://swarm.test/imgs/warm.png');
    await cache.put(request, new Response('warm'));
    let event = await worker.fetch(request);
    let response = await event.response;
    check('warm cache-first asset returns cached bytes', await response.text() == 'warm');
    check('warm cache-first asset skips fetch', worker.fetchCalls.length == 0, `${worker.fetchCalls.length} fetches`);
}

{
    let releaseWrite = null;
    let worker = makeWorker(async () => new Response('cold'));
    let cache = await worker.caches.open('swarm-asset-v2-test');
    cache.beforePut = async () => await new Promise(resolve => { releaseWrite = resolve; });
    let event = await worker.fetch(new Request('https://swarm.test/imgs/cold.png'));
    let response = await event.response;
    check('cold cache write does not delay response', await response.text() == 'cold');
    check('cold cache write is retained with waitUntil', event.waits.length == 1, `${event.waits.length} retained tasks`);
    releaseWrite();
    await flush(event);
    check('cold cache write completes after response', await (await cache.match('https://swarm.test/imgs/cold.png')).text() == 'cold');
}

{
    let worker = makeWorker(async () => new Response('network'));
    let cache = await worker.caches.open('swarm-asset-v2-test');
    cache.beforePut = async () => { throw new Error('quota'); };
    let event = await worker.fetch(new Request('https://swarm.test/imgs/quota.png'));
    let response = await event.response;
    await flush(event);
    check('cache write failure still returns the network response', await response.text() == 'network');
}

{
    let worker = makeWorker(async () => new Response('network'));
    await worker.caches.open('swarm-static-old');
    await worker.caches.open('swarm-static-test');
    await worker.caches.open('swarm-asset-old');
    await worker.caches.open('swarm-asset-test');
    await worker.caches.open('swarm-thumb-v0');
    await worker.caches.open('tagdex-index-v1');
    await worker.caches.open('another-extension-cache');
    await worker.activate();
    let names = await worker.caches.keys();
    check('activation removes stale worker static caches, including the prior current-version schema', !names.includes('swarm-static-old') && !names.includes('swarm-static-test'));
    check('activation removes stale worker thumbnail caches', !names.includes('swarm-thumb-v0'));
    check('activation removes the prior asset-cache schema', !names.includes('swarm-asset-old') && !names.includes('swarm-asset-test'));
    check('activation preserves unrelated origin caches', names.includes('tagdex-index-v1') && names.includes('another-extension-cache'));
    check('activation retains navigation preload and client claim', worker.navigationPreloadEnabled == 1 && worker.clientsClaimed == 1);
}

{
    let serial = 0;
    let worker = makeWorker(async () => new Response(`network-${++serial}`));
    let cache = await worker.caches.open('swarm-asset-v2-test');
    let url = 'https://swarm.test/imgs/cache-mode.png';
    await cache.put(url, new Response('old'));
    let reload = await worker.fetch(new Request(url, { cache: 'reload' }));
    check('reload bypasses a warm cache', await (await reload.response).text() == 'network-1');
    await flush(reload);
    check('reload replaces the cached response', await (await cache.match(url)).text() == 'network-1');
    let noStore = await worker.fetch(new Request(url, { cache: 'no-store' }));
    check('no-store leaves the request network-owned', noStore.response == null && worker.fetchCalls.length == 1);
    await flush(noStore);
    check('no-store does not replace the cached response', await (await cache.match(url)).text() == 'network-1');
}

{
    let worker = makeWorker(async () => new Response('network media'));
    let cache = await worker.caches.open('swarm-thumb-v1');
    let view = 'https://swarm.test/View/user/output.png?preview=true';
    let tagDex = 'https://swarm.test/TagDexThumb/model.png';
    await cache.put(view, new Response('private thumbnail'));
    await cache.put(tagDex, new Response('private TagDex thumbnail'));
    let viewEvent = await worker.fetch(new Request(view));
    let tagDexEvent = await worker.fetch(new Request(tagDex));
    let noStoreEvent = await worker.fetch(new Request(view, { cache: 'no-store' }));
    let rangeEvent = await worker.fetch(new Request(view, { headers: { Range: 'bytes=0-1' } }));
    check('cached private View previews remain auth-aware network requests', viewEvent.response == null && worker.fetchCalls.length == 0);
    check('TagDex thumbnails remain auth-aware network requests', tagDexEvent.response == null && worker.fetchCalls.length == 0);
    check('private no-store and Range requests remain unhandled', noStoreEvent.response == null && rangeEvent.response == null && worker.fetchCalls.length == 0);
}

{
    let worker = makeWorker(async request => new Response('offline page'));
    await worker.install();
    let cache = await worker.caches.open('swarm-static-v2-test');
    check('offline pre-cache uses reload plus redirect:error and stores a successful response', await (await cache.match('https://swarm.test/ExtensionFile/MobileEnhancementsExtension/Assets/offline.html')).text() == 'offline page');
    check('offline pre-cache request cannot follow an auth redirect', worker.fetchCalls[0].cache == 'reload' && worker.fetchCalls[0].redirect == 'error');
}

{
    let worker = makeWorker(async request => {
        if (request.url.endsWith('/simple')) {
            throw new Error('offline');
        }
        return new Response('network');
    });
    let cache = await worker.caches.open('swarm-static-v2-test');
    await cache.put('/ExtensionFile/MobileEnhancementsExtension/Assets/offline.html', new Response('offline fallback'));
    await cache.put('https://swarm.test/simple', new Response('private marker', { headers: { 'Content-Type': 'text/html' } }));
    let request = { url: 'https://swarm.test/simple', method: 'GET', mode: 'navigate', cache: 'default' };
    let event = await worker.fetch(request);
    check('offline navigation uses the dedicated fallback, never cached private HTML', await (await event.response).text() == 'offline fallback');
    let noStoreRequest = { url: 'https://swarm.test/simple', method: 'GET', mode: 'navigate', cache: 'no-store' };
    let noStoreEvent = await worker.fetch(noStoreRequest);
    check('navigation no-store leaves the request network-owned', noStoreEvent.response == null && worker.fetchCalls.length == 1);
}

{
    let worker = makeWorker(async () => new Response('network fallback'));
    let preload = new Response('preload');
    let request = { url: 'https://swarm.test/simple', method: 'GET', mode: 'navigate', cache: 'default' };
    let event = await worker.fetch(request, preload);
    check('navigation preload is returned without a duplicate fetch', await (await event.response).text() == 'preload' && worker.fetchCalls.length == 0);
    check('navigation preload is never retained in Cache Storage', event.waits.length == 0, `${event.waits.length} retained tasks`);
    await flush(event);
}

{
    let worker = makeWorker(async () => new Response('private marker', { headers: { 'Content-Type': 'text/html' } }));
    let request = { url: 'https://swarm.test/simple', method: 'GET', mode: 'cors', cache: 'default' };
    let event = await worker.fetch(request);
    await event.response;
    await flush(event);
    let cache = await worker.caches.open('swarm-static-v2-test');
    check('generic HTML fetches are never retained in Cache Storage', await cache.match(request) == undefined);
}

{
    let worker = makeWorker(async () => new Response('api'));
    let event = await worker.fetch(new Request('https://swarm.test/API/GetCurrentStatus'));
    check('API requests remain pass-through', event.response == null && worker.fetchCalls.length == 0);
    let noStoreEvent = await worker.fetch(new Request('https://swarm.test/API/GetCurrentStatus', { cache: 'no-store' }));
    check('API no-store remains pass-through', noStoreEvent.response == null && worker.fetchCalls.length == 0);
}

{
    let worker = makeWorker(async () => new Response('private data', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }));
    let request = new Request('https://swarm.test/private-data.json');
    let event = await worker.fetch(request);
    await event.response;
    await flush(event);
    let cache = await worker.caches.open('swarm-static-v2-test');
    check('private no-store non-HTML response is never retained', await cache.match(request) == undefined && event.waits.length == 0);
}

{
    let worker = makeWorker(async () => { throw new Error('offline'); });
    let request = new Request('https://swarm.test/old-private.json');
    let cache = await worker.caches.open('swarm-static-v2-test');
    await cache.put(request, new Response('old private', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private' } }));
    let event = await worker.fetch(request);
    let rejected = false;
    try {
        await event.response;
    }
    catch (err) {
        rejected = true;
    }
    check('private cached response is not used as a generic offline fallback', rejected);
}

{
    let worker = makeWorker(async () => new Response('media'));
    let rangeRequest = new Request('https://swarm.test/View/user/video.mp4', { headers: { Range: 'bytes=0-1' } });
    let rangeEvent = await worker.fetch(rangeRequest);
    let encodedViewEvent = await worker.fetch(new Request('https://swarm.test/%56iew/user/output.png?preview=true'));
    let encodedTagDexEvent = await worker.fetch(new Request('https://swarm.test/%54agDexThumb/model.png'));
    let crossOriginRequest = new Request('https://other.test/imgs/remote.png');
    let crossOriginEvent = await worker.fetch(crossOriginRequest);
    let crossOriginNoStoreRequest = new Request('https://other.test/imgs/remote.png', { cache: 'no-store' });
    let crossOriginNoStoreEvent = await worker.fetch(crossOriginNoStoreRequest);
    check('full media and Range requests remain pass-through', rangeEvent.response == null && worker.fetchCalls.length == 0);
    check('encoded private media paths remain pass-through', encodedViewEvent.response == null && encodedTagDexEvent.response == null && worker.fetchCalls.length == 0);
    check('cross-origin requests remain pass-through', crossOriginEvent.response == null && worker.fetchCalls.length == 0);
    check('cross-origin no-store remains pass-through', crossOriginNoStoreEvent.response == null && worker.fetchCalls.length == 0);
}

if (results.some(pass => !pass)) {
    process.exitCode = 1;
}
