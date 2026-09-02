/**
 * /simple grid builder harness (fork). Covers m_grid.js, the built axis surface that replaced the generic
 * "pick a parameter id, type its values" form behind the Generate long-press. The checks are aimed at the
 * ways a grid can run successfully and measure the wrong thing:
 *
 * 1. The LoRA axis is joined with '||', every other axis with ','. GridGenCore splits an axis on '||' when
 *    the string contains one and on ',' otherwise, and a LoRA axis VALUE can itself be a comma-joined stack
 *    - so joining LoRAs with ',' silently turns one three-LoRA stack into three single-LoRA cells.
 * 2. A LoRA axis strips the base LoRAs. GridGenerator registers loras/loraweights as comma-stackable, which
 *    means an axis value is APPENDED to the base rather than replacing it: left in, "compare A against B"
 *    quietly runs "current stack + A" against "current stack + B".
 * 3. The batch count never survives into the base, or every cell is multiplied by it.
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

const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_create.js', 'm_grid.js',
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
                { name: 'ill/style_a.safetensors', title: 'Style A' },
                { name: 'ill/style_b.safetensors', title: 'Style B' },
                { name: 'flux/detail.safetensors', title: 'Detail' }
            ], folders: [] });
        }
        else if (route == 'GetMyUserData') {
            callback({ presets: [], starred_models: {} });
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
        scheduler: { name: 'Scheduler', values: ['normal', 'karras', 'beta'] }
    };
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
check('the five requested axes are offered, and only those',
    axisNames.join(',') == 'LoRAs,Steps,CFG Scale,Sampler,Scheduler', axisNames.join(','));
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
    summary: [...__sheet().querySelectorAll('.m-grid-card-summary')][3].textContent,
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
await page.evaluate(() => {
    let options = [...__sheet().querySelectorAll('.m-grid-lora-options .m-grid-option')];
    options[0].click();
    options[1].click();
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
check('a LoRA axis strips the base LoRAs, so cells are not stack-plus-axis',
    !('loras' in payload.base) && !('loraweights' in payload.base), JSON.stringify(Object.keys(payload.base)));
check('the rest of the Create state still rides along', payload.base.prompt == 'a cat', `${payload.base.prompt}`);

// ---- Without a LoRA axis the base LoRAs must survive ----
const keptLoras = await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mGrid.selected = { steps: ['20', '30'] };
    let base = mGrid.buildBase();
    return { loras: base.loras, weights: base.loraweights, images: base.images };
});
check('with no LoRA axis, the Create tab\'s LoRAs are left alone',
    `${keptLoras.loras}` == 'ill/preexisting' && `${keptLoras.weights}` == '0.8', JSON.stringify(keptLoras));
check('the batch count is dropped either way', keptLoras.images == undefined, `${keptLoras.images}`);

// ---- Permission ----
const denied = await page.evaluate(() => {
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

await browser.close();
const failed = results.filter(result => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
