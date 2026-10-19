/** Lazy section loaders must not click the document, and /simple LoRA metadata stays at 4 in flight.
 *
 * Runs the real browsers.js and the real enrichLoraMetadata method.
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-browser-lazyload-cascade.mjs
 */
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { chromium } from 'playwright';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BROWSERS = `${REPO}/src/wwwroot/js/genpage/helpers/browsers.js`;
const CREATE = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m_create.js`, 'utf8');
const FILE_COUNT = 6000;
const MAX_PRE_BUILD = 20;

function check(name, condition, detail = '') {
    assert.equal(!!condition, true, `${name}${detail ? ` (${detail})` : ''}`);
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
}

function extractMethod(source, signature) {
    let start = source.indexOf(signature);
    assert.ok(start >= 0, `missing ${signature}`);
    let open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] == '{') {
            depth++;
        }
        else if (source[i] == '}') {
            depth--;
            if (depth == 0) {
                return source.slice(start, i + 1);
            }
        }
    }
    throw new Error(`unbalanced ${signature}`);
}

function staticNumber(name) {
    let match = CREATE.match(new RegExp(`static ${name} = (\\d+)`));
    assert.ok(match, `missing ${name}`);
    return Number(match[1]);
}

const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const html = `<!doctype html>
        <style>
            html, body { margin: 0; }
            #content { height: 500px; overflow: auto; }
            .browser-list-entry { height: 24px; overflow: hidden; display: block; }
            .browser-list-entry img { width: 24px; height: 24px; display: block; }
            .browser-section-loader { height: 4px; display: block; }
        </style>
        <div id="browser"></div>
        <div id="content"></div>`;
    await page.route('**/*', route => {
        let path = new URL(route.request().url()).pathname;
        if (path == '/cascade') {
            return route.fulfill({ contentType: 'text/html', body: html });
        }
        return route.fulfill({ contentType: 'text/plain', body: '' });
    });
    await page.goto('http://127.0.0.1/cascade');
    await page.addScriptTag({ content: `
        function getRequiredElementById(id) {
            let elem = document.getElementById(id);
            if (!elem) {
                throw new Error('missing ' + id);
            }
            return elem;
        }
        function createDiv(id, className) {
            let elem = document.createElement('div');
            if (id) {
                elem.id = id;
            }
            elem.className = className || '';
            return elem;
        }
        function createSpan(id, className, html) {
            let elem = document.createElement('span');
            if (id) {
                elem.id = id;
            }
            elem.className = className || '';
            if (html) {
                elem.innerHTML = html;
            }
            return elem;
        }
        function getCookie() { return null; }
        function escapeHtml(text) { return String(text == null ? '' : text); }
        function stripHtmlToText(text) { return String(text == null ? '' : text); }
    ` });
    await page.addScriptTag({ path: BROWSERS });
    await page.addScriptTag({ content: 'window.browserUtil = browserUtil; window.GenPageBrowserClass = GenPageBrowserClass;' });

    let cascade = await page.evaluate(async ({ fileCount, maxPreBuild }) => {
        let clicks = 0;
        document.addEventListener('click', () => { clicks++; }, true);
        let soonCalls = 0;
        let origSoon = browserUtil.scheduleVisibleSoon.bind(browserUtil);
        browserUtil.scheduleVisibleSoon = (elem, delayMs) => {
            soonCalls++;
            origSoon(elem, delayMs);
        };
        let scans = 0;
        let origVisible = browserUtil.makeVisible.bind(browserUtil);
        browserUtil.makeVisible = elem => {
            scans++;
            return origVisible(elem);
        };
        let probe = document.createElement('div');
        for (let i = 0; i < 5; i++) {
            browserUtil.scheduleVisibleSoon(probe, 80);
        }
        let soonAfterBurst = soonCalls;
        let pendingAfterBurst = browserUtil.pendingVisibleSoon.size;
        await new Promise(resolve => setTimeout(resolve, 200));
        let scansAfterBurst = scans;
        browserUtil.makeVisible = origVisible;

        let far = document.createElement('img');
        far.className = 'lazyload';
        far.dataset.src = '/far-above.png';
        far.style.position = 'fixed';
        far.style.top = '-4000px';
        far.style.height = '10px';
        far.id = 'far-above';
        document.body.appendChild(far);
        let near = document.createElement('img');
        near.className = 'lazyload';
        near.dataset.src = '/near-above.png';
        near.style.position = 'fixed';
        near.style.top = '-100px';
        near.style.height = '20px';
        near.id = 'near-above';
        document.body.appendChild(near);

        let content = document.getElementById('content');
        let renderer = new GenPageBrowserClass('browser', () => {}, 'cascade', 'List', () => {}, () => {});
        renderer.maxPreBuild = maxPreBuild;
        renderer.format = 'List';
        renderer.filter = '';
        renderer.chunksRendered = 0;
        renderer.id = 'cascade';
        renderer.handleMultiSelectTileClick = () => false;
        renderer.select = () => {};
        renderer.describe = file => ({
            className: '',
            description: file.name,
            searchable: file.name,
            display: file.name,
            name: file.name,
            image: '/thumb/' + file.name,
            buttons: []
        });
        let files = [];
        for (let i = 0; i < fileCount; i++) {
            files.push({ name: 'lora-' + i, data: { src: 'view/' + i } });
        }
        let soonBeforeBuild = soonCalls;
        renderer.buildContentList(content, files);
        let initialNames = content.querySelectorAll('[data-name]').length;
        let initialLoaders = content.querySelectorAll('.browser-section-loader').length;
        let cap = browserUtil.maxSectionLoadersPerPass;
        browserUtil.makeVisible(document.body);
        let afterCapNames = content.querySelectorAll('[data-name]').length;
        let afterCapLoaders = content.querySelectorAll('.browser-section-loader').length;
        let clicksAfterCap = clicks;
        let nearElem = document.getElementById('near-above');
        let farElemEarly = document.getElementById('far-above');
        let nearLoaded = !nearElem.classList.contains('lazyload') && nearElem.src.endsWith('/near-above.png');
        let farLoadedEarly = farElemEarly.getAttribute('src') != null || !farElemEarly.classList.contains('lazyload');

        let soonBeforeChunks = soonCalls;
        let manual = [...content.querySelectorAll('.browser-section-loader')].slice(0, 4);
        let namesBeforeManual = content.querySelectorAll('[data-name]').length;
        for (let loader of manual) {
            loader.lazyLoadChunk();
        }
        let namesAfterManual = content.querySelectorAll('[data-name]').length;
        manual[0].lazyLoadChunk();
        let namesAfterRepeat = content.querySelectorAll('[data-name]').length;
        for (let loader of manual) {
            loader.remove();
        }
        let pendingAfterChunks = browserUtil.pendingVisibleSoon.size;
        let soonFromChunks = soonCalls - soonBeforeChunks;

        let onclickLoader = content.querySelector('.browser-section-loader');
        let namesBeforeOnclick = content.querySelectorAll('[data-name]').length;
        onclickLoader.onclick();
        let namesAfterOnclick = content.querySelectorAll('[data-name]').length;
        onclickLoader.remove();
        let clicksAfterOnclick = clicks;

        let stuckNames = afterCapNames;
        let passes = 0;
        while (passes < 40) {
            let before = content.querySelectorAll('[data-name]').length;
            browserUtil.makeVisible(content);
            let after = content.querySelectorAll('[data-name]').length;
            passes++;
            if (after == before) {
                stuckNames = after;
                break;
            }
        }
        let loadersWhenStuck = content.querySelectorAll('.browser-section-loader').length;
        content.style.height = '500px';
        content.style.overflow = 'auto';
        let guard = 0;
        let stuckRect = null;
        while (guard < fileCount) {
            let loaders = [...content.querySelectorAll('.browser-section-loader')];
            if (loaders.length == 0) {
                break;
            }
            let target = loaders[loaders.length - 1];
            target.scrollIntoView({ block: 'center' });
            let rect = target.getBoundingClientRect();
            let before = content.querySelectorAll('[data-name]').length;
            browserUtil.makeVisible(document.body);
            let after = content.querySelectorAll('[data-name]').length;
            guard++;
            if (after == before) {
                stuckRect = {
                    top: rect.top,
                    bottom: rect.bottom,
                    scrollTop: content.scrollTop,
                    scrollHeight: content.scrollHeight,
                    client: content.clientHeight,
                    loaders: loaders.length
                };
                break;
            }
        }
        let names = [...content.querySelectorAll('[data-name]')].map(elem => elem.dataset.name);
        let unique = new Set(names);
        let farElem = document.getElementById('far-above');
        let fallback = document.createElement('div');
        fallback.className = 'lazyload browser-section-loader';
        fallback.style.position = 'fixed';
        fallback.style.top = '120px';
        fallback.style.height = '20px';
        fallback.style.width = '20px';
        document.body.appendChild(fallback);
        let clicksBeforeFallback = clicks;
        browserUtil.makeVisible(document.body);
        return {
            cap,
            soonAfterBurst,
            pendingAfterBurst,
            scansAfterBurst,
            soonBeforeBuild,
            initialNames,
            initialLoaders,
            afterCapNames,
            afterCapLoaders,
            clicksAfterCap,
            nearLoaded,
            farLoadedEarly,
            soonFromChunks,
            pendingAfterChunks,
            namesBeforeManual,
            namesAfterManual,
            namesAfterRepeat,
            namesBeforeOnclick,
            namesAfterOnclick,
            clicksAfterOnclick,
            stuckNames,
            loadersWhenStuck,
            guard,
            nameCount: names.length,
            uniqueCount: unique.size,
            loadersLeft: content.querySelectorAll('.browser-section-loader').length,
            stuckRect,
            farStillLazy: farElem.classList.contains('lazyload') && farElem.getAttribute('src') == null,
            clicksBeforeFallback,
            clicksAfterFallback: clicks,
            fallbackRemoved: !fallback.isConnected
        };
    }, { fileCount: FILE_COUNT, maxPreBuild: MAX_PRE_BUILD });

    let chunkSize = Math.min(MAX_PRE_BUILD / 2, 100);
    check('five scheduleVisibleSoon calls share one timer',
        cascade.soonAfterBurst == 5 && cascade.pendingAfterBurst == 1 && cascade.scansAfterBurst == 1,
        `calls ${cascade.soonAfterBurst}, pending ${cascade.pendingAfterBurst}, scans ${cascade.scansAfterBurst}`);
    check('one makeVisible builds only the section-loader cap',
        cascade.cap == 2
        && cascade.initialNames == MAX_PRE_BUILD
        && cascade.afterCapLoaders == cascade.initialLoaders - cascade.cap
        && cascade.afterCapNames == cascade.initialNames + cascade.cap * chunkSize,
        `names ${cascade.initialNames}->${cascade.afterCapNames}, loaders ${cascade.initialLoaders}->${cascade.afterCapLoaders}`);
    check('lazy loading does not dispatch document clicks',
        cascade.clicksAfterCap == 0 && cascade.clicksAfterOnclick == 0,
        `after cap ${cascade.clicksAfterCap}, after onclick ${cascade.clicksAfterOnclick}`);
    check('a loader onclick builds its chunk without a second copy',
        cascade.namesAfterOnclick > cascade.namesBeforeOnclick,
        `${cascade.namesBeforeOnclick}->${cascade.namesAfterOnclick}`);
    check('repeated chunk builds coalesce to one pending scan',
        cascade.soonFromChunks == 4 && cascade.pendingAfterChunks == 1 && cascade.namesAfterRepeat == cascade.namesAfterManual,
        `soon +${cascade.soonFromChunks}, pending ${cascade.pendingAfterChunks}, names ${cascade.namesAfterManual}/${cascade.namesAfterRepeat}`);
    check('an image just above the viewport still loads', cascade.nearLoaded);
    check('an image far above the viewport is not revealed', !cascade.farLoadedEarly && cascade.farStillLazy);
    check('loaders below the viewport wait for scroll',
        cascade.stuckNames < FILE_COUNT && cascade.loadersWhenStuck > 0,
        `stuck at ${cascade.stuckNames} with ${cascade.loadersWhenStuck} loaders`);
    check('scrolling to the end renders every file once',
        cascade.nameCount == FILE_COUNT && cascade.uniqueCount == FILE_COUNT && cascade.loadersLeft == 0,
        `${cascade.nameCount} names, ${cascade.uniqueCount} unique, ${cascade.loadersLeft} loaders, ${cascade.guard} passes ${JSON.stringify(cascade.stuckRect)}`);
    check('a third-party loader without lazyLoadChunk still activates',
        cascade.clicksAfterFallback == cascade.clicksBeforeFallback + 1 && cascade.fallbackRemoved,
        `clicks ${cascade.clicksBeforeFallback}->${cascade.clicksAfterFallback}`);
    check('cascade page produced no errors', pageErrors.length == 0, pageErrors.join('\n'));

    const enrichMethod = extractMethod(CREATE, '    enrichLoraMetadata(onDone) {');
    const enqueueMethod = extractMethod(CREATE, '    enqueueLoraFetch(job, done) {');
    const pumpMethod = extractMethod(CREATE, '    pumpLoraFetch() {');
    const parallel = staticNumber('MetadataFetchParallel');
    const depth = staticNumber('ListDepth');
    const limit = staticNumber('LoraCacheLimit');
    check('metadata fetch parallelism is 4', parallel == 4, `${parallel}`);
    check('LoRA metadata page size is 500', limit == 500, `${limit}`);
    let enrich = await page.evaluate(async ({ enrichMethod, enqueueMethod, pumpMethod, parallel, depth, limit }) => {
        window.MCreate = {
            ListDepth: depth,
            MetadataFetchParallel: parallel,
            LoraCacheLimit: limit,
            loraSortSetting: () => ({ mode: 'Name', reverse: false })
        };
        let Host = new Function(`return class Host { ${enqueueMethod} ${pumpMethod} ${enrichMethod} }`)();
        let jobs = [];
        let outstanding = 0;
        let maxOutstanding = 0;
        let calls = [];
        let payloads = [];
        window.genericRequest = (route, args, ok) => {
            outstanding++;
            if (outstanding > maxOutstanding) {
                maxOutstanding = outstanding;
            }
            calls.push(`${args.depth}:${args.path}`);
            payloads.push({
                route,
                subtype: args.subtype,
                dataImages: args.dataImages,
                limit: args.limit,
                offset: args.offset,
                search: args.search,
                depth: args.depth,
                path: args.path
            });
            jobs.push(() => {
                outstanding--;
                ok({ files: [{ name: 'kept.safetensors', title: 'Kept' }], total: 1, returned: 1, truncated: false });
            });
        };
        let host = new Host();
        host.loraList = null;
        host.loraMap = new Map();
        host.merged = [];
        host.mergeLoraMetadata = files => {
            for (let file of (files || [])) {
                host.merged.push(file.name);
            }
        };
        host.indexLoras = () => { host.indexed = true; };
        let doneCount = 0;
        let early = false;
        let failed = null;
        let errorText = null;
        host.enrichLoraMetadata((nextFailed, nextError) => {
            doneCount++;
            failed = nextFailed;
            errorText = nextError;
            if (jobs.length > 0 || outstanding > 0) {
                early = true;
            }
        });
        host.enrichLoraMetadata((nextFailed, nextError) => {
            doneCount++;
            failed = nextFailed;
            errorText = nextError;
        });
        let guard = 0;
        while (jobs.length > 0 && guard < 100) {
            let batch = jobs.splice(0, jobs.length);
            for (let finish of batch) {
                finish();
            }
            guard++;
        }
        let first = payloads[0] || {};
        return {
            doneCount,
            early,
            failed,
            errorText,
            maxOutstanding,
            outstanding,
            jobsLeft: jobs.length,
            calls: calls.length,
            merged: host.merged,
            indexed: host.indexed == true,
            route: first.route || '',
            subtype: first.subtype || '',
            dataImages: first.dataImages,
            limit: first.limit,
            offset: first.offset,
            search: first.search,
            depth: first.depth,
            path: first.path,
            guard
        };
    }, { enrichMethod, enqueueMethod, pumpMethod, parallel, depth, limit });

    check('enrichLoraMetadata issues one capped ListModels request',
        enrich.maxOutstanding <= 4 && enrich.outstanding == 0 && enrich.jobsLeft == 0
        && enrich.calls == 1 && enrich.limit == limit && enrich.offset == 0 && enrich.search == ''
        && enrich.depth == depth && enrich.path == ''
        && enrich.route == 'ListModels' && enrich.subtype == 'LoRA' && enrich.dataImages == false,
        `calls ${enrich.calls}, limit ${enrich.limit}, max ${enrich.maxOutstanding}`);
    check('enrichLoraMetadata calls onDone once per caller after that single page',
        enrich.doneCount == 2 && enrich.early == false && enrich.failed == false
        && enrich.merged.join(',') == 'kept.safetensors' && enrich.indexed == true,
        `done ${enrich.doneCount}, merged ${enrich.merged.join(',')}, ${enrich.errorText}`);
}
finally {
    await browser.close();
}
console.log('verify-browser-lazyload-cascade: ok');
