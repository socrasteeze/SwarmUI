/**
 * /simple Prompt Coach harness (fork). Covers the behaviours docs/SimplePromptCoach-Plan.md calls out as the
 * product rules a shipped Coach must hold to:
 *
 * 1. Profile resolution follows the EFFECTIVE checkpoint (mState.buildGenInput()['model']), picks up an
 *    official Anima filename pattern, and returns "no profile" for a generic (non-Anima) checkpoint rather
 *    than guessing one.
 * 2. "Add missing" is previewed, applied, and idempotent: running it a second time with nothing left missing
 *    is a no-op, and Undo restores the exact previous text - not a re-derived approximation of it.
 * 3. Natural-language ("prose") mode never rewrites the prompt - Add missing refuses outright, byte-for-byte.
 * 4. Every mutating tap in the sheet opens an exact before/after preview first, and declining it writes
 *    nothing - the plan's "every mutation is explicit, previewed, idempotent, and undoable".
 * 5. An active preset that REPLACES the field blocks the edit with a reason instead of writing a patch that
 *    generation would never see; a `{value}` preset merges, so the edit is allowed.
 * 6. The Steps/CFG advisory applies once and is idempotent, so Undo still restores the user's own values.
 * 7. The Aesthetic score-tag advisory is warning-only and never strips a tag.
 * 8. The Coach's preferences (profile override, mode) persist across a state save/load round trip, the same
 *    m_client_state localStorage blob every other /simple preference already uses.
 * 9. The tag tokenizer respects quotes, escapes, weighted groups, and Swarm `<...>` syntax - none of those get
 *    split on an internal comma - and reports malformed (unbalanced quote/bracket) input rather than guessing.
 * 10. The ordered-draft composer emits a NEW string without touching the source prompt, follows the six-stage
 *     section order, and keeps unknown/General tokens in their original relative order.
 * 11. Tag normalization is previewed/undoable/idempotent, and never rewrites an active LoRA's literal trigger
 *     text even when that text would otherwise be lowercased.
 * 12. LoRA role assignments persist across a save/load round trip, keyed by normalized LoRA name.
 * 13. A preset-supplied ("locked") LoRA row exposes no role selector and no insertion action.
 * 14. DescribeModel enrichment is requested at most once per uncached ACTIVE LoRA, is cached for reuse, and is
 *     never requested for the LoRA catalog/picker.
 * 15. TagDex character/artist classification is used only when TagDex's own index is already loaded/ready -
 *     never fetched by the coach itself.
 * 16. Custom (phase 5) profiles resolve as an explicit override, persist across save/load, and a deleted
 *     custom profile clears any override that pointed at it rather than leaving a phantom resolution.
 *
 * Runs the REAL shipped source: index.html with its server tokens substituted, the real m.css, and the real
 * m_*.js modules, with the Create panel built directly instead of booting (m_app.js is stubbed out, since
 * there is no server here). site.js/jquery/bootstrap are stubbed; the handful of util.js helpers the panel
 * needs come from the real util.js.
 *
 * Requires playwright + a chromium build; neither is a repo dependency, so this is opt-in tooling rather than
 * part of the CI gate. Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-coach.mjs
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

const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_coach.js', 'm_create.js',
    'm_grid.js', 'm_presets.js', 'm_images.js', 'm_models.js'];
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
        if (route == 'GetMyUserData') {
            callback({ presets: [], starred_models: {} });
        }
        else if (route == 'ListT2IParams') {
            callback({ list: [] });
        }
        else if (route == 'ListModels') {
            callback({ files: [], folders: [] });
        }
        else if (route == 'DescribeModel') {
            window.__describeCalls = window.__describeCalls || [];
            window.__describeCalls.push(args.modelName);
            if (args.modelName == 'ill/rich-lora.safetensors') {
                callback({ model: { name: args.modelName, trigger_phrase: 'rich trigger phrase' } });
            }
            else {
                callback({});
            }
        }
        else {
            callback({});
        }
    };
});
page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mCreate != 'undefined' && typeof mCoach != 'undefined');
await page.evaluate(() => {
    let panel = document.querySelector('.m-panel[data-mtab="create"]');
    panel.classList.add('m-tab-active');
    mCreate.build(panel);
});

// A fixed compat-class world: two Anima checkpoints (one official-name, one third-party) and one generic
// SDXL checkpoint, so resolution can be tested without ever calling DescribeModel.
await page.evaluate(() => {
    mState.loadParamMeta({
        list: [],
        models: {
            'Stable-Diffusion': [
                ['anima/anima-aesthetic-v1.safetensors', 'anima-image'],
                ['anima/some-finetune.safetensors', 'anima-image'],
                ['ill/anime-checkpoint.safetensors', 'sdxl-base']
            ]
        },
        model_classes: {
            'anima-image': { 'compat_class': 'anima' },
            'sdxl-base': { 'compat_class': 'stable-diffusion-xl-v1' }
        }
    });
});

// The entry point is a slim pill on the prompt heading row - not a modal, and not something model selection
// can open by itself. Tapping it is the only route into the sheet.
const entry = await page.evaluate(() => {
    let pill = document.querySelector('.m-coach-pill');
    return { present: !!pill, onHeadRow: !!(pill && pill.parentElement.classList.contains('m-prompt-head')),
        sheets: document.querySelectorAll('.m-sheet').length };
});
check('the coach entry point is a pill on the prompt heading row and opens nothing by itself',
    entry.present && entry.onHeadRow && entry.sheets == 0, JSON.stringify(entry));

// ---- 1. Profile resolution: Anima official name vs a generic (non-Anima) checkpoint ----
const officialResolve = await page.evaluate(() => {
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    return mCoach.resolveProfile();
});
check('an official Anima filename resolves to its exact profile',
    officialResolve.family == 'anima' && officialResolve.profileId == 'anima-aesthetic' && officialResolve.confidence == 'inferred',
    JSON.stringify(officialResolve));

const genericResolve = await page.evaluate(() => {
    mState.params['model'] = 'ill/anime-checkpoint.safetensors';
    return mCoach.resolveProfile();
});
check('a generic (non-Anima) checkpoint resolves to no profile, not a guessed one',
    genericResolve.family == null && genericResolve.profileId == null && genericResolve.profile == null,
    JSON.stringify(genericResolve));

const finetuneResolve = await page.evaluate(() => {
    mState.params['model'] = 'anima/some-finetune.safetensors';
    return mCoach.resolveProfile();
});
check('an Anima-compat third-party finetune with no matching filename is family-known but variant-unassigned '
    + '(never auto-picked)',
    finetuneResolve.family == 'anima' && finetuneResolve.profileId == null && finetuneResolve.confidence == 'unassigned',
    JSON.stringify(finetuneResolve));

const remembered = await page.evaluate(() => {
    mCoach.setProfileOverride('anima-turbo');
    let resolved = mCoach.resolveProfile();
    // Switching to a different checkpoint must not carry the override with it - it is keyed per checkpoint.
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    let other = mCoach.resolveProfile();
    mState.params['model'] = 'anima/some-finetune.safetensors';
    return { resolved, otherProfileId: other.profileId };
});
check('"Remember for this checkpoint" persists an explicit override for THIS checkpoint only',
    remembered.resolved.profileId == 'anima-turbo' && remembered.resolved.confidence == 'explicit'
    && remembered.otherProfileId == 'anima-aesthetic', JSON.stringify(remembered));

// ---- 2. Add missing: preview + apply + undo, idempotent ----
await page.evaluate(() => {
    mCoach.setProfileOverride(null);
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mState.promptGuide.modeByFamily['anima'] = 'tags';
    mState.params['prompt'] = 'a cat, sitting';
});
// Aesthetic ships an empty positivePrefix by design (Quality mode defaults to None) - use Base, whose prefix
// is non-empty, so there is something to add.
const addMissingFlow = await page.evaluate(() => {
    mCoach.setProfileOverride('anima-base');
    let before = mState.params['prompt'];
    let profile = mCoach.resolveProfile().profile;
    let missing = mCoach.computeMissing('prompt', profile.positivePrefix);
    let preview = mCoach.previewAddMissing('prompt', missing);
    let applied = mCoach.applyAddMissing('prompt', profile.positivePrefix, 'positive');
    let afterApply = mState.params['prompt'];
    let secondApply = mCoach.applyAddMissing('prompt', profile.positivePrefix, 'positive');
    let afterSecondApply = mState.params['prompt'];
    let undone = mCoach.undo();
    let afterUndo = mState.params['prompt'];
    return { before, missingCount: missing.length, previewAfter: preview.after, applied, afterApply,
        secondApply, afterSecondApply, undone, afterUndo };
});
check('Add missing computes the exact missing tags and previews the exact resulting text before writing anything',
    addMissingFlow.missingCount == 4 && addMissingFlow.previewAfter == 'masterpiece, best quality, score_7, safe, a cat, sitting',
    JSON.stringify(addMissingFlow));
check('applying Add missing writes exactly the previewed text',
    addMissingFlow.applied === true && addMissingFlow.afterApply == addMissingFlow.previewAfter,
    JSON.stringify(addMissingFlow));
check('applying Add missing a second time is a no-op - idempotent, no second diff',
    addMissingFlow.secondApply === false && addMissingFlow.afterSecondApply == addMissingFlow.afterApply,
    JSON.stringify(addMissingFlow));
check('Undo restores the exact original text, byte-for-byte',
    addMissingFlow.undone === true && addMissingFlow.afterUndo == addMissingFlow.before,
    JSON.stringify(addMissingFlow));

// ---- 3. Prose mode never rewrites the prompt ----
const proseFlow = await page.evaluate(() => {
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mCoach.setProfileOverride('anima-base');
    mCoach.setMode('natural');
    let prose = 'Miku stands on a stage under bright lights, holding a green leek in her right hand. '
        + 'She smiles warmly at the crowd.';
    mState.params['prompt'] = prose;
    let applied = mCoach.applyAddMissing('prompt', mCoach.resolveProfile().profile.positivePrefix, 'positive');
    return { prose, applied, after: mState.params['prompt'], mode: mCoach.currentMode() };
});
check('natural-language mode refuses to run Add missing at all',
    proseFlow.applied === false, JSON.stringify(proseFlow));
check('the prose is preserved byte-for-byte - not one character moved, added, or reordered',
    proseFlow.after === proseFlow.prose, JSON.stringify(proseFlow));

// ---- 4. Every mutating tap in the sheet opens an exact before/after preview first ----
await page.evaluate(() => {
    mCoach.setMode('tags');
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mCoach.setProfileOverride('anima-base');
    mState.params['prompt'] = 'a cat, sitting';
});
await page.click('.m-coach-pill');
await page.waitForSelector('.m-coach-sheet .m-coach-apply-button');
let dialogText = '';
page.once('dialog', async dialog => {
    dialogText = dialog.message();
    await dialog.dismiss();
});
await page.locator('.m-coach-sheet .m-coach-apply-button', { hasText: 'Add missing' }).click();
const declined = await page.evaluate(() => mState.params['prompt']);
check('tapping Add missing shows the exact before and after text before writing anything',
    dialogText.includes('Before:\na cat, sitting') && dialogText.includes('After:\nmasterpiece, best quality, score_7, safe, a cat, sitting'),
    JSON.stringify(dialogText));
check('declining the preview leaves the prompt byte-for-byte unchanged', declined == 'a cat, sitting', declined);
page.once('dialog', async dialog => await dialog.accept());
await page.locator('.m-coach-sheet .m-coach-apply-button', { hasText: 'Add missing' }).click();
await page.waitForFunction(() => mState.params['prompt'] != 'a cat, sitting');
check('accepting the preview writes exactly what it showed',
    await page.evaluate(() => mState.params['prompt']) == 'masterpiece, best quality, score_7, safe, a cat, sitting');
await page.evaluate(() => {
    mCoach.undo();
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
});

// ---- 5. A preset that replaces the field blocks the edit instead of pretending it worked ----
const presetGuard = await page.evaluate(() => {
    mState.params['prompt'] = 'a cat, sitting';
    mState.presets = [{ title: 'ill/hard', is_starred: false, param_map: { prompt: 'a fixed prompt' } },
        { title: 'ill/merge', is_starred: false, param_map: { prompt: '{value}, extra' } }];
    mState.activePresets = ['ill/hard'];
    let blocked = mCoach.applyAddMissing('prompt', MCoach.PROFILES['anima-base'].positivePrefix, 'positive');
    let afterBlocked = mState.params['prompt'];
    mState.activePresets = ['ill/merge'];
    let merged = mCoach.applyAddMissing('prompt', MCoach.PROFILES['anima-base'].positivePrefix, 'positive');
    let afterMerged = mState.params['prompt'];
    mCoach.undo();
    mState.activePresets = [];
    mState.presets = [];
    return { blocked, afterBlocked, merged, afterMerged, restored: mState.params['prompt'] };
});
check('a preset that replaces the prompt blocks Add missing and leaves the field untouched',
    presetGuard.blocked === false && presetGuard.afterBlocked == 'a cat, sitting', JSON.stringify(presetGuard));
check('a {value} preset merges the raw field, so the edit is allowed to run',
    presetGuard.merged === true && presetGuard.afterMerged == 'masterpiece, best quality, score_7, safe, a cat, sitting'
    && presetGuard.restored == 'a cat, sitting', JSON.stringify(presetGuard));

// ---- 6. Steps/CFG advisory: applied once, idempotent, and Undo restores the ORIGINAL values ----
const paramAdvice = await page.evaluate(() => {
    mState.params['steps'] = '35';
    mState.params['cfgscale'] = '4.5';
    let profile = MCoach.PROFILES['anima-turbo'];
    let first = mCoach.applyParamAdvice(profile);
    let afterFirst = [mState.params['steps'], mState.params['cfgscale']].join('/');
    let second = mCoach.applyParamAdvice(profile);
    let afterSecond = [mState.params['steps'], mState.params['cfgscale']].join('/');
    mCoach.undo();
    return { first, afterFirst, second, afterSecond, afterUndo: [mState.params['steps'], mState.params['cfgscale']].join('/') };
});
check('the Turbo Steps/CFG advisory writes the recommended values once',
    paramAdvice.first === true && paramAdvice.afterFirst == '8/1', JSON.stringify(paramAdvice));
check('applying it again is a no-op, so Undo still restores the values the user actually had',
    paramAdvice.second === false && paramAdvice.afterSecond == '8/1' && paramAdvice.afterUndo == '35/4.5',
    JSON.stringify(paramAdvice));

// ---- 7. The Aesthetic score-tag advisory is a warning only - it never strips anything ----
const scoreWarning = await page.evaluate(() => {
    delete mState.params['steps'];
    delete mState.params['cfgscale'];
    mCoach.setProfileOverride('anima-aesthetic');
    mState.params['prompt'] = 'score_7, a cat';
    mState.params['negativeprompt'] = 'score_1, blurry';
    let rows = mCoach.advisories(mCoach.resolveProfile());
    return { hits: mCoach.scoreTagHits().join(','), kinds: rows.map(row => row.kind).join(','),
        prompt: mState.params['prompt'], negative: mState.params['negativeprompt'] };
});
check('Aesthetic flags score tags in both prompts and never removes them',
    scoreWarning.hits == 'score_7,score_1' && scoreWarning.kinds.includes('scoreWarning')
    && scoreWarning.prompt == 'score_7, a cat' && scoreWarning.negative == 'score_1, blurry', JSON.stringify(scoreWarning));

// ---- 8. Persistence across a state save/load round trip ----
const persisted = await page.evaluate(() => {
    mCoach.setMode('tags');
    mState.params['model'] = 'anima/some-finetune.safetensors';
    mCoach.setProfileOverride('anima-turbo');
    mState.save();
    let before = JSON.parse(JSON.stringify(mState.promptGuide));
    // Simulate a fresh load (new tab / reopened PWA): wipe the in-memory copy, then read back from the same
    // localStorage key every other /simple preference persists through.
    mState.promptGuide = MState.defaultPromptGuide();
    mState.load();
    let after = mState.promptGuide;
    return { before, after, resolvedAfterReload: mCoach.resolveProfile() };
});
check('the checkpoint override and mode survive a save/load round trip',
    persisted.after.checkpointProfiles['anima/some-finetune.safetensors'] == 'anima-turbo'
    && persisted.after.modeByFamily['anima'] == 'tags',
    JSON.stringify(persisted.after));
check('resolution after reload matches resolution before it - the persisted state is actually read, not just stored',
    persisted.resolvedAfterReload.profileId == 'anima-turbo' && persisted.resolvedAfterReload.confidence == 'explicit',
    JSON.stringify(persisted.resolvedAfterReload));

// ---- 9. Tag tokenizer: quotes, escapes, weighted groups, Swarm syntax survive untouched; malformed detection ----
const tokenizerFixtures = await page.evaluate(() => {
    return {
        quoted: MCoach.tokenize('"a, b", c').map(t => t.raw),
        escaped: MCoach.tokenize('a\\, b, c').map(t => t.raw),
        weighted: MCoach.tokenize('(red hair, blue eyes:1.5), green').map(t => t.raw),
        loraTag: MCoach.tokenize('<lora:foo:1>, a cat').map(t => t.raw),
        triggerTag: MCoach.tokenize('<trigger>, a cat').map(t => t.raw),
        malformedQuote: MCoach.tokenizeChecked('"unterminated, tag').malformed,
        malformedBracket: MCoach.tokenizeChecked('(unterminated, tag').malformed,
        wellFormed: MCoach.tokenizeChecked('a cat, sitting').malformed
    };
});
check('a quoted comma stays inside one token, quotes kept in the raw slice',
    JSON.stringify(tokenizerFixtures.quoted) == JSON.stringify(['"a, b"', ' c']), JSON.stringify(tokenizerFixtures.quoted));
check('an escaped comma stays inside one token, backslash preserved literally',
    JSON.stringify(tokenizerFixtures.escaped) == JSON.stringify(['a\\, b', ' c']), JSON.stringify(tokenizerFixtures.escaped));
check('a weighted group (tag:1.2) keeps its internal comma inside one token',
    JSON.stringify(tokenizerFixtures.weighted) == JSON.stringify(['(red hair, blue eyes:1.5)', ' green']), JSON.stringify(tokenizerFixtures.weighted));
check('<lora:...> syntax survives untouched as one token',
    JSON.stringify(tokenizerFixtures.loraTag) == JSON.stringify(['<lora:foo:1>', ' a cat']), JSON.stringify(tokenizerFixtures.loraTag));
check('<trigger> syntax survives untouched as one token',
    JSON.stringify(tokenizerFixtures.triggerTag) == JSON.stringify(['<trigger>', ' a cat']), JSON.stringify(tokenizerFixtures.triggerTag));
check('an unterminated quote is reported malformed', tokenizerFixtures.malformedQuote === true);
check('an unbalanced bracket is reported malformed', tokenizerFixtures.malformedBracket === true);
check('ordinary well-formed text is not reported malformed', tokenizerFixtures.wellFormed === false);

// ---- 10. Ordered draft: new string only, six-stage order, unknown/General tokens keep relative order ----
const draftFlow = await page.evaluate(() => {
    mCoach.setProfileOverride(null);
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mCoach.setMode('tags');
    mState.presets = [];
    mState.activePresets = [];
    delete mState.params['loras'];
    delete mState.params['loraweights'];
    mState.promptGuide.loraRoles = {};
    let before = 'a cat, hatsune miku, __wildcard__, masterpiece, some studio, 1girl, unknownthing';
    mState.params['prompt'] = before;
    let plan = mCoach.buildOrderedDraft('prompt');
    let untouched = mState.params['prompt'];
    return { before, draft: plan.draft, blocked: plan.blocked, untouched };
});
check('buildOrderedDraft never mutates the source prompt on its own',
    draftFlow.untouched == draftFlow.before, JSON.stringify(draftFlow));
check('the ordered draft moves quality/subject tokens ahead of General, and General/unknown tokens keep their original relative order',
    draftFlow.draft == 'masterpiece, 1girl, a cat, hatsune miku, __wildcard__, some studio, unknownthing', JSON.stringify(draftFlow));

// ---- 15. TagDex bridge: used only when its own index is already loaded/ready, never fetched by the coach ----
const tagdexFlow = await page.evaluate(() => {
    tagDexCore.shards = [];
    tagDexCore.lastWord = null;
    tagDexCore.lastHits = null;
    tagDexCore.status = 'ready';
    tagDexCore.addShard({ id: 'test_char', kind: 'character', label: 'Test' }, 'hatsune_miku\thatsune miku\tvocaloid\t\t100000\n');
    tagDexCore.addShard({ id: 'test_artist', kind: 'artist', label: 'TestArtist' }, 'some_studio\tsome studio\t\t\t5000\n');
    mCoach.setMode('tags');
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mCoach.setProfileOverride(null);
    delete mState.params['loras'];
    delete mState.params['loraweights'];
    mState.params['prompt'] = 'a cat, hatsune miku, some studio, masterpiece';
    let plan = mCoach.buildOrderedDraft('prompt');
    tagDexCore.status = 'unloaded';
    tagDexCore.shards = [];
    return { draft: plan.draft };
});
check('TagDex-known character/artist names already loaded on the client are classified into their sections',
    tagdexFlow.draft == 'masterpiece, hatsune miku, some studio, a cat', JSON.stringify(tagdexFlow));

// ---- 11. Normalization: previewed, idempotent, undoable, exempts an active LoRA's literal trigger text ----
const normFlow = await page.evaluate(() => {
    mCoach.setMode('tags');
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mCoach.setProfileOverride(null);
    mState.presets = [];
    mState.activePresets = [];
    delete mState.params['loras'];
    delete mState.params['loraweights'];
    mState.params['prompt'] = 'Blue_Eyes, score_7, RED_HAIR';
    let before = mState.params['prompt'];
    let plan1 = mCoach.planNormalize('prompt');
    let applied = mCoach.applyNormalize('prompt', 'positive');
    let afterApply = mState.params['prompt'];
    let plan2 = mCoach.planNormalize('prompt');
    let appliedAgain = mCoach.applyNormalize('prompt', 'positive');
    let afterSecond = mState.params['prompt'];
    let undone = mCoach.undo();
    let afterUndo = mState.params['prompt'];
    return { before, changed1: plan1.changed, applied, afterApply, changed2: plan2.changed, appliedAgain, afterSecond, undone, afterUndo };
});
check('normalize lowercases and turns underscores to spaces, but keeps an exact score tag literal',
    normFlow.applied === true && normFlow.afterApply == 'blue eyes, score_7, red hair' && normFlow.changed1 == 2, JSON.stringify(normFlow));
check('normalizing an already-normalized prompt is idempotent - no second diff',
    normFlow.changed2 == 0 && normFlow.appliedAgain === false && normFlow.afterSecond == normFlow.afterApply, JSON.stringify(normFlow));
check('Undo restores the exact pre-normalize text',
    normFlow.undone === true && normFlow.afterUndo == normFlow.before, JSON.stringify(normFlow));

const loraNormFlow = await page.evaluate(() => {
    mCreate.loraMap = new Map();
    mCreate.loraMap.set('ill/MyLora', { name: 'ill/MyLora', trigger_phrase: 'MyTriggerWord_XYZ' });
    mState.params['loras'] = ['ill/MyLora'];
    mState.params['loraweights'] = ['1'];
    mCoach.setLoraRole('ill/MyLora', 'Character');
    mCoach.setMode('tags');
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mCoach.setProfileOverride(null);
    mState.presets = [];
    mState.activePresets = [];
    mState.params['prompt'] = 'MyTriggerWord_XYZ, Blue_Eyes';
    let plan = mCoach.planNormalize('prompt');
    delete mState.params['loras'];
    delete mState.params['loraweights'];
    mState.promptGuide.loraRoles = {};
    return { after: plan.after, changed: plan.changed };
});
check("an active LoRA's literal trigger text is exempt from normalization even though the rest of the field is lowercased",
    loraNormFlow.after == 'MyTriggerWord_XYZ, blue eyes' && loraNormFlow.changed == 1, JSON.stringify(loraNormFlow));

// ---- Section-aware "Prompt" insertion targets the section the LoRA's role implies ----
const sectionInsertFlow = await page.evaluate(() => {
    mCreate.loraMap = new Map();
    mCreate.loraMap.set('ill/CharLora', { name: 'ill/CharLora', trigger_phrase: 'my character trigger' });
    mState.params['loras'] = ['ill/CharLora'];
    mState.params['loraweights'] = ['1'];
    mCoach.setLoraRole('ill/CharLora', 'Character');
    mCoach.setMode('tags');
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mCoach.setProfileOverride(null);
    mState.presets = [];
    mState.activePresets = [];
    mState.params['prompt'] = 'masterpiece, 1girl, some studio';
    let plan = mCoach.planSectionInsert('my character trigger', 'Character');
    delete mState.params['loras'];
    delete mState.params['loraweights'];
    mState.promptGuide.loraRoles = {};
    return plan;
});
check('a Character-role LoRA trigger inserts before the first later-section token, not blindly appended at the end',
    sectionInsertFlow.sectioned === true && sectionInsertFlow.after == 'masterpiece, 1girl, my character trigger, some studio',
    JSON.stringify(sectionInsertFlow));

// ---- 12. LoRA role persistence across a save/load round trip, keyed by normalized name ----
const roleFlow = await page.evaluate(() => {
    mCoach.setLoraRole('ill/my-lora.safetensors', 'Character');
    mState.save();
    mState.promptGuide = MState.defaultPromptGuide();
    mState.load();
    let role = mCoach.getLoraRole('ill/my-lora.safetensors');
    let differentCase = mCoach.getLoraRole('ILL/MY-LORA.SAFETENSORS');
    mState.promptGuide.loraRoles = {};
    return { role, differentCase };
});
check('a LoRA role assignment survives a save/load round trip, matched case/extension-insensitively',
    roleFlow.role == 'Character' && roleFlow.differentCase == 'Character', JSON.stringify(roleFlow));

// ---- 13. A preset-supplied ("locked") LoRA row exposes no role selector and no insertion action ----
const lockedFlow = await page.evaluate(() => {
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mCoach.setProfileOverride(null);
    delete mState.params['loras'];
    delete mState.params['loraweights'];
    mState.presets = [{ title: 'ill/lora-preset', is_starred: false, param_map: { loras: ['ill/preset-lora'], loraweights: ['1'] } }];
    mState.activePresets = ['ill/lora-preset'];
    let rows = mCoach.activeLoraRows();
    mCoach.openSheet();
    let lockedNote = !!document.querySelector('.m-coach-lora-locked');
    let roleButtons = document.querySelectorAll('.m-coach-role-choice').length;
    let promptButtons = [...document.querySelectorAll('.m-coach-lora-insert')].filter(b => b.textContent == 'Prompt').length;
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    mState.presets = [];
    mState.activePresets = [];
    return { rows, lockedNote, roleButtons, promptButtons };
});
check('a preset-supplied LoRA is reported locked, with no role selector or insertion action rendered for it',
    lockedFlow.rows.length == 1 && lockedFlow.rows[0].locked === true && lockedFlow.lockedNote === true
    && lockedFlow.roleButtons == 0 && lockedFlow.promptButtons == 0, JSON.stringify(lockedFlow));

// ---- 14. DescribeModel: at most once per uncached active LoRA, cached for reuse, never for the catalog ----
const enrichFlow = await page.evaluate(() => {
    window.__describeCalls = [];
    mCreate.loraMap = new Map();
    mCoach.enrichInFlight = new Set();
    mCoach.enrichFailed = new Set();
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mCoach.setProfileOverride(null);
    mState.presets = [];
    mState.activePresets = [];
    mState.params['loras'] = ['ill/rich-lora.safetensors', 'ill/plain-lora.safetensors'];
    mState.params['loraweights'] = ['1', '1'];
    let rerenders = 0;
    let noop = () => { rerenders++; };
    mCoach.enrichActiveLoras(noop);
    let afterFirst = [...window.__describeCalls];
    mCoach.enrichActiveLoras(noop);
    let afterSecond = [...window.__describeCalls];
    let richTrigger = mCreate.loraByName('ill/rich-lora.safetensors').trigger_phrase;
    delete mState.params['loras'];
    delete mState.params['loraweights'];
    return { afterFirst, afterSecond, richTrigger };
});
check('DescribeModel is requested at most once per uncached active LoRA, and never again once cached/failed',
    enrichFlow.afterFirst.length == 2 && enrichFlow.afterSecond.length == 2
    && enrichFlow.afterFirst.includes('ill/rich-lora.safetensors') && enrichFlow.afterFirst.includes('ill/plain-lora.safetensors'),
    JSON.stringify(enrichFlow));
check("a successful DescribeModel response is cached into m_create.js's own loraMap for reuse",
    enrichFlow.richTrigger == 'rich trigger phrase', JSON.stringify(enrichFlow));

const catalogFlow = await page.evaluate(() => {
    window.__describeCalls = [];
    delete mState.params['loras'];
    delete mState.params['loraweights'];
    mCreate.openLoraSheet();
    let calls = [...window.__describeCalls];
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    return { calls };
});
check('opening the LoRA catalog/picker never calls DescribeModel',
    catalogFlow.calls.length == 0, JSON.stringify(catalogFlow));

// ---- 16. Custom (phase 5) profiles: explicit-only resolution, persistence, and clean deletion ----
const customFlow = await page.evaluate(() => {
    mState.params['model'] = 'ill/some-other-checkpoint.safetensors';
    mCoach.setProfileOverride(null);
    let id = mCoach.addCustomProfile({ 'label': 'My House Style', 'positivePrefix': ['aaa', 'bbb'],
        'negativeSuggested': ['ccc'], 'scoreForbidden': false, 'parameterAdvice': null });
    mCoach.setProfileOverride(id);
    let resolved = mCoach.resolveProfile();
    mState.save();
    mState.promptGuide = MState.defaultPromptGuide();
    mState.load();
    let resolvedAfterReload = mCoach.resolveProfile();
    mCoach.removeCustomProfile(id);
    let afterRemove = mCoach.resolveProfile();
    return { id, resolved, resolvedAfterReload, afterRemove };
});
check('a custom profile resolves as an explicit override once selected, and is never auto-suggested',
    customFlow.resolved.profileId == customFlow.id && customFlow.resolved.confidence == 'explicit'
    && customFlow.resolved.profile.label == 'My House Style', JSON.stringify(customFlow));
check('a custom profile and its checkpoint override survive a save/load round trip',
    customFlow.resolvedAfterReload.profileId == customFlow.id
    && customFlow.resolvedAfterReload.profile.positivePrefix.join(',') == 'aaa,bbb', JSON.stringify(customFlow));
check('deleting a custom profile clears the override that pointed at it, rather than leaving a phantom resolution',
    customFlow.afterRemove.profileId == null && customFlow.afterRemove.confidence == 'unassigned', JSON.stringify(customFlow));

// ---- 17. Tokenizer round trip: the raw slices plus the commas that split them ARE the original string ----
const roundTrip = await page.evaluate(() => {
    let fixtures = ['', '   ', 'a cat, sitting', 'a cat, sitting,', ' , ,, ', '(red hair, blue eyes:1.5), green',
        '(a, (b, c):1.2), d', '<segment:a face,0.6,0.5>, portrait', '<lora:foo:0.8>, <trigger>, a cat',
        'a\\, b, c', '"a, b", c', 'MyTrigger_Word,  __wildcard__ ,\tscore_7'];
    return fixtures.map(text => {
        let pieces = MCoach.tokenizeRaw(text).pieces.map(p => p.raw);
        return { text, rebuilt: pieces.join(','), ok: pieces.join(',') === text };
    });
});
check('tokenizing and re-joining reproduces every fixture byte-for-byte - empty, whitespace-only, trailing '
    + 'comma, nested parens, escapes, quotes, and Swarm <...> syntax all included',
    roundTrip.every(r => r.ok), JSON.stringify(roundTrip.filter(r => !r.ok)));

// ---- 18. The ordered draft is a permutation: no token dropped, none duplicated ----
const draftPermutation = await page.evaluate(() => {
    mCoach.setMode('tags');
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mCoach.setProfileOverride(null);
    mState.presets = [];
    mState.activePresets = [];
    delete mState.params['loras'];
    delete mState.params['loraweights'];
    mState.params['prompt'] = 'a cat, 1girl, masterpiece, (red hair, blue eyes:1.5), <lora:foo:0.8>, '
        + '<trigger>, __wildcard__, a cat, score_7';
    let source = MCoach.tokenize(mState.params['prompt']).map(t => t.raw.trim()).sort();
    let plan = mCoach.buildOrderedDraft('prompt');
    let drafted = MCoach.tokenize(plan.draft).map(t => t.raw.trim()).sort();
    return { source, drafted, same: JSON.stringify(source) == JSON.stringify(drafted) };
});
check('the ordered draft is a pure reordering - every source token appears exactly once, including the '
    + 'duplicate, the weighted group and the Swarm syntax',
    draftPermutation.same === true, JSON.stringify(draftPermutation));

// ---- 19. The TagDex bridge classifies on an EXACT record, never on a substring hit ----
const tagdexExact = await page.evaluate(() => {
    tagDexCore.shards = [];
    tagDexCore.lastWord = null;
    tagDexCore.lastHits = null;
    tagDexCore.status = 'ready';
    tagDexCore.addShard({ id: 'test_char', kind: 'character', label: 'Test' }, 'hatsune_miku\thatsune miku\tvocaloid\t\t100000\n');
    mCoach.setMode('tags');
    mState.params['prompt'] = 'zzz other, miku';
    let substring = mCoach.buildOrderedDraft('prompt').draft;
    mState.params['prompt'] = 'zzz other, hatsune miku';
    let exact = mCoach.buildOrderedDraft('prompt').draft;
    tagDexCore.status = 'unloaded';
    tagDexCore.shards = [];
    return { substring, exact };
});
check('a token that is only a SUBSTRING of a TagDex character name stays General in original order - an '
    + 'unsure classifier is not permission to move text',
    tagdexExact.substring == 'zzz other, miku', JSON.stringify(tagdexExact));
check('the exact TagDex character name is still classified and ordered ahead of General',
    tagdexExact.exact == 'hatsune miku, zzz other', JSON.stringify(tagdexExact));

// ---- 20. Normalization leaves prompt syntax, wildcard names and paths byte-for-byte alone ----
const normLiterals = await page.evaluate(() => {
    mCoach.setMode('tags');
    mState.presets = [];
    mState.activePresets = [];
    delete mState.params['loras'];
    delete mState.params['loraweights'];
    mState.params['prompt'] = '<segment:A Face,0.6,0.5>, __My_Wildcard__, Blue_Eyes, ill/Some_Model';
    let plan = mCoach.planNormalize('prompt');
    return { after: plan.after, changed: plan.changed, untouched: mState.params['prompt'] };
});
check('normalization rewrites only ordinary tag text - Swarm <...> syntax, a __wildcard__ name and a path-like '
    + 'token all survive byte-for-byte',
    normLiterals.after == '<segment:A Face,0.6,0.5>, __My_Wildcard__, blue eyes, ill/Some_Model'
    && normLiterals.changed == 1, JSON.stringify(normLiterals));

// ---- 21. The preset-replaces-field guard covers the NEW phase 3/4 actions, not just Add missing ----
const guardNewActions = await page.evaluate(() => {
    mCoach.setMode('tags');
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mCoach.setProfileOverride(null);
    mCreate.loraMap = new Map();
    mCreate.loraMap.set('ill/CharLora', { name: 'ill/CharLora', trigger_phrase: 'my character trigger' });
    mState.params['loras'] = ['ill/CharLora'];
    mState.params['loraweights'] = ['1'];
    mCoach.setLoraRole('ill/CharLora', 'Character');
    mState.params['prompt'] = 'a cat, 1girl';
    mState.presets = [{ title: 'ill/hard', is_starred: false, param_map: { prompt: 'a fixed prompt' } }];
    mState.activePresets = ['ill/hard'];
    let draft = mCoach.buildOrderedDraft('prompt');
    let usedDraft = mCoach.confirmUseDraft('prompt', () => {});
    let insert = mCoach.planSectionInsert('my character trigger', 'Character');
    let literal = mCoach.insertLiteralTrigger('my character trigger');
    let norm = mCoach.planNormalize('prompt');
    let after = mState.params['prompt'];
    mState.presets = [];
    mState.activePresets = [];
    delete mState.params['loras'];
    delete mState.params['loraweights'];
    mState.promptGuide.loraRoles = {};
    return { draftBlocked: draft.blocked, usedDraft, insertBlocked: insert.blocked, literal,
        normBlocked: norm.blocked, after };
});
check('a preset that replaces the prompt blocks the ordered draft, the section-aware trigger insertion and '
    + 'the literal trigger insertion too - not just Add missing - and writes nothing',
    !!guardNewActions.draftBlocked && guardNewActions.usedDraft === false && !!guardNewActions.insertBlocked
    && guardNewActions.literal === false && !!guardNewActions.normBlocked && guardNewActions.after == 'a cat, 1girl',
    JSON.stringify(guardNewActions));

// ---- 22. Analysis runs against the EFFECTIVE prompt, so a {value} preset's own tags are not re-added ----
const effectiveAnalysis = await page.evaluate(() => {
    mCoach.setMode('tags');
    mState.params['prompt'] = 'a cat';
    mState.params['negativeprompt'] = '';
    mState.presets = [{ title: 'ill/merge', is_starred: false,
        param_map: { prompt: 'masterpiece, best quality, {value}', negativeprompt: 'score_1, {value}' } }];
    mState.activePresets = ['ill/merge'];
    let missing = mCoach.computeMissing('prompt', MCoach.PROFILES['anima-base'].positivePrefix);
    let scoreHits = mCoach.scoreTagHits();
    mState.activePresets = [];
    mState.presets = [];
    let missingWithoutPreset = mCoach.computeMissing('prompt', MCoach.PROFILES['anima-base'].positivePrefix);
    return { missing, scoreHits, missingWithoutPreset };
});
check('a {value} preset that already contributes "masterpiece, best quality" makes them count as present - '
    + 'analysis reads the effective prompt, not the raw field',
    effectiveAnalysis.missing.join(',') == 'score_7,safe'
    && effectiveAnalysis.missingWithoutPreset.join(',') == 'masterpiece,best quality,score_7,safe',
    JSON.stringify(effectiveAnalysis));
check('the Aesthetic score-tag warning sees a score tag a preset injected into the negative prompt',
    effectiveAnalysis.scoreHits.join(',') == 'score_1', JSON.stringify(effectiveAnalysis));

// ---- 23. A closed sheet is inert: no rebuild, and above all no DescribeModel for a sheet nobody is looking at ----
const closedSheet = await page.evaluate(() => {
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mCoach.setProfileOverride(null);
    mState.presets = [];
    mState.activePresets = [];
    mCreate.loraMap = new Map();
    mCoach.enrichInFlight = new Set();
    mCoach.enrichFailed = new Set();
    mState.params['loras'] = ['ill/uncached-lora.safetensors'];
    mState.params['loraweights'] = ['1'];
    mCoach.openSheet();
    let openCalls = [...(window.__describeCalls = window.__describeCalls || [])].length;
    // Dismiss the way mUI.openSheet's backdrop tap eventually does - by detaching it.
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    window.__describeCalls = [];
    mCreate.loraMap = new Map();
    mCoach.enrichInFlight = new Set();
    mCoach.enrichFailed = new Set();
    mCoach.refreshSheet();
    let afterClose = [...window.__describeCalls];
    let cleared = mCoach.sheetContent === null && mCoach.sheetRerender === null;
    delete mState.params['loras'];
    delete mState.params['loraweights'];
    return { openCalls, afterClose, cleared };
});
check('an open sheet enriches its uncached active LoRA, and a closed one is inert - no rebuild and no '
    + 'DescribeModel once the sheet is gone',
    closedSheet.openCalls > 0 && closedSheet.afterClose.length == 0 && closedSheet.cleared === true,
    JSON.stringify(closedSheet));

// ---- 24. Rendering is read-only: building the sheet never writes state ----
const renderPurity = await page.evaluate(() => {
    delete mState.params['loras'];
    delete mState.params['loraweights'];
    mState.params['model'] = 'anima/anima-aesthetic-v1.safetensors';
    mCoach.setProfileOverride('anima-base');
    mState.params['prompt'] = 'a cat, sitting';
    let real = mState.changed;
    let calls = 0;
    mState.changed = function () { calls++; return real.apply(this, arguments); };
    mCoach.openSheet();
    mCoach.refreshSheet();
    mCoach.renderPill();
    mState.changed = real;
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    return { calls };
});
check('opening, re-rendering and re-labelling the coach never calls mState.changed() - no render-loop write',
    renderPurity.calls == 0, JSON.stringify(renderPurity));

await browser.close();
const failed = results.filter(result => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
