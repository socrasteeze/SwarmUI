/**
 * /simple Models-tab Load CivitAI harness (fork). Classic edit_model_load_civitai fills a form; this path
 * auto-saves through EditModelMetadata. Checks aim at ways the enrich+save can silently fail or corrupt:
 *
 * 1. Local cards with edit_model_metadata show a Load CivitAI button; remote cards and no-permission do not.
 * 2. The button stops propagation so it does not also select/add the model.
 * 3. No hash and no description URL -> GetModelHash, then ForwardMetadataRequest by-hash.
 * 4. No CivitAI match surfaces a warn toast and does not call EditModelMetadata.
 * 5. A successful fetch builds modelspec fields and saves title/author/trigger/tags plus preview_image when
 *    imageToData returns a face/preview; architecture and resolution from the card are preserved.
 * 6. Description URL short-circuits the hash path (same guess Classic uses).
 *
 * Runs the REAL shipped source with a scripted fake server. Requires playwright + chromium. Run from repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-models-civitai.mjs
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
    'm_create.js', 'm_grid.js', 'm_presets.js', 'm_images.js', 'm_models.js'];
const FILES = {
    '/js/util.js': `${REPO}/src/wwwroot/js/util.js`,
    '/js/site.js': `${REPO}/src/wwwroot/js/site.js`,
    '/js/translator.js': `${REPO}/src/wwwroot/js/translator.js`,
    '/js/permissions.js': `${REPO}/src/wwwroot/js/permissions.js`,
    '/css/site.css': `${REPO}/src/wwwroot/css/site.css`,
    '/css/themes/modern.css': `${REPO}/src/wwwroot/css/themes/modern.css`,
    '/css/themes/modern_dark.css': `${REPO}/src/wwwroot/css/themes/modern_dark.css`,
    '/css/bootstrap.min.css': `${REPO}/src/wwwroot/css/bootstrap.min.css`,
    '/js/lib/jquery.min.js': `${REPO}/src/wwwroot/js/lib/jquery.min.js`,
    '/js/lib/bootstrap.min.js': `${REPO}/src/wwwroot/js/lib/bootstrap.min.js`,
    '/ExtensionFile/MobileEnhancementsExtension/Assets/mobile_core.js':
        `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/mobile_core.js`,
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
        const body = readFileSync(file);
        const type = file.endsWith('.css') ? 'text/css'
            : file.endsWith('.js') ? 'application/javascript'
            : 'application/octet-stream';
        return route.fulfill({ contentType: type, body });
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
    window.__calls = [];
    window.__models = [
        { name: 'local/Alpha.safetensors', title: '', author: '', description: '', local: true,
            architecture: 'flux-1/lora', standard_width: 1024, standard_height: 1024,
            hash: '', trigger_phrase: '', tags: [], preview_image: 'imgs/model_placeholder.jpg',
            lora_default_weight: '0.8', lora_default_confinement: '' },
        { name: 'remote/Beta.safetensors', title: 'Remote', local: false, architecture: 'flux-1/lora' },
        { name: 'local/Known.safetensors', title: 'Old', author: 'me', local: true,
            architecture: 'flux-1/lora', standard_width: 768, standard_height: 768,
            description: 'From <a href="https://civitai.com/models/99?modelVersionId=77">link</a>',
            hash: '0xDEADBEEFCAFE', trigger_phrase: '', tags: ['old'],
            preview_image: 'imgs/model_placeholder.jpg', lora_default_weight: '', lora_default_confinement: '' }
    ];
    window.__hashMode = 'ok'; // ok | empty | fail
    window.__byHashMode = 'hit'; // hit | miss | error
    window.__modelMetaMode = 'ok'; // ok | empty
    window.__saveMode = 'ok'; // ok | fail
    window.__previewData = 'data:image/jpeg;base64,qq==';
    // imageToData is in util.js; stub after load so civitai CDN forwarding is not needed.
    window.__stubImageToData = true;
});

page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mModels != 'undefined' && typeof mUI != 'undefined' && typeof imageToData == 'function');

await page.evaluate(() => {
    if (window.__stubImageToData) {
        window.imageToData = (src, callback) => callback(window.__previewData);
    }
    mUI.warnings = [];
    mUI.notes = [];
    const _warn = mUI.warn.bind(mUI);
    const _note = mUI.note.bind(mUI);
    mUI.warn = (m) => { mUI.warnings.push(m); _warn(m); };
    mUI.note = (m) => { mUI.notes.push(m); _note(m); };
    window.genericRequest = (route, args, callback, depth, errorCallback) => {
        window.__calls.push({ route, args: JSON.parse(JSON.stringify(args || {})) });
        if (route == 'ListModels') {
            let files = window.__models.filter(m => m.local !== false || args.allowRemote);
            // Depth-1 folder listing: return all fixtures for this harness.
            callback({ files: JSON.parse(JSON.stringify(files)), folders: [] });
            return;
        }
        if (route == 'GetModelHash') {
            if (window.__hashMode == 'fail') {
                if (errorCallback) { errorCallback('hash failed'); }
                return;
            }
            if (window.__hashMode == 'empty') {
                callback({ hash: '' });
                return;
            }
            callback({ hash: '0xABCDEF1234567890' });
            return;
        }
        if (route == 'ForwardMetadataRequest') {
            let url = args.url || '';
            if (url.includes('/model-versions/by-hash/')) {
                if (window.__byHashMode == 'miss') {
                    callback({ response: { error: 'Not Found' } });
                    return;
                }
                if (window.__byHashMode == 'error') {
                    if (errorCallback) { errorCallback('network'); }
                    return;
                }
                callback({ response: { modelId: 42, id: 7 } });
                return;
            }
            if (url.includes('/api/v1/models/')) {
                if (window.__modelMetaMode == 'empty') {
                    callback({ response: null });
                    return;
                }
                callback({
                    response: {
                        name: 'Face Card',
                        description: 'Model desc',
                        creator: { username: 'artist' },
                        tags: ['character', 'style'],
                        modelVersions: [{
                            id: 7,
                            name: 'v1',
                            createdAt: '2026-01-02',
                            trainedWords: ['ohwx', 'person'],
                            baseModel: 'Illustrious',
                            description: 'Vers desc',
                            images: [{ type: 'image', url: 'https://image.civitai.com/x/preview.jpg' }]
                        }, {
                            id: 77,
                            name: 'vKnown',
                            createdAt: '2026-02-03',
                            trainedWords: ['known'],
                            baseModel: 'Pony',
                            description: '',
                            images: [{ type: 'image', url: 'https://image.civitai.com/x/known.jpg' }]
                        }]
                    }
                });
                return;
            }
            callback({ response: {} });
            return;
        }
        if (route == 'EditModelMetadata') {
            if (window.__saveMode == 'fail') {
                if (errorCallback) { errorCallback('save failed'); }
                return;
            }
            callback({ success: true });
            return;
        }
        if (route == 'GetMyUserData') {
            callback({ presets: [], starred_models: {} });
            return;
        }
        if (errorCallback) {
            errorCallback('unhandled ' + route);
        }
        else {
            callback({});
        }
    };
    mState.starredModels = {};
    mState.params = {};
    mCreate.loraList = null;
    mCreate.modelList = null;
    let panel = document.querySelector('.m-panel[data-mtab="models"]');
    panel.innerHTML = '';
    panel.classList.add('m-tab-active');
    mModels.subtype = 'LoRA';
    mModels.folder = '';
    mModels.build(panel);
    mModels.refresh();
});

await page.waitForFunction(() => document.querySelectorAll('.m-model-card').length >= 2);

const buttons = await page.evaluate(() => {
    let cards = [...document.querySelectorAll('.m-model-card')];
    return cards.map(card => ({
        text: card.querySelector('.m-model-name')?.textContent || '',
        hasBtn: !!card.querySelector('.m-model-civitai-btn')
    }));
});
check('local model card shows Load CivitAI', buttons.some(b => b.hasBtn && b.text.includes('Alpha')), JSON.stringify(buttons));
check('remote model card hides Load CivitAI', buttons.some(b => !b.hasBtn && (b.text.includes('Beta') || b.text.includes('Remote'))), JSON.stringify(buttons));

// Permission gate: rebuild without permission.
await page.evaluate(() => {
    window.permissions = { hasPermission: (p) => p != 'edit_model_metadata' };
    mModels.refresh();
});
await page.waitForFunction(() => document.querySelectorAll('.m-model-card').length >= 2);
check('no edit_model_metadata permission: no Load CivitAI buttons',
    await page.evaluate(() => document.querySelectorAll('.m-model-civitai-btn').length == 0));

// Restore permission and select/add must not fire when clicking Load CivitAI.
await page.evaluate(() => {
    window.permissions = { hasPermission: () => true };
    mUI.notes = [];
    mUI.warnings = [];
    window.__calls = [];
    mState.params = {};
    mState.setLoras([]);
    mModels.refresh();
});
await page.waitForFunction(() => document.querySelector('.m-model-civitai-btn'));

// ---- Miss path: hash lookup finds nothing ----
await page.evaluate(() => {
    window.__byHashMode = 'miss';
    window.__hashMode = 'ok';
    window.__calls = [];
    mUI.warnings = [];
    mModels.civitaiBusy = false;
    let btn = [...document.querySelectorAll('.m-model-civitai-btn')]
        .find(b => b.closest('.m-model-card').textContent.includes('Alpha'));
    btn.click();
});
await page.waitForFunction(() => (mUI.warnings || []).some(w => /No CivitAI match/i.test(w)));
const miss = await page.evaluate(() => ({
    warnings: mUI.warnings.slice(),
    routes: window.__calls.map(c => c.route),
    notes: (mUI.notes || []).slice(),
    loras: mState.getLoras(),
    sheetOpen: !!document.querySelector('.m-sheet')
}));
check('no match: GetModelHash then ForwardMetadataRequest, never EditModelMetadata',
    miss.routes.includes('GetModelHash') && miss.routes.includes('ForwardMetadataRequest') && !miss.routes.includes('EditModelMetadata'),
    miss.routes.join(','));
check('no match: warns the user', miss.warnings.some(w => /No CivitAI match/i.test(w)), miss.warnings.join('|'));
check('Load CivitAI click does not add the LoRA', miss.loras.length == 0, JSON.stringify(miss.loras));

// Close any open sheet from the miss path.
await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mUI.openSheets = 0;
    mModels.civitaiBusy = false;
});

// ---- Happy path via description URL (skips hash) ----
await page.evaluate(() => {
    window.__byHashMode = 'hit';
    window.__modelMetaMode = 'ok';
    window.__saveMode = 'ok';
    window.__calls = [];
    mUI.notes = [];
    mUI.warnings = [];
    mModels.refresh();
});
await page.waitForFunction(() => document.querySelectorAll('.m-model-civitai-btn').length >= 2);
await page.evaluate(() => {
    let btn = [...document.querySelectorAll('.m-model-civitai-btn')]
        .find(b => b.closest('.m-model-card').textContent.includes('Known')
            || b.closest('.m-model-card').textContent.includes('Old'));
    btn.click();
});
await page.waitForFunction(() => window.__calls.some(c => c.route == 'EditModelMetadata'));
const saved = await page.evaluate(() => {
    let edit = window.__calls.find(c => c.route == 'EditModelMetadata');
    return {
        routes: window.__calls.map(c => c.route),
        args: edit ? edit.args : null,
        notes: (mUI.notes || []).slice(),
        hashCalls: window.__calls.filter(c => c.route == 'GetModelHash').length,
        forwardUrls: window.__calls.filter(c => c.route == 'ForwardMetadataRequest').map(c => c.args.url)
    };
});
check('description URL skips GetModelHash', saved.hashCalls == 0, `${saved.hashCalls}`);
check('description URL fetches the model metadata API',
    saved.forwardUrls.some(u => u.includes('/api/v1/models/99')), saved.forwardUrls.join('|'));
check('EditModelMetadata saves CivitAI title/author/trigger/usage_hint',
    saved.args
    && saved.args.title == 'Face Card - vKnown'
    && saved.args.author == 'artist'
    && saved.args.trigger_phrase == 'known'
    && saved.args.usage_hint == 'Pony',
    JSON.stringify(saved.args && {
        title: saved.args.title, author: saved.args.author,
        trigger: saved.args.trigger_phrase, hint: saved.args.usage_hint
    }));
check('EditModelMetadata preserves architecture and resolution from the card',
    saved.args && saved.args.type == 'flux-1/lora'
    && saved.args.standard_width == 768 && saved.args.standard_height == 768,
    JSON.stringify(saved.args && {
        type: saved.args.type, w: saved.args.standard_width, h: saved.args.standard_height
    }));
check('EditModelMetadata includes the preview face card image',
    saved.args && typeof saved.args.preview_image == 'string' && saved.args.preview_image.startsWith('data:image/'),
    saved.args && String(saved.args.preview_image).slice(0, 40));
check('success notes the user', saved.notes.some(n => /CivitAI metadata saved/i.test(n)), saved.notes.join('|'));

// ---- Hash happy path for Alpha ----
await page.evaluate(() => {
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mUI.openSheets = 0;
    mModels.civitaiBusy = false;
    window.__calls = [];
    window.__byHashMode = 'hit';
    window.__modelMetaMode = 'ok';
    mUI.notes = [];
    mModels.refresh();
});
await page.waitForFunction(() => document.querySelectorAll('.m-model-civitai-btn').length >= 1);
await page.evaluate(() => {
    let btn = [...document.querySelectorAll('.m-model-civitai-btn')]
        .find(b => b.closest('.m-model-card').textContent.includes('Alpha'));
    btn.click();
});
await page.waitForFunction(() => window.__calls.some(c => c.route == 'EditModelMetadata'));
const hashPath = await page.evaluate(() => {
    let edit = window.__calls.find(c => c.route == 'EditModelMetadata');
    let byHash = window.__calls.find(c => c.route == 'ForwardMetadataRequest'
        && (c.args.url || '').includes('by-hash'));
    return {
        routes: window.__calls.map(c => c.route),
        byHashUrl: byHash ? byHash.args.url : null,
        title: edit && edit.args.title,
        weight: edit && edit.args.lora_default_weight,
        tags: edit && edit.args.tags
    };
});
check('hash path: GetModelHash then by-hash then models then EditModelMetadata',
    hashPath.routes.indexOf('GetModelHash') < hashPath.routes.indexOf('EditModelMetadata')
    && hashPath.byHashUrl && hashPath.byHashUrl.includes('by-hash/ABCDEF123456'),
    JSON.stringify({ routes: hashPath.routes, byHashUrl: hashPath.byHashUrl }));
check('hash path saves the matched version title and keeps LoRA default weight',
    hashPath.title == 'Face Card - v1' && hashPath.weight == '0.8' && hashPath.tags == 'character, style',
    JSON.stringify(hashPath));

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
