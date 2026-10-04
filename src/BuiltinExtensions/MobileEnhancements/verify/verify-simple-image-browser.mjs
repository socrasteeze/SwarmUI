/**
 * /simple machine-image-browser harness. Runs the shipped client with deterministic
 * genericRequest responses. It is opt-in because Playwright is local tooling.
 *
 * Run: node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-image-browser.mjs
 * Set SWARM_CHROMIUM to override Chromium. Set SWARM_SCREENSHOT=1 to save a local review PNG.
 */
import { chromium, webkit } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

let REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
let M = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m`;
let PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAA3ElEQVR4nO3WwU3EMBBG4bdPe6cDOqADcuBMB1AfNJLGOHBBHGBY0Jon5btFceR/PLbi0+3dPWUSJ3ESJ3ESJ3ESJ3ESd14dgP3l6ePj9vz6o89PC68Sn6JfVob/MD3fvV1fwCTfPqshf4i9/pTz7bEPRh4dWE3iJM7rTzn/SW2DkUcHLjJZ2m3WqGUd+DrfNt5mKy9z78K30T9xHOLVJE7iJE7iJE7iJE7iJE7iJE7izjcPj5RJnMRJnMRJnMRJnMRJnMRJnMRJnMRJnMRJnMRJnMRJnMS5OsBvvQEvTB44dH3nYQAAAABJRU5ErkJggg==';
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

let engine = process.env.SWARM_WEBKIT == '1' ? webkit : chromium;
let browser = await engine.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
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
            if (window.__failNext && args.offset == 48) {
                return reject('temporary page error');
            }
            let images = args.path == 'paged-output'
                ? Array.from({ length: 130 }, (_, i) => ({ src: `output-${i}.png`, metadata: '' }))
                : [{ src: 'output.png', metadata: '' }];
            images = images.filter(file => file.src.toLowerCase().includes((args.search || '').toLowerCase()));
            let offset = args.offset || 0;
            let limit = args.limit || images.length;
            return respond({ folders: ['inputs'], files: images.slice(offset, offset + limit), total: images.length,
                next_offset: offset + limit < images.length ? offset + limit : null });
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
                let files = Array.from({ length: 102 }, (_, i) => ({ name: `shot-${i}.png`, path: `E:\\Shots\\shot-${i}.png` }));
                files = files.filter(file => file.name.toLowerCase().includes((args.search || '').toLowerCase()));
                let data = { path, parent: 'E:\\', folders: [{ name: 'Nested', path: 'E:\\Shots\\Nested' }],
                    files: files.slice(args.offset, args.offset + args.limit), total: files.length,
                    next_offset: args.offset + args.limit < files.length ? args.offset + args.limit : null };
                if (args.search == 'late-search') {
                    window.__pending.push(() => callback(data));
                    return;
                }
                return respond(data);
            }
            if (path == 'E:\\Shots\\Nested') {
                return respond({ path, parent: 'E:\\Shots', folders: [], files: [{ name: 'pick.png', path: 'E:\\Shots\\Nested\\pick.png' }], total: 1, next_offset: null });
            }
            if (path == 'folder-pages') {
                let folders = Array.from({ length: 102 }, (_, i) => ({ name: `folder-${i}`, path: `folder-pages\\folder-${i}` }));
                return respond({ path, parent: '', folders, files: [{ name: 'after-folders.png', path: 'folder-pages\\after-folders.png' }],
                    total: 1, next_offset: null });
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
check('Go accepts a Windows path with Unicode, spaces, #, and ampersand', unicodeCall.args.path == 'E:\\A folder\\caf\u00e9 #1 & two' && unicodeCall.args.offset == 0 && unicodeCall.args.limit == 48 && unicodeCall.args.image_page, JSON.stringify(unicodeCall));
await go('\\\\files.example\\media');
check('Go accepts a UNC path', await page.locator('.m-imgbrowser-path').textContent() == '\\\\files.example\\media');

await go('E:\\Shots');
await page.waitForFunction(() => document.querySelectorAll('.m-imgbrowser-tile').length == 48);
await page.getByRole('button', { name: 'Next Page', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-tile-name')?.textContent == 'shot-48.png');
let secondPage = await page.locator('.m-imgbrowser-tile-name').allTextContents();
await page.getByRole('button', { name: 'Next Page', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-tile-name')?.textContent == 'shot-96.png');
let lastPage = await page.locator('.m-imgbrowser-tile-name').allTextContents();
check('Next replaces pages and disables at the final image page', secondPage.length == 48 && new Set(secondPage).size == 48
    && lastPage.length == 6 && await page.getByRole('button', { name: 'Next Page' }).isDisabled(), JSON.stringify({ second: secondPage.length, last: lastPage.length }));
await page.getByRole('button', { name: 'Previous Page', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-tile-name')?.textContent == 'shot-48.png');
await page.getByRole('button', { name: 'Previous Page', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-tile-name')?.textContent == 'shot-0.png');
check('Prev returns to the first page without duplicate tiles', await page.locator('.m-imgbrowser-tile').count() == 48
    && await page.getByRole('button', { name: 'Previous Page' }).isDisabled());
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-tile img')?.src.startsWith('data:image/'));
let previews = await page.evaluate(() => ({ peak: window.__previewPeak, visible: [...document.querySelectorAll('.m-imgbrowser-tile img')].filter(i => i.src.startsWith('data:image/')).length }));
check('lazy previews have a bounded maximum of four requests', previews.peak <= 4 && previews.visible > 0, JSON.stringify(previews));

let fixedBefore = await page.locator('.m-imgbrowser-pager').boundingBox();
await page.locator('.m-imgbrowser-grid').evaluate(grid => { grid.scrollTop = grid.scrollHeight; });
let fixedAfter = await page.locator('.m-imgbrowser-pager').boundingBox();
check('Prev and Next remain fixed while the image grid scrolls', Math.abs(fixedBefore.y - fixedAfter.y) <= 1 && Math.abs(fixedBefore.x - fixedAfter.x) <= 1);
await page.getByRole('button', { name: 'Next Page' }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-page')?.textContent == '2 / 3');
let search = page.getByRole('searchbox', { name: 'Search Filenames' });
await search.fill('SHOT-100');
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-tile-name')?.textContent == 'shot-100.png');
check('filename search reaches images beyond page one and resets the page', await page.locator('.m-imgbrowser-page').textContent() == '1 / 1'
    && await page.locator('.m-imgbrowser-tile').count() == 1 && await page.getByRole('button', { name: 'Previous Page' }).isDisabled());
check('search keeps folder navigation available', await page.getByRole('button', { name: 'Nested', exact: true }).count() == 1);
let searchAfter = await page.locator('.m-imgbrowser-pager').boundingBox();
check('pagination controls do not shift between full and filtered pages', Math.abs(fixedBefore.y - searchAfter.y) <= 1);
await search.fill('late-search');
await page.waitForFunction(() => window.__pending.length == 1);
await search.fill('shot-101');
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-tile-name')?.textContent == 'shot-101.png');
await page.evaluate(() => window.__pending.splice(0).forEach(reply => reply()));
check('late search response cannot overwrite a newer search', await page.locator('.m-imgbrowser-tile-name').textContent() == 'shot-101.png');
await search.fill('no-such-image');
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-status')?.textContent == 'No matching images.');
check('empty search disables both paging buttons and retains navigation', await page.getByRole('button', { name: 'Previous Page' }).isDisabled()
    && await page.getByRole('button', { name: 'Next Page' }).isDisabled() && await page.getByRole('button', { name: 'Nested', exact: true }).count() == 1);
await search.fill('');
await page.waitForFunction(() => document.querySelectorAll('.m-imgbrowser-tile').length == 48);

await go('folder-pages');
await page.waitForFunction(() => document.querySelectorAll('.m-imgbrowser-folder-row').length == 102);
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
check('all folder navigation remains available independently of image pages', true);

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

await page.evaluate(() => { mImageBrowser.source = 'output'; mImageBrowser.path = 'paged-output'; });
await openBrowser();
await page.waitForFunction(() => document.querySelectorAll('.m-imgbrowser-tile').length == 48);
await page.getByRole('button', { name: 'Next Page' }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-tile-name')?.textContent == 'output-48.png');
check('Output uses server pages instead of appending or truncating history', await page.locator('.m-imgbrowser-tile').count() == 48
    && await page.locator('.m-imgbrowser-page').textContent() == '2 / 3');
await page.getByRole('searchbox', { name: 'Search Filenames' }).fill('OUTPUT-120');
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-tile-name')?.textContent == 'output-120.png');
check('Output filename search finds an image past the original page', await page.locator('.m-imgbrowser-tile').count() == 1
    && await page.locator('.m-imgbrowser-page').textContent() == '1 / 1');
await page.getByRole('searchbox', { name: 'Search Filenames' }).fill('');
await page.waitForFunction(() => document.querySelectorAll('.m-imgbrowser-tile').length == 48);
await page.evaluate(() => { window.__failNext = true; });
await page.getByRole('button', { name: 'Next Page' }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-status')?.textContent.includes('temporary page error'));
await page.evaluate(() => { window.__failNext = false; });
await page.getByRole('button', { name: 'Previous Page' }).click();
await page.waitForFunction(() => document.querySelector('.m-imgbrowser-tile-name')?.textContent == 'output-0.png');
check('Prev recovers from a failed page request', await page.locator('.m-imgbrowser-tile').count() == 48);
let requestsBeforeClose = await page.evaluate(() => window.__calls.filter(call => call.route == 'ListImages').length);
await page.getByRole('searchbox', { name: 'Search Filenames' }).fill('pending');
await page.locator('.m-imgbrowser-close').click();
await page.waitForTimeout(300);
check('closing cancels a pending search debounce', requestsBeforeClose == await page.evaluate(() => window.__calls.filter(call => call.route == 'ListImages').length));
await page.evaluate(() => { mImageBrowser.path = ''; });

await page.evaluate(() => { window.__permission = false; });
await openBrowser();
check('permission denial hides Drives but keeps Output', await picker().evaluate(node => ![...node.querySelectorAll('.m-imgbrowser-source')].some(button => button.textContent == 'Drives') && [...node.querySelectorAll('.m-imgbrowser-source')].some(button => button.textContent == 'Output')));

await page.evaluate(() => { window.__permission = true; document.querySelectorAll('.m-sheet-backdrop').forEach(node => node.click()); });
for (let width of [360, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await openBrowser();
    await drives();
    await shots();
    await page.waitForFunction(() => document.querySelectorAll('.m-imgbrowser-tile').length == 48);
    let geometry = await page.evaluate(() => {
        let grid = document.querySelector('.m-imgbrowser-grid');
        let pager = document.querySelector('.m-imgbrowser-pager');
        let before = pager.getBoundingClientRect();
        grid.scrollTop = grid.scrollHeight;
        let after = pager.getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth <= window.innerWidth,
            grid: Math.round(grid.getBoundingClientRect().height), columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
            tileWidth: grid.querySelector('.m-imgbrowser-tile').getBoundingClientRect().width,
            folderWidth: document.querySelector('.m-imgbrowser-folders-panel').getBoundingClientRect().width,
            pagerVisible: before.bottom <= window.innerHeight && before.top >= 0,
            pagerShift: Math.abs(before.y - after.y) };
    });
    check(`responsive ${width}px has no horizontal overflow and a usable grid`, geometry.overflow && geometry.grid >= 96, JSON.stringify(geometry));
    check(`responsive ${width}px has four touch-sized columns and fixed paging`, geometry.columns == 4 && geometry.tileWidth >= 44
        && geometry.pagerVisible && geometry.pagerShift <= 1, JSON.stringify(geometry));
    if (process.env.SWARM_SCREENSHOT == '1') {
        await page.waitForFunction(() => {
            let grid = document.querySelector('.m-imgbrowser-grid');
            let bounds = grid.getBoundingClientRect();
            let visible = [...grid.querySelectorAll('img')].filter(img => {
                let box = img.getBoundingClientRect();
                return box.top < bounds.bottom && box.bottom > bounds.top;
            });
            return visible.length > 0 && visible.every(img => img.complete && img.naturalWidth > 0);
        });
        mkdirSync(`${REPO}/.local/simple-image-browser`, { recursive: true });
        await page.screenshot({ path: `${REPO}/.local/simple-image-browser/browser-${width}.png` });
    }
    await page.locator('.m-imgbrowser-close').click();
    await page.waitForTimeout(300);
}

await page.setViewportSize({ width: 680, height: 420 });
await openBrowser();
await drives();
await shots();
await page.waitForFunction(() => document.querySelectorAll('.m-imgbrowser-tile').length == 48);
let shortViewport = await page.evaluate(() => {
    let pager = document.querySelector('.m-imgbrowser-pager').getBoundingClientRect();
    let grid = document.querySelector('.m-imgbrowser-grid').getBoundingClientRect();
    let search = document.querySelector('.m-imgbrowser-search').getBoundingClientRect();
    return { pagerBottom: pager.bottom, gridHeight: grid.height, searchTop: search.top,
        overflow: document.documentElement.scrollWidth <= window.innerWidth };
});
check('landscape keeps search, images, and sticky paging reachable', shortViewport.pagerBottom <= 420 && shortViewport.gridHeight >= 80
    && shortViewport.searchTop >= 0 && shortViewport.overflow, JSON.stringify(shortViewport));
await page.locator('.m-imgbrowser-close').click();
await page.setViewportSize({ width: 390, height: 844 });

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
await page.waitForFunction(() => document.querySelectorAll('.m-imgbrowser-tile').length == 2);
let readsBeforeRapid = await page.evaluate(() => window.__fullReads);
await picker().evaluate(node => {
    let tiles = node.querySelectorAll('.m-imgbrowser-tile');
    tiles[0].click();
    tiles[1].click();
});
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

// Keep this in a final fresh document. It replaces visualViewport only for this regression, then uses the
// real picker and bottom-sheet path to cover iOS elastic overscroll without changing other harness cases.
await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mImageBrowser != 'undefined');
await page.evaluate(() => {
    let viewport = new EventTarget();
    Object.assign(viewport, { width: 390, height: 844, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    window.__keyboardViewport = viewport;
    mUI.initKeyboardWatch();
});
await openBrowser();
await page.waitForTimeout(300);
let bounce = await page.evaluate(() => {
    let sheet = document.querySelector('.m-sheet').getBoundingClientRect();
    let pager = document.querySelector('.m-imgbrowser-pager').getBoundingClientRect();
    window.__keyboardViewport.offsetTop = -240;
    window.__keyboardViewport.dispatchEvent(new Event('scroll'));
    let bouncedSheet = document.querySelector('.m-sheet').getBoundingClientRect();
    let bouncedPager = document.querySelector('.m-imgbrowser-pager').getBoundingClientRect();
    return { inset: document.documentElement.style.getPropertyValue('--m-kb-inset'),
        sheetShift: Math.abs(sheet.y - bouncedSheet.y), pagerShift: Math.abs(pager.y - bouncedPager.y) };
});
check('iOS bounce offset leaves the image picker inset and positions unchanged', bounce.inset == '0px' && bounce.sheetShift <= 1 && bounce.pagerShift <= 1, JSON.stringify(bounce));
let keyboardInset = await page.evaluate(() => {
    window.__keyboardViewport.height = 600;
    window.__keyboardViewport.offsetTop = 0;
    window.__keyboardViewport.dispatchEvent(new Event('resize'));
    return document.documentElement.style.getPropertyValue('--m-kb-inset');
});
check('keyboard height contraction publishes the covered bottom strip', keyboardInset == '244px', keyboardInset);
let scrolledKeyboardInset = await page.evaluate(() => {
    window.__keyboardViewport.offsetTop = 50;
    window.__keyboardViewport.dispatchEvent(new Event('scroll'));
    return document.documentElement.style.getPropertyValue('--m-kb-inset');
});
check('keyboard viewport scroll reduces the covered bottom strip', scrolledKeyboardInset == '194px', scrolledKeyboardInset);
let dismissedKeyboardInset = await page.evaluate(() => {
    window.__keyboardViewport.height = 844;
    window.__keyboardViewport.offsetTop = -240;
    window.__keyboardViewport.dispatchEvent(new Event('resize'));
    return document.documentElement.style.getPropertyValue('--m-kb-inset');
});
check('keyboard dismissal clears the inset despite a residual bounce offset', dismissedKeyboardInset == '0px', dismissedKeyboardInset);

// Favorites: a full host path saved in the editor opens in Drives; Output paths stay relative.
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => localStorage.removeItem('m_client_img_browser_roots'));
await openBrowser();
await picker().getByRole('button', { name: 'Edit', exact: true }).click();
let editor = page.locator('.m-imgbrowser-roots-edit');
await editor.locator('.m-imgbrowser-add-row .m-imgbrowser-root-label').fill('Shots');
await editor.locator('.m-imgbrowser-add-row .m-imgbrowser-root-path').fill('E:\\Shots\\');
await editor.getByRole('button', { name: 'Add', exact: true }).click();
await editor.locator('.m-imgbrowser-add-row .m-imgbrowser-root-path').fill('/inputs/');
await editor.getByRole('button', { name: 'Add', exact: true }).click();
await editor.getByRole('button', { name: 'Save', exact: true }).click();
let savedRoots = await page.evaluate(() => JSON.parse(localStorage.getItem('m_client_img_browser_roots')));
check('editor saves a full drive path as a Drives favorite without mangling it',
    savedRoots.some(r => r.label == 'Shots' && r.path == 'E:\\Shots' && r.machine), JSON.stringify(savedRoots));
check('editor still normalizes Output favorites and drops duplicates',
    savedRoots.filter(r => r.path == 'inputs' && !r.machine).length == 1, JSON.stringify(savedRoots));
let callsBeforeFavorite = await page.evaluate(() => window.__calls.length);
await picker().locator('.m-imgbrowser-favorites-select').selectOption({ label: 'Shots' });
await page.waitForFunction(count => window.__calls.slice(count).some(call => call.route == 'ListSimpleImageFolder' && call.args.path == 'E:\\Shots'), callsBeforeFavorite);
let favoriteState = await page.evaluate(() => ({
    machine: document.querySelector('.m-imgbrowser').classList.contains('m-imgbrowser-machine'),
    selected: document.querySelector('.m-imgbrowser-favorites-select').selectedOptions[0]?.textContent,
    saveHidden: [...document.querySelectorAll('.m-imgbrowser-favorites .m-imgbrowser-tool')].find(b => b.textContent == 'Save').hidden
}));
check('picking a drive favorite switches to Drives at that folder', favoriteState.machine && favoriteState.selected == 'Shots' && favoriteState.saveHidden, JSON.stringify(favoriteState));
await go('E:\\Shots\\Nested');
await picker().getByRole('button', { name: 'Save Folder to Favorites', exact: true }).click();
let quickSaved = await page.evaluate(() => ({
    roots: JSON.parse(localStorage.getItem('m_client_img_browser_roots')),
    selected: document.querySelector('.m-imgbrowser-favorites-select').selectedOptions[0]?.textContent
}));
check('Save adds the current Drives folder to favorites once', quickSaved.roots.filter(r => r.path == 'E:\\Shots\\Nested' && r.machine && r.label == 'Nested').length == 1
    && quickSaved.selected == 'Nested', JSON.stringify(quickSaved));
await page.evaluate(() => { window.__permission = false; });
await openBrowser();
let noPermissionLabels = await page.evaluate(() => [...document.querySelectorAll('.m-imgbrowser-favorites-select option')].map(o => o.textContent));
check('drive favorites are hidden without browse permission', !noPermissionLabels.includes('Shots') && noPermissionLabels.includes('Output'), JSON.stringify(noPermissionLabels));
await page.evaluate(() => { window.__permission = true; localStorage.removeItem('m_client_img_browser_roots'); });

if (process.env.SWARM_SCREENSHOT == '1') {
    mkdirSync(`${REPO}/.local/simple-image-browser`, { recursive: true });
    await page.screenshot({ path: `${REPO}/.local/simple-image-browser/primary.png`, fullPage: false });
}
await browser.close();
let failed = results.filter(result => !result.pass);
if (process.env.SWARM_SCREENSHOT == '1') {
    let report = '# UI Stability Audit — /simple Image Browser\n'
        + 'Scope: image picker | Viewports: 360, 768, 1024, 1440 | Runtime: ran\n\n'
        + '## Verdict\n' + (failed.length ? 'FIX FIRST' : 'SHIP') + '\n\n'
        + '## Findings\n| # | Check | Status | Severity | Evidence | Fix |\n|---|---|---|---|---|---|\n';
    for (let i = 0; i < results.length; i++) {
        let result = results[i];
        report += `| ${i + 1} | ${result.name} | ${result.pass ? 'PASS' : 'FAIL'} | ${result.pass ? 'N/A' : 'SHIFT'} | Browser harness; browser-360.png | ${result.pass ? 'None' : 'Resolve failed check'} |\n`;
    }
    writeFileSync(`${REPO}/.local/simple-image-browser/ui-stability.md`, report);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
