/**
 * /simple Create-panel harness (fork). It guards the controls and geometry that are easy to assert and easy
 * to get wrong:
 *
 * 1. The preview canvas is RESERVED. The block holding the generated images is the same height idle, queued,
 *    generating and done, so nothing below it - the model row, Generate, the prompt box - moves while a
 *    generation runs. Measured as "the Generate button is at the same y in every state", because that is what
 *    the complaint actually was.
 * 2. Starred models sort first. The pickers cap how many rows they render, so on a real library this is what
 *    decides whether a favourite is on screen at all.
 * 3. The compact priority controls keep their contracts: Random seed expansion, one final-resolution picker,
 *    paired architecture/preset picklists, exact 0.05 LoRA weights, and TagDex browse-to-prompt insertion.
 * 4. Deleting the selected genpage image chooses the newest surviving image from the current-session batch,
 *    or clears the canvas when none survives. The shipped helper is extracted rather than copied.
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
const TAGDEX = `${REPO}/src/BuiltinExtensions/TagDex/Assets`;
const OUTPUT_HISTORY = `${REPO}/src/wwwroot/js/genpage/gentab/outputhistory.js`;
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
    '/ExtensionFile/TagDexExtension/Assets/tagdex_core.js': `${TAGDEX}/tagdex_core.js`,
    '/ExtensionFile/TagDexExtension/Assets/m_tagdex.js': `${TAGDEX}/m_tagdex.js`,
    '/ExtensionFile/TagDexExtension/Assets/m_tagdex.css': `${TAGDEX}/m_tagdex.css`,
};
for (const file of CLIENT) {
    FILES[`/ExtensionFile/MobileEnhancementsExtension/Assets/m/${file}`] = `${M}/${file}`;
}

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** Pulls one free function from shipped JS by brace matching. */
function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) {
        throw new Error(`function ${name} not found`);
    }
    let brace = src.indexOf('{', start);
    let depth = 0;
    for (let i = brace; i < src.length; i++) {
        if (src[i] == '{') {
            depth++;
        }
        else if (src[i] == '}') {
            depth--;
            if (depth == 0) {
                return src.slice(start, i + 1);
            }
        }
    }
    throw new Error(`unbalanced function ${name}`);
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
    window.genericRequest = (route, args, callback) => {
        if (route == 'TagDexListSources') {
            callback({
                sources: [
                    { id: 'danbooru_character', label: 'Danbooru characters', kind: 'character', present: true },
                    { id: 'danbooru_artist', label: 'Danbooru artists', kind: 'artist', present: true }
                ],
                prefs: { active_sources: ['danbooru_character'] }
            });
        }
        else if (route == 'TagDexSearchEntries') {
            callback({
                total: 1,
                results: [{ name: 'hatsune_miku', display: 'Hatsune Miku', trigger: 'hatsune_miku, vocaloid', count: 123456, copyright_display: 'Vocaloid', kind: 'character' }]
            });
        }
    };
    window.makeWSRequest = () => null;
    window.getSession = () => {};
    window.getImageOutPrefix = () => 'View/local';
    window.isValidMediaPath = (path) => typeof path == 'string' && (path.startsWith('inputs/') || path.startsWith('raw/') || path.startsWith('Starred/'));
    window.getTextSelRange = () => [0, 0];
    window.largeCountStringify = value => `${value}`;
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

// ---- Priority-control regressions ----
const initialControls = await page.evaluate(() => ({
    randomLabel: document.querySelector('.m-seed-random').textContent,
    seedInputHidden: getComputedStyle(document.querySelector('.m-seed-input')).display == 'none',
    resolutionPickers: document.querySelectorAll('.m-resolution-select').length,
    oldResolutionPickers: document.querySelectorAll('.m-aspect-select, .m-size-select, .m-res-readout').length,
    tagDexButtons: document.querySelectorAll('.m-tagdex-browse-button').length
}));
check('seed starts as one Random button', initialControls.randomLabel == 'Random' && initialControls.seedInputHidden, JSON.stringify(initialControls));
check('aspect and size are one final-resolution picker', initialControls.resolutionPickers == 1 && initialControls.oldResolutionPickers == 0, JSON.stringify(initialControls));
check('TagDex browse is mounted once in the Create picker row', initialControls.tagDexButtons == 1, `${initialControls.tagDexButtons} buttons`);

await page.click('.m-seed-random');
await page.waitForFunction(() => document.activeElement == document.querySelector('.m-seed-input')
    && getComputedStyle(document.querySelector('.m-seed-clear')).display != 'none');
const explicitSeed = await page.evaluate(() => ({
    locked: mState.seedLocked,
    numeric: /^\d+$/.test(`${mState.params.seed}`),
    focused: document.activeElement == document.querySelector('.m-seed-input'),
    clearVisible: getComputedStyle(document.querySelector('.m-seed-clear')).display != 'none'
}));
check('Random expands to a focused editable numeric seed', explicitSeed.locked && explicitSeed.numeric && explicitSeed.focused && explicitSeed.clearVisible, JSON.stringify(explicitSeed));
await page.fill('.m-seed-input', '12345');
check('typed seed is stored exactly', await page.evaluate(() => mState.params.seed == '12345'));
await page.click('.m-seed-clear');
await page.waitForFunction(() => getComputedStyle(document.querySelector('.m-seed-random')).display != 'none');
const randomAgain = await page.evaluate(() => ({ locked: mState.seedLocked, seed: mState.params.seed, randomVisible: getComputedStyle(document.querySelector('.m-seed-random')).display != 'none' }));
check('seed X reverts to Random and -1', !randomAgain.locked && randomAgain.seed == '-1' && randomAgain.randomVisible, JSON.stringify(randomAgain));

await page.selectOption('.m-resolution-select', '16:9\n1024');
const resolution = await page.evaluate(() => ({
    aspect: mState.params.aspectratio,
    side: mState.params.sidelength,
    dims: mState.previewResolution(),
    label: document.querySelector('.m-resolution-select').selectedOptions[0].textContent
}));
check('combined resolution selection writes aspect and side length together', resolution.aspect == '16:9' && resolution.side == '1024', JSON.stringify(resolution));
check('combined picker names the final dimensions', resolution.dims.join('x') == '1344x768' && resolution.label.includes('1344 × 768'), JSON.stringify(resolution));

await page.evaluate(() => {
    mState.presets = [
        { title: 'ill/pose', is_starred: true, param_map: {} },
        { title: 'qwen/edit', is_starred: false, param_map: {} }
    ];
    mState.activePresets = [];
    mState.archFilter = '';
    mCreate.render();
});
const picklists = await page.evaluate(() => ({
    sameRow: document.querySelector('.m-arch-select').parentElement == document.querySelector('.m-preset-select').parentElement,
    all: document.querySelector('.m-arch-select').options[0].textContent,
    presetLabel: document.querySelector('.m-preset-select').options[0].textContent
}));
check('architecture and presets share one picklist row', picklists.sameRow, JSON.stringify(picklists));
check('architecture all-option is concise', picklists.all == 'All', JSON.stringify(picklists));
await page.selectOption('.m-preset-select', 'ill/pose');
await page.waitForFunction(() => document.querySelector('.m-preset-select').options[0].textContent == 'Presets (1)');
const presetOn = await page.evaluate(() => ({
    active: mState.activePresets.join(','),
    label: document.querySelector('.m-preset-select').options[0].textContent,
    marked: [...document.querySelector('.m-preset-select').options].some(option => option.textContent == '✓ ill/pose')
}));
check('preset picklist toggles a preset on and marks it', presetOn.active == 'ill/pose' && presetOn.label == 'Presets (1)' && presetOn.marked, JSON.stringify(presetOn));
await page.selectOption('.m-preset-select', 'ill/pose');
check('preset picklist toggles the same preset off', await page.evaluate(() => mState.activePresets.length == 0));

await page.evaluate(() => {
    mCreate.indexLoras([{ name: 'Consistency_Edit_V2.safetensors', title: 'Consistency Edit V2', trigger_phrase: '' }]);
    mState.setLoras([{ name: 'Consistency_Edit_V2.safetensors', weight: 0.2 }]);
    mCreate.openLoraSheet();
});
check('LoRA weight uses a 0.05-step picker, not a slider', await page.evaluate(() =>
    document.querySelectorAll('.m-lora-weight-picker').length == 1 && document.querySelectorAll('.m-lora-slider').length == 0));
await page.click('.m-lora-weight-picker .m-lora-weight-button:last-child');
const loraWeight = await page.evaluate(() => ({ state: mState.getLoras()[0].weight, shown: document.querySelector('.m-lora-weight-input').value }));
check('LoRA plus advances exactly 0.05', loraWeight.state == 0.25 && loraWeight.shown == '0.25', JSON.stringify(loraWeight));
await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mState.setLoras([]);
});

await page.click('.m-tagdex-browse-button');
await page.waitForSelector('.m-tagdex-card');
const tagDexSheet = await page.evaluate(() => ({
    title: document.querySelector('.m-tagdex-browse-sheet .m-sheet-title').textContent,
    source: document.querySelector('.m-tagdex-source').value,
    result: document.querySelector('.m-tagdex-card-name').textContent
}));
check('TagDex browse loads the preferred dataset and results', tagDexSheet.title == 'Characters' && tagDexSheet.source == 'danbooru_character' && tagDexSheet.result == 'Hatsune Miku', JSON.stringify(tagDexSheet));
await page.click('.m-tagdex-card');
check('TagDex browse inserts the selected trigger into the prompt', await page.evaluate(() => mState.params.prompt == 'hatsune_miku, vocaloid'));
await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mState.params.prompt = '';
    mState.changed();
});

await page.addScriptTag({ content: extractFunction(readFileSync(OUTPUT_HISTORY, 'utf8'), 'showMostRecentSessionImage') });
const deleteFallback = await page.evaluate(() => {
    let batch = document.createElement('div');
    batch.id = 'current_image_batch';
    // appendImage prepends each output, so current batch DOM order is newest-first.
    for (let src of ['newest.png', 'older.png']) {
        let block = document.createElement('div');
        block.className = 'image-block';
        block.dataset.src = src;
        block.dataset.metadata = `{ "src": "${src}" }`;
        block.dataset.batch_id = src;
        batch.appendChild(block);
    }
    document.body.appendChild(batch);
    window.__fallback = { clicked: '', shown: '', closed: false, blank: false };
    window.clickImageInBatch = block => { window.__fallback.clicked = block.dataset.src; };
    window.imageFullView = {
        close: () => { window.__fallback.closed = true; },
        showImage: src => { window.__fallback.shown = src; }
    };
    window.setCurrentImage = src => { window.__fallback.blank = src == null; };
    let shifted = showMostRecentSessionImage('deleted.png', true);
    for (let block of [...batch.children]) {
        block.remove();
    }
    let blanked = showMostRecentSessionImage('deleted.png', false);
    batch.remove();
    return { shifted, blanked, ...window.__fallback };
});
check('deleted current image falls back to the newest session image', deleteFallback.shifted && deleteFallback.clicked == 'newest.png' && deleteFallback.shown == 'newest.png', JSON.stringify(deleteFallback));
check('deleted last session image falls back to blank canvas', !deleteFallback.blanked && deleteFallback.closed && deleteFallback.blank, JSON.stringify(deleteFallback));

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
    mCreate.indexLoras(models);
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

// Star stored without the weight-file extension must still lift the .safetensors row. Genpage's
// starred_models and ListModels disagree on that suffix; exact-match dropped every favourite.
await page.evaluate(() => {
    mState.starredModels = { 'LoRA': ['zzz_starred'] };
});
const extless = await page.evaluate(() => mState.starredFirst(mCreate.loraList, 'LoRA').map(m => m.name));
check('star without .safetensors still lifts the ListModels row',
    extless[0] == 'zzz_starred.safetensors', JSON.stringify(extless));

// LoRA heading is the metadata title whenever it is non-empty, including when it equals the file stem.
await page.evaluate(pixel => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mState.starredModels = {};
    mCreate.indexLoras([
        { name: 'ill/epoch_1.safetensors', title: 'Azenda', trigger_phrase: '', preview_image: pixel },
        { name: 'ill/plain.safetensors', title: '', trigger_phrase: '', preview_image: pixel },
        { name: 'ill/Azenda.safetensors', title: 'Azenda', trigger_phrase: '', preview_image: pixel }
    ]);
    mCreate.openLoraSheet();
}, PIXEL);
const titled = await page.evaluate(() => [...document.querySelectorAll('.m-lora-results .m-model-result')].map(row => ({
    heading: row.querySelector('.m-model-name').textContent,
    sub: (row.querySelector('.m-model-sub') || {}).textContent || ''
})));
check('LoRA picker: a distinct title is the heading', titled[0].heading == 'Azenda' && titled[0].sub == 'epoch_1', JSON.stringify(titled[0]));
check('LoRA picker: missing title falls back to the file stem', titled[1].heading == 'plain', JSON.stringify(titled[1]));
check('LoRA picker: title equal to the file stem is still the heading', titled[2].heading == 'Azenda', JSON.stringify(titled[2]));

await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
});

// Folder-prefix architecture filter: a qwen LoRA must not survive an ill pick just because both report SDXL.
const arch = await page.evaluate(() => {
    mState.presets = [
        { title: 'ill/pose', param_map: { model: 'ill/ckpt' } },
        { title: 'qwen/edit', param_map: { model: 'qwen/ckpt' } }
    ];
    mState.archFilter = 'ill';
    let list = [
        { name: 'ill/keep.safetensors' },
        { name: 'qwen/hide.safetensors' },
        { name: 'misc/unknown.safetensors' }
    ];
    return mState.filterByArch(list, 'LoRA').map(m => m.name).join(',');
});
check('arch filter: other known group folders are hidden',
    arch == 'ill/keep.safetensors,misc/unknown.safetensors', arch);

// The Prefix row is hidden unless the session advertises the `filenameprefix` param - renderQuickParams
// recomputes `prefixRow.style.display` from `mState.paramMeta` on every render (m_create.js). This harness
// never boots, so ListT2IParams never lands and the row stayed `display: none`, giving the Prefix input a
// zero rect. The right-edge check below then compared a real edge against 0 and had always failed, which
// read as a misalignment for weeks. Populate the param and re-render first, so the check measures the
// arrangement it was written for.
await page.evaluate(() => {
    mState.paramMeta['filenameprefix'] = { id: 'filenameprefix', name: 'Filename Prefix', type: 'text', default: '' };
    mCreate.renderQuickParams();
});

// Prefix sits above Steps/CFG; clipboard and CLR follow the 1/2/4 batch buttons.
const layout = await page.evaluate(() => {
    let prefix = document.querySelector('.m-prefix-input');
    let tune = document.querySelector('.m-tune-row');
    let labels = [...document.querySelector('.m-quick-item.m-seg-group').querySelectorAll('.m-seg-button')].map(b => b.textContent);
    let createIcon = document.querySelector('.m-nav-item[data-mdest="create"] .m-nav-icon').textContent;
    let prefixBox = prefix ? prefix.getBoundingClientRect() : null;
    let batchBtns = [...document.querySelectorAll('.m-batch-group .m-seg-button')].map(b => b.getBoundingClientRect());
    let widths = batchBtns.map(b => Math.round(b.width * 10) / 10);
    let widthSpan = widths.length ? Math.max(...widths) - Math.min(...widths) : 99;
    let last = batchBtns.length ? batchBtns[batchBtns.length - 1] : null;
    return {
        prefixBeforeTune: !!(prefix && tune && (prefix.compareDocumentPosition(tune) & Node.DOCUMENT_POSITION_FOLLOWING)),
        batch: labels.join(','),
        createIcon: createIcon,
        batchEqual: widthSpan <= 1,
        batchWidths: widths,
        prefixVisible: !!(prefixBox && prefixBox.width > 0),
        batchRightAlign: !!(prefixBox && last && Math.abs(last.right - prefixBox.right) <= 1),
        batchRightGap: (prefixBox && last) ? Math.round((last.right - prefixBox.right) * 100) / 100 : null
    };
});
check('Prefix field sits above the Steps/CFG row', layout.prefixBeforeTune);
check('batch row is 1, 2, 4, clipboard, CLR',
    layout.batch == '1,2,4,📋,CLR', layout.batch);
check('batch 1/2/4/paste/CLR buttons are equal width',
    layout.batchEqual, JSON.stringify(layout.batchWidths));
check('Prefix row is visible once filenameprefix is advertised', layout.prefixVisible);
check('batch group right edge matches Prefix', layout.batchRightAlign, `gap ${layout.batchRightGap}px`);
check('Create nav icon is the geometric triangle, not a pencil emoji',
    layout.createIcon == '\u25B3', JSON.stringify(layout.createIcon));

// Generated-image attach must send a path, never a data URI or a View/ URL.
const paths = await page.evaluate(() => {
    let fromView = mImages.promptPathEntry('View/local/raw/2026-08-17/foo.png');
    let fromRaw = mImages.promptPathEntry('raw/2026-08-17/foo.png');
    let fromData = mImages.promptPathEntry('data:image/png;base64,aaaa');
    return {
        view: fromView && fromView.kind == 'path' && fromView.value == 'raw/2026-08-17/foo.png',
        raw: fromRaw && fromRaw.kind == 'path' && fromRaw.value == 'raw/2026-08-17/foo.png',
        data: fromData == null
    };
});
check('Prompt Img strips a View URL down to the output-relative path', paths.view);
check('Prompt Img accepts an already-relative raw/ path', paths.raw);
check('Prompt Img refuses a data URI rather than stuffing it as a path', paths.data);

// Models tab uses the same preferTitle heading rule; checkpoints stay filename-first.
const headings = await page.evaluate(() => {
    let lora = mUI.modelLines({ name: 'ill/epoch_1.safetensors', title: 'Azenda' }, true);
    let untitled = mUI.modelLines({ name: 'ill/epoch_1.safetensors', title: '' }, true);
    let ckpt = mUI.modelLines({ name: 'ill/epoch_1.safetensors', title: 'Azenda' }, false);
    return { lora: lora.primary, untitled: untitled.primary, ckpt: ckpt.primary };
});
check('Models-tab LoRA heading is the title, not epoch_1', headings.lora == 'Azenda', JSON.stringify(headings));
check('untitled LoRA falls back to the file stem', headings.untitled == 'epoch_1', JSON.stringify(headings));
check('checkpoint heading stays the file stem even when titled', headings.ckpt == 'epoch_1', JSON.stringify(headings));

await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="models"]');
    panel.classList.add('m-tab-active');
    mModels.build(panel);
});
const toggle = await page.evaluate(() => {
    let group = document.querySelector('.m-models-toggle');
    let panel = document.querySelector('.m-panel[data-mtab="models"]');
    let btns = [...group.querySelectorAll('.m-seg-button')];
    let gw = group.getBoundingClientRect().width;
    let content = panel.clientWidth - parseFloat(getComputedStyle(panel).paddingLeft) - parseFloat(getComputedStyle(panel).paddingRight);
    return {
        labels: btns.map(b => b.textContent).join('|'),
        full: Math.abs(gw - content) < 3,
        even: btns.length == 2 && Math.abs(btns[0].getBoundingClientRect().width - btns[1].getBoundingClientRect().width) < 3
    };
});
check('Models toggle is Checkpoints | LoRAs', toggle.labels == 'Checkpoints|LoRAs', toggle.labels);
check('Models toggle spans the panel content width', toggle.full, JSON.stringify(toggle));
check('Models toggle buttons are equal halves', toggle.even, JSON.stringify(toggle));

const bars = await page.evaluate(() => {
    let panel = getComputedStyle(document.querySelector('.m-panel'));
    let sheetRule = [...document.styleSheets].some(s => {
        try {
            return [...s.cssRules].some(r => r.selectorText && r.selectorText.includes('.m-panel') && `${r.style.scrollbarWidth}` == 'none');
        }
        catch (e) {
            return false;
        }
    });
    return { width: panel.scrollbarWidth, sheetRule: sheetRule };
});
check('Create/Models panel scrollbar is hidden', bars.width == 'none' || bars.sheetRule, JSON.stringify(bars));

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
