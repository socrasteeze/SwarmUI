/**
 * /simple Create-panel harness (fork). Two claims, both of the kind that is easy to assert and easy to get
 * wrong:
 *
 * 1. The preview canvas is RESERVED. The block holding the generated images is the same height idle, queued,
 *    generating and done, so nothing below it - the model row, Generate, the prompt box - moves while a
 *    generation runs. Measured as "the Generate button is at the same y in every state", because that is what
 *    the complaint actually was.
 * 2. Starred models sort first. The pickers cap how many rows they render, so on a real library this is what
 *    decides whether a favourite is on screen at all.
 *
 * Runs the REAL shipped source: index.html with its server tokens substituted, the real m.css, and the real
 * m_*.js modules, with the Create panel built directly instead of booting (m_app.js is stubbed out, since
 * there is no server here). site.js/jquery/bootstrap are stubbed; the handful of util.js helpers the panel
 * needs come from the real util.js.
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling rather than
 * part of the CI gate. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-create-panel.mjs
 * Set SWARM_CHROMIUM to override the browser path. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const M = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m`;
const WIDTH = 390, HEIGHT = 844;
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const TOAST = '<div class="center-toast toast-error-box" id="center_toast">'
    + '<div class="toast hide" id="error_toast_box"><div class="toast-body" id="error_toast_content"></div></div></div>';
const html = readFileSync(`${M}/index.html`, 'utf8')
    .replace('[HEADEXTRA]', '')
    .replace('[REMAPS]', '[]')
    .replaceAll('[TOAST]', TOAST)
    .replaceAll('[VARY]', '1');

/** Client modules served from the real tree. m_app.js is deliberately absent - booting needs a server. */
const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_create.js', 'm_images.js', 'm_models.js'];
const FILES = {
    '/js/util.js': `${REPO}/src/wwwroot/js/util.js`,
    '/css/site.css': `${REPO}/src/wwwroot/css/site.css`,
    '/css/themes/modern.css': `${REPO}/src/wwwroot/css/themes/modern.css`,
    '/css/themes/modern_dark.css': `${REPO}/src/wwwroot/css/themes/modern_dark.css`,
};
for (const file of CLIENT) {
    FILES[`/ExtensionFile/MobileEnhancementsExtension/Assets/m/${file}`] = `${M}/${file}`;
}

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path == '/simple') {
        return route.fulfill({ contentType: 'text/html', body: html });
    }
    const file = FILES[path];
    if (file) {
        return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript', body: readFileSync(file, 'utf8') });
    }
    return route.fulfill({ contentType: 'application/javascript', body: '' });
});
// Stands in for site.js: only the handful of globals the Create panel touches, all of them server-facing.
await page.addInitScript(() => {
    window.showError = function (message) { window.__err = message; };
    window.getUserSetting = () => '';
    window.genericRequest = () => {};
    window.makeWSRequest = () => null;
    window.getSession = () => {};
    window.getImageOutPrefix = () => '/View';
    window.getTextSelRange = () => [0, 0];
    window.session_id = 'test';
    window.permissions = { hasPermission: () => true };
});
page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mCreate != 'undefined');
await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mCreate.build(panel);
});

/** y of the first thing below the preview that the user cares about, plus the panel's total height. */
const geometry = () => page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    return {
        generateTop: document.querySelector('.m-generate-button').getBoundingClientRect().top,
        promptTop: document.querySelector('.m-prompt-box').getBoundingClientRect().top,
        previewHeight: document.querySelector('.m-create-preview').getBoundingClientRect().height,
        panelHeight: panel.scrollHeight,
    };
});
/** Feeds the panel one WS frame, exactly as mGen would. */
const frame = (kind, data) => page.evaluate(([k, d]) => mCreate.onFrame(k, d), [kind, data]);

const idle = await geometry();
check('idle: the canvas is already holding real height', idle.previewHeight > 200, `${idle.previewHeight}px`);
check('idle: the placeholder says so', (await page.textContent('.m-preview-canvas-label')) == 'No preview yet');
check('idle: the empty canvas is not pinned to the top of the panel',
    await page.evaluate(() => getComputedStyle(document.querySelector('.m-create-preview')).position == 'static'));

// ---- Queued: Generate tapped, nothing back from the server yet ----
await page.evaluate(() => mCreate.setPending(true));
const queued = await geometry();
check('queued: nothing below the preview moved',
    queued.generateTop == idle.generateTop && queued.promptTop == idle.promptTop,
    `generate ${idle.generateTop} -> ${queued.generateTop}, prompt ${idle.promptTop} -> ${queued.promptTop}`);
check('queued: the panel is the same total height', queued.panelHeight == idle.panelHeight, `${idle.panelHeight} -> ${queued.panelHeight}`);
check('queued: the label switches and the progress bar shows',
    (await page.textContent('.m-preview-canvas-label')) == 'Queued...'
    && await page.evaluate(() => getComputedStyle(document.querySelector('.m-preview-canvas-bar')).visibility == 'visible'));
check('queued: the preview pins itself now that something is happening',
    await page.evaluate(() => getComputedStyle(document.querySelector('.m-create-preview')).position == 'sticky'));

// ---- First frame: one live tile replaces the placeholder ----
await frame('progress', { request_id: 'r1', batch_index: 0, overall_percent: 0.4, preview: PIXEL });
const live = await geometry();
check('generating: nothing below the preview moved',
    live.generateTop == idle.generateTop && live.promptTop == idle.promptTop,
    `generate ${idle.generateTop} -> ${live.generateTop}, prompt ${idle.promptTop} -> ${live.promptTop}`);
check('generating: the preview block is the same height', live.previewHeight == idle.previewHeight, `${idle.previewHeight} -> ${live.previewHeight}`);
check('generating: the placeholder gave way to the grid',
    await page.evaluate(() => getComputedStyle(document.querySelector('.m-preview-canvas')).display == 'none'
        && document.querySelectorAll('.m-preview-cell').length == 1));

// ---- Completed ----
await frame('image', { request_id: 'r1', batch_index: 0, image: PIXEL, metadata: '' });
const done = await geometry();
check('completed: nothing below the preview moved',
    done.generateTop == idle.generateTop && done.promptTop == idle.promptTop,
    `generate ${idle.generateTop} -> ${done.generateTop}, prompt ${idle.promptTop} -> ${done.promptTop}`);

// ---- A 4-image batch: more tiles, same canvas ----
for (let i = 0; i < 4; i++) {
    await frame('progress', { request_id: 'r2', batch_index: i, overall_percent: 0.2, preview: PIXEL });
}
const batch = await geometry();
check('4-up batch: nothing below the preview moved',
    batch.generateTop == idle.generateTop && batch.promptTop == idle.promptTop,
    `generate ${idle.generateTop} -> ${batch.generateTop}, prompt ${idle.promptTop} -> ${batch.promptTop}`);
check('4-up batch: the block is the same height', batch.previewHeight == idle.previewHeight, `${idle.previewHeight} -> ${batch.previewHeight}`);
check('4-up batch: the cells fill the canvas rather than half of it', await page.evaluate(() => {
    let cells = [...document.querySelectorAll('.m-preview-cell')];
    let grid = document.querySelector('.m-preview-grid').getBoundingClientRect().height;
    let rows = cells[0].getBoundingClientRect().height * 2;
    return cells.length == 4 && Math.abs(rows - grid) < 6;
}));

// ---- Interrupt back to a single restored tile ----
await page.evaluate(() => mCreate.clearUnfinished());
const after = await geometry();
check('after an interrupt: still nothing moved',
    after.generateTop == idle.generateTop && after.promptTop == idle.promptTop,
    `generate ${idle.generateTop} -> ${after.generateTop}, prompt ${idle.promptTop} -> ${after.promptTop}`);

// ---- Collapse is the opt-out: it gives the space back on purpose ----
await page.click('.m-preview-toggle');
const collapsed = await geometry();
check('collapsing the preview does hand the space back', collapsed.generateTop < idle.generateTop - 100,
    `generate ${idle.generateTop} -> ${collapsed.generateTop}`);
await page.click('.m-preview-toggle');

// ---- Starred models sort first ----
await page.evaluate(pixel => {
    let models = ['aaa_first.safetensors', 'bbb_middle.safetensors', 'zzz_starred.safetensors', 'zzz_unstarred.safetensors']
        .map(name => ({ name, title: '', trigger_phrase: '', preview_image: pixel }));
    mCreate.loraList = models;
    mCreate.loraMap = new Map(models.map(m => [m.name, m]));
    mCreate.modelList = models;
    mState.starredModels = { 'LoRA': ['zzz_starred.safetensors'], 'Stable-Diffusion': ['zzz_starred.safetensors'] };
    mCreate.openLoraSheet();
}, PIXEL);
const loraRows = await page.evaluate(() => [...document.querySelectorAll('.m-lora-results .m-model-result')]
    .map(row => ({ name: row.querySelector('.m-model-name').textContent, starred: !!row.querySelector('.m-model-star') })));
check('LoRA picker: the starred LoRA is first', loraRows.length == 4 && loraRows[0].name == 'zzz_starred', JSON.stringify(loraRows.map(r => r.name)));
check('LoRA picker: it is marked as starred', !!loraRows[0]?.starred);
check('LoRA picker: everything else keeps its original order',
    loraRows.slice(1).map(r => r.name).join(',') == 'aaa_first,bbb_middle,zzz_unstarred',
    loraRows.slice(1).map(r => r.name).join(','));
check('LoRA picker: only the starred row is marked', loraRows.filter(r => r.starred).length == 1);

// Same list, searched: the sort has to survive filtering, or a search that matches a favourite buries it.
await page.fill('.m-lora-sheet .m-lora-search', 'zzz');
const searched = await page.evaluate(() => [...document.querySelectorAll('.m-lora-results .m-model-result')]
    .map(row => row.querySelector('.m-model-name').textContent));
check('LoRA picker: starred still leads a filtered list', searched.join(',') == 'zzz_starred,zzz_unstarred', searched.join(','));

// The checkpoint sheet uses the same ordering, off its own subtype's star list.
await page.evaluate(() => {
    // Drop the LoRA sheet rather than animating it closed - openSheet's close() is on a 250ms timer.
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mCreate.openModelSheet();
});
const modelRows = await page.evaluate(() => [...document.querySelectorAll('.m-model-results .m-model-result')]
    .map(row => row.querySelector('.m-model-name').textContent));
check('checkpoint picker: starred first there too', modelRows[0] == 'zzz_starred', JSON.stringify(modelRows));

// No stars configured at all must leave the list exactly as the server sorted it.
await page.evaluate(() => { mState.starredModels = {}; });
const unsorted = await page.evaluate(() => mState.starredFirst(mCreate.loraList, 'LoRA').map(m => m.name).join(','));
check('no stars set: the list is returned untouched',
    unsorted == 'aaa_first.safetensors,bbb_middle.safetensors,zzz_starred.safetensors,zzz_unstarred.safetensors', unsorted);

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
