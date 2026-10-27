/** Capped LoRA listings: Classic Load more and server search, Simple metadata window and search merge.
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-model-list-cap.mjs
 */
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { chromium } from 'playwright';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BROWSERS = `${REPO}/src/wwwroot/js/genpage/helpers/browsers.js`;
const MODELS = `${REPO}/src/wwwroot/js/genpage/gentab/models.js`;
const CREATE = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m_create.js`;

function check(name, condition, detail = '') {
    assert.equal(!!condition, true, `${name}${detail ? ` (${detail})` : ''}`);
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
}

const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const pageErrors = [];
    page.on('pageerror', error => { pageErrors.push(error.message); console.log('PAGE', error.message); });
    const classicHtml = '<div id="model_list"></div><div id="vae_list"></div><div id="lora_list"></div><div id="embedding_list"></div><div id="controlnet_list"></div><div id="wildcard_list"></div><textarea id="alt_prompt_textbox"></textarea><div id="edit_model_image_block"></div><img id="edit_model_image"><input id="edit_model_image_toggle"><select id="current_model"></select>';
    await page.route('**/*', route => {
        let path = new URL(route.request().url()).pathname;
        if (path == '/classic') {
            return route.fulfill({ contentType: 'text/html', body: classicHtml });
        }
        return route.fulfill({ contentType: 'text/plain', body: '' });
    });
    await page.goto('http://127.0.0.1/classic');
    await page.addScriptTag({ content: `
        function getRequiredElementById(id) {
            let elem = document.getElementById(id);
            if (!elem) {
                elem = document.createElement('div');
                elem.id = id;
                document.body.appendChild(elem);
            }
            return elem;
        }
        function createDiv(id, className) {
            let elem = document.createElement('div');
            if (id) elem.id = id;
            elem.className = className || '';
            return elem;
        }
        function createSpan(id, className, html) {
            let elem = document.createElement('span');
            if (id) elem.id = id;
            elem.className = className || '';
            if (html) elem.innerHTML = html;
            return elem;
        }
        function makeImageInput() { return ''; }
        function getCookie() { return null; }
        function escapeHtml(text) { return String(text == null ? '' : text); }
        function escapeHtmlNoBr(text) { return escapeHtml(text); }
        function stripHtmlToText(text) { return String(text == null ? '' : text); }
        function translate(text) { return text; }
        function convertRemToPixels() { return 320; }
        function applyTranslations() {}
        function showError(message) { window.__errors.push(String(message)); }
        window.__errors = [];
        window.__queue = [];
        window.genericRequest = (route, args, ok, depth, err) => {
            window.__queue.push({ route, args, ok, err });
        };
        window.genTabLayout = { layoutResets: [] };
        window.starredModels = { LoRA: [], VAE: [] };
    ` });
    await page.addScriptTag({ path: BROWSERS });
    await page.addScriptTag({ path: MODELS });

    let classic = await page.evaluate(async () => {
        starredModels = { LoRA: [], VAE: [] };
        sdLoraBrowser.browser.format = 'List';
        sdLoraBrowser.browser.describe = file => ({
            className: '',
            name: file.name,
            display: file.data.name,
            searchable: `${file.data.name} ${file.data.title || ''} ${file.data.trigger_phrase || ''}`,
            description: file.data.name,
            buttons: [],
            image: ''
        });
        sdLoraBrowser.browser.navigate('');
        let first = window.__queue.shift();
        let opened = {
            subtype: first.args.subtype,
            limit: first.args.limit,
            offset: first.args.offset,
            search: first.args.search
        };
        let page = [];
        for (let i = 0; i < 500; i++) {
            page.push({ name: `lora-${String(i).padStart(4, '0')}.safetensors`, title: `Title ${i}` });
        }
        first.ok({ files: page, folders: ['chars'], total: 1200, returned: 500, truncated: true });
        let label = document.querySelector('.browser-list-more-label');
        let button = document.querySelector('.browser-list-more-button');
        button.click();
        let more = window.__queue.shift();
        let moreArgs = { offset: more.args.offset, limit: more.args.limit, search: more.args.search };
        let next = [];
        for (let i = 500; i < 1000; i++) {
            next.push({ name: `lora-${String(i).padStart(4, '0')}.safetensors`, title: `Title ${i}` });
        }
        more.ok({ files: next, folders: ['chars'], total: 1200, returned: 500, truncated: true });
        let names = sdLoraBrowser.browser.lastFiles.map(file => file.name);
        let after = document.querySelector('.browser-list-more-label').innerText;
        let beforeClickCount = window.__queue.length;
        let filter = document.getElementById('sdlorabrowser_filter_input');
        filter.value = 'alpha';
        filter.dispatchEvent(new Event('input'));
        await new Promise(resolve => setTimeout(resolve, 100));
        let during = window.__queue.length;
        filter.value = 'beta';
        filter.dispatchEvent(new Event('input'));
        await new Promise(resolve => setTimeout(resolve, 100));
        let still = window.__queue.length;
        await new Promise(resolve => setTimeout(resolve, 250));
        let beta = window.__queue.shift();
        filter.value = 'gamma';
        filter.dispatchEvent(new Event('input'));
        await new Promise(resolve => setTimeout(resolve, 300));
        let gamma = window.__queue.shift();
        beta.ok({ files: [{ name: 'alpha-only.safetensors', title: 'Alpha only' }], folders: [], total: 1, returned: 1, truncated: false });
        let afterStale = sdLoraBrowser.browser.lastFiles.map(file => file.name);
        gamma.ok({ files: [{ name: 'gamma-only.safetensors', title: 'Gamma only' }], folders: [], total: 1, returned: 1, truncated: false });
        let afterGamma = sdLoraBrowser.browser.lastFiles.map(file => file.name);
        window.__queue = [];
        sdLoraBrowser.listCache = new Map();
        sdLoraBrowser.browser.lastListCache = null;
        sdLoraBrowser.browser.filter = '';
        sdLoraBrowser.unfilteredTruncated = false;
        filter.value = '';
        sdLoraBrowser.browser.update(true);
        let small = window.__queue.shift();
        small.ok({
            files: [
                { name: 'keep.safetensors', title: 'Keep' },
                { name: 'drop.safetensors', title: 'Drop' }
            ],
            folders: [],
            total: 2,
            returned: 2,
            truncated: false
        });
        let beforeFilter = window.__queue.length;
        filter = document.getElementById('sdlorabrowser_filter_input');
        filter.value = 'keep';
        filter.dispatchEvent(new Event('input'));
        await new Promise(resolve => setTimeout(resolve, 300));
        let visible = [...document.querySelectorAll('#lora_list [data-name]')].map(row => row.dataset.name);
        sdVAEBrowser.listModelFolderAndFiles('folder', false, () => {}, 1);
        let vae = window.__queue.find(entry => entry.args.subtype == 'VAE');
        sdLoraBrowser.browser.getFileFor('missing/lora.safetensors');
        let described = window.__queue.find(entry => entry.route == 'DescribeModel');
        return {
            opened,
            firstLabel: label.innerText,
            button: button.innerText,
            moreArgs,
            hasFirst: names.includes('lora-0000.safetensors'),
            hasSecond: names.includes('lora-0500.safetensors'),
            count: names.length,
            after,
            beforeClickCount,
            during,
            still,
            betaSearch: beta.args.search,
            gammaSearch: gamma.args.search,
            afterStale,
            afterGamma,
            beforeFilter,
            serverSearches: window.__queue.filter(entry => entry.route == 'ListModels' && entry.args.subtype == 'LoRA' && entry.args.search).length,
            visible,
            vaeLimit: vae ? vae.args.limit : 'missing',
            vaeSearch: vae ? vae.args.search : 'missing',
            described: described ? described.args : null
        };
    });

    check('LoRA listing requests one capped page',
        classic.opened.subtype == 'LoRA' && classic.opened.limit == 500 && classic.opened.offset == 0 && classic.opened.search == '',
        JSON.stringify(classic.opened));
    check('truncated listing shows the window row and Load more',
        classic.firstLabel.includes('Showing') && classic.firstLabel.includes('500') && classic.firstLabel.includes('search or open a subfolder')
        && classic.button == 'Load more',
        classic.firstLabel);
    check('Load more appends the next page',
        classic.moreArgs.offset == 500 && classic.moreArgs.limit == 500 && classic.moreArgs.search == ''
        && classic.hasFirst && classic.hasSecond && classic.count == 1000
        && (classic.after.includes('1,000') || classic.after.includes('1000')),
        `${classic.count} ${classic.after} offset ${classic.moreArgs.offset}`);
    check('filter on a truncated listing debounces one server search',
        classic.during == classic.beforeClickCount && classic.still == classic.beforeClickCount && classic.betaSearch == 'beta',
        `during ${classic.during}, still ${classic.still}, search ${classic.betaSearch}`);
    check('an older search response is ignored',
        classic.afterStale.includes('lora-0000.safetensors') && !classic.afterStale.includes('alpha-only.safetensors')
        && classic.afterGamma.includes('gamma-only.safetensors') && !classic.afterGamma.includes('alpha-only.safetensors')
        && classic.gammaSearch == 'gamma',
        `stale kept page ${classic.afterStale.includes('lora-0000.safetensors') && !classic.afterStale.includes('alpha-only.safetensors')}; gamma ${classic.afterGamma.join(',')}`);
    check('filter on a complete listing stays client-side',
        classic.beforeFilter == 0 && classic.serverSearches == 0
        && classic.visible.includes('keep.safetensors') && !classic.visible.includes('drop.safetensors'),
        `visible ${classic.visible.join(',')}`);
    check('other subtypes do not send the LoRA window',
        classic.vaeLimit == null && (classic.vaeSearch == null || classic.vaeSearch == ''),
        `limit ${classic.vaeLimit}, search ${classic.vaeSearch}`);
    check('a LoRA missing from the page falls back to DescribeModel',
        classic.described && classic.described.modelName == 'missing/lora.safetensors' && classic.described.subtype == 'LoRA',
        JSON.stringify(classic.described));
    check('classic page produced no errors', pageErrors.length == 0, pageErrors.join('\n'));

    // Compatible-only filter: the Classic LoRA browser asks the server to drop incompatible LoRAs, so paging and counts stay honest.
    let compatUi = await page.evaluate(async () => {
        let out = {};
        let nextList = () => {
            while (window.__queue.length > 0) {
                let request = window.__queue.shift();
                if (request.route == 'ListModels') {
                    return request;
                }
            }
            return null;
        };
        let pendingLists = () => window.__queue.filter(entry => entry.route == 'ListModels').length;
        let respond = (request, names, total, hidden) => request.ok({
            files: names.map(name => ({ name, title: name })),
            folders: [],
            total,
            returned: names.length,
            truncated: names.length < total,
            compat_hidden: hidden
        });
        let names = () => sdLoraBrowser.browser.lastFiles.map(file => file.name);
        let rows = () => [...document.querySelectorAll('#lora_list .browser-list-more-label')].map(el => el.innerText);
        let pad = (prefix, from, to) => {
            let list = [];
            for (let i = from; i < to; i++) {
                list.push(`${prefix}-${String(i).padStart(4, '0')}.safetensors`);
            }
            return list;
        };
        window.__queue = [];
        localStorage.removeItem('models_LoRA_compat_only');
        currentModelHelper.curCompatClass = 'fam-a';
        sdLoraBrowser.listCache = new Map();
        sdLoraBrowser.browser.lastListCache = null;
        sdLoraBrowser.browser.filter = '';
        sdLoraBrowser.unfilteredTruncated = false;
        sdLoraBrowser.browser.update(true);
        let first = nextList();
        out.firstCompat = first.args.compat;
        respond(first, ['on-1.safetensors', 'on-2.safetensors'], 2, 7);
        let box = document.getElementById('models_LoRA_compat_only');
        out.boxExists = !!box;
        out.boxChecked = !!box && box.checked;
        out.hiddenRow = rows().filter(text => text.includes('hidden as incompatible'));
        out.hiddenButton = (document.querySelector('#lora_list .browser-list-compat-hidden button') || {}).innerText;
        out.noLoadMoreWhenComplete = ![...document.querySelectorAll('#lora_list .browser-list-more-button')].some(button => button.innerText == 'Load more');

        document.querySelector('#lora_list .browser-list-compat-hidden button').click();
        let off = nextList();
        out.offCompat = off ? off.args.compat : 'no request';
        out.storedAfterShowAll = localStorage.getItem('models_LoRA_compat_only');
        out.boxAfterShowAll = box.checked;
        respond(off, pad('off', 0, 9), 9, 0);
        out.offCount = names().length;
        out.hiddenRowAfterShowAll = rows().filter(text => text.includes('hidden as incompatible')).length;

        box.checked = true;
        box.dispatchEvent(new Event('change'));
        out.reenableRequests = pendingLists();
        out.reenableNames = names();
        out.storedAfterReenable = localStorage.getItem('models_LoRA_compat_only');
        window.__queue = [];

        currentModelHelper.curCompatClass = 'fam-b';
        sdLoraBrowser.browser.lightRefresh();
        let second = nextList();
        out.secondCompat = second ? second.args.compat : 'no request';
        respond(second, pad('b', 0, 500), 1200, 3);
        out.bothRows = rows();

        currentModelHelper.curCompatClass = 'fam-a';
        document.querySelector('#lora_list .browser-list-more-button').click();
        let more = nextList();
        out.moreCompat = more ? more.args.compat : 'no request';
        out.moreOffset = more ? more.args.offset : null;
        respond(more, pad('b', 500, 1000), 1200, 3);
        out.afterMoreCount = names().length;

        currentModelHelper.curCompatClass = 'fam-c';
        refreshLoraCompatIfChanged();
        let refreshed = nextList();
        out.refreshedCompat = refreshed ? refreshed.args.compat : 'no request';
        if (refreshed) {
            respond(refreshed, ['c-1.safetensors'], 1, 0);
        }
        window.__queue = [];
        refreshLoraCompatIfChanged();
        out.unchangedRequests = pendingLists();

        sdLoraBrowser.browser.filter = 'zeta';
        sdLoraBrowser.onServerFilter('zeta');
        let searched = nextList();
        out.searchArgs = searched ? { search: searched.args.search, compat: searched.args.compat } : null;
        if (searched) {
            respond(searched, ['zeta-1.safetensors'], 1, 0);
        }
        sdLoraBrowser.browser.filter = '';
        window.__queue = [];

        sdVAEBrowser.listModelFolderAndFiles('', false, () => {}, 1);
        let vae = nextList();
        out.vaeCompat = vae ? vae.args.compat : 'no request';
        return out;
    });

    check('LoRA listing sends the compat classes by default, before the header exists',
        compatUi.firstCompat == 'fam-a' && compatUi.boxExists && compatUi.boxChecked,
        `compat ${compatUi.firstCompat}, box ${compatUi.boxExists}/${compatUi.boxChecked}`);
    check('hidden rows are reported under the list with a Show all button',
        compatUi.hiddenRow.length == 1 && compatUi.hiddenRow[0].includes('7') && compatUi.hiddenRow[0].includes('fam-a') && compatUi.hiddenButton == 'Show all',
        `${compatUi.hiddenRow.join('|')} / ${compatUi.hiddenButton}`);
    check('the hidden-rows report shows even when the listing is not truncated',
        compatUi.noLoadMoreWhenComplete, 'no Load more button on a complete listing');
    check('Show all stores the choice, unchecks the box, and re-lists without compat',
        compatUi.offCompat == undefined && compatUi.storedAfterShowAll == 'false' && compatUi.boxAfterShowAll == false && compatUi.offCount == 9 && compatUi.hiddenRowAfterShowAll == 0,
        `compat ${compatUi.offCompat}, stored ${compatUi.storedAfterShowAll}, box ${compatUi.boxAfterShowAll}, ${compatUi.offCount} rows, hidden rows ${compatUi.hiddenRowAfterShowAll}`);
    check('turning it back on reuses the filtered page and never serves the unfiltered one',
        compatUi.reenableRequests == 0 && JSON.stringify(compatUi.reenableNames) == JSON.stringify(['on-1.safetensors', 'on-2.safetensors']) && compatUi.storedAfterReenable == 'true',
        `${compatUi.reenableRequests} requests, ${compatUi.reenableNames.join(',')}`);
    check('a different model asks again with its own class, not the cached page',
        compatUi.secondCompat == 'fam-b', `compat ${compatUi.secondCompat}`);
    check('a truncated and filtered listing shows both the window row and the hidden row',
        compatUi.bothRows.length == 2 && compatUi.bothRows[0].includes('Showing') && compatUi.bothRows[1].includes('3') && compatUi.bothRows[1].includes('fam-b'),
        compatUi.bothRows.join(' | '));
    check('Load more keeps the filter its first page used even if the model moved',
        compatUi.moreCompat == 'fam-b' && compatUi.moreOffset == 500 && compatUi.afterMoreCount == 1000,
        `compat ${compatUi.moreCompat}, offset ${compatUi.moreOffset}, ${compatUi.afterMoreCount} rows`);
    check('refreshLoraCompatIfChanged re-lists when the classes changed and not when they did not',
        compatUi.refreshedCompat == 'fam-c' && compatUi.unchangedRequests == 0,
        `refreshed ${compatUi.refreshedCompat}, unchanged requests ${compatUi.unchangedRequests}`);
    check('a server search carries the compat filter too',
        compatUi.searchArgs && compatUi.searchArgs.search == 'zeta' && compatUi.searchArgs.compat == 'fam-c', JSON.stringify(compatUi.searchArgs));
    check('other subtypes never send compat', compatUi.vaeCompat == undefined, `vae compat ${compatUi.vaeCompat}`);
    check('compat filter produced no page errors', pageErrors.length == 0, pageErrors.join('\n'));

    const simplePage = await browser.newPage();
    const simpleErrors = [];
    simplePage.on('pageerror', error => simpleErrors.push(error.message));
    await simplePage.route('**/*', route => {
        let path = new URL(route.request().url()).pathname;
        if (path == '/simple-cap') {
            return route.fulfill({ contentType: 'text/html', body: '<header class="m-header"></header>' });
        }
        return route.fulfill({ contentType: 'text/plain', body: '' });
    });
    await simplePage.goto('http://127.0.0.1/simple-cap');
    await simplePage.addScriptTag({ content: `
        window.__queue = [];
        window.__maxInFlight = 0;
        window.genericRequest = (route, args, ok, depth, err) => {
            window.__queue.push({ route, args, ok, err });
            if (window.__queue.length > window.__maxInFlight) {
                window.__maxInFlight = window.__queue.length;
            }
        };
        window.mGen = { onFrame() {} };
        window.mUI = {
            el(tag, cls, text) {
                let elem = document.createElement(tag);
                elem.className = cls || '';
                if (text) elem.textContent = text;
                return elem;
            },
            confirm() {},
            note() {}
        };
        window.mAutoComplete = { hide() {} };
        window.mState = {
            models: { LoRA: [['epoch_1.safetensors', 'anima/lora'], ['named.safetensors', 'anima/lora']] },
            resetParams() {}
        };
        window.MState = {
            stripModelExt(name) {
                return String(name).endsWith('.safetensors') ? String(name).slice(0, -'.safetensors'.length) : String(name);
            }
        };
    ` });
    await simplePage.addScriptTag({ path: CREATE });
    let simple = await simplePage.evaluate(async () => {
        let done = [];
        mCreate.enrichLoraMetadata((failed, error) => done.push(`${failed}:${error}`));
        mCreate.enrichLoraMetadata((failed, error) => done.push(`${failed}:${error}`));
        let enrich = window.__queue.slice();
        enrich[0].ok({ files: [{ name: 'named.safetensors', title: 'Named', preview_image: '/p.png', trigger_phrase: 'named' }], total: 4000, returned: 1, truncated: true });
        let localBefore = MCreate.filterModels(mCreate.loraList, 'miku').map(model => model.name);
        let searchDone = 0;
        mCreate.searchLoraMetadata('miku', () => { searchDone++; });
        let search = window.__queue[window.__queue.length - 1];
        search.ok({ files: [{ name: 'epoch_1.safetensors', title: 'Hatsune Miku', trigger_phrase: '' }], total: 1, returned: 1, truncated: false });
        let localAfter = MCreate.filterModels(mCreate.loraList, 'miku').map(model => model.name);
        let beforeRepeat = window.__queue.length;
        let repeatDone = 0;
        mCreate.searchLoraMetadata('miku', () => { repeatDone++; });
        let afterRepeat = window.__queue.length;
        let aaCalled = 0;
        let bbCalled = 0;
        mCreate.searchLoraMetadata('aa', () => { aaCalled++; });
        mCreate.searchLoraMetadata('bb', () => { bbCalled++; });
        let aa = window.__queue[window.__queue.length - 2];
        let bb = window.__queue[window.__queue.length - 1];
        aa.ok({ files: [{ name: 'aa-only.safetensors', title: 'Aa Only' }], total: 1, returned: 1, truncated: false });
        let namesAfterStale = mCreate.loraList.map(model => model.name);
        let fetchedAa = mCreate.loraSearchFetched.has('aa');
        let aaCalledAfterStale = aaCalled;
        bb.ok({ files: [{ name: 'bb-only.safetensors', title: 'Bb Only' }], total: 1, returned: 1, truncated: false });
        let namesAfterBb = mCreate.loraList.map(model => model.name);
        let beforeRepeatAa = window.__queue.length;
        let repeatAa = 0;
        mCreate.searchLoraMetadata('aa', () => { repeatAa++; });
        let afterRepeatAa = window.__queue.length;
        window.__queue = [];
        window.__maxInFlight = 0;
        for (let i = 0; i < 6; i++) {
            mCreate.searchLoraMetadata(`term${i}`, () => {});
        }
        let started = window.__queue.length;
        let waiting = mCreate.loraFetchQueue.length;
        let inFlight = mCreate.loraFetchInFlight;
        while (window.__queue.length > 0) {
            let job = window.__queue.shift();
            job.ok({ files: [], total: 0, returned: 0, truncated: false });
        }
        mCreate.loraMetaRootDone = false;
        let errorText = null;
        let failed = null;
        mCreate.enrichLoraMetadata((nextFailed, nextError) => {
            failed = nextFailed;
            errorText = nextError;
        });
        window.__queue[0].err('nope');
        return {
            enrichCount: enrich.length,
            enrich: enrich[0].args,
            done,
            localBefore,
            searchArgs: search.args,
            searchDone,
            localAfter,
            beforeRepeat,
            afterRepeat,
            repeatDone,
            aaCalled,
            aaCalledAfterStale,
            bbCalled,
            fetchedAa,
            namesAfterStale,
            namesAfterBb,
            repeatAa,
            beforeRepeatAa,
            afterRepeatAa,
            started,
            waiting,
            inFlight,
            failed,
            errorText
        };
    });

    check('enrichLoraMetadata issues one capped request and keeps onDone',
        simple.enrichCount == 1 && simple.enrich.limit == 500 && simple.enrich.offset == 0 && simple.enrich.path == ''
        && simple.enrich.depth == 32 && simple.enrich.subtype == 'LoRA' && simple.enrich.search == ''
        && simple.done.join('|') == 'false:|false:',
        JSON.stringify({ count: simple.enrichCount, args: simple.enrich, done: simple.done }));
    check('searchLoraMetadata merges a title-only match and dedupes the term',
        simple.localBefore.length == 0 && simple.searchArgs.search == 'miku' && simple.searchArgs.limit == 500
        && simple.localAfter.includes('epoch_1.safetensors') && simple.searchDone == 1
        && simple.afterRepeat == simple.beforeRepeat && simple.repeatDone == 1,
        JSON.stringify({ before: simple.localBefore, after: simple.localAfter, repeat: simple.repeatDone }));
    check('searchLoraMetadata caches a stale response without calling its waiters',
        simple.aaCalledAfterStale == 0 && simple.fetchedAa == true
        && simple.namesAfterStale.includes('aa-only.safetensors')
        && simple.bbCalled == 1 && simple.aaCalled == 0
        && simple.namesAfterBb.includes('aa-only.safetensors')
        && simple.namesAfterBb.includes('bb-only.safetensors')
        && simple.repeatAa == 1 && simple.afterRepeatAa == simple.beforeRepeatAa,
        `aaCalled ${simple.aaCalledAfterStale}/${simple.aaCalled}; fetched ${simple.fetchedAa}; after stale ${simple.namesAfterStale.join(',')}; after bb ${simple.namesAfterBb.join(',')}; repeat ${simple.repeatAa}`);
    check('LoRA metadata fetches stay at 4 in flight',
        simple.started == 4 && simple.waiting == 2 && simple.inFlight == 4,
        `started ${simple.started}, waiting ${simple.waiting}, in flight ${simple.inFlight}`);
    check('enrichLoraMetadata reports a failure through onDone',
        simple.failed == true && simple.errorText == 'nope',
        `${simple.failed} ${simple.errorText}`);
    check('simple page produced no errors', simpleErrors.length == 0, simpleErrors.join('\n'));
}
finally {
    await browser.close();
}
console.log('verify-model-list-cap: ok');
