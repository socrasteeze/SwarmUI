/**
 * /simple machine-image-browser harness. Runs the shipped client with deterministic
 * genericRequest responses. It is opt-in because Playwright is local tooling.
 *
 * Run: node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-image-browser.mjs
 * Set SWARM_CHROMIUM to override Chromium. Set SWARM_SCREENSHOT=1 to save a local review PNG.
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

let REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
let M = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m`;
let PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
let TOAST = '<div class="center-toast toast-error-box" id="center_toast"><div class="toast hide" id="error_toast_box"><div class="toast-body" id="error_toast_content"></div></div></div>';
let html = readFileSync(`${M}/index.html`, 'utf8').replace('[HEADEXTRA]', '').replace('[REMAPS]', '[]').replaceAll('[TOAST]', TOAST).replaceAll('[VARY]', '1');
let client = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_coach.js', 'm_enhance.js', 'm_frame_prep.js', 'm_image_browser.js', 'm_create.js', 'm_grid.js', 'm_presets.js', 'm_images.js', 'm_models.js'];
let files = {
    '/js/util.js': `${REPO}/src/wwwroot/js/util.js`,
    '/css/bootstrap.min.css': `${REPO}/src/wwwroot/css/bootstrap.min.css`,
    '/css/site.css': `${REPO}/src/wwwroot/css/site.css`,
    '/css/themes/modern.css': `${REPO}/src/wwwroot/css/themes/modern.css`,
    '/css/themes/modern_dark.css': `${REPO}/src/wwwroot/css/themes/modern_dark.css`
};
for (let file of client) {
    files[`/ExtensionFile/MobileEnhancementsExtension/Assets/m/${file}`] = `${M}/${file}`;
}

let results = [];
function check(name, pass, detail = '') {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

let browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
let page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
page.setDefaultTimeout(5000);
await page.route('**/*', async route => {
    let path = new URL(route.request().url()).pathname;
    if (path == '/simple') {
        return route.fulfill({ contentType: 'text/html', body: html });
    }
    let file = files[path];
    let body = file ? readFileSync(file, 'utf8') : '';
    return route.fulfill({ contentType: file && file.endsWith('.css') ? 'text/css' : 'application/javascript', body });
});
await page.addInitScript(pixel => {
    window.__calls = [];
    window.__pending = [];
    window.__permission = true;
    window.__slowPaths = new Set();
    window.__previewInFlight = 0;
    window.__previewPeak = 0;
    window.__fullReads = 0;
    window.__rootPending = [];
    window.__fullPending = [];
    window.showError = message => { window.__error = message; };
    window.getUserSetting = () => '';
    window.getImageOutPrefix = () => 'View/local';
    window.getTextSelRange = () => [0, 0];
    window.largeCountStringify = value => `${value}`;
    window.session_id = 'simple-image-browser-test';
    window.permissions = { hasPermission: permission => window.__permission && permission == 'browse_server_images' };
    window.getMediaType = path => /\.(png|jpe?g|webp|gif)$/i.test(path) ? 'image' : 'video';
    window.makeWSRequest = () => null;
    window.getSession = () => {};
    window.genericRequest = (route, args, callback, unused, fail) => {
        window.__calls.push({ route, args: JSON.parse(JSON.stringify(args)) });
        let respond = data => setTimeout(() => callback(data), 0);
        let reject = message => setTimeout(() => fail && fail(message), 0);
        if (route == 'ListImages') {
            return respond({ folders: ['inputs'], files: [{ src: 'output.png', metadata: '' }] });
        }
        if (route == 'ListSimpleImageFolder') {
            let path = args.path || '';
            if (path == 'late') {
                window.__pending.push(() => callback({ path: 'late', parent: '', folders: [], files: [{ name: 'late.png', path: 'late\\late.png' }], total: 1, next_offset: null }));
                return;
            }
            if (path == 'error') {
                return reject('read denied');
            }
            if (path == '') {
                if (window.__delayRoot) {
                    window.__rootPending.push(() => callback({ path: '', parent: null, folders: [{ name: 'E:', path: 'E:\\' }], files: [], total: 0, next_offset: null }));
                    return;
                }
                return respond({ path: '', parent: null, folders: [{ name: 'E:', path: 'E:\\' }, { name: 'NAS', path: '\\\\files.example\\media' }, { name: 'Rapid', path: 'rapid' }, { name: 'Failure', path: 'failure' }, { name: 'Hold', path: 'hold' }], files: [], total: 0, next_offset: null });
            }
            if (path == 'E:\\') {
                return respond({ path, parent: '', folders: [{ name: 'Shots', path: 'E:\\Shots' }], files: [], total: 0, next_offset: null });
            }
            if (path == 'E:\\Shots') {
                let files = [];
                for (let i = args.offset; i < Math.min(args.offset + args.limit, 102); i++) {
                    files.push({ name: `shot-${i}.png`, path: `E:\\Shots\\shot-${i}.png` });
                }
                return respond({ path, parent: 'E:\\', folders: [{ name: 'Nested', path: 'E:\\Shots\\Nested' }], files, total: 102, next_offset: args.offset + args.limit < 102 ? args.offset + args.limit : null });
            }
            if (path == 'E:\\Shots\\Nested') {
                return respond({ path, parent: 'E:\\Shots', folders: [], files: [{ name: 'pick.png', path: 'E:\\Shots\\Nested\\pick.png' }], total: 1, next_offset: null });
            }
            if (path == 'folder-pages') {
                let folders = [];
                for (let i = args.offset; i < Math.min(args.offset + args.limit, 102); i++) {
                    folders.push({ name: `folder-${i}`, path: `folder-pages\\folder-${i}` });
                }
                let files = args.offset >= 100 ? [{ name: 'after-folders.png', path: 'folder-pages\\after-folders.png' }] : [];
                return respond({ path, parent: '', folders, files, total: 103, next_offset: args.offset + args.limit < 102 ? args.offset + args.limit : null });
            }
            if (path == 'rapid') {
                return respond({ path, parent: '', folders: [], files: [{ name: 'first.png', path: 'rapid\\first.png' }, { name: 'second.png', path: 'rapid\\second.png' }], total: 2, next_offset: null });
            }
            if (path == 'failure') {
                return respond({ path, parent: '', folders: [], files: [{ name: 'fail.png', path: 'failure\\fail.png' }], total: 1, next_offset: null });
            }
            if (path == 'hold') {
                return respond({ path, parent: '', folders: [], files: [{ name: 'hold.png', path: 'hold\\hold.png' }], total: 1, next_offset: null });
            }
            if (path == 'E:\\A folder\\caf\u00e9 #1 & two') {
                return respond({ path, parent: 'E:\\', folders: [], files: [{ name: 'unicode.png', path: `${path}\\unicode.png` }], total: 1, next_offset: null });
            }
            if (path == '\\\\files.example\\media') {
                return respond({ path, parent: '', folders: [], files: [{ name: 'unc.png', path: '\\\\files.example\\media\\unc.png' }], total: 1, next_offset: null });
            }
            return respond({ path, parent: '', folders: [], files: [], total: 0, next_offset: null });
        }
        if (route == 'ReadSimpleImage') {
            if (args.preview) {
                window.__previewInFlight++;
                window.__previewPeak = Math.max(window.__previewPeak, window.__previewInFlight);
                return setTimeout(() => { window.__previewInFlight--; callback({ image: pixel }); }, 15);
            }
            if (`${args.path}`.includes('fail')) {
                window.__fullReads++;
                return reject('file changed');
            }
            window.__fullReads++;
            if (`${args.path}`.includes('hold')) {
                window.__fullPending.push(() => callback({ image: pixel }));
                return;
            }
            return setTimeout(() => callback({ image: pixel }), 30);
        }
        return respond({});
    };
}, PIXEL);
page.on('pageerror', error => check(`no page error: ${error.message}`, false));
await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mImageBrowser != 'undefined' && typeof mCreate != 'undefined');
await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mCreate.build(panel);
});

/** Open directly so navigation tests do not depend on a prior selection. */
async function openBrowser(onPick = null) {
    await page.evaluate(() => document.querySelectorAll('.m-sheet-backdrop').forEach(node => node.click()));
    await page.waitForFunction(() => document.querySelectorAll('.m-imgbrowser').length == 0);
    await page.evaluate(() => { window.__picked = null; window.__pick = entry => { window.__picked = entry; }; });
    await page.evaluate(() => { mImageBrowser.source = 'output'; mImageBrowser.machinePath = ''; mImageBrowser.open({ title: 'Pick image', onPick: window.__pick }); });
    await page.waitForSelector('.m-imgbrowser');
}
function picker() {
    return page.locator('.m-imgbrowser').last();
}
async function drives() {
    await picker().getByRole('button', { name: 'Drives', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.m-imgbrowser').length == 1 && document.querySelector('.m-imgbrowser-path')?.textContent == 'Drives');
}
async function go(path, enter = false) {
    let callCount = await page.evaluate(() => window.__calls.length);
    let field = picker().locator('.m-imgbrowser-machine-path');
    await field.fill(path);
    if (enter) {
        await field.press('Enter');
    }
    else {
        await picker().getByRole('button', { name: 'Go', exact: true }).click();
    }
    await page.waitForFunction(({ count, expected }) => window.__calls.slice(count).some(call => call.route == 'ListSimpleImageFolder' && call.args.path == expected), { count: callCount, expected: path });
    await page.waitForTimeout(40);
}
async function nested() {
    await picker().getByRole('button', { name: 'E:', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.m-imgbrowser-path')?.textContent == 'E:\\');
    await picker().getByRole('button', { name: 'Shots', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.m-imgbrowser-path')?.textContent == 'E:\\Shots');
    await picker().getByRole('button', { name: 'Nested', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.m-imgbrowser-path')?.textContent == 'E:\\Shots\\Nested');
}
async function shots() {
    await picker().getByRole('button', { name: 'E:', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.m-imgbrowser-path')?.textContent == 'E:\\');
    await picker().getByRole('button', { name: 'Shots', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.m-imgbrowser-path')?.textContent == 'E:\\Shots');
}

await openBrowser();
let source = await page.evaluate(() => ({ output: !!document.querySelector('.m-imgbrowser-source.m-selected'), drives: !![...document.querySelectorAll('.m-imgbrowser-source')].find(b => b.textContent == 'Drives'), phone: !![...document.querySelectorAll('.m-imgbrowser-tool')].find(b => b.textContent == 'From Phone') }));
check('picker shows Output and permission-gated Drives, with phone fallback', source.output && source.drives && source.phone, JSON.stringify(source));
await drives();
check('Drives starts at the drive root', await page.locator('.m-imgbrowser-path').textContent() == 'Drives');
await page.evaluate(() => { window.__delayRoot = true; });
await picker().getByRole('button', { name: 'Output', exact: true }).click();
await drives();
await picker().locator('.m-imgbrowser-machine-path').fill('E:\\A folder\\caf\u00e9 #1 & two');
await picker().getByRole('button', { name: 'Go', exact: true }).click();
await page.evaluate(() => { window.__rootPending.splice(0).forEach(reply => reply()); window.__delayRoot = false; });
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-path')?.textContent == 'E:\\A folder\\caf\u00e9 #1 & two');
check('a delayed Drives root response cannot overwrite typed Go path', await picker().locator('.m-imgbrowser-machine-path').inputValue() == 'E:\\A folder\\caf\u00e9 #1 & two');
await page.waitForTimeout(80);
await page.evaluate(() => { mImageBrowser.machinePath = ''; });
await picker().getByRole('button', { name: 'Output', exact: true }).click();
await drives();
await page.getByRole('button', { name: 'E:', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-path')?.textContent == 'E:\\');
await page.getByRole('button', { name: 'Shots', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-path')?.textContent == 'E:\\Shots');
await page.getByRole('button', { name: 'Nested', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-path')?.textContent == 'E:\\Shots\\Nested');
await page.locator('.m-imgbrowser-up').click();
check('drive, nested-folder, and Up navigation preserve server paths', await page.locator('.m-imgbrowser-path').textContent() == 'E:\\Shots');
await go('E:\\A folder\\caf\u00e9 #1 & two', true);
let unicodeCall = await page.evaluate(() => window.__calls.filter(c => c.route == 'ListSimpleImageFolder' && c.args.path == 'E:\\A folder\\caf\u00e9 #1 & two').at(-1));
check('Go accepts a Windows path with Unicode, spaces, #, and ampersand', unicodeCall.args.path == 'E:\\A folder\\caf\u00e9 #1 & two' && unicodeCall.args.offset == 0 && unicodeCall.args.limit == 100, JSON.stringify(unicodeCall));
await go('\\\\files.example\\media');
check('Go accepts a UNC path', await page.locator('.m-imgbrowser-path').textContent() == '\\\\files.example\\media');

await go('E:\\Shots');
await page.waitForSelector('.m-imgbrowser-more');
let firstPage = await page.locator('.m-imgbrowser-tile').count();
await page.locator('.m-imgbrowser-more').click();
await page.waitForFunction(() => document.querySelectorAll('.m-imgbrowser-tile').length == 102);
let paging = await page.evaluate(() => { let paths = [...document.querySelectorAll('.m-imgbrowser-tile')].map(tile => tile.dataset.path); return { unique: new Set(paths).size, count: paths.length, calls: window.__calls.filter(c => c.route == 'ListSimpleImageFolder' && c.args.path == 'E:\\Shots').map(c => c.args.offset) }; });
check('Load More appends exactly one second page without duplicate files', firstPage == 100 && paging.count == 102 && paging.unique == 102 && JSON.stringify(paging.calls.slice(-2)) == '[0,100]', JSON.stringify(paging));
await page.waitForTimeout(160);
let previews = await page.evaluate(() => ({ peak: window.__previewPeak, visible: [...document.querySelectorAll('.m-imgbrowser-tile img')].filter(i => i.src.startsWith('data:image/')).length }));
check('lazy previews have a bounded maximum of four requests', previews.peak <= 4, JSON.stringify(previews));

await go('folder-pages');
await page.waitForSelector('.m-imgbrowser-more');
await page.locator('.m-imgbrowser-more').click();
await page.waitForFunction(() => [...document.querySelectorAll('.m-imgbrowser-folder-row')].some(row => row.textContent.includes('folder-101')) && [...document.querySelectorAll('.m-imgbrowser-tile-name')].some(name => name.textContent == 'after-folders.png'));
let hierarchy = await page.evaluate(() => ({
    body: !!document.querySelector('.m-imgbrowser-body'),
    folders: !!document.querySelector('.m-imgbrowser-folders-panel .m-imgbrowser-folders'),
    images: !!document.querySelector('.m-imgbrowser-images-panel .m-imgbrowser-grid'),
    chips: document.querySelectorAll('.m-imgbrowser .m-folder-chip').length,
    longName: [...document.querySelectorAll('.m-imgbrowser-folder-row')].some(row => row.textContent.includes('folder-101'))
}));
check('directory layout uses panels and rows without folder chips', hierarchy.body && hierarchy.folders && hierarchy.images && hierarchy.chips == 0 && hierarchy.longName, JSON.stringify(hierarchy));
await page.getByRole('button', { name: 'folder-101', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-path')?.textContent == 'folder-pages\\folder-101');
check('Load More appends later folders and makes the final folder navigable', true);

await page.evaluate(() => { document.querySelector('.m-imgbrowser-machine-path').value = 'late'; [...document.querySelectorAll('.m-imgbrowser-tool')].find(button => button.textContent == 'Go').click(); });
await page.waitForFunction(() => window.__pending.length == 1);
await go('E:\\Shots\\Nested');
await page.evaluate(() => window.__pending.splice(0).forEach(reply => reply()));
await page.waitForTimeout(40);
check('late folder response cannot replace newer navigation', await page.locator('.m-imgbrowser-path').textContent() == 'E:\\Shots\\Nested');
await page.locator('.m-imgbrowser-close').click();
await page.waitForTimeout(320);
await page.evaluate(() => window.__pending.splice(0).forEach(reply => reply()));
check('closing the picker prevents late responses from attaching a selection', await page.evaluate(() => !window.__picked));

await openBrowser();
await drives();
await picker().getByRole('button', { name: 'Hold', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-path')?.textContent == 'hold');
await picker().locator('.m-imgbrowser-tile').click();
await page.waitForFunction(() => window.__fullPending.length == 1);
await page.evaluate(() => document.querySelectorAll('.m-sheet-backdrop').item(document.querySelectorAll('.m-sheet-backdrop').length - 1).click());
await page.evaluate(() => window.__fullPending.splice(0).forEach(reply => reply()));
await page.waitForTimeout(300);
check('backdrop dismissal cancels a late full-image read', await page.evaluate(() => !window.__picked));

await openBrowser();
await drives();
await nested();
await page.locator('.m-imgbrowser-tile').click();
await page.waitForTimeout(320);
let directPick = await page.evaluate(() => window.__picked);
check('machine image selection reads original data and never stores its filesystem path', directPick?.kind == 'data' && directPick?.value == PIXEL, JSON.stringify(directPick));

await openBrowser();
await drives();
await page.getByRole('button', { name: 'Failure', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-path')?.textContent == 'failure');
await page.locator('.m-imgbrowser-tile').click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-status')?.textContent.includes('Try again.'));
let retryable = await page.locator('.m-imgbrowser-tile').isDisabled().then(disabled => !disabled);
await page.locator('.m-imgbrowser-tile').click();
await page.waitForTimeout(40);
check('failed full image read keeps the picker open and re-enables retry', retryable && await page.locator('.m-imgbrowser').count() == 1);
await page.locator('.m-imgbrowser-close').click();
await page.waitForTimeout(320);

await page.evaluate(() => { window.__picked = null; mImageBrowser.machinePath = ''; mCreate.openPromptImagePicker(); });
await page.getByRole('button', { name: /Browse Folders/i }).click();
await drives();
await nested();
await page.locator('.m-imgbrowser-tile').click();
await page.waitForTimeout(320);
let promptPick = await page.evaluate(() => ({ image: mState.promptImages.at(-1), output: mState.buildGenInput().promptimages }));
check('Create prompt picker stores data entries and sends data, not a filesystem path', promptPick.image?.kind == 'data' && promptPick.image?.value == PIXEL && `${promptPick.output}`.includes(PIXEL) && !`${promptPick.output}`.includes('E:\\'), JSON.stringify(promptPick));

await page.evaluate(() => { mImageBrowser.machinePath = ''; mCreate.openFramePicker(mCreate.startFrameSlot); });
await drives();
await nested();
await page.locator('.m-imgbrowser-tile').click();
await page.waitForTimeout(320);
let framePick = await page.evaluate(() => ({ init: mState.initImage, value: mState.buildGenInput().initimage }));
check('Create start-frame picker stores original data and sends initimage', framePick.init?.kind == 'data' && framePick.value == PIXEL, JSON.stringify(framePick));

await page.evaluate(() => { mImageBrowser.machinePath = ''; mCreate.openFramePicker(mCreate.endFrameSlot); });
await drives();
await nested();
await picker().locator('.m-imgbrowser-tile').click();
await page.waitForTimeout(320);
let endFramePick = await page.evaluate(() => ({ end: mState.videoEndImage, value: mState.buildGenInput().videoendimage }));
check('Create end-frame picker stores original data and sends videoendimage', endFramePick.end?.kind == 'data' && endFramePick.value == PIXEL, JSON.stringify(endFramePick));

await openBrowser();
let upload = page.locator('.m-imgbrowser input[type="file"]');
await upload.setInputFiles({ name: 'phone.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
await page.waitForTimeout(60);
let phonePick = await page.evaluate(() => window.__picked);
check('phone fallback remains a data entry path', phonePick?.kind == 'data' && `${phonePick.value}`.startsWith('data:image/png'), JSON.stringify(phonePick));

await page.evaluate(() => { window.__permission = false; });
await openBrowser();
check('permission denial hides Drives but keeps Output', await picker().evaluate(node => ![...node.querySelectorAll('.m-imgbrowser-source')].some(button => button.textContent == 'Drives') && [...node.querySelectorAll('.m-imgbrowser-source')].some(button => button.textContent == 'Output')));

await page.evaluate(() => { window.__permission = true; document.querySelectorAll('.m-sheet-backdrop').forEach(node => node.click()); });
for (let width of [360, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await openBrowser();
    await drives();
    await shots();
    let geometry = await page.evaluate(() => { let sheet = document.querySelector('.m-sheet-content') || document.querySelector('.m-imgbrowser'); let grid = document.querySelector('.m-imgbrowser-grid'); return { overflow: document.documentElement.scrollWidth <= window.innerWidth, grid: Math.round(grid.getBoundingClientRect().height), sheetTop: Math.round(sheet.getBoundingClientRect().top) }; });
    check(`responsive ${width}px has no horizontal overflow and a usable grid`, geometry.overflow && geometry.grid >= 96, JSON.stringify(geometry));
    await page.locator('.m-imgbrowser-close').click();
    await page.waitForTimeout(300);
}

// Run this race in a fresh document. Earlier cases deliberately leave delayed callbacks and closing sheets
// behind, which is useful for their own guards but not valid setup for the independent dual-tap contract.
await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mImageBrowser != 'undefined' && typeof mCreate != 'undefined');
await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mCreate.build(panel);
    mCreate.openPromptImagePicker();
});
await page.getByRole('button', { name: /Browse Folders/i }).click();
await drives();
await picker().getByRole('button', { name: 'Rapid', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-path')?.textContent == 'rapid');
let readsBeforeRapid = await page.evaluate(() => window.__fullReads);
await picker().locator('.m-imgbrowser-tile').nth(0).click();
await picker().locator('.m-imgbrowser-tile').nth(1).click();
await page.waitForFunction(() => mState.promptImages.length == 1);
let rapid = await page.evaluate(() => ({ reads: window.__fullReads, images: mState.promptImages.length }));
check('rapid double selection allows one full read and one attachment', rapid.reads == readsBeforeRapid + 1 && rapid.images == 1, JSON.stringify(rapid));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mCreate != 'undefined' && typeof mFramePrep != 'undefined');
let frameAspect = await page.evaluate(pixel => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mState.presets = [
        { title: 'minimax/FL2VA', param_map: { videomodel: 'minimax/fl2va', aspectratio: '1:1' } },
        { title: 'minimax/Wide FL2VA', param_map: { videomodel: 'minimax/fl2va', aspectratio: '16:9' } },
        { title: 'krea/Image', param_map: { model: 'krea/image', aspectratio: '1:1' } },
        { title: 'minimax/FL2VA_360_Orbit_Eros', param_map: { videomodel: 'minimax/fl2va', aspectratio: '1:1' } }
    ];
    mState.activePresets = ['minimax/FL2VA'];
    mCreate.build(panel);
    mCreate.startFrameSlot.setEntry({ kind: 'data', value: pixel, width: 900, height: 1200 });
    mCreate.render();
    let attached = mCreate.ratioRow.style.display != 'none';
    mCreate.presetSelect.value = 'krea/Image';
    mCreate.presetSelect.dispatchEvent(new Event('change'));
    mCreate.render();
    let unrelatedHidden = mCreate.ratioRow.style.display == 'none';
    mCreate.presetSelect.value = 'minimax/FL2VA';
    mCreate.presetSelect.dispatchEvent(new Event('change'));
    mCreate.render();
    let returned = mCreate.ratioRow.style.display != 'none';
    mCreate.startFrameSlot.setEntry(null);
    mCreate.render();
    return { attached, unrelatedHidden, returned, clearedHidden: mCreate.ratioRow.style.display == 'none' };
}, PIXEL);
check('Start alone exposes ratio actions without changing prompt images', frameAspect.attached, JSON.stringify(frameAspect));
check('ratio actions follow preset changes with the same Start frame', frameAspect.unrelatedHidden && frameAspect.returned, JSON.stringify(frameAspect));
check('clearing Start hides ratio actions when no prompt images remain', frameAspect.clearedHidden, JSON.stringify(frameAspect));

let measurementRace = await page.evaluate(pixel => {
    let originalMeasure = mCreate.measureEntry;
    let finish;
    mCreate.measureEntry = (entry, callback) => { finish = callback; };
    mCreate.startFrameSlot.setEntry({ kind: 'data', value: pixel });
    mCreate.presetSelect.value = 'minimax/Wide FL2VA';
    mCreate.presetSelect.dispatchEvent(new Event('change'));
    finish({ w: 900, h: 1200, ratio: 0.75 });
    mCreate.measureEntry = originalMeasure;
    return { aspect: mState.buildGenInput().aspectratio, pinned: mState.aspectPinned };
}, PIXEL);
check('preset selection cancels an earlier Start measurement', measurementRace.aspect == '16:9' && !measurementRace.pinned, JSON.stringify(measurementRace));

let scalingRace = await page.evaluate(async pixel => {
    mCreate.presetSelect.value = 'minimax/FL2VA_360_Orbit_Eros';
    mCreate.presetSelect.dispatchEvent(new Event('change'));
    let originalScale = mFramePrep.scaleEntry;
    let finish;
    mFramePrep.scaleEntry = () => new Promise(resolve => { finish = resolve; });
    mCreate.startFrameSlot.setEntry({ kind: 'data', value: pixel });
    mCreate.presetSelect.value = 'minimax/Wide FL2VA';
    mCreate.presetSelect.dispatchEvent(new Event('change'));
    finish({ kind: 'data', value: pixel, width: 768, height: 1024 });
    await Promise.resolve();
    mFramePrep.scaleEntry = originalScale;
    return { aspect: mState.buildGenInput().aspectratio, pinned: mState.aspectPinned };
}, PIXEL);
check('preset selection cancels aspect snapping after an earlier Start scale', scalingRace.aspect == '16:9' && !scalingRace.pinned, JSON.stringify(scalingRace));

if (process.env.SWARM_SCREENSHOT == '1') {
    mkdirSync(`${REPO}/.local/simple-image-browser`, { recursive: true });
    await page.screenshot({ path: `${REPO}/.local/simple-image-browser/primary.png`, fullPage: false });
}
await browser.close();
let failed = results.filter(result => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
