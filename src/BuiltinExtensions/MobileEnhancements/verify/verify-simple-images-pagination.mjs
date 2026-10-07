/** /simple Images-tab explicit pagination, sort, search, stale-request, and layout harness. */
import { chromium, webkit } from 'playwright';
import { mkdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SOURCE = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m_images.js`, 'utf8');
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
    let stored = new Map([['m_client_img_sort', 'Newest first']]);
    Object.defineProperty(window, 'localStorage', { value: { getItem: key => stored.has(key) ? stored.get(key) : null, setItem: (key, value) => stored.set(key, `${value}`) } });
    window.__requests = [];
    window.__warnings = [];
    window.mGen = { onFrame: callback => { window.__frame = callback; } };
    window.mUI = { el: (tag, classes, text = '') => { let el = document.createElement(tag); el.className = classes; el.textContent = text; return el; }, warn: message => window.__warnings.push(message) };
    window.genericRequest = (route, args, success, depth, fail) => window.__requests.push({ route, args, success, fail });
    window.getImageOutPrefix = () => '/View';
});
await page.addScriptTag({ content: SOURCE });
await page.evaluate(() => mImages.build(document.querySelector('.m-panel')));

function files(offset, count) {
    return Array.from({ length: count }, (_, i) => ({ src: `img-${String(offset + i).padStart(3, '0')}.png`, metadata: '' }));
}
let report = await page.evaluate(() => {
    mImages.refresh(true);
    window.__pending = window.__requests.shift();
    return { args: window.__pending.args, label: mImages.sortMode };
});
check('legacy Newest label migrates and sends backend descending Date semantics', report.label == 'Newest First' && report.args.sortBy == 'Date' && report.args.sortReverse == false, JSON.stringify({ label: report.label, args: report.args }));
await page.evaluate(rows => window.__pending.success({ folders: ['zeta', 'Starred', 'alpha', 'beta', 'gamma'], files: rows, total: 125, next_offset: 48 }), files(0, 48));
report = await page.evaluate(() => ({ tiles: document.querySelectorAll('.m-image-tile-cell').length, status: mImages.pageStatus.textContent, columns: getComputedStyle(mImages.grid).gridTemplateColumns.split(' ').length, firstFolder: mImages.folderChips.firstElementChild.textContent }));
check('first image page is 48 square tiles in three columns with Starred first', report.tiles == 48 && report.status == 'Page 1 of 3 · 125' && report.columns == 3 && report.firstFolder == 'Starred', JSON.stringify(report));

let seen = await page.evaluate(() => mImages.entries.map(entry => entry.src));
await page.click('.m-pagination-button:last-child');
report = await page.evaluate(() => { window.__pending = window.__requests.shift(); return window.__pending.args; });
check('Next requests offset 48', report.offset == 48 && report.limit == 48, JSON.stringify(report));
await page.evaluate(rows => window.__pending.success({ folders: [], files: rows, total: 125, next_offset: 96 }), files(48, 48));
seen.push(...await page.evaluate(() => mImages.entries.map(entry => entry.src)));
await page.click('.m-pagination-button:last-child');
await page.evaluate(rows => window.__requests.shift().success({ folders: [], files: rows, total: 125, next_offset: null }), files(96, 29));
seen.push(...await page.evaluate(() => mImages.entries.map(entry => entry.src)));
report = await page.evaluate(() => ({ tiles: document.querySelectorAll('.m-image-tile-cell').length, status: mImages.pageStatus.textContent, next: mImages.nextPage.disabled }));
check('final image page is 29 and traversal has no gaps or repeats', report.tiles == 29 && report.status == 'Page 3 of 3 · 125' && report.next && seen.length == 125 && new Set(seen).size == 125, JSON.stringify(report));

await page.selectOption('.m-images-bar select', 'Name A-Z');
report = await page.evaluate(() => window.__requests.shift().args);
check('Name A-Z uses backend reverse because ListImages defaults descending', report.sortBy == 'Name' && report.sortReverse == true && report.offset == 0, JSON.stringify(report));

await page.fill('.m-images-search', 'needle');
await page.waitForTimeout(180);
report = await page.evaluate(() => window.__requests.shift().args);
check('filename search resets page and passes the direct-file search parameter', report.offset == 0 && report.search == 'needle', JSON.stringify(report));

report = await page.evaluate(() => {
    mImages.search.value = '';
    mImages.loadPage(0);
    let old = window.__requests.shift();
    mImages.folder = 'fresh';
    mImages.loadPage(0);
    let fresh = window.__requests.shift();
    fresh.success({ folders: [], files: [{ src: 'fresh.png', metadata: '' }], total: 1, next_offset: null });
    old.success({ folders: [], files: [{ src: 'stale.png', metadata: '' }], total: 1, next_offset: null });
    old.fail('stale failure');
    return { names: mImages.entries.map(entry => entry.src), warnings: window.__warnings, status: mImages.pageStatus.textContent };
});
check('late success and failure callbacks cannot replace the current folder', report.names.join(',') == 'fresh.png' && report.warnings.length == 0 && report.status == 'Page 1 of 1 · 1', JSON.stringify(report));

report = await page.evaluate(() => {
    mImages.loadPage(1);
    window.__requests.shift().fail('failed page');
    return { names: mImages.entries.map(entry => entry.src), page: mImages.page, loading: mImages.pageLoading };
});
check('failed page navigation preserves the last loaded page', report.names.join(',') == 'fresh.png' && report.page == 0 && !report.loading, JSON.stringify(report));
report = await page.evaluate(() => {
    mImages.refresh(true);
    window.__requests.shift().fail('failed filter');
    return { count: mImages.entries.length, status: mImages.pageStatus.textContent,
        retry: mImages.grid.textContent.includes('Use Refresh to retry.'), disabled: mImages.prevPage.disabled && mImages.nextPage.disabled };
});
check('failed new criteria cannot show images from the old criteria', report.count == 0 && report.status == 'Unavailable' && report.retry && report.disabled, JSON.stringify(report));
await page.evaluate(() => {
    mImages.loadPage(0);
    window.__requests.shift().success({ folders: [], files: [{ src: 'fresh.png', metadata: '' }], total: 1, next_offset: null });
});

report = await page.evaluate(() => {
    mImages.folder = 'root/nested';
    mImages.renderFolders(['one', 'two', 'three', 'four', 'five']);
    let breadcrumb = mImages.breadcrumb.getBoundingClientRect();
    let chips = [...mImages.folderChips.children].map(el => el.getBoundingClientRect());
    let grid = mImages.grid.getBoundingClientRect();
    let cells = [...mImages.grid.querySelectorAll('.m-image-tile-cell')].map(el => el.getBoundingClientRect());
    return { breadcrumbAbove: chips.every(box => breadcrumb.bottom <= box.top + 1), chipGap: mImages.folderChips.clientWidth - Math.max(...chips.map(box => box.right - mImages.folderChips.getBoundingClientRect().left)), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, gridWidth: grid.width, square: cells.every(box => Math.abs(box.width - box.height) <= 1) };
});
check('image folder chips fill the final row under a separate breadcrumb', report.breadcrumbAbove && report.chipGap <= 1 && report.overflow <= 1, JSON.stringify(report));
check('image grid stays square and within the viewport', report.square && report.gridWidth <= 390, JSON.stringify(report));
mkdirSync(`${REPO}/.local/simple-image-tab`, { recursive: true });
await page.screenshot({ path: `${REPO}/.local/simple-image-tab/images-${engine == webkit ? 'webkit' : 'chromium'}.png`, fullPage: true });
await browser.close();
process.exit(failed ? 1 : 0);
