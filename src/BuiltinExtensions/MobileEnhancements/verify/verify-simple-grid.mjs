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
    mGen.runGrid = (base, axes) => { window.__grid = { base, axes }; };
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
check('the LoRA axis sorts the matching Anima variant first and dims the others',
    loraDim.map(row => row.name).join(',') == 'style_a,detail,style_b'
    && loraDim.map(row => row.dim).join(',') == 'false,true,true',
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
check('every filled axis is sent, and no empty one is',
    payload.axes.map(a => a.mode).sort().join(',') == 'cfgscale,loras,sampler,steps',
    payload.axes.map(a => a.mode).join(','));
check('the LoRA axis is joined with || so a stacked value stays one cell',
    byMode.loras == 'ill/style_a||ill/style_b', byMode.loras);
check('every other axis is joined with a comma',
    byMode.steps == '20,30' && byMode.sampler == 'euler,er_sde' && byMode.cfgscale == '4.5',
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
check('preset chips use the short name after the folder slash',
    presetPicked.chips.join('|') == presetTitles.map(t => t.split('/').pop()).join('|'),
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

await browser.close();
const failed = results.filter(result => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
