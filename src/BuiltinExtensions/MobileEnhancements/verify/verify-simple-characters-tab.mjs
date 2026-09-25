/**
 * /simple Characters-tab harness (fork). Guards the TagDex bottom-nav tab:
 *
 * 1. Registration: TagDex adds a fourth nav slot (Create/Images/Models/Characters) and its panel without
 *    editing index.html, via mUI.registerNavTab. More lives in the header, not the nav.
 * 2. Pagination contract: one bounded page of cards per request (no endless scroll), Prev/Next walk the
 *    offset, the pager clamps at both ends, and a narrowed result set clamps a stale offset back to a real
 *    page instead of showing an empty one.
 * 3. Search resets to page one; favorites filter round-trips through TagDexToggleFavorite.
 * 4. Tapping a card inserts the trigger and its core tags into the Create prompt at the remembered caret.
 *
 * Runs the REAL shipped source, same scheme as verify-simple-create-panel.mjs: index.html with tokens
 * substituted, real m_*.js and TagDex assets, server stubbed at genericRequest. m_app.js is absent, so the
 * router is driven by calling mUI.applyHash() directly.
 *
 * Run from the repo root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-characters-tab.mjs
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

const CLIENT = ['m.css', 'm_state.js', 'm_gen.js', 'm_ui.js', 'm_autocomplete.js', 'm_coach.js', 'm_enhance.js', 'm_create.js', 'm_grid.js', 'm_presets.js', 'm_images.js', 'm_models.js'];
const FILES = {
    '/js/util.js': `${REPO}/src/wwwroot/js/util.js`,
    '/ExtensionFile/TagDexExtension/Assets/tagdex_core.js': `${TAGDEX}/tagdex_core.js`,
    '/ExtensionFile/TagDexExtension/Assets/m_tagdex.js': `${TAGDEX}/m_tagdex.js`,
    '/ExtensionFile/TagDexExtension/Assets/m_tagdex.css': `${TAGDEX}/m_tagdex.css`,
    '/ExtensionFile/TagDexExtension/Assets/tagdex_editor.js': `${TAGDEX}/tagdex_editor.js`,
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
// Server stub: a 120-row character dataset with real offset/limit/search/favorites semantics, so the
// pagination logic under test runs against honest totals rather than a one-row echo.
await page.addInitScript(() => {
    window.showError = function (message) { window.__err = message; };
    window.getUserSetting = () => '';
    window.__requests = [];
    window.__favorites = new Set(['char_007']);
    window.__dataset = Array.from({ length: 120 }, (unused, i) => ({
        name: `char_${`${i}`.padStart(3, '0')}`,
        display: `Char ${i}`,
        trigger: `char_${`${i}`.padStart(3, '0')}, series`,
        count: 1000 - i,
        copyright_display: 'Series',
        kind: 'character',
        core_tags: ['long hair', 'blue eyes']
    }));
    window.genericRequest = (route, args, callback) => {
        window.__requests.push({ route, args });
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
            let rows = window.__dataset.filter(row => !args.search || row.name.includes(args.search));
            if (args.favoritesOnly) {
                rows = rows.filter(row => window.__favorites.has(row.name));
            }
            let pageRows = rows.slice(args.offset, args.offset + args.limit)
                .map(row => ({ ...row, favorited: window.__favorites.has(row.name) }));
            callback({ total: rows.length, offset: args.offset, limit: args.limit, results: pageRows });
        }
        else if (route == 'TagDexToggleFavorite') {
            let has = window.__favorites.has(args.name);
            if (has) {
                window.__favorites.delete(args.name);
            }
            else {
                window.__favorites.add(args.name);
            }
            callback({ success: true, favorited: !has });
        }
        else if (route == 'GetMyUserData') {
            callback({ presets: [], starred_models: {} });
        }
        else if (route == 'TagDexLibraryReview' && args.view == 'favorites') {
            callback({ ok: true, results: [{ data: { target_kind: 'character', target_id: 'lib1', favorited: true } }] });
        }
        else if (route == 'TagDexLibrarySave') {
            if (args.action == 'create_character') {
                callback({ ok: true, record: { id: 'libNew', revision: 'r1', data: args.body.data } });
            }
            else {
                callback({ ok: true, record: { id: 'fav', data: args.body } });
            }
        }
        else if (route == 'TagDexLibraryCharacter') {
            let variants = args.id == 'lib1' ? [{ id: 'v1', revision: 'r1',
                data: { name: 'Robot', archived: false, recipe: { prompt: 'ariarobzzz, robot joints', negative_prompt: '', checkpoint: '', loras: [] } } }] : [];
            callback({ ok: true, record: { id: args.id, revision: 'r1', data: { name: args.id == 'lib1' ? 'Aria (Robot)' : 'Solo', series: '' } }, variants });
        }
        else if (route == 'TagDexLibraryResolve') {
            callback({ ok: true, ready: true, loras: [] });
        }
        else if (route == 'TagDexLibraryCharacters') {
            let rows = [{ id: 'lib1', data: { name: 'Aria (Robot)', series: 'Zenless Zone Zero', archived: false } },
                { id: 'lib2', data: { name: 'Solo', series: '', archived: false } }]
                .filter(row => !args.q || row.data.name.toLowerCase().includes(args.q.toLowerCase()));
            callback({ ok: true, total: rows.length, results: rows });
        }
    };
    window.makeWSRequest = () => null;
    window.getSession = () => {};
    window.getImageOutPrefix = () => 'View/local';
    window.isValidMediaPath = () => true;
    window.getTextSelRange = () => [0, 0];
    window.largeCountStringify = value => `${value}`;
    window.session_id = 'test';
    window.permissions = { hasPermission: () => true };
});
page.on('pageerror', e => check(`no page errors (${e.message})`, false));

await page.goto('http://localhost/simple');
await page.waitForFunction(() => typeof mCreate != 'undefined' && typeof mTagDex != 'undefined');

// ---- Registration ----
const nav = await page.evaluate(() => ({
    items: [...document.querySelectorAll('.m-nav-item')].map(btn => btn.dataset.mdest),
    panel: !!document.querySelector('.m-panel[data-mtab="characters"]'),
    headerMore: document.querySelector('.m-header-link')?.getAttribute('href'),
}));
check('Characters is the fourth nav slot, More is not in the nav', nav.items.join(',') == 'create,images,models,characters', nav.items.join(','));
check('the characters panel exists', nav.panel);
check('the header link is the More entry point', nav.headerMore == '#more', `${nav.headerMore}`);

// ---- Build the Create panel (for prompt insertion), then activate the tab ----
await page.evaluate(() => {
    mCreate.build(document.querySelector('.m-panel[data-mtab="create"]'));
    location.hash = 'characters';
    mUI.applyHash();
});
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card)').length > 0);

// The tab opens on favorites (only char_007 is starred); one tap on the filter shows everything.
const opening = await page.evaluate(() => ({
    view: document.querySelector('.m-tagdex-tab .m-tagdex-source').value,
    viewLabel: document.querySelector('.m-tagdex-tab .m-tagdex-source').selectedOptions[0].textContent,
    pinned: [...document.querySelectorAll('.m-tagdex-tab .m-tagdex-library-card')].map(e => [...e.querySelectorAll('.m-tagdex-card-name, .m-tagdex-card-sub')].map(x => x.textContent).join(' · ')),
    pressed: document.querySelector('.m-tagdex-tab .m-tagdex-favorite-filter').getAttribute('aria-pressed'),
    cards: [...document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card) .m-tagdex-card-name')].map(e => e.textContent)
}));
check('the Characters tab opens on All Characters with favorited added characters pinned',
    opening.view == '__all__' && opening.viewLabel == 'All Characters'
    && opening.pinned.join('|') == 'Aria (Robot) · Zenless Zone Zero', JSON.stringify(opening));
check('the Characters tab opens on favorites', opening.pressed == 'true' && opening.cards.length == 1
    && opening.cards[0] == "Char 7", JSON.stringify(opening));
await page.evaluate(() => document.querySelector('.m-tagdex-tab .m-tagdex-favorite-filter').click());
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card)').length == 50);
const unfiltered = await page.evaluate(() => [...document.querySelectorAll('.m-tagdex-tab .m-tagdex-library-card')].length);
check('with favorites off, every added character is pinned', unfiltered == 2, `${unfiltered} pinned`);

const firstPage = await page.evaluate(() => ({
    cards: document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card)').length,
    status: document.querySelector('.m-tagdex-tab .m-tagdex-browse-status').textContent,
    label: document.querySelector('.m-tagdex-page-label').textContent,
    prevDisabled: document.querySelector('.m-tagdex-pager .m-tagdex-page-button').disabled,
    pagerVisible: document.querySelector('.m-tagdex-pager').style.display != 'none',
    firstName: document.querySelector('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card) .m-tagdex-card-name').textContent,
}));
check('page one holds exactly one bounded page of cards', firstPage.cards == 50, `${firstPage.cards} cards`);
check('status names the window and the total', firstPage.status.includes('1') && firstPage.status.includes('50') && firstPage.status.includes('120'), firstPage.status);
check('pager shows 1 / 3 with Prev disabled', firstPage.label.trim() == '1 / 3' && firstPage.prevDisabled && firstPage.pagerVisible, firstPage.label);

// ---- Next walks the offset; the last page clamps ----
const nextButton = '.m-tagdex-pager .m-tagdex-page-button:last-of-type';
await page.click(nextButton);
await page.waitForFunction(() => document.querySelector('.m-tagdex-page-label').textContent.trim() == '2 / 3');
const pageTwo = await page.evaluate(() => ({
    firstName: document.querySelector('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card) .m-tagdex-card-name').textContent,
    prevDisabled: document.querySelector('.m-tagdex-pager .m-tagdex-page-button').disabled,
}));
check('Next fetches the next offset, not a longer list', pageTwo.firstName == 'Char 50' && !pageTwo.prevDisabled, pageTwo.firstName);
await page.click(nextButton);
await page.waitForFunction(() => document.querySelector('.m-tagdex-page-label').textContent.trim() == '3 / 3');
const lastPage = await page.evaluate(() => ({
    cards: document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card)').length,
    nextDisabled: document.querySelector('.m-tagdex-pager .m-tagdex-page-button:last-of-type').disabled,
}));
check('the last page holds the remainder and Next is disabled', lastPage.cards == 20 && lastPage.nextDisabled, `${lastPage.cards} cards`);

// ---- Search resets to page one ----
await page.fill('.m-tagdex-tab .m-tagdex-search', 'char_01');
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card)').length == 10);
const searched = await page.evaluate(() => ({
    status: document.querySelector('.m-tagdex-tab .m-tagdex-browse-status').textContent,
    pagerVisible: document.querySelector('.m-tagdex-pager').style.display != 'none',
    offset: window.__requests.filter(r => r.route == 'TagDexSearchEntries').at(-1).args.offset,
}));
check('search narrows from page one and hides the pager for one page of results', searched.offset == 0 && !searched.pagerVisible, JSON.stringify(searched));

// ---- A stale offset clamps to the last real page ----
// The one real flow that refetches at an unchanged offset is unstarring in the favorites view (search and
// the filter buttons all restart from page one). Star 51 rows, walk to favorites page 2, unstar its only
// row: the refetch happens at offset 50 of a 50-row list, and must land on page 1/1 rather than an empty 2/2.
await page.fill('.m-tagdex-tab .m-tagdex-search', '');
await page.waitForFunction(() => document.querySelector('.m-tagdex-page-label').textContent.trim() == '1 / 3');
await page.evaluate(() => {
    window.__favorites = new Set(window.__dataset.slice(0, 51).map(row => row.name));
    document.querySelectorAll('.m-tagdex-tab .m-tagdex-favorite-filter').forEach(button => button.click());
});
await page.waitForFunction(() => document.querySelector('.m-tagdex-page-label').textContent.trim() == '1 / 2');
await page.click(nextButton);
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card)').length == 1
    && document.querySelector('.m-tagdex-page-label').textContent.trim() == '2 / 2');
await page.evaluate(() => document.querySelector('.m-tagdex-tab .m-tagdex-favorite-button').click());
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card)').length == 50);
const clamped = await page.evaluate(() => ({
    label: document.querySelector('.m-tagdex-page-label').textContent.trim(),
    pagerVisible: document.querySelector('.m-tagdex-pager').style.display != 'none',
}));
check('unstarring the last row of the last page clamps to a real page', clamped.label == '1 / 1' || !clamped.pagerVisible, JSON.stringify(clamped));
// Back to the plain view for the checks below.
await page.evaluate(() => {
    window.__favorites = new Set(['char_007']);
    document.querySelectorAll('.m-tagdex-tab .m-tagdex-favorite-filter').forEach(button => button.click());
});
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card)').length == 50);

// ---- My Library: every added character, no favorites filter or sort ----
const libraryList = await page.evaluate(async () => {
    let source = document.querySelector('.m-tagdex-tab .m-tagdex-source');
    let libOption = [...source.options].find(o => o.value == '__library__');
    source.value = '__library__';
    source.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    let tab = document.querySelector('.m-tagdex-tab');
    let out = {
        option: libOption ? libOption.textContent : null,
        rows: [...tab.querySelectorAll('.m-tagdex-library-card')].map(e => [...e.querySelectorAll('.m-tagdex-card-name, .m-tagdex-card-sub')].map(x => x.textContent).join(' · ')),
        status: tab.querySelector('.m-tagdex-browse-status').textContent,
        favoritesHidden: tab.querySelector('.m-tagdex-favorite-filter').style.display == 'none',
        pagerHidden: tab.querySelector('.m-tagdex-pager').style.display == 'none'
    };
    source.value = 'danbooru_character';
    source.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    out.favoritesBack = tab.querySelector('.m-tagdex-favorite-filter').style.display == '';
    return out;
});
check('Characters tab offers a My Library list', !!libraryList.option, JSON.stringify(libraryList));
check('My Library lists every added character, unfiltered', libraryList.rows.length == 2
    && libraryList.rows[0] == 'Aria (Robot) · Zenless Zone Zero' && libraryList.favoritesHidden && libraryList.pagerHidden
    && libraryList.status == '2 characters', JSON.stringify(libraryList));
check('switching back to a dataset restores the favorites filter', libraryList.favoritesBack, JSON.stringify(libraryList));

// ---- Added characters are cards like the dataset ones: tap applies, ... opens variants, star is the favorite ----
const libraryCard = await page.evaluate(async () => {
    let wait = () => new Promise(r => setTimeout(r, 200));
    let tab = document.querySelector('.m-tagdex-tab');
    let source = tab.querySelector('.m-tagdex-source');
    let startSource = source.value;
    let startPressed = tab.querySelector('.m-tagdex-favorite-filter').getAttribute('aria-pressed');
    source.value = '__all__';
    source.dispatchEvent(new Event('change'));
    await wait();
    if (tab.querySelector('.m-tagdex-favorite-filter').getAttribute('aria-pressed') == 'true') {
        tab.querySelector('.m-tagdex-favorite-filter').click();
        await wait();
    }
    let cards = [...tab.querySelectorAll('.m-tagdex-library-card')];
    let aria = cards.find(c => c.querySelector('.m-tagdex-card-name').textContent == 'Aria (Robot)');
    let solo = cards.find(c => c.querySelector('.m-tagdex-card-name').textContent == 'Solo');
    let out = {
        count: aria ? aria.querySelector('.m-tagdex-card-count').textContent : null,
        hasImage: !!(aria && aria.querySelector('.m-tagdex-card-image')),
        details: aria ? aria.querySelector('.m-tagdex-alltags-button').textContent : null,
        ariaStar: aria ? aria.querySelector('.m-tagdex-favorite-button').textContent : null,
        soloStar: solo ? solo.querySelector('.m-tagdex-favorite-button').textContent : null,
        wideButtons: tab.querySelectorAll('.m-tagdex-browse-results .m-wide-button').length
    };
    mState.params['prompt'] = '1girl';
    aria.querySelector('.m-tagdex-card-main').click();
    await wait();
    out.prompt = mState.params['prompt'];
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    solo.querySelector('.m-tagdex-card-main').click();
    await wait();
    let sheet = [...document.querySelectorAll('.m-sheet')].pop();
    out.soloOpened = sheet ? sheet.querySelector('.m-sheet-title').textContent : null;
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    // Leave the tab exactly as the following checks expect it.
    source.value = startSource;
    source.dispatchEvent(new Event('change'));
    await wait();
    if (tab.querySelector('.m-tagdex-favorite-filter').getAttribute('aria-pressed') != startPressed) {
        tab.querySelector('.m-tagdex-favorite-filter').click();
        await wait();
    }
    return out;
});
check('added characters render as cards like the dataset ones', libraryCard.count == 'Your character' && libraryCard.hasImage
    && libraryCard.details == '⋯' && libraryCard.wideButtons == 0, JSON.stringify(libraryCard));
check('added-character stars show the library favorite', libraryCard.ariaStar == '★' && libraryCard.soloStar == '☆',
    JSON.stringify(libraryCard));
check('tapping an added character adds its variant to the prompt', libraryCard.prompt == '1girl, ariarobzzz, robot joints',
    JSON.stringify(libraryCard));
check('tapping a character with no variant opens its variants to add one', libraryCard.soloOpened == 'Solo', JSON.stringify(libraryCard));

// ---- Add Character sheet: themed like the other /simple sheets, no Archived box on a new character ----
const addCharacter = await page.evaluate(async () => {
    document.documentElement.style.setProperty('--emphasis', 'rgb(1, 2, 3)');
    await new Promise(resolve => mTagDex.ensureLibraryEditor(() => { tagDexLibraryEditor.character(null, true, () => {}); resolve(); }));
    await new Promise(r => setTimeout(r, 300));
    let sheet = [...document.querySelectorAll('.m-sheet')].pop();
    let save = sheet.querySelector('.tagdex-editor-actions button[type="submit"]');
    // The harness loads no theme stylesheet, so pin the theme color to a known value to compare against.
    document.documentElement.style.setProperty('--emphasis', 'rgb(1, 2, 3)');
    let emphasisRgb = 'rgb(1, 2, 3)';
    let out = {
        labels: [...sheet.querySelectorAll('.tagdex-editor-field > span')].map(e => e.textContent),
        titleSize: getComputedStyle(sheet.querySelector('.tagdex-editor h3')).fontSize,
        saveBg: getComputedStyle(save).backgroundColor, emphasisRgb,
        saveHeight: Math.round(save.getBoundingClientRect().height),
        nameAutocomplete: sheet.querySelector('.tagdex-editor-field input').autocomplete,
        loaderSrc: document.querySelector('.tagdex-editor-loader').getAttribute('src')
    };
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    tagDexLibraryEditor.character({ id: 'c1', revision: 'r1', data: { name: 'Aria', series: '', archived: false } }, true, () => {});
    await new Promise(r => setTimeout(r, 200));
    out.editLabels = [...document.querySelectorAll('.m-sheet .tagdex-editor-field > span')].map(e => e.textContent);
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    return out;
});
const autoFavorite = await page.evaluate(async () => {
    window.__requests = [];
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    let savedRecord = null;
    tagDexLibraryEditor.character(null, true, record => savedRecord = record);
    let sheet = [...document.querySelectorAll('.m-sheet')].pop();
    sheet.querySelector('.tagdex-editor-field input').value = 'New One';
    sheet.querySelector('.tagdex-editor-form').requestSubmit();
    await new Promise(r => setTimeout(r, 200));
    let fav = window.__requests.find(r => r.route == 'TagDexLibrarySave' && r.args.action == 'favorite');
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    return { fav: fav ? fav.args.body : null, saved: savedRecord ? savedRecord.id : null };
});
check('a new character is favorited as soon as it is created', autoFavorite.fav && autoFavorite.fav.target_id == 'libNew'
    && autoFavorite.fav.favorited === true && autoFavorite.fav.target_kind == 'character' && autoFavorite.saved == 'libNew',
    JSON.stringify(autoFavorite));
// Variant prompts are saved with literal parens escaped; weights, <tags> and existing escapes are kept.
const variantEscape = await page.evaluate(async () => {
    let B = String.fromCharCode(92);
    let cases = [
        ['aria (robot)', `aria ${B}(robot${B})`],
        [`aria ${B}(robot${B})`, `aria ${B}(robot${B})`],
        ['(aria (robot):1.1), (masterpiece:1.2)', `(aria ${B}(robot${B}):1.1), (masterpiece:1.2)`],
        ['<lora:x (v2):0.8> smile (open mouth)', `<lora:x (v2):0.8> smile ${B}(open mouth${B})`],
        ['a (b', `a ${B}(b`]
    ];
    let bad = cases.filter(([input, want]) => tagDexLibraryEditor.escapePromptParens(input) !== want).map(c => c[0]);
    window.__requests = [];
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    tagDexLibraryEditor.variant({ id: 'lib1' }, null, true, () => {});
    let sheet = [...document.querySelectorAll('.m-sheet')].pop();
    sheet.querySelector('.tagdex-editor-field input').value = 'Robot';
    let areas = sheet.querySelectorAll('.tagdex-editor-field textarea');
    areas[0].value = 'ariarobzzz, aria (robot), (glowing eyes:1.2)';
    areas[1].value = 'bad hands (extra fingers)';
    sheet.querySelector('.tagdex-editor-form').requestSubmit();
    await new Promise(r => setTimeout(r, 200));
    let save = window.__requests.find(r => r.route == 'TagDexLibrarySave' && r.args.action == 'create_variant');
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    return { bad, prompt: save ? save.args.body.data.recipe.prompt : null, negative: save ? save.args.body.data.recipe.negative_prompt : null };
});
check('prompt paren escaping keeps weights, tags and existing escapes', variantEscape.bad.length == 0, JSON.stringify(variantEscape.bad));
check('saving a variant escapes its prompt and negative prompt',
    variantEscape.prompt == String.raw`ariarobzzz, aria \(robot\), (glowing eyes:1.2)` && variantEscape.negative == String.raw`bad hands \(extra fingers\)`,
    JSON.stringify(variantEscape));
check('Add Character has no Archived box; editing explains it', addCharacter.labels.join('|') == 'Name|Series'
    && addCharacter.editLabels.some(l => l.startsWith('Archived (hidden')), JSON.stringify(addCharacter));
check('Add Character matches the /simple sheets', addCharacter.titleSize == '15px' && addCharacter.saveBg == addCharacter.emphasisRgb
    && addCharacter.saveHeight >= 44 && addCharacter.nameAutocomplete == 'off', JSON.stringify(addCharacter));
check('the editor script is loaded with the page version token', /\?vary=/.test(addCharacter.loaderSrc), addCharacter.loaderSrc);

// ---- Favorites filter ----
await page.evaluate(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-favorite-filter').forEach(button => button.click()));
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card)').length == 1);
const favorites = await page.evaluate(() => ({
    name: document.querySelector('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card) .m-tagdex-card-name').textContent,
    starred: document.querySelector('.m-tagdex-tab .m-tagdex-favorite-button').textContent,
}));
check('favorites filter shows only starred rows, marked as starred', favorites.name == 'Char 7' && favorites.starred == '★', JSON.stringify(favorites));
await page.evaluate(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-favorite-filter').forEach(button => button.click()));
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-library-card)').length == 50);

// ---- Card tap inserts the trigger into the Create prompt ----
await page.evaluate(() => document.querySelector('.m-tagdex-tab .m-tagdex-card-main').click());
const prompt = await page.evaluate(() => mState.params['prompt']);
check('tapping a card inserts its trigger into the prompt', `${prompt}`.includes('char_000, series'), `${prompt}`);

// ---- The all-tags control reaches the nav tab too ----
// The tab and the Create-row sheet share buildBrowseRow, so this is the shared control seen from the other
// surface - the one where the Create panel is hidden while the insert happens.
// Seeded long enough that the box has auto-grown well past its three-row floor: a short prompt would sit at
// the floor either way, and the height check below could not then fail on the bug it exists for.
await page.evaluate(async () => {
    document.querySelector('.m-panel[data-mtab="characters"]').classList.remove('m-tab-active');
    document.querySelector('.m-panel[data-mtab="create"]').classList.add('m-tab-active');
    mState.params['prompt'] = 'a seeded prompt long enough to wrap over several lines in a phone-width box, '
        + 'so the prompt field has grown well past the three rows it starts at';
    mState.changed();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__grownPrompt = Math.round(document.querySelector('.m-prompt-box').getBoundingClientRect().height);
    document.querySelector('.m-panel[data-mtab="create"]').classList.remove('m-tab-active');
    document.querySelector('.m-panel[data-mtab="characters"]').classList.add('m-tab-active');
    mState.params['prompt'] = '';
    mState.changed();
    document.querySelector('.m-tagdex-tab .m-tagdex-card-main').click();
});
const allTagsPrompt = await page.evaluate(() => mState.params['prompt']);
check('tapping a card adds the trigger plus the core tags',
    `${allTagsPrompt}`.includes('char_000, series, long hair, blue eyes'), `${allTagsPrompt}`);
const triggerOnlyPrompt = await page.evaluate(() => {
    mState.params['prompt'] = '';
    mState.changed();
    document.querySelector('.m-tagdex-tab .m-tagdex-alltags-button').click();
    return mState.params['prompt'];
});
check('the trigger-only control adds just the trigger',
    `${triggerOnlyPrompt}`.includes('char_000, series') && !`${triggerOnlyPrompt}`.includes('long hair'), `${triggerOnlyPrompt}`);
// Inserting from here runs mCreate.render() against a Create panel that is display:none, where the prompt
// box reports scrollHeight 0. That measurement used to be applied as an inline height:0px and stayed, so the
// box came back a sliver with the prompt spilling out of it. Switching the panel back on directly rather
// than through the router: m_app.js is absent here, so 'create' is not registered and applyHash cannot
// reach it - which also means nothing calls onShow, leaving the guard inside autoGrow as the only defence.
const promptBox = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.querySelector('.m-panel[data-mtab="characters"]').classList.remove('m-tab-active');
    document.querySelector('.m-panel[data-mtab="create"]').classList.add('m-tab-active');
    return { grown: window.__grownPrompt,
        onReturn: Math.round(document.querySelector('.m-prompt-box').getBoundingClientRect().height) };
});
check('inserting from the Characters tab does not collapse the hidden prompt box',
    promptBox.grown > 76 && promptBox.onReturn == promptBox.grown, JSON.stringify(promptBox));

await browser.close();
const failed = results.filter(result => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
