/**
 * /simple grid builder harness (fork). Covers m_grid.js, the built axis surface that replaced the generic
 * "pick a parameter id, type its values" form behind the Generate long-press. The checks are aimed at the
 * ways a grid can run successfully and measure the wrong thing:
 *
 * 1. The LoRA axis is joined with '||', every other axis with ','. GridGenCore splits an axis on '||' when
 *    the string contains one and on ',' otherwise, and a LoRA axis VALUE can itself be a comma-joined stack
 *    - so joining LoRAs with ',' silently turns one three-LoRA stack into three single-LoRA cells.
 * 2. A LoRA axis STACKS onto session/preset LoRAs (CommaStackable append). Same LoRA id in both -> base entry
 *    is dropped so the grid axis wins. Non-overlapping base LoRAs remain in the base params.
 * 3. The batch count never survives into the base, or every cell is multiplied by it.
 * 7. Row-count chooser (Auto/1/2/3/4) persists in localStorage and is forwarded as runGrid opts.rows.
 * 8. Picking from the LoRA or Preset list keeps the search focused, so the on-screen keyboard stays up and
 *    the sheet does not move. Scrolling the list dismisses it.
 * 9. Reset Params clears every Simple grid setting (axes, Grid mode, rows, remembered open sections)
 *    and repaints the sheet and Generate button. Other client prefs and the filename prefix stay.
 * 10. Axis sections start collapsed. The header toggles one section, and that choice is restored next open.
 * 11. Enter in an axis value field adds like the Add button. Empty Enter and IME Enter do not. Search fields
 *     are not value fields.
 * 12. Grid Image, next to Rows, defaults to on. Off persists and sends Just Images. Reset Params turns it
 *     back on. More than three varying axes forces Just Images and disables the control until the count drops.
 * 13. The Create live preview picks columns from the box width and the cell aspect. A wide portrait preview
 *     uses at least three columns. A narrow box uses fewer. One image stays one column. Resizing updates it.
 * 4. LoRA axis values are extension-stripped, matching how a LoRA is named everywhere else in the client.
 * 5. The image count is the product of the live axes, and Run is unavailable below two images - a "grid" of
 *    one is a generation.
 * 6. Sampler and Scheduler are both offered, from the server's own value lists. ER-SDE and the DPM family
 *    are SAMPLERS, so a builder that offered only Scheduler would answer a different question than asked.
 *
 * Runs the REAL shipped source: index.html with its server tokens substituted, the real m.css, and the real
 * m_*.js modules, with the Create panel built directly instead of booting (m_app.js is stubbed out, since
 * there is no server here). GridGenRun is intercepted at mGen.runGrid, so the payload is asserted rather
 * than sent.
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling rather than
 * part of the CI gate. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-grid.mjs
 * Set SWARM_CHROMIUM to override the browser path. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const M = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m`;
const TAGDEX = `${REPO}/src/BuiltinExtensions/TagDex/Assets`;
const WIDTH = 390, HEIGHT = 844;

const TOAST = '<div class="center-toast toast-error-box" id="center_toast">'
    + '<div class="toast hide" id="error_toast_box"><div class="toast-body" id="error_toast_content"></div></div></div>';
const html = readFileSync(`${M}/index.html`, 'utf8')
    .replace('[HEADEXTRA]', '')
    .replace('[REMAPS]', '[]')
    .replaceAll('[TOAST]', TOAST)
    .replaceAll('[VARY]', '1');

const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_coach.js', 'm_enhance.js', 'm_create.js', 'm_grid.js',
    'm_presets.js', 'm_images.js', 'm_models.js'];
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

await page.addInitScript(() => {
    window.showError = function (message) { window.__err = message; };
    window.getUserSetting = () => '';
    window.largeCountStringify = value => `${value}`;
    window.getTextSelRange = () => [0, 0];
    window.makeWSRequest = () => null;
    window.getSession = () => {};
    window.getImageOutPrefix = () => 'View/local';
    window.isValidMediaPath = () => true;
    window.permissions = { hasPermission: () => true };
    window.__sheet = () => [...document.querySelectorAll('.m-sheet')].pop();
    window.genericRequest = (route, args, callback) => {
        if (route == 'ListModels') {
            callback({ files: [
                { name: 'ill/style_a.safetensors', title: 'Style A', architecture: 'anima-2.9b/lora', compat_class: 'anima-2.9b' },
                { name: 'ill/style_b.safetensors', title: 'Style B', architecture: 'anima/lora', compat_class: 'anima' },
                { name: 'flux/detail.safetensors', title: 'Detail', architecture: 'anima-3.8b/lora', compat_class: 'anima-3.8b' }
            ], folders: [] });
        }
        else if (route == 'GetMyUserData') {
            callback({ presets: window.__gridPresets || [], starred_models: {} });
        }
        else {
            callback({});
        }
    };
});
page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mCreate != 'undefined' && typeof mGrid != 'undefined');
await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mCreate.build(panel);
    // Stands in for ListT2IParams. The sampler list carries the two the request named by hand.
    mState.paramMeta = {
        steps: { name: 'Steps' }, cfgscale: { name: 'CFG Scale' },
        sampler: { name: 'Sampler', values: ['euler', 'dpmpp_2m', 'er_sde'],
            value_names: ['Euler', 'DPM++ 2M', 'ER-SDE'] },
        scheduler: { name: 'Scheduler', values: ['normal', 'karras', 'beta'] },
        aspectratio: { name: 'Aspect Ratio', values: ['1:1', '16:9', 'Custom'],
            value_names: ['1:1 (Square)', '16:9 (Standard Widescreen)', 'Custom'] }
    };
    // The LoRA axis is built when the sheet opens, so the checkpoint has to be in place first.
    mState.models = { 'Stable-Diffusion': [['anima/checkpoint.safetensors', 'anima-29']] };
    mState.modelClasses = { 'anima-29': { compat_class: 'anima-2.9b' } };
    mState.compatCache = {};
    mState.archIdCache = {};
    mState.params['model'] = 'anima/checkpoint.safetensors';
    // Intercepted rather than sent: this is the payload every check below reads.
    window.__grid = null;
    window.__realRunGrid = mGen.runGrid.bind(mGen);
    mGen.runGrid = (base, axes, opts) => { window.__grid = { base, axes, opts: opts || null }; };
});

// ---- Registration and shape ----
const registered = await page.evaluate(() => mUI.moreItems.map(item => item.label));
check('Grid generate is registered as a More-tab row', registered.includes('Grid generate'), registered.join(','));

await page.evaluate(() => mGrid.open());
await page.waitForFunction(() => document.querySelectorAll('.m-grid-card').length > 0);
const axisNames = await page.evaluate(() =>
    [...__sheet().querySelectorAll('.m-grid-card-name')].map(e => e.textContent));
check('the requested axes are offered, and only those',
    axisNames.join(',') == 'Preset,LoRAs,LoRA Strength,LoRA Section,Prompt Replace,Aspect Ratio,Steps,CFG Scale,Sampler,Scheduler', axisNames.join(','));
const startState = await page.evaluate(() => ({
    count: __sheet().querySelector('.m-grid-count').textContent,
    disabled: __sheet().querySelector('.m-grid-run').disabled,
    summaries: [...__sheet().querySelectorAll('.m-grid-card-summary')].map(e => e.textContent)
}));
check('it opens with nothing set and Run unavailable',
    startState.disabled && startState.count == 'No axes set yet.'
    && startState.summaries.every(s => s == 'off'), JSON.stringify(startState));

// ---- Sampler and Scheduler read the server's own value lists ----
const samplerOptions = await page.evaluate(() => {
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Sampler');
    card.open = true;
    return [...card.querySelectorAll('.m-grid-option')].map(e => e.textContent);
});
check('the Sampler axis lists the server values by display name, ER-SDE and DPM++ among them',
    samplerOptions.join(',') == 'Euler,DPM++ 2M,ER-SDE', samplerOptions.join(','));
const schedulerOptions = await page.evaluate(() => {
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Scheduler');
    card.open = true;
    return [...card.querySelectorAll('.m-grid-option')].map(e => e.textContent);
});
check('the Scheduler axis is offered separately, from its own value list',
    schedulerOptions.join(',') == 'normal,karras,beta', schedulerOptions.join(','));

// ---- Picking values ----
await page.evaluate(() => {
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Sampler');
    let buttons = [...card.querySelectorAll('.m-grid-option')];
    buttons.find(b => b.textContent == 'Euler').click();
    buttons.find(b => b.textContent == 'ER-SDE').click();
});
const samplerPicked = await page.evaluate(() => ({
    selected: mGrid.valuesFor('sampler'),
    summary: [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Sampler')
        .querySelector('.m-grid-card-summary').textContent,
    count: __sheet().querySelector('.m-grid-count').textContent,
    disabled: __sheet().querySelector('.m-grid-run').disabled
}));
check('picking two samplers stores the raw ids, not the display names',
    samplerPicked.selected.join(',') == 'euler,er_sde', samplerPicked.selected.join(','));
check('the collapsed card summary names what is picked', samplerPicked.summary == '2: euler, er_sde', samplerPicked.summary);
check('two values on one axis is a runnable grid',
    samplerPicked.count == '2 images' && !samplerPicked.disabled, JSON.stringify(samplerPicked));

// A single value on a second axis pins it without making a grid of one.
await page.evaluate(() => {
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Steps');
    card.open = true;
    [...card.querySelectorAll('.m-grid-quick-button')].find(b => b.textContent == '20').click();
    [...card.querySelectorAll('.m-grid-quick-button')].find(b => b.textContent == '30').click();
});
const stepsPicked = await page.evaluate(() => ({
    selected: mGrid.valuesFor('steps'),
    count: __sheet().querySelector('.m-grid-count').textContent
}));
check('the Steps quick row toggles values on', stepsPicked.selected.join(',') == '20,30', stepsPicked.selected.join(','));
check('the count is the product of the live axes', stepsPicked.count == '4 images', stepsPicked.count);

// Custom values, including a pasted comma list.
await page.evaluate(() => {
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'CFG Scale');
    card.open = true;
    card.querySelector('.m-grid-custom-input').value = '2.5, 4.5 , 2.5';
    card.querySelector('.m-grid-add-button').click();
});
const cfgAdded = await page.evaluate(() => ({
    selected: mGrid.valuesFor('cfgscale'),
    input: [...__sheet().querySelectorAll('.m-grid-custom-input')].map(e => e.value)
}));
check('a pasted comma list adds every value, trimmed and de-duplicated',
    cfgAdded.selected.join('|') == '2.5|4.5', cfgAdded.selected.join('|'));
check('the custom field clears after adding', cfgAdded.input.every(v => v == ''), JSON.stringify(cfgAdded.input));

// Removing via the chip.
await page.evaluate(() => {
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'CFG Scale');
    card.querySelector('.m-grid-chip .m-grid-chip-x').click();
});
check('a chip removes just its own value', await page.evaluate(() => mGrid.valuesFor('cfgscale').join(',') == '4.5'),
    await page.evaluate(() => mGrid.valuesFor('cfgscale').join(',')));

// ---- LoRA axis ----
await page.evaluate(() => {
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'LoRAs');
    card.open = true;
});
await page.waitForFunction(() => __sheet().querySelectorAll('.m-grid-lora-options .m-grid-option').length > 0);
const loraNames = await page.evaluate(() =>
    [...__sheet().querySelectorAll('.m-grid-lora-options .m-grid-option')].map(e => e.textContent));
check('the LoRA axis loads the library even though the Create LoRA sheet was never opened',
    loraNames.length == 3, loraNames.join(','));
const loraDim = await page.evaluate(() => [...__sheet().querySelectorAll('.m-grid-lora-options .m-grid-option')].map(e => ({
    name: e.textContent, dim: e.classList.contains('m-model-unavailable')
})));
check('the LoRA axis keeps every Anima-family LoRA and dims none of them',
    loraDim.map(row => row.name).join(',') == 'detail,style_a,style_b'
    && loraDim.map(row => row.dim).join(',') == 'false,false,false',
    JSON.stringify(loraDim));
await page.evaluate(() => {
    // Picked by name, not by index: indexLoras sorts its corpus, so the fixture's declaration order is not
    // the order the options render in.
    let options = [...__sheet().querySelectorAll('.m-grid-lora-options .m-grid-option')];
    for (let want of ['style_a', 'style_b']) {
        options.find(option => option.textContent.includes(want)).click();
    }
});
const lorasPicked = await page.evaluate(() => mGrid.valuesFor('loras'));
check('LoRA values are extension-stripped, as they are named everywhere else',
    lorasPicked.join(',') == 'ill/style_a,ill/style_b', lorasPicked.join(','));

// ---- The payload ----
await page.evaluate(() => {
    // Base state the grid must partly override: a batch count, and LoRAs already active on the Create tab.
    mState.params['prompt'] = 'a cat';
    mState.params['images'] = '4';
    mState.setLoras([{ name: 'ill/preexisting', weight: 0.8 }]);
    __sheet().querySelector('.m-grid-run').click();
});
const payload = await page.evaluate(() => window.__grid);
const byMode = Object.fromEntries(payload.axes.map(a => [a.mode, a.vals]));
check('multi-value axes are sent, and a one-value axis is a fixed param',
    payload.axes.map(a => a.mode).sort().join(',') == 'loras,sampler,steps'
    && !('cfgscale' in byMode) && `${payload.base.cfgscale}` == '4.5',
    JSON.stringify({ axes: payload.axes.map(a => a.mode), cfg: payload.base.cfgscale }));
check('the LoRA axis is joined with || so a stacked value stays one cell',
    byMode.loras == 'ill/style_a||ill/style_b', byMode.loras);
check('every other axis is joined with a comma',
    byMode.steps == '20,30' && byMode.sampler == 'euler,er_sde',
    JSON.stringify(byMode));
check('the batch count never reaches the base params', !('images' in payload.base), JSON.stringify(Object.keys(payload.base)));
check('a LoRA axis keeps non-overlapping base LoRAs so cells stack session + axis',
    `${payload.base.loras}` == 'ill/preexisting' && `${payload.base.loraweights}` == '0.8',
    JSON.stringify({ loras: payload.base.loras, weights: payload.base.loraweights }));
check('the rest of the Create state still rides along', payload.base.prompt == 'a cat', `${payload.base.prompt}`);

// Same LoRA id on the Create tab and the axis: base entry is dropped, grid wins.
const overlap = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mState.setLoras([
        { name: 'ill/preexisting', weight: 0.8 },
        { name: 'ill/style_a', weight: 0.5 }
    ]);
    mGrid.selected = { loras: ['ill/style_a', 'ill/style_b'] };
    let base = mGrid.buildBase();
    return { loras: base.loras, weights: base.loraweights };
});
check('same LoRA id in session and axis drops the session entry (grid wins)',
    `${overlap.loras}` == 'ill/preexisting' && `${overlap.weights}` == '0.8', JSON.stringify(overlap));

// ---- Without a LoRA axis the base LoRAs must survive ----
const keptLoras = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mState.setLoras([{ name: 'ill/preexisting', weight: 0.8 }]);
    mGrid.selected = { steps: ['20', '30'] };
    let base = mGrid.buildBase();
    return { loras: base.loras, weights: base.loraweights, images: base.images };
});
check('with no LoRA axis, the Create tab\'s LoRAs are left alone',
    `${keptLoras.loras}` == 'ill/preexisting' && `${keptLoras.weights}` == '0.8', JSON.stringify(keptLoras));
check('the batch count is dropped either way', keptLoras.images == undefined, `${keptLoras.images}`);

// ---- Row layout chooser ----
const rowUi = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    localStorage.removeItem('m_client_grid_rows');
    mGrid.rows = MGrid.loadRowsPref();
    mGrid.open();
    let buttons = [...__sheet().querySelectorAll('.m-grid-layout-button')].map(b => ({
        label: b.textContent, rows: b.dataset.rows, selected: b.classList.contains('m-selected')
    }));
    __sheet().querySelector('.m-grid-layout-button[data-rows="2"]').click();
    return {
        buttons,
        after: mGrid.rows,
        stored: localStorage.getItem('m_client_grid_rows'),
        selected: [...__sheet().querySelectorAll('.m-grid-layout-button')].map(b =>
            b.classList.contains('m-selected') ? b.dataset.rows : null).filter(Boolean)
    };
});
check('row chooser offers Auto and 1-4',
    rowUi.buttons.map(b => b.label).join(',') == 'Auto,1,2,3,4'
    && rowUi.buttons[0].selected && rowUi.buttons[0].rows == '0', JSON.stringify(rowUi.buttons));
check('picking 2 rows persists and selects that choice',
    rowUi.after == 2 && rowUi.stored == '2' && rowUi.selected.join(',') == '2', JSON.stringify(rowUi));

const rowForward = await page.evaluate(() => {
    window.__gridOpts = null;
    let orig = mGen.runGrid;
    mGen.runGrid = (base, axes, opts) => { window.__gridOpts = opts || null; window.__grid = { base, axes }; };
    mGrid.selected = { steps: ['20', '30'] };
    mGrid.rows = 3;
    __sheet().querySelector('.m-grid-run').click();
    mGen.runGrid = orig;
    return window.__gridOpts;
});
check('Run forwards the chosen row count into runGrid opts',
    rowForward && rowForward.rows == 3, JSON.stringify(rowForward));

const cellCounts = await page.evaluate(() => ({
    presets: MGenSocket.cellCount('a||b||c||d'),
    loras: MGenSocket.cellCount('ill/style_a||ill/style_b'),
    steps: MGenSocket.cellCount('20,30'),
    one: MGenSocket.cellCount('4.5')
}));
check('an axis joined with || counts one cell per value, and a comma axis still splits on commas',
    cellCounts.presets == 4 && cellCounts.loras == 2 && cellCounts.steps == 2 && cellCounts.one == 1,
    JSON.stringify(cellCounts));

// ---- Preset axis ----
const presetTitles = [
    'anima/TrattoNero-niTratto_steeze',
    'anima/TrattoNero-orenz_steeze',
    'anima/TrattoNero-niTratto_steeze_cfg35',
    'anima/TrattoNero-orenz_steeze_cfg35'
];
const presetOpen = await page.evaluate(titles => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    window.__gridPresets = titles.map(title => ({ title, description: '', param_map: {}, is_starred: false }))
        .concat([{ title: 'other/noise', description: '', param_map: {}, is_starred: false }]);
    mState.presets = window.__gridPresets;
    mState.params['prompt'] = 'a cat';
    mState.params['cfgscale'] = '7';
    mGrid.selected = {};
    mGrid.open();
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Preset');
    card.open = true;
    return [...card.querySelectorAll('.m-grid-option')].map(e => e.dataset.preset);
}, presetTitles);
check('the Preset axis lists saved preset titles, including the four TrattoNero presets',
    presetTitles.every(title => presetOpen.includes(title)) && presetOpen.includes('other/noise'),
    presetOpen.join(','));

const presetSearch = await page.evaluate(() => {
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Preset');
    card.querySelector('.m-grid-search').value = 'orenz';
    card.querySelector('.m-grid-search').dispatchEvent(new Event('input'));
    let shown = [...card.querySelectorAll('.m-grid-option')].map(e => e.dataset.preset);
    card.querySelector('.m-grid-search').value = '';
    card.querySelector('.m-grid-search').dispatchEvent(new Event('input'));
    return shown;
});
check('preset search matches the title, so orenz shows the two orenz presets',
    presetSearch.join(',') == 'anima/TrattoNero-orenz_steeze,anima/TrattoNero-orenz_steeze_cfg35',
    presetSearch.join(','));

const presetPicked = await page.evaluate(titles => {
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Preset');
    for (let title of titles) {
        [...card.querySelectorAll('.m-grid-option')].find(b => b.dataset.preset == title).click();
    }
    return {
        selected: mGrid.valuesFor('preset'),
        chips: [...card.querySelectorAll('.m-grid-chip')].map(e => e.childNodes[0].textContent.trim()),
        count: __sheet().querySelector('.m-grid-count').textContent,
        disabled: __sheet().querySelector('.m-grid-run').disabled
    };
}, presetTitles);
check('the four TrattoNero presets can be multi-selected by their full titles',
    presetPicked.selected.join('|') == presetTitles.join('|'), presetPicked.selected.join('|'));
check('preset chips keep the folder, so the same name from two folders stays distinct',
    presetPicked.chips.join('|') == presetTitles.join('|'),
    presetPicked.chips.join('|'));
check('four presets is a runnable grid of four images',
    presetPicked.count == '4 images' && !presetPicked.disabled, JSON.stringify(presetPicked));

const presetPayload = await page.evaluate(() => {
    window.__grid = null;
    __sheet().querySelector('.m-grid-run').click();
    return window.__grid;
});
check('the Preset axis is sent as gridgenpresets joined with ||, and is not baked into the base',
    presetPayload.axes.length == 1
    && presetPayload.axes[0].mode == 'gridgenpresets'
    && presetPayload.axes[0].vals == presetTitles.join('||')
    && presetPayload.base.prompt == 'a cat'
    && presetPayload.base.cfgscale == '7'
    && !('gridgenpresets' in presetPayload.base),
    JSON.stringify(presetPayload));

const presetEmpty = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mGrid.selected = { steps: ['20', '30'] };
    mGrid.open();
    __sheet().querySelector('.m-grid-run').click();
    return window.__grid.axes.map(a => a.mode);
});
check('an empty Preset axis is left out of the run',
    presetEmpty.join(',') == 'steps', presetEmpty.join(','));

const presetFolders = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    window.__gridPresets = [
        { title: 'krea/Realism', description: '', param_map: {}, is_starred: false },
        { title: 'krea-lf/Realism', description: 'krea look', param_map: {}, is_starred: false },
        { title: 'qwen2/Realism', description: '', param_map: {}, is_starred: false },
        { title: 'krea/Starred Look', description: '', param_map: {}, is_starred: true },
        { title: 'Plain Root', description: '', param_map: {}, is_starred: false },
        { title: 'krea/sub/Realism', description: '', param_map: {}, is_starred: false }
    ];
    mState.presets = window.__gridPresets;
    mGrid.selected = {};
    mGrid.open();
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Preset');
    card.open = true;
    let read = () => ({
        headers: [...card.querySelectorAll('.m-grid-folder')].map(e => e.textContent),
        buttons: [...card.querySelectorAll('.m-grid-option')].map(e => ({
            preset: e.dataset.preset,
            label: e.textContent
        }))
    });
    let listed = read();
    let search = card.querySelector('.m-grid-search');
    search.value = 'krea-lf';
    search.dispatchEvent(new Event('input'));
    let lf = read();
    search.value = 'krea';
    search.dispatchEvent(new Event('input'));
    let krea = read();
    search.value = '';
    search.dispatchEvent(new Event('input'));
    [...card.querySelectorAll('.m-grid-option')].find(b => b.dataset.preset == 'krea/Realism').click();
    [...card.querySelectorAll('.m-grid-option')].find(b => b.dataset.preset == 'krea-lf/Realism').click();
    let samplerFolders = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Sampler')
        .querySelectorAll('.m-grid-folder').length;
    let steps = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Steps');
    steps.open = true;
    return {
        listed,
        lf,
        krea,
        summary: card.querySelector('.m-grid-card-summary').textContent,
        chips: [...card.querySelectorAll('.m-grid-chip')].map(e => e.childNodes[0].textContent.trim()),
        samplerFolders,
        stepLabels: [...steps.querySelectorAll('.m-grid-quick-button')].map(e => e.textContent)
    };
});
let presetLabel = Object.fromEntries(presetFolders.listed.buttons.map(b => [b.preset, b.label]));
let kreaOrder = presetFolders.listed.buttons
    .filter(b => b.preset.startsWith('krea/')).map(b => b.preset);
check('preset buttons sit under folder headers, and a root preset is under Other',
    presetFolders.listed.headers.join(',') == 'krea,krea-lf,qwen2,Other'
    && presetLabel['krea/Realism'] == 'Realism'
    && presetLabel['krea-lf/Realism'] == 'Realism'
    && presetLabel['qwen2/Realism'] == 'Realism'
    && presetLabel['krea/sub/Realism'] == 'sub/Realism'
    && presetLabel['Plain Root'] == 'Plain Root',
    JSON.stringify(presetFolders.listed));
check('a starred preset still leads its folder and still wears a star',
    kreaOrder[0] == 'krea/Starred Look' && presetLabel['krea/Starred Look'] == '\u2605 Starred Look',
    JSON.stringify(kreaOrder));
check('preset search matches a folder name, and krea-lf does not also open every krea preset',
    presetFolders.lf.headers.join(',') == 'krea-lf'
    && presetFolders.lf.buttons.map(b => b.preset).join(',') == 'krea-lf/Realism'
    && presetFolders.krea.headers.join(',') == 'krea,krea-lf'
    && presetFolders.krea.buttons.every(b => b.preset.startsWith('krea')),
    JSON.stringify({ lf: presetFolders.lf, krea: presetFolders.krea.headers }));
check('preset chips and the axis summary show the folder, and other axes stay ungrouped',
    presetFolders.chips.join('|') == 'krea/Realism|krea-lf/Realism'
    && presetFolders.summary == '2: krea/Realism, krea-lf/Realism'
    && presetFolders.samplerFolders == 0
    && presetFolders.stepLabels.join(',') == '4,8,16,20,30,40',
    JSON.stringify({ chips: presetFolders.chips, summary: presetFolders.summary, steps: presetFolders.stepLabels }));

const gridLoraSearch = await page.evaluate(async () => {
    let calls = 0;
    let orig = MCreate.filterModels;
    MCreate.filterModels = (list, term) => {
        calls++;
        return orig(list, term);
    };
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mState.params['model'] = 'anima/checkpoint.safetensors';
    mGrid.selected = {};
    mGrid.open();
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(entry => entry.querySelector('.m-grid-card-name').textContent == 'LoRAs');
    card.open = true;
    let baseline = calls;
    let search = card.querySelector('.m-grid-search');
    for (let value of ['s', 'st', 'sty']) {
        search.value = value;
        search.dispatchEvent(new Event('input'));
    }
    let during = calls;
    await new Promise(resolve => setTimeout(resolve, MCreate.SearchDebounceMs + 80));
    let after = calls;
    let shown = [...card.querySelectorAll('.m-grid-option')].map(elem => elem.textContent);
    let expected = mState.compatFirst(mState.starredFirst(orig(mCreate.loraList, 'sty'), 'LoRA'), 'LoRA')
        .map(model => mUI.modelName(MState.stripModelExt(model.name)));
    search.value = '';
    search.dispatchEvent(new Event('input'));
    let cleared = calls;
    MCreate.filterModels = orig;
    return { baseline, during, after, cleared, shown, expected };
});
// The debounced local render is one filter pass. searchLoraMetadata then re-renders when ListModels
// returns, which this harness answers immediately, so the settled count is two.
check('grid LoRA search debounce renders once for a fast-typed word',
    gridLoraSearch.during == gridLoraSearch.baseline && gridLoraSearch.after == gridLoraSearch.baseline + 2,
    JSON.stringify({ baseline: gridLoraSearch.baseline, during: gridLoraSearch.during, after: gridLoraSearch.after }));
check('debounced grid LoRA search matches the undebounced filter',
    gridLoraSearch.shown.join(',') == gridLoraSearch.expected.join(','),
    `${gridLoraSearch.shown.join(',')} vs ${gridLoraSearch.expected.join(',')}`);
check('clearing the grid LoRA search renders immediately',
    gridLoraSearch.cleared == gridLoraSearch.after + 1, `${gridLoraSearch.cleared} vs ${gridLoraSearch.after}`);

// ---- Permission ----
const denied = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    permissions.hasPermission = () => false;
    mUI.toastBox = null;
    for (let toast of document.querySelectorAll('.m-toast')) {
        toast.remove();
    }
    mGrid.open();
    permissions.hasPermission = () => true;
    return {
        opened: !!document.querySelector('.m-grid-card'),
        toast: document.querySelector('.m-toast') ? document.querySelector('.m-toast').textContent : ''
    };
});
check('no grid permission means no sheet and a reason',
    !denied.opened && denied.toast == 'You do not have grid generation permission.', JSON.stringify(denied));

// ---- Fields are 16px, or iOS zooms the page on focus ----
const fontSizes = await page.evaluate(() => {
    mGrid.open();
    for (let card of __sheet().querySelectorAll('.m-grid-card')) {
        card.open = true;
    }
    return [...__sheet().querySelectorAll('.m-grid-custom-input, .m-grid-search')]
        .map(e => getComputedStyle(e).fontSize);
});
check('every grid input is at least 16px', fontSizes.length > 0 && fontSizes.every(size => parseFloat(size) >= 16), fontSizes.join(','));

// ---- LoRA Strength, LoRA Section, Aspect Ratio, Prompt Replace ----
/** Reopens the sheet with this selection and reports what its Run button would do. */
const gridState = selected => page.evaluate(selected => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mGrid.selected = selected;
    window.__grid = null;
    mGrid.open();
    let run = __sheet().querySelector('.m-grid-run');
    return { disabled: run.disabled, count: __sheet().querySelector('.m-grid-count').textContent };
}, selected);
/** Clicks Run and returns the sent axes as mode -> vals. */
const gridSent = async () => {
    await page.evaluate(() => __sheet().querySelector('.m-grid-run').click());
    await page.waitForFunction(() => window.__grid);
    return page.evaluate(() => Object.fromEntries(window.__grid.axes.map(a => [a.mode, a.vals])));
};
const cardOf = name => page.evaluate(name => {
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == name);
    return [...card.querySelectorAll('.m-grid-option')].map(e => e.textContent);
}, name);

let state = await gridState({ loraweights: ['0.5', '1'] });
check('LoRA Strength with no LoRA axis cannot run, and says why',
    state.disabled && state.count == 'Pick a LoRA in the LoRAs axis first.', JSON.stringify(state));
state = await gridState({ loraconfinement: ['5', '1'] });
check('LoRA Section with no LoRA axis cannot run either', state.disabled, JSON.stringify(state));
check('LoRA Section offers the Create tab sections', (await cardOf('LoRA Section')).join(',') == 'Full,Base,Refine',
    (await cardOf('LoRA Section')).join(','));

state = await gridState({ loras: ['ill/style_a'], loraweights: ['0.5', '1'], loraconfinement: ['5', '1'] });
check('with a LoRA picked, the two LoRA axes multiply', !state.disabled && state.count == '4 images', JSON.stringify(state));
const sectionSummary = await page.evaluate(() => [...__sheet().querySelectorAll('.m-grid-card')]
    .find(c => c.querySelector('.m-grid-card-name').textContent == 'LoRA Section').querySelector('.m-grid-card-summary').textContent);
check('the section summary uses names, not section IDs', sectionSummary == '2: Base, Refine', sectionSummary);
let sent = await gridSent();
check('strength and section go out under their server parameter IDs with raw values',
    sent.loraweights == '0.5,1' && sent.lorasectionconfinement == '5,1' && sent.loras == 'ill/style_a', JSON.stringify(sent));

await gridState({ aspectratio: ['1:1', '16:9'] });
check('the Aspect Ratio axis lists the server values without Custom',
    (await cardOf('Aspect Ratio')).join(',') == '1:1 (Square),16:9 (Standard Widescreen)', (await cardOf('Aspect Ratio')).join(','));
sent = await gridSent();
check('the Aspect Ratio axis sends raw ratios', sent.aspectratio == '1:1,16:9', JSON.stringify(sent));

// Typed through the real field: a comma in prompt text must stay inside one value.
await gridState({});
await page.evaluate(() => {
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Prompt Replace');
    let input = card.querySelector('.m-grid-custom-input');
    let add = card.querySelector('.m-grid-add-button');
    for (let value of ['red hair, tall', 'blue hair, short', 'score=9']) {
        input.value = value;
        add.click();
    }
});
const replaceValues = await page.evaluate(() => mGrid.valuesFor('promptreplace'));
check('a Prompt Replace value keeps its commas',
    replaceValues.join('|') == 'red hair, tall|blue hair, short|score=9', replaceValues.join('|'));
sent = await gridSent();
check('Prompt Replace sends every cell as find=value, split on ||',
    sent.gridgenpromptreplace == 'red hair, tall=red hair, tall||red hair, tall=blue hair, short||red hair, tall=score=9',
    sent.gridgenpromptreplace);

state = await gridState({ promptreplace: ['cat'], steps: ['20', '30'] });
sent = await gridSent();
check('a lone Prompt Replace value replaces nothing, so no axis is sent',
    !('gridgenpromptreplace' in sent) && sent.steps == '20,30', JSON.stringify(sent));

state = await gridState({ promptreplace: ['ARTISTS || @a || @b'] });
check('a Prompt Replace list on its own is a ready grid',
    !state.disabled && state.count == '3 images', JSON.stringify(state));
sent = await gridSent();
check('that list is sent as find=value for every cell',
    sent.gridgenpromptreplace == 'ARTISTS=ARTISTS||ARTISTS=@a||ARTISTS=@b', sent.gridgenpromptreplace);
state = await gridState({ promptreplace: ['ARTISTS'] });
check('a Prompt Replace key with no replacement values is not ready',
    state.disabled && state.count == '1 image', JSON.stringify(state));
state = await gridState({ promptreplace: [' || '] });
check('a blank Prompt Replace axis is not ready',
    state.disabled && state.count == 'No axes set yet.', JSON.stringify(state));
state = await gridState({ promptreplace: ['ARTISTS || @a || @b'], steps: ['20', '30'] });
check('Prompt Replace cells still multiply with another axis',
    !state.disabled && state.count == '6 images', JSON.stringify(state));
sent = await gridSent();
check('both axes are sent, with the list expanded',
    sent.gridgenpromptreplace == 'ARTISTS=ARTISTS||ARTISTS=@a||ARTISTS=@b' && sent.steps == '20,30', JSON.stringify(sent));

await gridState({});
const pastedReplace = await page.evaluate(() => {
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Prompt Replace');
    let input = card.querySelector('.m-grid-custom-input');
    input.value = 'ARTISTS || @a || @b, still one';
    card.querySelector('.m-grid-add-button').click();
    return {
        values: mGrid.valuesFor('promptreplace').join('|'),
        disabled: __sheet().querySelector('.m-grid-run').disabled,
        count: __sheet().querySelector('.m-grid-count').textContent
    };
});
check('pasting a key || value list fills the axis and marks it ready',
    pastedReplace.values == 'ARTISTS|@a|@b, still one' && !pastedReplace.disabled && pastedReplace.count == '3 images',
    JSON.stringify(pastedReplace));
const reloadedReplace = await page.evaluate(() => {
    let previous = localStorage.getItem('m_client_grid_selected');
    localStorage.setItem('m_client_grid_selected', JSON.stringify({ promptreplace: ['ARTISTS || @a || @b'], steps: ['20'] }));
    let loaded = MGrid.loadSelected();
    if (previous == null) {
        localStorage.removeItem('m_client_grid_selected');
    }
    else {
        localStorage.setItem('m_client_grid_selected', previous);
    }
    return loaded;
});
check('a saved Prompt Replace list reloads as one cell per value',
    reloadedReplace.promptreplace.join('|') == 'ARTISTS|@a|@b' && reloadedReplace.steps.join('|') == '20',
    JSON.stringify(reloadedReplace));

await gridState({ promptreplace: ['a=b', 'c'] });
await page.evaluate(() => __sheet().querySelector('.m-grid-run').click());
const blockedFind = await page.evaluate(() => ({
    grid: window.__grid, toast: document.querySelector('.m-toast') ? document.querySelector('.m-toast').textContent : ''
}));
check('find text with "=" is refused with a reason, not sent wrong',
    blockedFind.grid == null && blockedFind.toast.includes('cannot contain'), JSON.stringify(blockedFind));

// ---- Picking a value must not move what is under the finger ----
// Long names, so the chips would wrap onto new rows if the strip allowed it.
const layoutShifts = await page.evaluate(async () => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    let rows = [];
    for (let i = 0; i < 40; i++) {
        rows.push({ name: `ill/a_rather_long_lora_name_for_wrapping_${`${i}`.padStart(2, '0')}.safetensors`,
            title: '', compat_class: 'anima-2.9b', architecture: 'anima-2.9b/lora' });
    }
    mCreate.loraList = rows;
    mGrid.selected = {};
    mGrid.open();
    let sheet = __sheet();
    let card = [...sheet.querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'LoRAs');
    card.open = true;
    let cards = sheet.querySelector('.m-grid-cards');
    let list = card.querySelector('.m-grid-lora-options');
    let frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await frames();
    await new Promise(resolve => setTimeout(resolve, 350));
    cards.scrollTop = 40;
    list.scrollTop = 300;
    await frames();
    let shifts = [];
    for (let i = 20; i < 26; i++) {
        let label = `a_rather_long_lora_name_for_wrapping_${i}`;
        let row = () => [...list.querySelectorAll('.m-grid-option')].find(o => o.textContent == label);
        list.scrollTop = row().offsetTop - list.offsetTop - 60;
        await frames();
        let before = { top: row().getBoundingClientRect().top, list: list.scrollTop, cards: cards.scrollTop, sheet: sheet.getBoundingClientRect().top };
        row().click();
        await frames();
        shifts.push({ row: row().getBoundingClientRect().top - before.top, list: list.scrollTop - before.list,
            cards: cards.scrollTop - before.cards, sheet: sheet.getBoundingClientRect().top - before.sheet });
    }
    return { shifts, picked: mGrid.valuesFor('loras').length };
});
check('six LoRA picks are all recorded', layoutShifts.picked == 6, `${layoutShifts.picked}`);
check('picking a LoRA leaves the tapped row, both scrollers and the sheet where they were',
    layoutShifts.shifts.every(s => Math.abs(s.row) < 1 && s.list == 0 && s.cards == 0 && Math.abs(s.sheet) < 1),
    JSON.stringify(layoutShifts.shifts));

// A Prompt Replace value has no option row to untoggle it, so its x has to stay reachable however long it is.
await gridState({ promptreplace: ['a very long prompt phrase '.repeat(6), 'b'] });
const longChip = await page.evaluate(() => {
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Prompt Replace');
    card.open = true;
    let strip = card.querySelector('.m-grid-chosen');
    let chip = strip.querySelector('.m-grid-chip');
    let x = chip.querySelector('.m-grid-chip-x');
    let sheetWidth = __sheet().getBoundingClientRect().width;
    let clipped = x.getBoundingClientRect().right > chip.getBoundingClientRect().right;
    strip.scrollLeft = strip.scrollWidth;
    return { clipped, scrolls: strip.scrollWidth > strip.clientWidth, sheetWidth, viewport: innerWidth,
        pageOverflow: document.documentElement.scrollWidth > innerWidth, height: strip.getBoundingClientRect().height };
});
check('a long chip scrolls inside its strip with its x unclipped, and the page does not scroll sideways',
    !longChip.clipped && longChip.scrolls && !longChip.pageOverflow && longChip.sheetWidth <= longChip.viewport && longChip.height == 32,
    JSON.stringify(longChip));

// ---- A long LoRA name is cut from the start, so its version stays readable ----
const tailNames = await page.evaluate(async () => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    let longName = 'a_really_long_lora_name_(style)_with_many_words_that_will_not_fit_on_one_row-v1.5';
    let savedLoras = mCreate.loraList;
    mCreate.loraList = [{ name: `ill/${longName}.safetensors`, title: '', compat_class: 'anima-2.9b' },
        { name: 'ill/short_v2.safetensors', title: '', compat_class: 'anima-2.9b' }];
    mGrid.selected = { loras: [`ill/${longName}`] };
    mGrid.open();
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'LoRAs');
    card.open = true;
    await new Promise(resolve => setTimeout(resolve, 350));
    let measure = label => {
        let text = label.querySelector('bdi').firstChild;
        let range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 1);
        let first = range.getBoundingClientRect();
        range.setStart(text, text.length - 1);
        range.setEnd(text, text.length);
        let last = range.getBoundingClientRect();
        let box = label.getBoundingClientRect();
        return { firstCut: first.left < box.left - 1, firstAtLeft: Math.abs(first.left - box.left) < 2, lastShown: last.right <= box.right + 1 && last.left >= box.left, firstBeforeLast: first.left < last.left };
    };
    let rows = [...card.querySelectorAll('.m-grid-lora-options .m-grid-tail')];
    let row = rows.find(r => r.textContent == longName);
    let shortRow = rows.find(r => r.textContent == 'short_v2');
    let chip = card.querySelector('.m-grid-chosen .m-grid-chip');
    let x = chip.querySelector('.m-grid-chip-x').getBoundingClientRect();
    let chipBox = chip.getBoundingClientRect();
    let strip = card.querySelector('.m-grid-chosen').getBoundingClientRect();
    mCreate.loraList = savedLoras;
    return { row: measure(row), short: measure(shortRow), chip: measure(chip.querySelector('.m-grid-tail')),
        xInChip: x.right <= chipBox.right + 1, chipFits: chipBox.right <= strip.right + 1, rowText: row.textContent };
});
check('a long LoRA row shows the end of its name, cut at the start, in reading order',
    tailNames.row.firstCut && tailNames.row.lastShown && tailNames.row.firstBeforeLast, JSON.stringify(tailNames.row));
check('a short LoRA row is whole and sits on the left', !tailNames.short.firstCut && tailNames.short.firstAtLeft && tailNames.short.lastShown, JSON.stringify(tailNames.short));
check('a long LoRA chip shows the end of its name and keeps its x on screen',
    tailNames.chip.firstCut && tailNames.chip.lastShown && tailNames.xInChip && tailNames.chipFits, JSON.stringify(tailNames));

// ---- Grid mode: Generate runs the saved axes ----
const modeState = () => page.evaluate(() => ({
    button: mCreate.genButton.textContent,
    target: mCreate.genTargetLabel.textContent,
    sheet: !!document.querySelector('.m-grid-sheet'),
    grid: window.__grid,
    single: window.__single,
    toast: document.querySelector('.m-toast') ? document.querySelector('.m-toast').textContent : ''
}));
/** Clears sheets and spies, applies a selection and repaints. */
const modeSetup = (selected, prompt = 'a cat') => page.evaluate(({ selected, prompt }) => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    window.__grid = null;
    window.__single = 0;
    mGen.generate = () => { window.__single++; };
    mState.params['prompt'] = prompt;
    mGrid.starting = false;
    mGrid.selected = selected;
    mCreate.renderGenTarget();
}, { selected, prompt });

await modeSetup({ steps: ['20', '30'] });
await page.evaluate(() => mCreate.openGenTargetSheet());
const sheetModes = await page.evaluate(() => {
    let sheet = __sheet();
    let buttons = [...sheet.querySelectorAll('.m-gen-mode .m-seg-button')];
    let labels = buttons.map(b => b.textContent);
    let selectedBefore = buttons.find(b => b.classList.contains('m-selected')).textContent;
    let beforeGen = mCreate.genButton.textContent;
    buttons[1].click();
    return { labels, selectedBefore, beforeGen, active: mGrid.active, stored: localStorage.getItem('m_client_grid_mode'),
        selectedAfter: buttons.find(b => b.classList.contains('m-selected')).textContent, stillOpen: document.contains(sheet) };
});
check('the Generate on sheet offers Single and Grid, starting on Single',
    sheetModes.labels.join(',') == 'Single,Grid' && sheetModes.selectedBefore == 'Single' && sheetModes.beforeGen == 'Generate', JSON.stringify(sheetModes));
check('choosing Grid is saved and leaves the sheet open to pick a backend',
    sheetModes.active && sheetModes.stored == 'grid' && sheetModes.selectedAfter == 'Grid' && sheetModes.stillOpen, JSON.stringify(sheetModes));
let mode = await modeState();
check('Grid mode renames both halves of the button, with the image count', mode.button == 'Run Grid (2)' && mode.target == 'Grid Hub', JSON.stringify(mode));

await modeSetup({ steps: ['20', '30'] });
await page.evaluate(() => mCreate.doGenerate());
await page.waitForFunction(() => window.__grid);
mode = await modeState();
check('a Generate tap runs the saved grid, with no sheet and no single batch',
    !mode.sheet && mode.single == 0 && mode.grid.axes[0].mode == 'steps' && mode.grid.axes[0].vals == '20,30', JSON.stringify(mode.grid.axes));

await modeSetup({});
await page.evaluate(() => mCreate.doGenerate());
mode = await modeState();
check('with nothing saved the button says so, and a tap opens the sheet', mode.button == 'Set Up Grid' && mode.sheet && !mode.grid, JSON.stringify(mode));

await modeSetup({ promptreplace: ['ARTISTS || @a || @b'] });
await page.evaluate(() => mGrid.setActive(true));
mode = await modeState();
check('Grid mode treats a Prompt Replace list as ready', mode.button == 'Run Grid (3)' && mode.target == 'Grid Hub', JSON.stringify(mode));
await page.evaluate(() => mCreate.doGenerate());
await page.waitForFunction(() => window.__grid);
mode = await modeState();
check('a Generate tap runs that Prompt Replace grid',
    !mode.sheet && mode.single == 0 && mode.grid.axes.length == 1
        && mode.grid.axes[0].mode == 'gridgenpromptreplace'
        && mode.grid.axes[0].vals == 'ARTISTS=ARTISTS||ARTISTS=@a||ARTISTS=@b',
    JSON.stringify(mode.grid && mode.grid.axes));

await modeSetup({ promptreplace: ['ARTISTS'] });
await page.evaluate(() => mCreate.doGenerate());
mode = await modeState();
check('a Prompt Replace key alone still opens the sheet', mode.button == 'Set Up Grid' && mode.sheet && !mode.grid, JSON.stringify(mode));

await modeSetup({ loraweights: ['0.5', '1'] });
await page.evaluate(() => mCreate.doGenerate());
mode = await modeState();
check('an axis that cannot run opens the sheet rather than starting', mode.button == 'Set Up Grid' && mode.sheet && !mode.grid, JSON.stringify(mode));

await modeSetup({ steps: ['20', '30'] }, '');
await page.evaluate(() => mCreate.doGenerate());
mode = await modeState();
check('an empty prompt is refused with a reason', !mode.grid && mode.toast.includes('Type a prompt'), JSON.stringify(mode));

// The grid must run where the button says. Each cell carries the pin, so a slow reply must not double-start.
await modeSetup({ steps: ['20', '30'] });
const pinned = await page.evaluate(async () => {
    let real = window.genericRequest;
    let calls = 0;
    window.genericRequest = (route, args, callback, depth, onError) => {
        if (route != 'ListBackends') {
            return real(route, args, callback, depth, onError);
        }
        calls++;
        setTimeout(() => callback({ a: { id: 7, type: 'comfyui', status: 'running', title: 'Hub GPU', can_load_models: true },
            b: { id: 9, type: 'swarmswarmbackend', status: 'running', title: 'Spoke', can_load_models: true } }), 20);
    };
    let runs = 0;
    let runGrid = mGen.runGrid;
    mGen.runGrid = (base, axes, opts) => { runs++; runGrid(base, axes, opts); };
    mCreate.doGenerate();
    mCreate.doGenerate();
    await new Promise(resolve => setTimeout(resolve, 150));
    window.genericRequest = real;
    mGen.runGrid = runGrid;
    return { calls, runs, pin: window.__grid && window.__grid.base.exactbackendid };
});
check('a double tap starts one grid, pinned to the chosen backend', pinned.calls == 1 && pinned.runs == 1 && `${pinned.pin}` == '7', JSON.stringify(pinned));

// Saved values come back after a reload, and a damaged entry cannot break the page.
const saved = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mGrid.selected = {};
    mGrid.open();
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(c => c.querySelector('.m-grid-card-name').textContent == 'Steps');
    card.open = true;
    let quick = card.querySelector('.m-grid-quick-button');
    quick.click();
    let stored = JSON.parse(localStorage.getItem('m_client_grid_selected'));
    let loaded = MGrid.loadSelected();
    localStorage.setItem('m_client_grid_selected', '{not json');
    let damaged = MGrid.loadSelected();
    localStorage.setItem('m_client_grid_selected', JSON.stringify({ steps: ['8', 5], unknown: ['x'], cfgscale: 'no' }));
    let filtered = MGrid.loadSelected();
    return { stored, loaded, damaged, filtered, activeLoaded: MGrid.loadActive() };
});
check('axis picks are saved and reload, and Grid mode survives a reload',
    saved.stored.steps[0] == '4' && saved.loaded.steps[0] == '4' && saved.activeLoaded, JSON.stringify(saved));
check('a damaged or foreign saved entry is dropped safely',
    Object.keys(saved.damaged).length == 0 && JSON.stringify(saved.filtered) == '{"steps":["8"]}', JSON.stringify(saved));

await page.evaluate(() => {
    mGrid.setActive(false);
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
});
await modeSetup({ steps: ['20', '30'] });
await page.evaluate(() => mCreate.doGenerate());
await page.waitForFunction(() => window.__single > 0);
mode = await modeState();
check('Single mode still generates one batch', mode.button == 'Generate' && mode.target == 'Hub' && mode.single == 1 && !mode.grid, JSON.stringify(mode));

// ---- Sections start collapsed, remember what was left open, and Reset Params puts them back ----
await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mGrid.sheetContent = null;
    mGrid.sheetClose = null;
    mGrid.reset();
});
const sectionStart = await page.evaluate(() => {
    mGrid.open();
    let cards = [...__sheet().querySelectorAll('.m-grid-card')];
    let allClosed = cards.every(card => !card.open);
    let chevron = cards[0].querySelector('.m-grid-card-chevron');
    let closed = getComputedStyle(chevron).transform;
    let steps = cards.find(card => card.querySelector('.m-grid-card-name').textContent == 'Steps');
    let cfg = cards.find(card => card.querySelector('.m-grid-card-name').textContent == 'CFG Scale');
    steps.querySelector('summary').click();
    let opened = getComputedStyle(steps.querySelector('.m-grid-card-chevron')).transform;
    steps.querySelector('summary').click();
    let closedAgain = !steps.open && !cfg.open && localStorage.getItem('m_client_grid_open') == null;
    steps.querySelector('summary').click();
    return {
        count: cards.length,
        chevrons: cards.filter(card => card.querySelector('.m-grid-card-chevron')).length,
        allClosed,
        stepsOpen: steps.open,
        cfgStillClosed: !cfg.open,
        markerHidden: getComputedStyle(steps.querySelector('summary'), '::marker').content,
        transformChanged: closed != opened && opened != 'none',
        closedAgain
    };
});
check('grid sections start collapsed, with a chevron on every header',
    sectionStart.count == 10 && sectionStart.chevrons == 10 && sectionStart.allClosed
    && (sectionStart.markerHidden == 'none' || sectionStart.markerHidden == '""' || sectionStart.markerHidden == ''),
    JSON.stringify(sectionStart));
check('a section header toggles only that section, and the chevron changes',
    sectionStart.stepsOpen && sectionStart.cfgStillClosed && sectionStart.transformChanged && sectionStart.closedAgain,
    JSON.stringify(sectionStart));

const sectionMemory = await page.evaluate(async () => {
    mGrid.sheetClose();
    await new Promise(resolve => setTimeout(resolve, 400));
    mGrid.open();
    let cards = [...__sheet().querySelectorAll('.m-grid-card')];
    let openOf = name => cards.find(card => card.querySelector('.m-grid-card-name').textContent == name).open;
    let stored = JSON.parse(localStorage.getItem('m_client_grid_open') || '{}');
    return { steps: openOf('Steps'), cfg: openOf('CFG Scale'), sampler: openOf('Sampler'), stored };
});
check('an opened section is remembered after the sheet is closed and opened again',
    sectionMemory.steps && !sectionMemory.cfg && !sectionMemory.sampler && sectionMemory.stored.steps == true
    && sectionMemory.stored.cfgscale == null, JSON.stringify(sectionMemory));

const gridReset = await page.evaluate(() => {
    localStorage.setItem('m_client_haptics', 'off');
    localStorage.setItem('m_client_img_sort', 'Name A-Z');
    localStorage.setItem('m_client_resolved_collapsed', '0');
    localStorage.setItem('models_LoRA_sort_by', 'Name');
    mState.params.prompt = 'a cat';
    mState.params.filenameprefix = 'keep-prefix';
    mGrid.selected = { steps: ['20', '30'], promptreplace: ['cat', 'dog'] };
    mGrid.saveSelected();
    mGrid.rows = 3;
    MGrid.saveRowsPref(3);
    mGrid.setActive(true);
    mGrid.openSections = { steps: true, cfgscale: true };
    mGrid.setSectionOpen('steps', true);
    mGrid.setSectionOpen('cfgscale', true);
    mCreate.renderGenTarget();
    let before = { button: mCreate.genButton.textContent, target: mCreate.genTargetLabel.textContent };
    mCreate.openGenTargetSheet();
    let modeBefore = [...__sheet().querySelectorAll('.m-gen-mode .m-seg-button')]
        .find(button => button.classList.contains('m-selected')).textContent;
    mState.resetParams();
    let sheet = mGrid.sheetContent;
    let cards = [...sheet.querySelectorAll('.m-grid-card')];
    let modeButtons = [...document.querySelectorAll('.m-gen-mode .m-seg-button')];
    return {
        before,
        modeBefore,
        prompt: mState.params.prompt,
        prefix: mState.params.filenameprefix,
        selected: mGrid.selected,
        active: mGrid.active,
        rows: mGrid.rows,
        open: mGrid.openSections,
        storedSelected: localStorage.getItem('m_client_grid_selected'),
        storedMode: localStorage.getItem('m_client_grid_mode'),
        storedRows: localStorage.getItem('m_client_grid_rows'),
        storedOpen: localStorage.getItem('m_client_grid_open'),
        haptics: localStorage.getItem('m_client_haptics'),
        sort: localStorage.getItem('m_client_img_sort'),
        resolved: localStorage.getItem('m_client_resolved_collapsed'),
        loraSort: localStorage.getItem('models_LoRA_sort_by'),
        button: mCreate.genButton.textContent,
        target: mCreate.genTargetLabel.textContent,
        count: sheet.querySelector('.m-grid-count').textContent,
        runDisabled: sheet.querySelector('.m-grid-run').disabled,
        summariesOff: cards.every(card => card.querySelector('.m-grid-card-summary').textContent == 'off'),
        allCollapsed: cards.every(card => !card.open),
        rowsLabel: [...sheet.querySelectorAll('.m-grid-layout-button')].find(button => button.classList.contains('m-selected')).textContent,
        modeAfter: modeButtons.filter(button => button.classList.contains('m-selected')).map(button => button.textContent).join(',')
    };
});
check('resetParams clears grid axes, mode, rows, and open sections from memory and storage',
    Object.keys(gridReset.selected).length == 0 && gridReset.active == false && gridReset.rows == 0
    && Object.keys(gridReset.open).length == 0
    && gridReset.storedSelected == null && gridReset.storedMode == null
    && gridReset.storedRows == null && gridReset.storedOpen == null, JSON.stringify(gridReset));
check('resetParams leaves the filename prefix and non-grid client prefs',
    gridReset.prefix == 'keep-prefix' && gridReset.prompt == ''
    && gridReset.haptics == 'off' && gridReset.sort == 'Name A-Z'
    && gridReset.resolved == '0' && gridReset.loraSort == 'Name', JSON.stringify(gridReset));
check('an open grid sheet and the Generate button return to the empty Single defaults',
    gridReset.before.button == 'Run Grid (4)' && gridReset.before.target == 'Grid Hub'
    && gridReset.button == 'Generate' && gridReset.target == 'Hub'
    && gridReset.count == 'No axes set yet.' && gridReset.runDisabled
    && gridReset.summariesOff && gridReset.allCollapsed && gridReset.rowsLabel == 'Auto', JSON.stringify(gridReset));
check('an open Generate-on sheet returns to Single',
    gridReset.modeBefore == 'Grid' && gridReset.modeAfter == 'Single', JSON.stringify(gridReset));

const resetButton = await page.evaluate(() => {
    mGrid.selected = { cfgscale: ['1', '2'] };
    mGrid.saveSelected();
    mGrid.setActive(true);
    mGrid.rows = 2;
    MGrid.saveRowsPref(2);
    mGrid.setSectionOpen('sampler', true);
    mState.params.filenameprefix = 'keep-prefix';
    let seen = '';
    let original = window.confirm;
    window.confirm = message => { seen = message; return true; };
    mCreate.resetButton.click();
    window.confirm = original;
    return {
        seen,
        active: mGrid.active,
        rows: mGrid.rows,
        selected: mGrid.selected,
        storedOpen: localStorage.getItem('m_client_grid_open'),
        prefix: mState.params.filenameprefix,
        button: mCreate.genButton.textContent
    };
});
check('the Reset Params button clears the same grid config',
    resetButton.seen.includes('grid') && resetButton.active == false && resetButton.rows == 0
    && Object.keys(resetButton.selected).length == 0 && resetButton.storedOpen == null
    && resetButton.prefix == 'keep-prefix' && resetButton.button == 'Generate', JSON.stringify(resetButton));

// ---- Enter in a value field adds like the Add button. Search fields are not value fields. ----
const enterAdd = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mGrid.sheetContent = null;
    mGrid.sheetClose = null;
    mGrid.reset();
    mState.params.prompt = 'a cat';
    window.__grid = null;
    window.__single = 0;
    mGen.generate = () => { window.__single++; };
    mGrid.open();
    let card = name => [...__sheet().querySelectorAll('.m-grid-card')]
        .find(item => item.querySelector('.m-grid-card-name').textContent == name);
    let enter = (input, patch) => {
        let event = new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
            isComposing: !!(patch && patch.isComposing)
        });
        if (patch && patch.keyCode != null) {
            Object.defineProperty(event, 'keyCode', { configurable: true, get: () => patch.keyCode });
        }
        input.dispatchEvent(event);
        return { prevented: event.defaultPrevented, keyCode: event.keyCode };
    };
    let replace = card('Prompt Replace').querySelector('.m-grid-custom-input');
    replace.value = 'red || blue';
    let replaceEnter = enter(replace);
    let replaceValues = mGrid.valuesFor('promptreplace').join('|');
    let replaceCleared = replace.value;
    let steps = card('Steps').querySelector('.m-grid-custom-input');
    steps.value = '12, 18, 12';
    let stepsEnter = enter(steps);
    let stepsValues = mGrid.valuesFor('steps').join('|');
    steps.value = '12';
    enter(steps);
    let stepsDeduped = mGrid.valuesFor('steps').join('|');
    steps.value = '   ';
    let emptyEnter = enter(steps);
    let afterEmpty = mGrid.valuesFor('steps').join('|');
    let emptyLeft = steps.value;
    steps.value = '99';
    let composing = enter(steps, { isComposing: true });
    let afterComposing = mGrid.valuesFor('steps').join('|');
    let ime = enter(steps, { keyCode: 229 });
    let afterIme = mGrid.valuesFor('steps').join('|');
    let search = card('LoRAs').querySelector('.m-grid-search');
    search.value = 'style_a';
    let searchEnter = enter(search);
    return {
        replaceEnter, replaceValues, replaceCleared,
        stepsEnter, stepsValues, stepsDeduped,
        emptyEnter, afterEmpty, emptyLeft,
        composing, afterComposing, ime, afterIme,
        searchEnter,
        loras: mGrid.valuesFor('loras').join('|'),
        searchValue: search.value,
        runs: window.__grid,
        single: window.__single
    };
});
check('Enter in Prompt Replace adds like Add, including a || list',
    enterAdd.replaceValues == 'red|blue' && enterAdd.replaceCleared == '' && enterAdd.replaceEnter.prevented,
    JSON.stringify(enterAdd));
check('Enter in another axis adds a comma list, trimmed and de-duplicated',
    enterAdd.stepsValues == '12|18' && enterAdd.stepsDeduped == '12|18' && enterAdd.stepsEnter.prevented,
    JSON.stringify(enterAdd));
check('empty Enter adds nothing and still does not submit',
    enterAdd.afterEmpty == '12|18' && enterAdd.emptyLeft.trim() == '' && enterAdd.emptyEnter.prevented
    && enterAdd.runs == null && enterAdd.single == 0, JSON.stringify(enterAdd));
check('IME composition and keyCode 229 do not add',
    enterAdd.afterComposing == '12|18' && enterAdd.afterIme == '12|18'
    && enterAdd.composing.prevented == false && enterAdd.ime.prevented == false
    && enterAdd.ime.keyCode == 229, JSON.stringify(enterAdd));
check('Enter in a LoRA or Preset search does not add the search text',
    enterAdd.loras == '' && enterAdd.searchEnter.prevented == false, JSON.stringify(enterAdd));

// ---- One-cell axes are base params. More than three varying axes still runs, as Just Images. ----
const folded = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mState.params['prompt'] = 'a cat';
    mState.setLoras([]);
    mGrid.starting = false;
    mGrid.selected = {
        preset: ['a/one', 'a/two', 'a/three', 'a/four', 'a/five'],
        loras: ['ill/style_a', 'ill/style_b'],
        loraweights: ['1'],
        loraconfinement: ['0'],
        promptreplace: ['cat', 'dog', 'wolf', 'fox', 'bird', 'fish', 'frog']
    };
    window.__grid = null;
    mGrid.open();
    let run = __sheet().querySelector('.m-grid-run');
    let count = __sheet().querySelector('.m-grid-count').textContent;
    run.click();
    let payload = window.__grid;
    let modes = payload.axes.map(a => a.mode).sort();
    let weights = MState.toList(payload.base.loraweights);
    let confs = MState.toList(payload.base.lorasectionconfinement);
    return {
        disabled: run.disabled,
        count,
        modes,
        weights: weights[weights.length - 1],
        section: confs[confs.length - 1],
        outputType: payload.opts && payload.opts.outputType,
        loraVals: payload.axes.find(a => a.mode == 'loras').vals
    };
});
check('five presets, two LoRAs and seven replacements count as 70, and the one-value LoRA axes do not',
    !folded.disabled && folded.count == '70 images' && folded.modes.join(',') == 'gridgenpresets,gridgenpromptreplace,loras',
    JSON.stringify(folded));
check('that run sends Grid Image, and the one strength and section are on the base LoRA list',
    folded.outputType == 'Grid Image' && folded.weights == '1' && folded.section == '0'
    && folded.loraVals == 'ill/style_a||ill/style_b',
    JSON.stringify(folded));

const justImages = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mState.params['prompt'] = 'a cat';
    mGrid.starting = false;
    mGrid.selected = {
        preset: ['a/one', 'a/two'],
        loras: ['ill/style_a', 'ill/style_b'],
        steps: ['20', '30'],
        sampler: ['euler', 'er_sde']
    };
    window.__grid = null;
    mGrid.open();
    let count = __sheet().querySelector('.m-grid-count').textContent;
    let run = __sheet().querySelector('.m-grid-run');
    run.click();
    return {
        disabled: run.disabled,
        count,
        modes: window.__grid.axes.map(a => a.mode).sort(),
        outputType: window.__grid.opts && window.__grid.opts.outputType
    };
});
check('four varying axes still start, as Just Images, and the count says there is no combined image',
    !justImages.disabled && justImages.modes.length == 4 && justImages.outputType == 'Just Images'
    && justImages.count == '16 images, no combined grid image',
    JSON.stringify(justImages));

const wiredOutput = await page.evaluate(() => {
    let sent = [];
    let previous = window.makeWSRequest;
    window.makeWSRequest = (route, data) => { sent.push({ route, outputType: data.outputType, axes: data.gridAxes.length }); };
    window.__realRunGrid({ prompt: 'a cat' }, [
        { mode: 'steps', vals: '20,30' },
        { mode: 'cfgscale', vals: '1,2' },
        { mode: 'sampler', vals: 'euler,er_sde' }
    ], { outputType: 'Grid Image' });
    window.__realRunGrid({ prompt: 'a cat' }, [
        { mode: 'steps', vals: '20,30' },
        { mode: 'cfgscale', vals: '1,2' },
        { mode: 'sampler', vals: 'euler,er_sde' },
        { mode: 'scheduler', vals: 'normal,karras' }
    ], { outputType: 'Just Images' });
    window.__realRunGrid({ prompt: 'a cat' }, [{ mode: 'steps', vals: '20,30' }], {});
    window.makeWSRequest = previous;
    return sent;
});
check('runGrid sends Grid Image, Just Images, or Grid Image when the caller omits it',
    wiredOutput.length == 3
    && wiredOutput[0].outputType == 'Grid Image' && wiredOutput[0].axes == 3
    && wiredOutput[1].outputType == 'Just Images' && wiredOutput[1].axes == 4
    && wiredOutput[2].outputType == 'Grid Image' && wiredOutput[2].route == 'GridGenRun',
    JSON.stringify(wiredOutput));

// ---- Quick-pick buttons share one width. Name rows and chips do not have to. ----
const quickWidths = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mGrid.selected = {};
    mGrid.open();
    let card = [...__sheet().querySelectorAll('.m-grid-card')]
        .find(item => item.querySelector('.m-grid-card-name').textContent == 'LoRA Strength');
    card.open = true;
    let widths = [...card.querySelectorAll('.m-grid-quick-button')].map(button => button.getBoundingClientRect().width);
    let min = Math.min(...widths);
    let max = Math.max(...widths);
    return { widths, span: max - min, count: widths.length };
});
check('LoRA Strength quick-pick buttons are the same width',
    quickWidths.count == 6 && quickWidths.span <= 1 && quickWidths.widths.every(width => width > 20),
    JSON.stringify(quickWidths));

// ---- A mouse hold opens the grid sheet. A short click still generates, once. ----
await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mGrid.sheetContent = null;
    mGrid.sheetClose = null;
    mState.params['prompt'] = 'a cat';
    mGrid.starting = false;
    mGrid.selected = { steps: ['20', '30'] };
    mGrid.setActive(true);
    mCreate.renderGenTarget();
    window.__grid = null;
    window.__runs = 0;
    let orig = mGen.runGrid;
    mGen.runGrid = (base, axes, opts) => {
        window.__runs++;
        orig(base, axes, opts);
    };
    // Dispatched on the button. A real mouse press in this harness lands on the page body: the preview
    // sits on top of the scrolled Generate row, so elementFromPoint never sees the button.
    let button = document.querySelector('.m-gen-split .m-generate-button');
    window.__pointer = (type, dx) => {
        button.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerId: 1, pointerType: 'mouse', isPrimary: true,
            button: 0, buttons: type == 'pointerup' || type == 'pointercancel' ? 0 : 1,
            clientX: 20 + (dx || 0), clientY: 20
        }));
    };
});
await page.evaluate(() => window.__pointer('pointerdown'));
await page.waitForTimeout(80);
await page.evaluate(() => window.__pointer('pointerup'));
const shortPress = await page.evaluate(() => ({
    runs: window.__runs,
    sheet: !!document.querySelector('.m-grid-sheet'),
    axes: window.__grid && window.__grid.axes && window.__grid.axes[0] && window.__grid.axes[0].vals
}));
check('a short mouse click runs the saved grid once and does not open the sheet',
    shortPress.runs == 1 && !shortPress.sheet && shortPress.axes == '20,30', JSON.stringify(shortPress));

await page.evaluate(() => {
    window.__grid = null;
    window.__runs = 0;
    mGrid.starting = false;
    window.__pointer('pointerdown');
});
await page.waitForFunction(() => !!document.querySelector('.m-grid-card'));
await page.evaluate(() => window.__pointer('pointerup'));
await page.waitForTimeout(100);
const heldPress = await page.evaluate(() => ({
    runs: window.__runs,
    sheet: !!document.querySelector('.m-grid-card'),
    grid: window.__grid
}));
check('holding the mouse on Generate for about 600ms opens the grid sheet and does not run',
    heldPress.runs == 0 && heldPress.sheet && heldPress.grid == null, JSON.stringify(heldPress));

await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    window.__grid = null;
    window.__runs = 0;
    mGrid.starting = false;
    window.__pointer('pointerdown');
    window.__pointer('pointermove', 40);
});
await page.waitForTimeout(700);
await page.evaluate(() => window.__pointer('pointerup', 40));
const slidPress = await page.evaluate(() => ({
    runs: window.__runs,
    sheet: !!document.querySelector('.m-grid-sheet')
}));
check('a mouse press that slides off Generate does not open the sheet or run',
    slidPress.runs == 0 && !slidPress.sheet, JSON.stringify(slidPress));

await page.evaluate(() => document.querySelector('.m-gen-target').click());
const caretOpened = await page.evaluate(() => ({
    modes: [...document.querySelectorAll('.m-gen-mode .m-seg-button')].map(button => button.textContent).join(','),
    runs: window.__runs
}));
check('the target caret still opens its own sheet and does not run the grid',
    caretOpened.modes == 'Single,Grid' && caretOpened.runs == 0, JSON.stringify(caretOpened));

// ---- The search keyboard stays up through a pick, and goes when the list is scrolled ----
// A real mouse click, not element.click(): only a real press moves focus to the tapped button.
for (const [name, listClass, key] of [['LoRAs', '.m-grid-lora-options', 'loras'], ['Preset', '.m-grid-preset-options', 'preset']]) {
    await gridState({});
    const target = await page.evaluate(async ({ name, listClass }) => {
        let card = [...__sheet().querySelectorAll('.m-grid-card')]
            .find(c => c.querySelector('.m-grid-card-name').textContent == name);
        card.open = true;
        await new Promise(resolve => setTimeout(resolve, 350));
        let list = card.querySelector(listClass);
        list.style.maxHeight = '120px';
        card.scrollIntoView();
        let rect = list.querySelector('.m-grid-option').getBoundingClientRect();
        window.__search = card.querySelector('.m-grid-search');
        window.__list = list;
        window.__search.focus();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, { name, listClass });
    await page.mouse.click(target.x, target.y);
    const afterPick = await page.evaluate(key => ({ focused: document.activeElement == window.__search, picked: mGrid.valuesFor(key).length }), key);
    check(`picking from ${name} keeps the search field focused`, afterPick.focused && afterPick.picked == 1, JSON.stringify(afterPick));
    const afterScroll = await page.evaluate(async () => {
        let focusedBefore = document.activeElement == window.__search;
        window.__list.scrollTop = 30;
        await new Promise(resolve => setTimeout(resolve, 100));
        return { focusedBefore, focused: document.activeElement == window.__search, top: window.__list.scrollTop };
    });
    check(`scrolling the ${name} list closes the keyboard`, afterScroll.focusedBefore && afterScroll.top > 0 && !afterScroll.focused, JSON.stringify(afterScroll));
}

// ---- Grid Image defaults on, persists off, and more than three axes forces it off. ----
const gridImage = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mGrid.sheetContent = null;
    mGrid.sheetClose = null;
    mGrid.reset();
    mState.params.prompt = 'a cat';
    mState.params.filenameprefix = 'keep-prefix';
    localStorage.setItem('m_client_haptics', 'off');
    mGrid.selected = { steps: ['20', '30'], cfgscale: ['1', '2'] };
    mGrid.saveSelected();
    window.__grid = null;
    mGrid.starting = false;
    mGrid.open();
    let row = () => [...__sheet().querySelectorAll('.m-grid-layout')]
        .find(item => item.querySelector('.m-grid-layout-label').textContent == 'Grid Image');
    let read = () => {
        let buttons = [...row().querySelectorAll('button')];
        let selected = buttons.find(button => button.classList.contains('m-selected'));
        return {
            label: row().querySelector('.m-grid-layout-label').textContent,
            selected: selected ? selected.textContent : '',
            disabled: buttons.map(button => button.disabled),
            stored: localStorage.getItem('m_client_grid_composite'),
            count: __sheet().querySelector('.m-grid-count').textContent,
            nearRows: row().previousElementSibling.querySelector('.m-grid-layout-label').textContent
        };
    };
    // Run closes the sheet. Drop whatever is left, then open a fresh one.
    let reopen = () => {
        for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
            elem.remove();
        }
        mGrid.sheetContent = null;
        mGrid.sheetClose = null;
        mGrid.starting = false;
        mGrid.open();
    };
    let initial = read();
    __sheet().querySelector('.m-grid-run').click();
    let onType = window.__grid && window.__grid.opts && window.__grid.opts.outputType;
    reopen();
    row().querySelector('button[data-composite="0"]').click();
    let off = read();
    window.__grid = null;
    __sheet().querySelector('.m-grid-run').click();
    let offType = window.__grid && window.__grid.opts && window.__grid.opts.outputType;
    reopen();
    let reopened = read();
    mState.resetParams();
    let reset = read();
    mState.params.prompt = 'a cat';
    mGrid.selected = { steps: ['20', '30'], cfgscale: ['1', '2'] };
    mGrid.saveSelected();
    reopen();
    let resetReady = read();
    window.__grid = null;
    __sheet().querySelector('.m-grid-run').click();
    let resetType = window.__grid && window.__grid.opts && window.__grid.opts.outputType;
    mGrid.selected = {
        preset: ['a/one', 'a/two'],
        loras: ['ill/style_a', 'ill/style_b'],
        steps: ['20', '30'],
        sampler: ['euler', 'er_sde']
    };
    mGrid.saveSelected();
    reopen();
    let forced = read();
    window.__grid = null;
    __sheet().querySelector('.m-grid-run').click();
    let forcedType = window.__grid && window.__grid.opts && window.__grid.opts.outputType;
    let storedWhileForced = localStorage.getItem('m_client_grid_composite');
    mGrid.selected = { steps: ['20', '30'], cfgscale: ['1', '2'], sampler: ['euler', 'er_sde'] };
    mGrid.saveSelected();
    reopen();
    let back = read();
    window.__grid = null;
    __sheet().querySelector('.m-grid-run').click();
    let backType = window.__grid && window.__grid.opts && window.__grid.opts.outputType;
    reopen();
    row().querySelector('button[data-composite="0"]').click();
    mGrid.selected = {
        preset: ['a/one', 'a/two'],
        loras: ['ill/style_a', 'ill/style_b'],
        steps: ['20', '30'],
        sampler: ['euler', 'er_sde']
    };
    mGrid.saveSelected();
    reopen();
    let forcedOff = read();
    mGrid.selected = { steps: ['20', '30'], cfgscale: ['1', '2'] };
    mGrid.saveSelected();
    reopen();
    let preferenceBack = read();
    return {
        initial, onType, off, offType, reopened, reset, resetReady, resetType, forced, forcedType,
        storedWhileForced, back, backType, forcedOff, preferenceBack,
        prefix: mState.params.filenameprefix,
        haptics: localStorage.getItem('m_client_haptics')
    };
});
check('Grid Image sits by Rows and defaults to on, and that run sends Grid Image',
    gridImage.initial.label == 'Grid Image' && gridImage.initial.nearRows == 'Rows'
    && gridImage.initial.selected == 'On' && gridImage.initial.stored == null
    && gridImage.initial.disabled.join(',') == 'false,false'
    && gridImage.initial.count == '4 images' && gridImage.onType == 'Grid Image',
    JSON.stringify(gridImage.initial));
check('turning Grid Image off persists and the run sends Just Images',
    gridImage.off.selected == 'Off' && gridImage.off.stored == '0'
    && gridImage.off.count == '4 images, no combined grid image' && gridImage.offType == 'Just Images'
    && gridImage.reopened.selected == 'Off' && gridImage.reopened.stored == '0',
    JSON.stringify({ off: gridImage.off, reopened: gridImage.reopened, offType: gridImage.offType }));
check('Reset Params turns Grid Image back on and a run of three or fewer axes sends Grid Image',
    gridImage.reset.selected == 'On' && gridImage.reset.stored == null
    && gridImage.reset.count == 'No axes set yet.'
    && gridImage.resetReady.selected == 'On' && gridImage.resetReady.count == '4 images'
    && gridImage.resetType == 'Grid Image'
    && gridImage.prefix == 'keep-prefix' && gridImage.haptics == 'off',
    JSON.stringify({ reset: gridImage.reset, resetReady: gridImage.resetReady, resetType: gridImage.resetType }));
check('more than three varying axes forces Just Images and disables Grid Image without forgetting the default',
    gridImage.forced.selected == 'Off' && gridImage.forced.disabled.join(',') == 'true,true'
    && gridImage.forced.count == '16 images, no combined grid image'
    && gridImage.forcedType == 'Just Images' && gridImage.storedWhileForced == null,
    JSON.stringify(gridImage.forced));
check('dropping back to three or fewer axes honors the saved Grid Image choice',
    gridImage.back.selected == 'On' && gridImage.back.disabled.join(',') == 'false,false'
    && gridImage.backType == 'Grid Image'
    && gridImage.forcedOff.selected == 'Off' && gridImage.forcedOff.stored == '0'
    && gridImage.forcedOff.disabled.join(',') == 'true,true'
    && gridImage.preferenceBack.selected == 'Off' && gridImage.preferenceBack.stored == '0'
    && gridImage.preferenceBack.disabled.join(',') == 'false,false',
    JSON.stringify({ back: gridImage.back, forcedOff: gridImage.forcedOff, preferenceBack: gridImage.preferenceBack }));

// ---- Live preview columns follow width and aspect, including a resize. ----
const previewMath = await page.evaluate(() => ({
    wide: MCreate.previewColumns(1100, 400, 2 / 3, 6, 4.8),
    narrow: MCreate.previewColumns(220, 400, 2 / 3, 6, 4.8),
    one: MCreate.previewColumns(1100, 400, 2 / 3, 1, 4.8),
    landscape: MCreate.previewColumns(1100, 400, 21 / 9, 6, 4.8)
}));
check('preview column math fits at least three portrait cells on a wide row, and fewer on a narrow one',
    previewMath.wide >= 3 && previewMath.narrow < previewMath.wide && previewMath.narrow >= 1
    && previewMath.one == 1 && previewMath.landscape < previewMath.wide,
    JSON.stringify(previewMath));

await page.evaluate(() => {
    mCreate.clearTiles();
    mCreate.currentRequest = null;
    mCreate.previewWrap.style.width = '1100px';
    mCreate.previewWrap.style.maxWidth = 'none';
    mCreate.previewWrap.style.setProperty('--m-preview-h', '400px');
    mState.params.aspectratio = '21:9';
    mState.params.sidelength = '1024';
    let pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    for (let i = 0; i < 6; i++) {
        mCreate.onFrame('progress', { request_id: 'preview-layout', batch_index: i, overall_percent: 0.2, preview: pixel });
    }
});
const previewWideLandscape = await page.evaluate(() => {
    let raw = mCreate.previewGrid.style.gridTemplateColumns;
    let match = /repeat\((\d+)/.exec(raw);
    return { columns: match ? parseInt(match[1], 10) : 0, raw, ratio: mCreate.previewAspectRatio() };
});
const portraitUrl = await page.evaluate(() => {
    let canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 30;
    return canvas.toDataURL('image/png');
});
await page.evaluate(url => {
    mCreate.clearTiles();
    mCreate.currentRequest = null;
    for (let i = 0; i < 6; i++) {
        mCreate.onFrame('progress', { request_id: 'preview-portrait', batch_index: i, overall_percent: 0.2, preview: url });
    }
}, portraitUrl);
await page.waitForFunction(() => {
    let match = /repeat\((\d+)/.exec(mCreate.previewGrid.style.gridTemplateColumns);
    return match && parseInt(match[1], 10) >= 3;
});
const previewWidePortrait = await page.evaluate(() => {
    let raw = mCreate.previewGrid.style.gridTemplateColumns;
    let match = /repeat\((\d+)/.exec(raw);
    let img = mCreate.previewGrid.querySelector('img');
    return {
        columns: match ? parseInt(match[1], 10) : 0,
        raw,
        natural: img ? [img.naturalWidth, img.naturalHeight] : [0, 0]
    };
});
check('a wide preview with portrait cells uses at least three columns',
    previewWidePortrait.columns >= 3 && previewWidePortrait.columns > previewWideLandscape.columns,
    JSON.stringify({ landscape: previewWideLandscape, portrait: previewWidePortrait }));

await page.evaluate(() => { mCreate.previewWrap.style.width = '220px'; });
await page.waitForFunction(() => {
    let match = /repeat\((\d+)/.exec(mCreate.previewGrid.style.gridTemplateColumns);
    return match && parseInt(match[1], 10) < 3;
});
const previewNarrow = await page.evaluate(() => {
    let match = /repeat\((\d+)/.exec(mCreate.previewGrid.style.gridTemplateColumns);
    return match ? parseInt(match[1], 10) : 0;
});
check('a narrow preview uses fewer columns, and resizing the container is what updates them',
    previewNarrow >= 1 && previewNarrow < previewWidePortrait.columns, `${previewNarrow} vs ${previewWidePortrait.columns}`);

await page.evaluate(() => {
    mCreate.clearTiles();
    mCreate.currentRequest = null;
    mCreate.previewWrap.style.width = '1100px';
    mCreate.onFrame('progress', {
        request_id: 'preview-one', batch_index: 0, overall_percent: 0.2,
        preview: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    });
});
const previewOne = await page.evaluate(() => {
    let match = /repeat\((\d+)/.exec(mCreate.previewGrid.style.gridTemplateColumns);
    return {
        columns: match ? parseInt(match[1], 10) : 0,
        height: getComputedStyle(mCreate.previewGrid.querySelector('.m-preview-cell')).height,
        canvas: getComputedStyle(mCreate.previewGrid).height
    };
});
check('a single preview image stays one column',
    previewOne.columns == 1, JSON.stringify(previewOne));

await page.evaluate(() => {
    mCreate.previewWrap.style.width = '';
    mCreate.previewWrap.style.maxWidth = '';
    mCreate.previewWrap.style.removeProperty('--m-preview-h');
    mGrid.reset();
});

await browser.close();
const failed = results.filter(result => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
