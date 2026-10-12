/** /simple Models-tab pagination, sorting, stale-request, and layout harness. */
import { chromium, webkit } from 'playwright';
import { mkdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MODELS = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m_models.js`, 'utf8');
const CREATE = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m_create.js`, 'utf8');
const CSS = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m.css`, 'utf8');
const engine = process.env.SWARM_WEBKIT == '1' ? webkit : chromium;
const browser = await engine.launch(engine == chromium && process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
let failed = false;
function check(name, pass, detail = '') {
    failed ||= !pass;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}
page.on('pageerror', error => check(`no page errors: ${error.message}`, false));
await page.setContent('<style>:root{--background:#111;--background-panel:#222;--text:#eee;--text-soft:#aaa;--border-color:#555;--emphasis:#85f}</style><main><section class="m-panel m-tab-active"></section></main>');
await page.addStyleTag({ content: CSS });
await page.evaluate(() => {
    window.__requests = [];
    window.__warnings = [];
    let stored = new Map();
    Object.defineProperty(window, 'localStorage', { value: { getItem: key => stored.has(key) ? stored.get(key) : null, setItem: (key, value) => stored.set(key, `${value}`) } });
    window.mUI = {
        el: (tag, classes, text = '') => { let el = document.createElement(tag); el.className = classes; el.textContent = text; return el; },
        modelThumb: model => model.preview ? Object.assign(document.createElement('img'), { src: model.preview }) : null,
        starBadge: () => null,
        modelText: model => { let wrap = document.createElement('div'); wrap.className = 'm-model-text'; let name = document.createElement('div'); name.className = 'm-model-name'; name.textContent = model.name; wrap.appendChild(name); return wrap; },
        modelName: name => name, modelLines: model => ({ primary: model.name }), note: () => {}, warn: message => window.__warnings.push(message), openSheet: () => () => {}
    };
    window.mState = { params: {}, models: {}, modelClasses: {}, refreshUserData: () => {}, isStarred: () => false, onChange: callback => window.__stateChanged = callback, starredFirst: files => [...files].sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0)), getLoras: () => [], setLoras: () => {}, changed: () => {} };
    window.MState = { sameModel: (a, b) => a == b, stripModelExt: name => name };
    window.mCreate = { loraList: null, modelList: null, insertTriggerPhrase: () => {}, indexLoras: () => {}, enrichLoraMetadata: done => done(), buildCountRow: (shown, total) => mUI.el('div', 'm-list-count', `${shown}/${total}`) };
    window.permissions = { hasPermission: () => false };
    window.genericRequest = (route, args, success, depth, fail) => window.__requests.push({ route, args, success, fail });
});
await page.addScriptTag({ content: CREATE.replace(/mCreate = new MCreate\(\);[\s\S]*$/, '') });
await page.addScriptTag({ content: MODELS });
await page.evaluate(() => { mModels.build(document.querySelector('.m-panel')); mModels.refresh(); });
let report = await page.evaluate(() => {
    let request = window.__requests.shift();
    let files = Array.from({ length: 125 }, (_, i) => ({ name: `Model-${String(i).padStart(3, '0')}`, local: false, starred: i == 124 }));
    request.success({ files, folders: ['anima', 'character', 'trained', 'style', 'concepts'] });
    return { cards: document.querySelectorAll('.m-model-card').length, status: mModels.pageStatus.textContent, prev: mModels.prevPage.disabled, next: mModels.nextPage.disabled, first: document.querySelector('.m-model-name').textContent };
});
check('first folder page is explicit, bounded, and favourites-first', report.cards == 48 && report.status == 'Page 1 of 3 · 125' && report.prev && !report.next && report.first == 'Model-124', JSON.stringify(report));
let seen = await page.evaluate(() => [...document.querySelectorAll('.m-model-name')].map(el => el.textContent));
await page.click('.m-pagination-button:last-child');
seen.push(...await page.evaluate(() => [...document.querySelectorAll('.m-model-name')].map(el => el.textContent)));
await page.click('.m-pagination-button:last-child');
seen.push(...await page.evaluate(() => [...document.querySelectorAll('.m-model-name')].map(el => el.textContent)));
report = await page.evaluate(() => ({ cards: document.querySelectorAll('.m-model-card').length, status: mModels.pageStatus.textContent, next: mModels.nextPage.disabled }));
check('Next reaches the final folder page', report.cards == 29 && report.status == 'Page 3 of 3 · 125' && report.next, JSON.stringify(report));
check('page traversal reaches every row once', seen.length == 125 && new Set(seen).size == 125, `rows=${seen.length}, unique=${new Set(seen).size}`);
report = await page.evaluate(() => {
    localStorage.setItem('models_Stable-Diffusion_sort_by', 'DateModified');
    localStorage.setItem('models_Stable-Diffusion_sort_reverse', 'true');
    mModels.page = 0;
    mModels.refresh();
    let request = window.__requests.shift();
    return { sortBy: request.args.sortBy, reverse: request.args.sortReverse, selected: mModels.sortSelect.value, pressed: mModels.sortReverse.getAttribute('aria-pressed') };
});
check('Models tab reads Classic sort keys and sends them to ListModels', report.sortBy == 'DateModified' && report.reverse && report.selected == 'DateModified' && report.pressed == 'true', JSON.stringify(report));
report = await page.evaluate(() => {
    localStorage.setItem('models_LoRA_sort_by', 'Title');
    localStorage.setItem('models_LoRA_sort_reverse', 'false');
    mModels.subtype = 'LoRA';
    mModels.refresh();
    let request = window.__requests.pop();
    return { sortBy: request.args.sortBy, reverse: request.args.sortReverse };
});
check('checkpoint and LoRA sort preferences remain independent', report.sortBy == 'Title' && !report.reverse, JSON.stringify(report));
report = await page.evaluate(() => {
    mModels.refresh();
    let oldRequest = window.__requests.shift();
    mModels.folder = 'fresh';
    mModels.refresh();
    let freshRequest = window.__requests.shift();
    freshRequest.success({ files: [{ name: 'fresh', local: false }], folders: [] });
    oldRequest.success({ files: [{ name: 'stale', local: false }], folders: [] });
    oldRequest.fail('stale failure');
    return { names: [...document.querySelectorAll('.m-model-name')].map(el => el.textContent), warnings: window.__warnings };
});
check('stale folder callbacks stay inert', report.names.join(',') == 'fresh' && report.warnings.length == 0, JSON.stringify(report));
report = await page.evaluate(async () => {
    mModels.refresh();
    let oldRequest = window.__requests.pop();
    mModels.search.value = 'needle';
    mModels.search.dispatchEvent(new Event('input', { bubbles: true }));
    oldRequest.success({ files: [{ name: 'old', local: false }], folders: [] });
    mCreate.loraList = [{ name: 'needle', local: false }];
    await new Promise(resolve => setTimeout(resolve, 180));
    return [...document.querySelectorAll('.m-model-name')].map(el => el.textContent);
});
check('search invalidates an in-flight folder response during debounce', report.join(',') == 'needle', JSON.stringify(report));
report = await page.evaluate(() => {
    mModels.folder = 'root/nested';
    mModels.renderFolders(['one', 'two', 'three', 'four', 'five']);
    let breadcrumb = mModels.breadcrumb.getBoundingClientRect();
    let chips = [...mModels.folderChips.children].map(el => el.getBoundingClientRect());
    let card = mModels.buildCard({ name: 'A very long model name that must stay bounded and not make one card taller than its peers', local: false });
    mModels.grid.innerHTML = '';
    mModels.grid.appendChild(card);
    return { breadcrumbAbove: chips.every(box => breadcrumb.bottom <= box.top + 1), chipGap: mModels.folderChips.clientWidth - Math.max(...chips.map(box => box.right - mModels.folderChips.getBoundingClientRect().left)), placeholderSquare: Math.abs(card.querySelector('.m-model-card-placeholder').clientWidth - card.querySelector('.m-model-card-placeholder').clientHeight), title: card.title, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
});
check('breadcrumb is separate and folder chips fill the final row', report.breadcrumbAbove && report.chipGap <= 1 && report.overflow <= 1, JSON.stringify(report));
check('missing previews reserve a square and full text remains accessible', report.placeholderSquare <= 1 && report.title.includes('A very long'), JSON.stringify(report));
report = await page.evaluate(() => {
    permissions.hasPermission = () => true;
    mModels.grid.innerHTML = '';
    for (let i = 0; i < 8; i++) {
        mModels.grid.appendChild(mModels.buildCard({ name: `card-${i}`, local: i % 2 == 0, preview: i % 3 == 0 ? 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==' : null }));
    }
    let heights = [...document.querySelectorAll('.m-model-card')].map(card => card.getBoundingClientRect().height);
    return { min: Math.min(...heights), max: Math.max(...heights) };
});
check('local, remote, preview, and no-preview cards keep one height across rows', Math.abs(report.max - report.min) <= 1, JSON.stringify(report));
report = await page.evaluate(() => {
    mModels.renderPage([{ name: 'only', local: false }]);
    return { hidden: mModels.pager.hidden, display: getComputedStyle(mModels.pager).display };
});
check('single-page results hide the pager from layout', report.hidden && report.display == 'none', JSON.stringify(report));
report = await page.evaluate(() => {
    mState.models = {
        'Stable-Diffusion': [['nested/anima.safetensors', 'anima'], ['flux.safetensors', 'flux']],
        'LoRA': [['nested/needle.safetensors', 'anima/lora'], ['other/needle.safetensors', 'flux/lora'], ['unclassified.safetensors', null]]
    };
    mState.modelClasses = { 'anima': { name: 'Anima' }, 'flux': { name: 'Flux' }, 'anima/lora': { name: 'Anima LoRA' }, 'flux/lora': { name: 'Flux LoRA' } };
    window.__stateChanged();
    return [...mModels.architectureSelect.options].map(option => option.textContent);
});
check('architecture options populate when the boot inventory arrives late', report.includes('Anima LoRA') && report.includes('Flux LoRA') && report.includes('Unknown'), JSON.stringify(report));
report = await page.evaluate(() => {
    mCreate.loraList = [{ name: 'nested/needle.safetensors', local: false }, { name: 'other/needle.safetensors', local: false, starred: true }, { name: 'unclassified.safetensors', local: false }];
    mModels.search.value = '';
    mModels.page = 5;
    mModels.architectureSelect.value = 'anima/lora';
    mModels.architectureSelect.dispatchEvent(new Event('change'));
    return { names: [...document.querySelectorAll('.m-model-name')].map(el => el.textContent), page: mModels.page, folders: mModels.folderChips.style.display, selected: mModels.architectureSelect.value };
});
check('architecture alone finds nested LoRAs using the uncapped index and resets pagination', report.names.join(',') == 'nested/needle.safetensors' && report.page == 0 && report.folders == 'none' && report.selected == 'anima/lora', JSON.stringify(report));
report = await page.evaluate(() => {
    mModels.search.value = 'other';
    mModels.refresh();
    return { cards: document.querySelectorAll('.m-model-card').length, pager: mModels.pager.hidden, count: document.querySelector('.m-models-search-count').textContent };
});
check('text search intersects architecture and excludes starred models of other architectures', report.cards == 0 && report.pager && report.count == '0/0', JSON.stringify(report));
report = await page.evaluate(() => {
    mModels.search.value = '';
    mModels.architectureSelect.value = '__unknown__';
    mModels.architectureSelect.dispatchEvent(new Event('change'));
    return [...document.querySelectorAll('.m-model-name')].map(el => el.textContent);
});
check('Unknown keeps unclassified models reachable', report.join(',') == 'unclassified.safetensors', JSON.stringify(report));
report = await page.evaluate(() => {
    mCreate.modelList = Array.from({ length: 65 }, (_, i) => ({ name: `nested/checkpoint-${String(i).padStart(3, '0')}`, local: false, architecture: 'anima' }));
    mCreate.modelList.push({ name: 'flux', architecture: 'flux', local: false });
    mModels.toggle.querySelector('[data-subtype="Stable-Diffusion"]').click();
    let initial = mModels.architectureSelect.value;
    mModels.architectureSelect.value = 'anima';
    mModels.architectureSelect.dispatchEvent(new Event('change'));
    let first = { cards: document.querySelectorAll('.m-model-card').length, status: mModels.pageStatus.textContent };
    mModels.nextPage.click();
    return { initial, first, last: document.querySelectorAll('.m-model-card').length, status: mModels.pageStatus.textContent };
});
check('checkpoint architecture is independent and filtered results retain every page', report.initial == '' && report.first.cards == 48 && report.first.status == 'Page 1 of 2 · 65' && report.last == 17 && report.status == 'Page 2 of 2 · 65', JSON.stringify(report));
report = await page.evaluate(() => {
    mModels.toggle.querySelector('[data-subtype="LoRA"]').click();
    let restored = mModels.architectureSelect.value;
    window.__requests = [];
    mModels.architectureSelect.value = '';
    mModels.architectureSelect.dispatchEvent(new Event('change'));
    let request = window.__requests.pop();
    request.success({ files: [{ name: 'folder-row', local: false }], folders: ['child'] });
    return { restored, path: request.args.path, folder: mModels.folder, names: [...document.querySelectorAll('.m-model-name')].map(el => el.textContent), folders: mModels.folderChips.style.display };
});
check('switching subtypes restores the filter and All Architectures restores folder browsing', report.restored == '__unknown__' && report.path == report.folder && report.names.join(',') == 'folder-row' && report.folders == '', JSON.stringify(report));
for (let width of [360, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    report = await page.evaluate(() => {
        let select = mModels.architectureSelect.getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, height: select.height, label: mModels.architectureSelect.getAttribute('aria-label') };
    });
    check(`architecture dropdown fits ${width}px and has an accessible label and touch target`, report.overflow <= 1 && report.height >= 44 && report.label == 'Architecture', JSON.stringify(report));
}
mkdirSync(`${REPO}/.local/simple-model-browser`, { recursive: true });
await page.screenshot({ path: `${REPO}/.local/simple-model-browser/models-${engine == webkit ? 'webkit' : 'chromium'}.png`, fullPage: true });
await browser.close();
process.exit(failed ? 1 : 0);
