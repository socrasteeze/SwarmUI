/** Visible LoRA rows fetch their own metadata.
 * A stub corpus larger than the 500-row cache still gets thumbnails on a later page.
 * At most four ListModels calls are in flight, and leaving the page drops work that has not started.
 *
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-lora-metadata.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const M = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m`;
const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
let failed = false;
function check(name, pass, detail = '') {
    failed ||= !pass;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}
page.on('pageerror', error => check(`no page errors: ${error.message}`, false));
await page.route('**/*', route => {
    let path = new URL(route.request().url()).pathname;
    if (path == '/simple') {
        return route.fulfill({ contentType: 'text/html', body: '<header class="m-header"></header><main></main>' });
    }
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});
await page.goto('http://127.0.0.1/simple');
await page.addScriptTag({ path: `${M}/m_ui.js` });
await page.addScriptTag({ path: `${M}/m_state.js` });
await page.addInitScript(() => {});
await page.evaluate(() => {
    window.__pending = [];
    window.__maxInFlight = 0;
    window.__inFlight = 0;
    window.__pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    window.mGen = { onFrame() {} };
    window.mAutoComplete = { hide() {} };
    window.showError = () => {};
    window.genericRequest = (route, args, ok) => {
        if (route != 'ListModels') {
            if (ok) {
                ok(route == 'GetMyUserData' ? { presets: [], starred_models: {} } : {});
            }
            return;
        }
        window.__inFlight++;
        if (window.__inFlight > window.__maxInFlight) {
            window.__maxInFlight = window.__inFlight;
        }
        window.__pending.push({
            args,
            ok: (data) => {
                window.__inFlight--;
                ok(data);
            }
        });
    };
});
await page.addScriptTag({ path: `${M}/m_create.js` });
await page.addScriptTag({ path: `${M}/m_models.js` });

let report = await page.evaluate(async () => {
    let names = (prefix, count) => {
        let list = [];
        for (let i = 0; i < count; i++) {
            list.push({ name: `${prefix}-${pad(i)}.safetensors` });
        }
        return list;
    };
    function pad(n) {
        return String(n).padStart(4, '0');
    }
    let pageA = names('queue/a', 48);
    let pageB = names('queue/b', 48);
    mCreate.ensureLoraMetadata(pageA, () => {}, 'unit');
    let afterA = {
        inFlight: mCreate.loraFetchInFlight,
        pending: window.__pending.length,
        queued: mCreate.loraFetchQueue.length,
        depth: window.__pending.every(item => item.args.depth == 1 && item.args.limit == 10 && item.args.subtype == 'LoRA' && item.args.dataImages == false && item.args.allowRemote == true),
        path: window.__pending[0] && window.__pending[0].args.path,
        search: window.__pending[0] && window.__pending[0].args.search
    };
    mCreate.ensureLoraMetadata(pageB, () => {}, 'unit');
    let queuedSearches = mCreate.loraFetchQueue.map(item => item.job.search);
    let inFlightSearches = window.__pending.map(item => item.args.search);
    let afterB = {
        inFlight: mCreate.loraFetchInFlight,
        pending: window.__pending.length,
        queued: queuedSearches.length,
        droppedA: queuedSearches.every(search => !`${search}`.startsWith('a-')) && inFlightSearches.filter(search => `${search}`.startsWith('a-')).length <= 4,
        queuedAreB: queuedSearches.every(search => `${search}`.startsWith('b-')),
        max: window.__maxInFlight
    };
    while (window.__pending.length > 0) {
        window.__pending.shift().ok({ files: [], total: 0, returned: 0, truncated: false });
    }
    mCreate.cancelLoraMetaScope('unit');
    return { afterA, afterB };
});
check('a visible page starts at most 4 row fetches',
    report.afterA.inFlight == 4 && report.afterA.pending == 4 && report.afterA.queued == 44 && report.afterA.depth
    && report.afterA.path == 'queue' && report.afterA.search == 'a-0000',
    JSON.stringify(report.afterA));
check('paging away drops queued row fetches and keeps the cap',
    report.afterB.inFlight == 4 && report.afterB.pending == 4 && report.afterB.queued == 48
    && report.afterB.droppedA && report.afterB.queuedAreB && report.afterB.max <= 4,
    JSON.stringify(report.afterB));

report = await page.evaluate(async () => {
    let count = 548;
    let entries = [];
    for (let i = 0; i < count; i++) {
        entries.push([`pack/lora-${String(i).padStart(4, '0')}.safetensors`, '']);
    }
    mState.models = { LoRA: entries, 'Stable-Diffusion': [] };
    mState.modelClasses = {};
    mState.params = { prompt: '', images: '1', seed: '-1' };
    mState.starredModels = {};
    mState.archFilter = '';
    mCreate.loraList = null;
    mCreate.loraMetaRootDone = false;
    mCreate.loraMetaRootWaiters = [];
    window.__pending = [];
    window.__inFlight = 0;
    mCreate.loraFetchQueue = [];
    mCreate.loraFetchInFlight = 0;
    mCreate.openLoraSheet();
    function answer(item) {
        let args = item.args;
        if (args.limit == 500 && !args.search) {
            let files = [];
            for (let i = 0; i < 500; i++) {
                let name = `pack/lora-${String(i).padStart(4, '0')}.safetensors`;
                files.push({ name, title: `Early ${i}`, preview_image: window.__pixel, trigger_phrase: `early ${i}` });
            }
            item.ok({ files, total: count, returned: 500, truncated: true });
            return;
        }
        if (args.search == 'lora-0528') {
            item.ok({ files: [{ name: 'pack/lora-0528-other.safetensors', title: 'Other', preview_image: window.__pixel }], total: 1, returned: 1, truncated: false });
            return;
        }
        let name = `${args.path}/${args.search}.safetensors`;
        item.ok({
            files: [{ name, title: `Title ${args.search}`, preview_image: window.__pixel, trigger_phrase: `trigger ${args.search}` }],
            total: 1, returned: 1, truncated: false
        });
    }
    while (window.__pending.length > 0) {
        answer(window.__pending.shift());
    }
    let next = () => {
        let buttons = [...document.querySelectorAll('.m-lora-results .m-pagination-button')];
        buttons[buttons.length - 1].click();
    };
    for (let i = 0; i < 11; i++) {
        next();
    }
    let mid = {
        page: document.querySelector('.m-lora-results .m-pagination-status').textContent,
        inFlight: mCreate.loraFetchInFlight,
        pending: window.__pending.length,
        queued: mCreate.loraFetchQueue.map(item => item.job.search),
        started: window.__pending.map(item => item.args.search),
        max: window.__maxInFlight
    };
    let rows = [...document.querySelectorAll('.m-lora-results .m-model-result')];
    let rowIds = rows.map(row => row);
    let paints = 0;
    let paint = mCreate.paintLoraMetadataRows.bind(mCreate);
    mCreate.paintLoraMetadataRows = function () {
        paints++;
        return paint.apply(this, arguments);
    };
    while (window.__pending.length > 0) {
        answer(window.__pending.shift());
    }
    await new Promise(resolve => setTimeout(resolve, 120));
    let search = document.querySelector('.m-lora-search');
    search.value = 'hello';
    search.focus();
    search.setSelectionRange(1, 4);
    for (let row of document.querySelectorAll('.m-lora-results .m-model-result')) {
        row.dataset.loraMetaRev = '';
    }
    mCreate.paintLoraMetadataRows(document.querySelector('.m-lora-results'), '.m-model-result', {
        'thumbClass': 'm-model-thumb',
        'preferTitle': true
    });
    let focus = {
        active: document.activeElement == search,
        activeClass: document.activeElement ? document.activeElement.className : '',
        value: search.value,
        start: search.selectionStart,
        end: search.selectionEnd
    };
    search.value = '';
    let lateRows = [...document.querySelectorAll('.m-lora-results .m-model-result')];
    let described = lateRows.map(row => {
        let img = row.querySelector('img');
        return {
            name: row.dataset.loraName,
            title: row.querySelector('.m-model-name') ? row.querySelector('.m-model-name').textContent : '',
            src: img ? img.getAttribute('src') : '',
            preview: img ? img.src.startsWith('data:image/gif') : false,
            loading: img ? img.loading : '',
            decoding: img ? img.decoding : '',
            sameNode: rowIds.includes(row)
        };
    });
    let miss = described.find(row => row.name == 'pack/lora-0528.safetensors');
    let hit = described.find(row => row.name == 'pack/lora-0529.safetensors');
    document.querySelector('.m-lora-results .m-pagination-button').click();
    next();
    let retrySearches = window.__pending.map(item => item.args.search).concat(mCreate.loraFetchQueue.map(item => item.job.search));
    while (window.__pending.length > 0) {
        answer(window.__pending.shift());
    }
    let retriedMiss = retrySearches.includes('lora-0528');
    let clicked = false;
    let hitRow = [...document.querySelectorAll('.m-lora-results .m-model-result')].find(row => row.dataset.loraName == 'pack/lora-0530.safetensors');
    let clickError = '';
    if (hitRow) {
        try {
            hitRow.click();
        }
        catch (error) {
            clickError = `${error}`;
        }
    }
    clicked = mState.getLoras().some(row => row.name == 'pack/lora-0530.safetensors');
    let activeThumb = document.querySelector('.m-lora-row img');
    let activeTitle = document.querySelector('.m-lora-row .m-model-name');
    return {
        mid,
        paints,
        count: described.length,
        miss,
        hit,
        retriedMiss,
        focus,
        clicked,
        hitFound: !!hitRow,
        clickError,
        pageNames: [...document.querySelectorAll('.m-lora-results .m-model-result')].map(row => row.dataset.loraName),
        active: {
            src: activeThumb ? activeThumb.getAttribute('src') : '',
            preview: !!(activeThumb && activeThumb.src.startsWith('data:image/gif')),
            title: activeTitle ? activeTitle.textContent : ''
        },
        max: window.__maxInFlight
    };
});
check('page past the first 500 is the one that asks for row metadata',
    report.mid.page == 'Page 12 of 12' && report.mid.inFlight == 4 && report.mid.pending == 4
    && report.mid.queued.length == 20 && report.mid.queued.every(search => search >= 'lora-0528')
    && report.mid.started.every(search => search < 'lora-0528') && report.mid.max <= 4,
    JSON.stringify(report.mid));
check('those rows gain lazy thumbnails and titles in place, once',
    report.paints >= 1 && report.paints <= 4 && report.count == 20
    && report.hit && report.hit.title == 'Title lora-0529' && report.hit.preview
    && report.hit.loading == 'lazy' && report.hit.decoding == 'async' && report.hit.sameNode
    && report.miss && report.miss.src == '' && report.miss.title == 'lora-0528',
    JSON.stringify({ paints: report.paints, hit: report.hit, miss: report.miss, count: report.count }));
check('a LoRA with no matching preview is not fetched again', !report.retriedMiss, JSON.stringify(report.retriedMiss));
check('metadata paint keeps the search caret and the row click',
    report.focus.active && report.focus.start == 1 && report.focus.end == 4 && report.clicked,
    JSON.stringify({ focus: report.focus, clicked: report.clicked }));
check('the active LoRA row uses the metadata that just landed',
    report.active.preview && report.active.title == 'Title lora-0530',
    JSON.stringify(report.active));

report = await page.evaluate(async () => {
    let extra = [];
    for (let i = 0; i < 20; i++) {
        extra.push({ name: `gone/x-${i}.safetensors` });
    }
    window.__closedPaint = 0;
    mCreate.ensureLoraMetadata(extra, () => { window.__closedPaint++; }, 'sheet-results');
    let queuedBefore = mCreate.loraFetchQueue.length;
    document.querySelector('.m-sheet-backdrop').click();
    let queuedAfter = mCreate.loraFetchQueue.filter(item => item.job.scope == 'sheet-results').length;
    while (window.__pending.length > 0) {
        window.__pending.shift().ok({ files: [], total: 0, returned: 0, truncated: false });
    }
    await new Promise(resolve => setTimeout(resolve, 120));
    return { queuedBefore, queuedAfter, closedPaint: window.__closedPaint, max: window.__maxInFlight };
});
check('closing the sheet drops queued fetches and does not repaint',
    report.queuedBefore > 0 && report.queuedAfter == 0 && report.closedPaint == 0 && report.max <= 4,
    JSON.stringify(report));

report = await page.evaluate(async () => {
    let entries = [];
    for (let i = 0; i < 30; i++) {
        entries.push([`desk/card-${String(i).padStart(4, '0')}.safetensors`, i == 7 ? 'anima-lora' : '']);
    }
    mState.models.LoRA = entries;
    mCreate.loraList = null;
    mCreate.indexLoras([]);
    let panel = document.createElement('section');
    document.body.appendChild(panel);
    mModels.build(panel);
    mModels.subtype = 'LoRA';
    mModels.updateArchitectures();
    mModels.architectureFilters.LoRA = 'anima-lora';
    mModels.search.value = '';
    window.__pending = [];
    mModels.paintSearch();
    let asked = window.__pending.map(item => ({ path: item.args.path, search: item.args.search, depth: item.args.depth, limit: item.args.limit }));
    while (window.__pending.length > 0) {
        let item = window.__pending.shift();
        let name = `${item.args.path}/${item.args.search}.safetensors`;
        item.ok({ files: [{ name, title: 'Card Seven', preview_image: window.__pixel, trigger_phrase: 'card trigger', local: true }], total: 1, returned: 1, truncated: false });
    }
    await new Promise(resolve => setTimeout(resolve, 120));
    let card = document.querySelector('.m-model-card');
    let img = card ? card.querySelector('img') : null;
    let known = [{ name: 'pack/already.safetensors', title: 'Has', preview_image: '/already.jpg', local: true, _mListed: true, _mMetaRev: 3 }];
    window.__pending = [];
    mModels.architectureFilters.LoRA = '';
    mModels.showingSearch = false;
    mModels.page = 0;
    mModels.renderPage(known);
    let folderAsks = window.__pending.length;
    let folderImg = document.querySelector('.m-model-card img');
    mModels.subtype = 'Stable-Diffusion';
    mModels.renderPage([{ name: 'checkpoint.safetensors', title: 'Checkpoint', preview_image: '/ckpt.jpg' }]);
    return {
        asked,
        title: card ? card.querySelector('.m-model-name').textContent : '',
        src: img ? img.getAttribute('src') : '',
        preview: !!(img && img.src.startsWith('data:image/gif')),
        loading: img ? img.loading : '',
        decoding: img ? img.decoding : '',
        placeholder: card ? !!card.querySelector('.m-model-card-placeholder') : true,
        civit: card ? !!card.querySelector('.m-model-civitai-btn') : true,
        folderAsks,
        folderSrc: folderImg ? folderImg.getAttribute('src') : '',
        checkpointAsks: window.__pending.length,
        max: window.__maxInFlight
    };
});
check('Models search and architecture view fetch the visible LoRA card',
    report.asked.length == 1 && report.asked[0].path == 'desk' && report.asked[0].search == 'card-0007'
    && report.asked[0].depth == 1 && report.asked[0].limit == 10
    && report.title == 'Card Seven' && report.preview
    && report.loading == 'lazy' && report.decoding == 'async'
    && !report.placeholder && !report.civit,
    JSON.stringify(report));
check('a folder row that already has metadata is not fetched again, and checkpoints are left alone',
    report.folderAsks == 0 && report.folderSrc == '/already.jpg' && report.checkpointAsks == 0 && report.max <= 4,
    JSON.stringify(report));

await browser.close();
process.exit(failed ? 1 : 0);
