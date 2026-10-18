/**
 * /simple upscale vs preset harness (fork). An active preset used to overwrite the Upscale row after the
 * picklist had already drawn the base value, so the screen could say Off while the request still ran at the
 * preset's 3x. These checks drive the real Create controls:
 *
 * 1. Untouched scale shows the preset value, and that value is what buildGenInput sends.
 * 2. An explicit scale wins, including Off (the key is deleted; the preset scale is not sent).
 * 3. Changing the preset selection clears that pick, so the new preset's scale shows and is sent.
 * 4. The method picklist follows the same rule. seedvrupscale has no row control; a recorded pin still
 *    beats its preset, and a preset change drops the pin.
 * 5. Steps stay on the old "key in params" rule and are not cleared with the upscale pins.
 *
 * Runs the real m_*.js modules with the Create panel built directly (m_app.js is not booted).
 * Requires playwright + chromium. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-upscale-preset.mjs
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

const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_coach.js', 'm_enhance.js',
    'm_image_browser.js', 'm_create.js', 'm_grid.js', 'm_presets.js', 'm_images.js', 'm_models.js'];
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
    window.genericRequest = (route, args, callback) => {
        if (callback) {
            callback({});
        }
    };
});
page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mCreate != 'undefined' && typeof mState != 'undefined');
await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mCreate.build(panel);
    mState.paramMeta = {
        refinerupscale: { id: 'refinerupscale', name: 'Refiner Upscale', type: 'decimal',
            default: '1', min: 0.25, max: 8, view_max: 4, step: 0.25, examples: ['1', '1.5', '2'] },
        refinerupscalemethod: { id: 'refinerupscalemethod', name: 'Refiner Upscale Method', type: 'dropdown',
            default: 'pixel-lanczos',
            values: ['pixel-lanczos', 'latent-nearest-exact'],
            value_names: ['Pixel Lanczos', 'Latent Nearest'] },
        steps: { id: 'steps', name: 'Steps', default: '20' },
        cfgscale: { id: 'cfgscale', name: 'CFG Scale', default: '7' }
    };
    mState.presets = [
        { title: 'anima/00_default', param_map: {
            refinerupscale: '3', refinerupscalemethod: 'pixel-lanczos', seedvrupscale: '2', steps: '28', sampler: 'euler' } },
        { title: 'anima/other', param_map: {
            refinerupscale: '2', refinerupscalemethod: 'latent-nearest-exact', seedvrupscale: '4', steps: '10' } }
    ];
    // Steps use the key itself as the pin. It must keep winning across preset changes.
    mState.params['steps'] = '12';
    mState.params['prompt'] = 'a cat';
    mCreate.render();
});

const scaleFlow = await page.evaluate(async () => {
    let settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    let scale = () => document.querySelector('.m-choice-select[aria-label="Upscale"]');
    let method = () => document.querySelector('.m-choice-select[aria-label="Method"]');
    let preset = document.querySelector('.m-preset-select');
    let snap = () => {
        let input = mState.buildGenInput();
        let scaleEl = scale();
        let methodEl = method();
        return {
            upscale: 'refinerupscale' in input ? `${input.refinerupscale}` : '',
            label: scaleEl.selectedOptions[0] ? scaleEl.selectedOptions[0].textContent : '',
            method: 'refinerupscalemethod' in input ? `${input.refinerupscalemethod}` : '',
            methodValue: methodEl.value,
            seedvr: 'seedvrupscale' in input ? `${input.seedvrupscale}` : '',
            steps: `${input.steps}`,
            pins: [...mState.pinnedUpscale].sort().join(',')
        };
    };
    preset.value = 'anima/00_default';
    preset.dispatchEvent(new Event('change'));
    await settle();
    let untouched = snap();
    scale().value = '1.5';
    scale().dispatchEvent(new Event('change'));
    await settle();
    let picked = snap();
    scale().value = '1';
    scale().dispatchEvent(new Event('change'));
    await settle();
    let off = snap();
    // Off has no key to survive a reload. The pin set has to.
    mState.pinnedUpscale = new Set();
    mState.load();
    mCreate.render();
    let reloaded = snap();
    preset.value = 'anima/other';
    preset.dispatchEvent(new Event('change'));
    await settle();
    let switched = snap();
    return { untouched, picked, off, reloaded, switched };
});

check('untouched upscale sends the preset scale and the picker shows it',
    scaleFlow.untouched.upscale == '3' && scaleFlow.untouched.label == 'Upscale: 3x' && scaleFlow.untouched.pins == '',
    JSON.stringify(scaleFlow.untouched));
check('untouched method and seedvr scale come from the preset',
    scaleFlow.untouched.method == 'pixel-lanczos' && scaleFlow.untouched.methodValue == 'pixel-lanczos'
    && scaleFlow.untouched.seedvr == '2',
    JSON.stringify(scaleFlow.untouched));
check('a stored steps value still beats the preset',
    scaleFlow.untouched.steps == '12', scaleFlow.untouched.steps);
check('picking 1.5 sends 1.5 and the picker shows 1.5x',
    scaleFlow.picked.upscale == '1.5' && scaleFlow.picked.label == 'Upscale: 1.5x'
    && scaleFlow.picked.pins == 'refinerupscale',
    JSON.stringify(scaleFlow.picked));
check('picking Off sends no upscale scale',
    scaleFlow.off.upscale == '' && scaleFlow.off.label == 'Upscale: Off',
    JSON.stringify(scaleFlow.off));
check('Off still beats the preset after the pin set is restored from saved state',
    scaleFlow.reloaded.upscale == '' && scaleFlow.reloaded.label == 'Upscale: Off'
    && scaleFlow.reloaded.pins == 'refinerupscale',
    JSON.stringify(scaleFlow.reloaded));
check('changing preset clears the upscale pick and applies the new preset',
    scaleFlow.switched.upscale == '2' && scaleFlow.switched.label == 'Upscale: 2x'
    && scaleFlow.switched.pins == '' && scaleFlow.switched.seedvr == '4'
    && scaleFlow.switched.method == 'latent-nearest-exact' && scaleFlow.switched.steps == '12',
    JSON.stringify(scaleFlow.switched));

const methodFlow = await page.evaluate(async () => {
    let settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    let method = () => document.querySelector('.m-choice-select[aria-label="Method"]');
    let preset = document.querySelector('.m-preset-select');
    mState.resetParams();
    mState.params['prompt'] = 'a cat';
    mState.params['steps'] = '12';
    await settle();
    preset.value = 'anima/00_default';
    preset.dispatchEvent(new Event('change'));
    await settle();
    method().value = 'latent-nearest-exact';
    method().dispatchEvent(new Event('change'));
    await settle();
    let picked = `${mState.buildGenInput().refinerupscalemethod || ''}`;
    method().value = '';
    method().dispatchEvent(new Event('change'));
    await settle();
    let cleared = 'refinerupscalemethod' in mState.buildGenInput();
    let scaleStillPreset = `${mState.buildGenInput().refinerupscale || ''}`;
    preset.value = 'anima/other';
    preset.dispatchEvent(new Event('change'));
    await settle();
    let switched = `${mState.buildGenInput().refinerupscalemethod || ''}`;
    mState.pinUpscale('sampler');
    let samplerIgnored = mState.pinnedUpscale.has('sampler');
    return { picked, cleared, scaleStillPreset, switched, samplerIgnored };
});

check('picking a method sends that method',
    methodFlow.picked == 'latent-nearest-exact', methodFlow.picked);
check('picking the method default drops the preset method and leaves the preset scale',
    methodFlow.cleared == false && methodFlow.scaleStillPreset == '3',
    JSON.stringify(methodFlow));
check('changing preset restores the new preset method',
    methodFlow.switched == 'latent-nearest-exact', methodFlow.switched);
check('pinUpscale ignores params the upscale row does not own',
    methodFlow.samplerIgnored == false, `${methodFlow.samplerIgnored}`);

const seedvrFlow = await page.evaluate(() => {
    mState.clearPinnedUpscale();
    mState.activePresets = ['anima/00_default'];
    delete mState.params['seedvrupscale'];
    let fromPreset = `${mState.buildGenInput().seedvrupscale || ''}`;
    mState.pinUpscale('seedvrupscale');
    let pinnedOff = 'seedvrupscale' in mState.buildGenInput();
    mState.params['seedvrupscale'] = '1.5';
    let pinnedScale = `${mState.buildGenInput().seedvrupscale || ''}`;
    mState.clearPinnedUpscale();
    let restored = `${mState.buildGenInput().seedvrupscale || ''}`;
    return { fromPreset, pinnedOff, pinnedScale, restored };
});

check('an unpinned seedvr scale comes from the preset',
    seedvrFlow.fromPreset == '2', seedvrFlow.fromPreset);
check('a pinned seedvr Off is not sent, and a pinned scale is',
    seedvrFlow.pinnedOff == false && seedvrFlow.pinnedScale == '1.5',
    JSON.stringify(seedvrFlow));
check('clearing the seedvr pin returns the preset scale',
    seedvrFlow.restored == '2', seedvrFlow.restored);

await browser.close();
const failed = results.filter(result => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
