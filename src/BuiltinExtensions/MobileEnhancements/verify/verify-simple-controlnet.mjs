/** Synthetic, CPU-only browser checks for the shipped Anima panel and editor. No generation route is contacted. */
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

const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_coach.js', 'm_enhance.js', 'm_image_browser.js', 'm_frame_prep.js', 'm_controlnet.js', 'm_create.js', 'm_grid.js', 'm_presets.js',
    'm_images.js', 'm_models.js'];
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
page.setDefaultTimeout(10000);
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
    // Sheets stack: opening the editor over the manager leaves TWO .m-sheet elements in the document, and a
    // bare querySelector answers from the one underneath. Every check below reads the topmost sheet.
    window.__sheet = () => [...document.querySelectorAll('.m-sheet')].pop();
    window.__calls = [];
    // The preset store the fake server keeps. preview_image is the /ViewSpecial form the real GetMyUserData
    // sends for a preset whose image is a stored data URI - the exact value that must never be echoed back.
    window.__presets = [
        { title: 'flux/Portrait', description: 'Close crop', is_starred: false,
            preview_image: '/ViewSpecial/Preset/flux/Portrait?editid=3',
            param_map: { model: 'flux/base', steps: '20', cfgscale: '1', 'video_frames': '81' } },
        { title: 'ill/Anime', description: '', is_starred: true,
            preview_image: 'imgs/model_placeholder.jpg',
            param_map: { model: 'ill/anime', steps: '30' } }
    ];
    window.genericRequest = (route, args, callback, depth, errorCallback) => {
        window.__calls.push({ route, args: JSON.parse(JSON.stringify(args || {})) });
        if (route == 'GetMyUserData') {
            callback({ presets: JSON.parse(JSON.stringify(window.__presets)), starred_models: {} });
        }
        else if (route == 'AddNewPreset') {
            if (window.__failNext) {
                window.__failNext = false;
                callback({ preset_fail: 'A preset with that title already exists.' });
                return;
            }
            let existing = window.__presets.find(p => p.title == (args.is_edit ? args.editing : args.title));
            let saved = {
                title: args.title,
                description: args.description || '',
                is_starred: !!args.is_starred,
                // Mirrors the server: blank preview_image on an edit keeps the existing image.
                preview_image: args.preview_image || (existing ? existing.preview_image : 'imgs/model_placeholder.jpg'),
                param_map: JSON.parse(JSON.stringify(args.param_map || {}))
            };
            if (existing && args.is_edit) {
                window.__presets[window.__presets.indexOf(existing)] = saved;
            }
            else {
                window.__presets.push(saved);
            }
            callback({ success: true });
        }
        else if (route == 'DeletePreset') {
            window.__presets = window.__presets.filter(p => p.title != args.preset);
            callback({ success: true });
        }
        else if (route == 'DuplicatePreset') {
            let existing = window.__presets.find(p => p.title == args.preset);
            window.__presets.push({ ...existing, title: `${existing.title} (2)` });
            callback({ success: true });
        }
        else if (route == 'GetSimpleControlNetCapabilities') { callback({ backends: window.__caps || [] }); }
        else if (route == 'ListBackends') { callback({ '0': { id: 0, type: 'comfyui_selfstart', status: 'running', enabled: true, title: 'Local' } }); }
        else if (route == 'ListT2IParams') {
            callback({ list: [] });
        }
        else if (route == 'ListModels') {
            callback({ files: [], folders: [] });
        }
        else if (errorCallback) {
            callback({});
        }
    };
});
page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mCreate != 'undefined' && typeof mPresets != 'undefined');
await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mCreate.build(panel);
    // Stands in for ListT2IParams, which the picker reads to offer parameters.
    mState.paramMeta = {
        model: { name: 'Model' }, steps: { name: 'Steps', default: '20' }, cfgscale: { name: 'CFG Scale' },
        prompt: { name: 'Prompt' }, sampler: { name: 'Sampler', default: 'euler' }, images: { name: 'Image Count' }
    };
});


const configure = async () => page.evaluate(() => {
    mState.resetParams();
    mState.loadParamMeta({ list: ['model', 'prompt', 'steps', 'cfgscale', 'controlnetmodel', 'controlnetstrength', 'controlnetpreprocessor',
        'controlnetstart', 'controlnetend', 'exactbackendid', 'initimage', 'videoendimage'].map(id => ({ id, name: id })),
        models: { 'Stable-Diffusion': [['base.safetensors', 'anima'], ['large.safetensors', 'anima-2.9b'], ['largest.safetensors', 'anima-3.8b'], ['video.safetensors', 'minimax-h3']],
            ControlNet: [['controls/anima-pose.safetensors', 'anima/controlnet'], ['controls/anima-lineart.safetensors', 'anima/controlnet'],
                ['controls/anima-scribble.safetensors', 'anima/controlnet'], ['controls/anima-depth.safetensors', 'anima/controlnet'],
                ['controls/anima-inpaint.safetensors', 'anima/controlnet'], ['controls/unknown-pose.safetensors', 'unknown'],
                ['controls/large-pose.safetensors', 'anima-2.9b/controlnet'], ['controls/sdxl-pose.safetensors', 'sdxl/controlnet']] },
        model_classes: Object.fromEntries(['anima', 'anima-2.9b', 'anima-3.8b', 'minimax-h3', 'anima/controlnet', 'anima-2.9b/controlnet', 'sdxl/controlnet']
            .map(id => [id, { compat_class: id.split('/')[0], standard_width: 1024, standard_height: 1024 }])) });
    mState.params = { prompt: 'synthetic fixture', model: 'base.safetensors' };
    mState.genTarget = { kind: 'local' };
    mState.backendTargets = [{ id: '0', kind: 'local', usable: true }];
    window.__caps = [{ id: 0, supported: true, checkpoints: ['base.safetensors', 'large.safetensors', 'largest.safetensors'],
        patches: mState.models.ControlNet.map(row => row[0].replaceAll('/', '\\')),
        preprocessors: { DWPreprocessor: true, LineartStandardPreprocessor: true, ScribblePreprocessor: true } }];
    mControlNet.backends = JSON.parse(JSON.stringify(window.__caps));
    window.__presets = [{ title: 'Anima/Generation', param_map: { model: 'base.safetensors', prompt: 'preset prompt', steps: '20', cfgscale: '4', loras: 'style', loraweights: '0.7' } },
        { title: 'ControlNet/Anima/Pose', param_map: { controlnetmodel: 'controls/anima-pose.safetensors', controlnetpreprocessor: 'DWPreprocessor',
            controlnetstrength: '0.6', controlnetstart: '0', controlnetend: '0.9', model: 'video.safetensors', prompt: 'must not escape', loras: 'must not escape' } }];
    mState.presets = JSON.parse(JSON.stringify(window.__presets));
    mState.activePresets = ['Anima/Generation'];
    mCreate.render();
    window.__resetSheets = () => document.querySelectorAll('.m-sheet, .m-sheet-backdrop').forEach(el => el.remove());
    window.__attach = () => { mState.control.image = { kind: 'path', value: 'inputs/reference.png' }; };
});
await configure();
const resolution = await page.evaluate(() => {
    mState.control.selection = 'preset:ControlNet/Anima/Pose';
    __attach();
    let input = mState.buildGenInput();
    return { input, config: mControlNet.config(mState.mergedParams()).error, candidates: mControlNet.modelsFor(mState.mergedParams()),
        presets: [...mCreate.presetSelect.options].map(row => row.value), groups: mState.presetGroups() };
});
check('a control-only preset cannot replace the checkpoint, prompt, or LoRA stack', resolution.input.model == 'base.safetensors'
    && resolution.input.prompt == 'preset prompt' && resolution.input.loras.join(',') == 'style', JSON.stringify(resolution.input));
check('registered Windows patch names match catalog paths and pin the verified backend', resolution.input.controlnetmodel == 'controls/anima-pose.safetensors'
    && resolution.input.exactbackendid == 0 && !resolution.config);
check('unknown, foreign, inpainting, and larger-variant patches are excluded', resolution.candidates.length == 4 && resolution.candidates.every(name => name.startsWith('controls/anima-') && !name.includes('inpaint')));
check('control presets do not appear as generation presets or architecture folders', !resolution.presets.some(name => name.startsWith('ControlNet/')) && !resolution.groups.includes('ControlNet'));

const frameRoles = await page.evaluate(() => {
    mState.initImage = { kind: 'path', value: 'inputs/start.png' };
    mState.videoEndImage = { kind: 'path', value: 'inputs/end.png' };
    mCreate.render();
    let anima = mState.buildGenInput();
    let hidden = mCreate.framesWrap.hidden && !mControlNet.wrap.hidden;
    mState.activePresets = [];
    mState.params.model = 'video.safetensors';
    mCreate.render();
    let video = mState.buildGenInput();
    return { anima, video, hidden, restored: !mCreate.framesWrap.hidden && mControlNet.wrap.hidden };
});
check('Anima guidance never inherits a hidden Start or End Frame', !frameRoles.anima.initimage && !frameRoles.anima.videoendimage && frameRoles.hidden);
check('H3 restores its frame controls and original image roles without an Anima control overlay', frameRoles.restored
    && frameRoles.video.initimage == 'inputs/start.png' && frameRoles.video.videoendimage == 'inputs/end.png' && !frameRoles.video.controlnetmodel);

await configure();
const variants = await page.evaluate(() => {
    __attach(); mState.activePresets = []; mState.params.model = 'large.safetensors'; mState.control.selection = 'pose';
    let large = mState.buildGenInput();
    mState.params.model = 'largest.safetensors';
    let largest = mState.buildGenInput();
    return { large, largest, reason: mControlNet.validate(largest) };
});
check('2.9B chooses only a 2.9B patch', variants.large.controlnetmodel == 'controls/large-pose.safetensors');
check('3.8B never falls back to a base or 2.9B patch', !variants.largest.controlnetmodel && variants.reason.includes('compatible'));

await configure();
const prepared = await page.evaluate(() => {
    __attach(); mState.control.selection = 'depth';
    let missing = mState.buildGenInput(); let reason = mControlNet.validate(missing);
    mState.control.prepared = true;
    let ready = mState.buildGenInput();
    mState.control.selection = 'lineart'; mState.control.prepared = false; mState.control.values = {};
    let lines = mState.buildGenInput();
    mState.control.selection = 'scribble'; let sketch = mState.buildGenInput();
    mState.control.selection = 'off'; let off = mState.buildGenInput();
    return { missing, reason, ready, lines, sketch, off };
});
check('uncached preprocessing blocks generation with an actionable reason', !prepared.missing.controlnetmodel && prepared.reason.includes('preprocessor'));
check('a prepared depth map bypasses the missing annotator', prepared.ready.controlnetpreprocessor == 'None');
check('Lines and Sketch send explicit preprocessors', prepared.lines.controlnetpreprocessor == 'LineartStandardPreprocessor' && prepared.sketch.controlnetpreprocessor == 'ScribblePreprocessor');
check('Off removes all ControlNet parameters', !Object.keys(prepared.off).some(key => key.startsWith('controlnet')));

const storage = await page.evaluate(() => {
    mState.control.selection = 'pose'; mState.control.image = { kind: 'data', value: 'data:image/png;base64,synthetic' };
    mState.save(); let bytes = localStorage.getItem('m_client_state');
    mState.load(); let restored = mState.control.image;
    __attach(); mState.save(); mState.control.image = null; mState.load();
    let path = mState.control.image?.value;
    mState.control.values = { controlnetstrength: '0' }; mState.control.selection = 'pose';
    let zero = mState.buildGenInput().controlnetstrength;
    mState.control.image = null;
    let noImage = mState.buildGenInput();
    return { bytes: bytes.includes('data:image'), restored, path, zero, missing: mControlNet.validate(noImage), capture: mPresets.captureCurrent() };
});
check('attached bytes never enter localStorage and do not restore', !storage.bytes && !storage.restored);
check('server-relative control image paths survive reload', storage.path == 'inputs/reference.png');
check('zero strength remains zero', storage.zero == '0');
check('missing control images block an enabled guide', storage.missing.includes('control image'));
check('preset capture excludes control media', !('controlnetimageinput' in storage.capture));

await configure();
const grid = await page.evaluate(() => {
    mState.control.selection = 'pose'; __attach(); let input = mState.buildGenInput();
    mState.presets.push({ title: 'Other/Video', param_map: { model: 'video.safetensors' } });
    return { safe: mControlNet.validateGrid(input, ['Anima/Generation']), foreign: mControlNet.validateGrid(input, ['Other/Video']),
        control: mControlNet.validateGrid(input, ['ControlNet/Anima/Pose']) };
});
check('same-architecture generation presets can use the shared guide in a grid', !grid.safe);
check('grid cells cannot replace the architecture or smuggle control preset overrides', !!grid.foreign && !!grid.control);

await configure();
const failure = await page.evaluate(async () => {
    mState.control.selection = 'pose'; mState.control.image = null;
    let sent = false; let reset = false;
    mControlNet.prepare(() => mState.buildGenInput(), () => { sent = true; }, () => { reset = true; });
    return { sent, reset };
});
check('failed preflight releases pending state and never submits work', failure.reset && !failure.sent);

// Capture is a selective merge into the unsaved editor, never a direct write to the saved preset.
await configure();
await page.evaluate(() => { window.__working = { custom_parameter: 'keep', prompt: 'old' }; mPresets.openCapture(window.__working, () => {}, false); });
await page.selectOption('[aria-label="Settings Source"]', 'effective');
await page.evaluate(() => {
    let prompt = __sheet().querySelector('[data-param="prompt"]'); prompt.checked = false; prompt.dispatchEvent(new Event('change'));
    __sheet().querySelector('.m-edit-save-button').click();
});
await page.waitForFunction(() => !document.querySelector('.m-sheet'));
const captured = await page.evaluate(() => window.__working);
check('selective effective capture keeps unchecked and unknown existing fields', captured.prompt == 'old' && captured.custom_parameter == 'keep');
check('effective capture includes preset settings without resolved image dimensions', captured.model == 'base.safetensors' && captured.steps == '20' && !captured.width && !captured.height);

// A valid control preset round-trips through the existing API and carries its independent selection on rename.
await page.evaluate(() => {
    mState.presets[1].param_map = { controlnetmodel: 'controls/anima-pose.safetensors', controlnetpreprocessor: 'DWPreprocessor', controlnetstrength: '0.6', controlnetstart: '0', controlnetend: '0.9' };
    window.__presets = JSON.parse(JSON.stringify(mState.presets)); window.__calls = [];
    mState.control.selection = 'preset:ControlNet/Anima/Pose';
    mPresets.openEditor(mState.presets[1]);
});
const editor = await page.evaluate(() => ({ type: __sheet().querySelector('.m-sheet-title').textContent,
    models: [...__sheet().querySelector('[data-param="controlnetmodel"]').options].map(row => row.value),
    video: __sheet().querySelector('.m-preset-video').hidden }));
check('the control editor has compatible model choices and hides video fields', editor.type == 'Control Preset'
    && editor.models.join('|') == '|controls/anima-pose.safetensors' && editor.video);
await page.evaluate(() => { __sheet().querySelector('.m-preset-field').value = 'ControlNet/Anima/Pose_Saved'; __sheet().querySelector('.m-edit-save-button').click(); });
await page.waitForFunction(() => !document.querySelector('.m-sheet'));
const saved = await page.evaluate(() => ({ payload: window.__calls.find(row => row.route == 'AddNewPreset')?.args, selection: mState.control.selection,
    generation: mState.activePresets[0] }));
check('control settings round-trip without images or generation keys', Object.keys(saved.payload.param_map).length == 5 && !saved.payload.param_map.model && !saved.payload.param_map.controlnetimageinput);
check('renaming a control preset preserves its selection and the generation preset', saved.selection == 'preset:ControlNet/Anima/Pose_Saved' && saved.generation == 'Anima/Generation');

await page.evaluate(() => { window.__calls = []; mPresets.openEditor(null, null, 'control'); __sheet().querySelector('.m-preset-field').value = 'ControlNet/Anima/Invalid';
    let start = __sheet().querySelector('[data-param="controlnetstart"]'); start.value = '0.9'; start.dispatchEvent(new Event('input'));
    let end = __sheet().querySelector('[data-param="controlnetend"]'); end.value = '0.1'; end.dispatchEvent(new Event('input'));
    __sheet().querySelector('.m-edit-save-button').click(); });
const invalid = await page.evaluate(() => ({ saved: window.__calls.some(row => row.route == 'AddNewPreset'), open: !!document.querySelector('.m-sheet') }));
check('invalid control ranges remain editable and never reach AddNewPreset', !invalid.saved && invalid.open);
await page.evaluate(() => __resetSheets());

for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await configure();
    await page.evaluate(() => { mState.control.selection = 'pose'; __attach(); mCreate.render(); });
    const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
        sizes: [...mControlNet.wrap.querySelectorAll('select,button')].filter(el => el.offsetParent).map(el => el.getBoundingClientRect().height),
        inputs: [...mControlNet.wrap.querySelectorAll('select')].map(el => parseFloat(getComputedStyle(el).fontSize)) }));
    check(`ControlNet fits ${width}px without horizontal overflow or small touch controls`, !layout.overflow && layout.sizes.every(size => size >= 44) && layout.inputs.every(size => size >= 16), JSON.stringify(layout));
}

await configure();
await page.evaluate(() => { mState.control.selection = 'pose'; mCreate.render(); });
await page.setInputFiles('.m-controlnet input[type="file"]', { name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64') });
await page.waitForFunction(() => mState.control.image?.kind == 'data');
const upload = await page.evaluate(() => ({ control: mState.buildGenInput().controlnetimageinput?.startsWith('data:image/png'), start: mState.initImage, end: mState.videoEndImage }));
check('the actual file input attaches control bytes without altering frame state', upload.control && !upload.start && !upload.end);
await page.evaluate(() => { mControlNet.prepared.checked = true; mControlNet.prepared.dispatchEvent(new Event('change')); });
let enabledPrepared = await page.evaluate(() => mState.buildGenInput().controlnetpreprocessor);
await page.evaluate(() => { mControlNet.prepared.checked = false; mControlNet.prepared.dispatchEvent(new Event('change')); });
let disabledPrepared = await page.evaluate(() => mState.buildGenInput().controlnetpreprocessor);
check('Prepared Image can switch back to automatic processing', enabledPrepared == 'None' && disabledPrepared == 'DWPreprocessor');
const aliases = await page.evaluate(() => {
    mState.control = { selection: 'inherit', values: {}, prepared: false, image: {kind:'path',value:'inputs/reference.png'} };
    mState.params.controlnetmodel = 'CONTROLS\\ANIMA-POSE';
    return mState.buildGenInput().controlnetmodel;
});
check('extensionless and Windows preset aliases resolve to the catalog model', aliases == 'controls/anima-pose.safetensors');
await page.evaluate(() => {
    mState.control = { selection: 'off', values: {}, prepared: false, image: null };
    mCreate.render();
});
await page.selectOption('.m-controlnet [aria-label="Control Preset"]', 'depth');
check('a prepared-only type clearly selects map input when its annotator is unavailable', await page.evaluate(() => mState.control.prepared && mControlNet.preset.selectedOptions[0].textContent == 'Depth (Prepared)'));
const extraSlot = await page.evaluate(() => {
    mState.control.selection = 'pose'; mState.control.prepared = false; __attach();
    mState.params.controlnettwomodel = 'controls/anima-pose.safetensors';
    return mControlNet.validate(mState.buildGenInput());
});
check('additional inherited control slots cannot disappear silently', extraSlot.includes('one control'));

await configure();
const backendPick = await page.evaluate(() => {
    mState.models.ControlNet.unshift(['controls/aaa-pose.safetensors', 'anima/controlnet']);
    mState.compatCache = {}; mState.archIdCache = {};
    mState.control.selection = 'pose'; __attach();
    return mState.buildGenInput().controlnetmodel;
});
check('automatic selection skips compatible patches absent from the selected backend', backendPick == 'controls/anima-pose.safetensors');
await page.evaluate(() => { __resetSheets(); mPresets.openEditor({ title:'Anima/Swap', param_map:{model:'base.safetensors',controlnetmodel:'controls/anima-pose.safetensors'} }); });
await page.selectOption('.m-preset-params select', 'large.safetensors');
const modelSwap = await page.evaluate(() => [...__sheet().querySelector('[data-param="controlnetmodel"]').options].map(row=>row.value));
check('changing the generation checkpoint updates the control editor to the new variant', modelSwap.includes('controls/large-pose.safetensors'));
await page.evaluate(() => __resetSheets());
await configure();
const sendPath = await page.evaluate(() => {
    let real = mGen.generate; let calls = [];
    mGen.generate = input => calls.push(JSON.parse(JSON.stringify(input)));
    mState.control.selection = 'pose'; mState.control.image = null;
    mCreate.doGenerate(); let blocked = !mCreate.pending && calls.length == 0;
    __attach(); mCreate.doGenerate(); let payload = calls[0];
    mGen.generate = real; mCreate.setPending(false);
    return { blocked, payload };
});
check('Generate blocks an incomplete guide and clears its pending preview', sendPath.blocked);
check('Generate sends the resolved guide to its verified backend after preflight', sendPath.payload?.controlnetmodel == 'controls/anima-pose.safetensors' && sendPath.payload.exactbackendid == 0);
await browser.close();
const failed = results.filter(result => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
