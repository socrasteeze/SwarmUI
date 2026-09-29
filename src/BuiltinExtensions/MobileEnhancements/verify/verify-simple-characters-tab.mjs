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
 * 5. My Characters: the user's own cards (tags plus attached LoRAs) list, insert, edit and delete like dataset
 *    cards, through the shared editor.
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
    window.__favorites = new Set(['char_007', 'aria_(robot)']);
    window.__dataset = Array.from({ length: 120 }, (unused, i) => ({
        name: `char_${`${i}`.padStart(3, '0')}`,
        display: `Char ${i}`,
        trigger: `char_${`${i}`.padStart(3, '0')}, series`,
        count: 1000 - i,
        copyright_display: 'Series',
        kind: 'character',
        core_tags: ['long hair', 'blue eyes']
    }));
    window.__custom = [
        { name: 'aria_(robot)', display: 'Aria (Robot)', trigger: 'aria_robot, robot joints', count: 0, copyright: 'Zenless Zone Zero',
            copyright_display: 'Zenless Zone Zero', kind: 'character', core_tags: ['<lora:folder/ariarob:0.8>', 'ariarobzzz'],
            custom: { name: 'Aria (Robot)', series: 'Zenless Zone Zero', tags: 'aria_robot, robot joints',
                loras: [{ name: 'folder/ariarob', weight: 0.8, tags: 'ariarobzzz' }] } },
        { name: 'solo', display: 'Solo', trigger: 'solo, plain', count: 0, kind: 'character',
            custom: { name: 'Solo', series: '', tags: 'solo, plain', loras: [] } }
    ];
    window.genericRequest = (route, args, callback) => {
        window.__requests.push({ route, args });
        if (route == 'TagDexListSources') {
            callback({
                sources: [
                    { id: 'danbooru_character', label: 'Danbooru characters', kind: 'character', present: true },
                    { id: 'danbooru_artist', label: 'Danbooru artists', kind: 'artist', present: true },
                    { id: 'custom_character', label: 'My Characters', kind: 'character', present: true, custom: true, rows: window.__custom.length }
                ],
                prefs: { active_sources: ['danbooru_character'] }
            });
        }
        else if (route == 'TagDexSearchEntries' && args.source == 'custom_character') {
            let rows = window.__custom.filter(row => !args.search || row.name.includes(args.search.toLowerCase()) || row.display.toLowerCase().includes(args.search.toLowerCase()));
            if (args.favoritesOnly) {
                rows = rows.filter(row => window.__favorites.has(row.name));
            }
            callback({ total: rows.length, offset: args.offset, limit: args.limit,
                results: rows.map(row => ({ ...row, favorited: window.__favorites.has(row.name) })) });
        }
        else if (route == 'TagDexSaveCustomCharacter') {
            let slug = args.name.trim().toLowerCase().replace(/\s+/g, '_');
            let record = { name: slug, display: args.name, trigger: args.tags, count: 0, kind: 'character', copyright: args.series,
                copyright_display: args.series, custom: { name: args.name, series: args.series, tags: args.tags, loras: args.loras } };
            let at = window.__custom.findIndex(row => row.custom.name == args.original);
            if (at >= 0) {
                window.__custom[at] = record;
            }
            else {
                window.__custom.push(record);
            }
            window.__favorites.add(slug);
            callback({ success: true, name: slug });
        }
        else if (route == 'TagDexDeleteCustomCharacter') {
            window.__custom = window.__custom.filter(row => row.custom.name != args.name);
            callback({ success: true });
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
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card)').length > 0);

// The tab opens on favorites (only char_007 is starred); one tap on the filter shows everything.
const opening = await page.evaluate(() => ({
    view: document.querySelector('.m-tagdex-tab .m-tagdex-source').value,
    viewLabel: document.querySelector('.m-tagdex-tab .m-tagdex-source').selectedOptions[0].textContent,
    pinned: [...document.querySelectorAll('.m-tagdex-tab .m-tagdex-custom-card')].map(e => [...e.querySelectorAll('.m-tagdex-card-name, .m-tagdex-card-sub')].map(x => x.textContent).join(' · ')),
    pressed: document.querySelector('.m-tagdex-tab .m-tagdex-favorite-filter').getAttribute('aria-pressed'),
    cards: [...document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card) .m-tagdex-card-name')].map(e => e.textContent)
}));
check('the Characters tab opens on All Characters with favorited custom characters pinned',
    opening.view == '__all__' && opening.viewLabel == 'All Characters'
    && opening.pinned.join('|') == 'Aria (Robot) · Zenless Zone Zero', JSON.stringify(opening));
check('the Characters tab opens on favorites', opening.pressed == 'true' && opening.cards.length == 1
    && opening.cards[0] == "Char 7", JSON.stringify(opening));
await page.evaluate(() => document.querySelector('.m-tagdex-tab .m-tagdex-favorite-filter').click());
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card)').length == 50);
const unfiltered = await page.evaluate(() => [...document.querySelectorAll('.m-tagdex-tab .m-tagdex-custom-card')].length);
check('with favorites off, every custom character is pinned', unfiltered == 2, `${unfiltered} pinned`);

const firstPage = await page.evaluate(() => ({
    cards: document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card)').length,
    status: document.querySelector('.m-tagdex-tab .m-tagdex-browse-status').textContent,
    label: document.querySelector('.m-tagdex-page-label').textContent,
    prevDisabled: document.querySelector('.m-tagdex-pager .m-tagdex-page-button').disabled,
    pagerVisible: document.querySelector('.m-tagdex-pager').style.display != 'none',
    firstName: document.querySelector('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card) .m-tagdex-card-name').textContent,
}));
check('page one holds exactly one bounded page of cards', firstPage.cards == 50, `${firstPage.cards} cards`);
check('status names the window and the total', firstPage.status.includes('1') && firstPage.status.includes('50') && firstPage.status.includes('120'), firstPage.status);
check('pager shows 1 / 3 with Prev disabled', firstPage.label.trim() == '1 / 3' && firstPage.prevDisabled && firstPage.pagerVisible, firstPage.label);

// ---- Next walks the offset; the last page clamps ----
const nextButton = '.m-tagdex-pager .m-tagdex-page-button:last-of-type';
await page.click(nextButton);
await page.waitForFunction(() => document.querySelector('.m-tagdex-page-label').textContent.trim() == '2 / 3');
const pageTwo = await page.evaluate(() => ({
    firstName: document.querySelector('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card) .m-tagdex-card-name').textContent,
    prevDisabled: document.querySelector('.m-tagdex-pager .m-tagdex-page-button').disabled,
}));
check('Next fetches the next offset, not a longer list', pageTwo.firstName == 'Char 50' && !pageTwo.prevDisabled, pageTwo.firstName);
await page.click(nextButton);
await page.waitForFunction(() => document.querySelector('.m-tagdex-page-label').textContent.trim() == '3 / 3');
const lastPage = await page.evaluate(() => ({
    cards: document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card)').length,
    nextDisabled: document.querySelector('.m-tagdex-pager .m-tagdex-page-button:last-of-type').disabled,
}));
check('the last page holds the remainder and Next is disabled', lastPage.cards == 20 && lastPage.nextDisabled, `${lastPage.cards} cards`);

// ---- Search resets to page one ----
await page.fill('.m-tagdex-tab .m-tagdex-search', 'char_01');
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card)').length == 10);
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
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card)').length == 1
    && document.querySelector('.m-tagdex-page-label').textContent.trim() == '2 / 2');
await page.evaluate(() => document.querySelector('.m-tagdex-tab .m-tagdex-favorite-button').click());
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card)').length == 50);
const clamped = await page.evaluate(() => ({
    label: document.querySelector('.m-tagdex-page-label').textContent.trim(),
    pagerVisible: document.querySelector('.m-tagdex-pager').style.display != 'none',
}));
check('unstarring the last row of the last page clamps to a real page', clamped.label == '1 / 1' || !clamped.pagerVisible, JSON.stringify(clamped));
// Back to the plain view for the checks below.
await page.evaluate(() => {
    window.__favorites = new Set(['char_007', 'aria_(robot)']);
    document.querySelectorAll('.m-tagdex-tab .m-tagdex-favorite-filter').forEach(button => button.click());
});
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card)').length == 50);

// ---- My Characters: a normal dataset in the picker, with cards that carry your own tags and LoRAs ----
const customList = await page.evaluate(async () => {
    let source = document.querySelector('.m-tagdex-tab .m-tagdex-source');
    let option = [...source.options].find(o => o.value == 'custom_character');
    source.value = 'custom_character';
    source.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    let tab = document.querySelector('.m-tagdex-tab');
    let out = {
        option: option ? option.textContent : null,
        legacyOption: [...source.options].some(o => o.value == '__library__'),
        rows: [...tab.querySelectorAll('.m-tagdex-custom-card')].map(e => [...e.querySelectorAll('.m-tagdex-card-name, .m-tagdex-card-sub')].map(x => x.textContent).join(' · ')),
        counts: [...tab.querySelectorAll('.m-tagdex-custom-card .m-tagdex-card-count')].map(e => e.textContent),
        editButtons: [...tab.querySelectorAll('.m-tagdex-custom-card .m-tagdex-edit-button')].map(e => e.getAttribute('aria-label')),
        favoritesShown: tab.querySelector('.m-tagdex-favorite-filter').style.display == '',
        add: !!tab.querySelector('.m-tagdex-add-button')
    };
    source.value = 'danbooru_character';
    source.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    return out;
});
check('My Characters is a normal dataset in the picker and the old library list is gone',
    customList.option == 'My Characters' && !customList.legacyOption, JSON.stringify(customList));
check('custom cards read "Your character", not a post count, and carry an edit button',
    customList.rows.length == 2 && customList.rows[0] == 'Aria (Robot) · Zenless Zone Zero'
    && customList.counts.every(c => c == 'Your character')
    && customList.editButtons.join('|') == 'Edit Aria (Robot)|Edit Solo', JSON.stringify(customList));
check('the favorites filter stays available and the tab has a + Add button', customList.favoritesShown && customList.add, JSON.stringify(customList));

// ---- Tapping a custom card inserts my tags + <lora:...> + the LoRA's tags; T is my tags alone ----
const customCard = await page.evaluate(async () => {
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
    let cards = [...tab.querySelectorAll('.m-tagdex-custom-card')];
    let aria = cards.find(c => c.querySelector('.m-tagdex-card-name').textContent == 'Aria (Robot)');
    let solo = cards.find(c => c.querySelector('.m-tagdex-card-name').textContent == 'Solo');
    let out = {
        ariaStar: aria ? aria.querySelector('.m-tagdex-favorite-button').textContent : null,
        soloStar: solo ? solo.querySelector('.m-tagdex-favorite-button').textContent : null,
        soloTriggerOnly: solo ? !!solo.querySelector('.m-tagdex-alltags-button:not(.m-tagdex-edit-button)') : null
    };
    mState.params['prompt'] = '1girl';
    aria.querySelector('.m-tagdex-card-main').click();
    out.prompt = mState.params['prompt'];
    mState.params['prompt'] = '';
    aria.querySelector('.m-tagdex-alltags-button:not(.m-tagdex-edit-button)').click();
    out.triggerOnly = mState.params['prompt'];
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
check('custom-character stars are the normal favorites', customCard.ariaStar == '★' && customCard.soloStar == '☆', JSON.stringify(customCard));
check('tapping a custom character adds my tags, its LoRA tag and the LoRA tags',
    `${customCard.prompt}`.endsWith('aria_robot, robot joints, <lora:folder/ariarob:0.8>, ariarobzzz'), JSON.stringify(customCard));
check('the T button adds just my tags', customCard.triggerOnly == 'aria_robot, robot joints', JSON.stringify(customCard));
check('a custom character with no LoRA has no trigger-only button (nothing extra to leave out)', customCard.soloTriggerOnly === false, JSON.stringify(customCard));

// ---- Add Character sheet: themed like the other /simple sheets, with a LoRA section ----
const addCharacter = await page.evaluate(async () => {
    window.confirm = () => true;
    document.documentElement.style.setProperty('--emphasis', 'rgb(1, 2, 3)');
    mState.models = { 'LoRA': [['folder/ariarob.safetensors', 'c'], ['folder/other.safetensors', 'c'], ['Style/ARIA_style', 'c']] };
    await new Promise(resolve => mTagDex.ensureCharacterEditor(resolve));
    window.__requests = [];
    mTagDex.editCharacter(null);
    await new Promise(r => setTimeout(r, 300));
    let sheet = [...document.querySelectorAll('.m-sheet')].pop();
    let save = sheet.querySelector('.tagdex-editor-actions button[type="submit"]');
    let out = {
        labels: [...sheet.querySelectorAll('.tagdex-editor-field > span')].map(e => e.textContent),
        titleSize: getComputedStyle(sheet.querySelector('.tagdex-editor h3')).fontSize,
        saveBg: getComputedStyle(save).backgroundColor,
        saveHeight: Math.round(save.getBoundingClientRect().height),
        nameAutocomplete: sheet.querySelector('.tagdex-editor-field input').autocomplete,
        loaderSrc: document.querySelector('.tagdex-editor-loader').getAttribute('src'),
        deleteOnNew: !!sheet.querySelector('.tagdex-editor-delete'),
        rowsAtStart: sheet.querySelectorAll('.tagdex-editor-lora').length
    };
    sheet.querySelector('.tagdex-editor-add').click();
    let row = sheet.querySelector('.tagdex-editor-lora');
    let nameBox = row.querySelector('.tagdex-editor-lora-name');
    nameBox.value = 'ARIA';
    nameBox.dispatchEvent(new Event('input'));
    let picks = [...row.querySelectorAll('.tagdex-editor-suggest-item')].map(e => e.textContent);
    out.suggestions = picks;
    out.pickHeight = Math.round(row.querySelector('.tagdex-editor-suggest-item').getBoundingClientRect().height);
    row.querySelectorAll('.tagdex-editor-suggest-item')[0].click();
    out.pickedName = nameBox.value;
    row.querySelector('.tagdex-editor-lora-weight').value = '0.8';
    row.querySelector('.tagdex-editor-lora-tags').value = 'ariarobzzz, aria (robot)';
    let fields = sheet.querySelectorAll('.tagdex-editor-field');
    fields[0].querySelector('input').value = '  New One ';
    fields[1].querySelector('input').value = 'Zenless';
    fields[2].querySelector('textarea').value = '1girl, silver hair';
    sheet.querySelector('.tagdex-editor-form').requestSubmit();
    await new Promise(r => setTimeout(r, 200));
    let saved = window.__requests.find(r => r.route == 'TagDexSaveCustomCharacter');
    out.saved = saved ? saved.args : null;
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    return out;
});
check('Add Character has Name, Series, Tags, no Delete, no LoRA rows', addCharacter.labels.join('|') == 'Name|Series|Tags'
    && !addCharacter.deleteOnNew && addCharacter.rowsAtStart == 0, JSON.stringify(addCharacter));
check('Add Character matches the /simple sheets', addCharacter.titleSize == '15px' && addCharacter.saveBg == 'rgb(1, 2, 3)'
    && addCharacter.saveHeight >= 44 && addCharacter.nameAutocomplete == 'off', JSON.stringify(addCharacter));
check('the editor script is loaded with the page version token', /\?vary=/.test(addCharacter.loaderSrc), addCharacter.loaderSrc);
check('LoRA name suggestions come from the known LoRAs, case-insensitively, as 44px targets',
    addCharacter.suggestions.length == 2 && addCharacter.suggestions[0] == 'folder/ariarob' && addCharacter.suggestions[1] == 'Style/ARIA_style'
    && addCharacter.pickedName == 'folder/ariarob' && addCharacter.pickHeight >= 44, JSON.stringify(addCharacter));
check('saving sends the flat payload with LoRA rows and escaped tags',
    addCharacter.saved && addCharacter.saved.original == '' && addCharacter.saved.name == 'New One' && addCharacter.saved.series == 'Zenless'
    && addCharacter.saved.tags == '1girl, silver hair' && addCharacter.saved.loras.length == 1
    && addCharacter.saved.loras[0].name == 'folder/ariarob' && addCharacter.saved.loras[0].weight === 0.8
    && addCharacter.saved.loras[0].tags == String.raw`ariarobzzz, aria \(robot\)`, JSON.stringify(addCharacter.saved));

// ---- Edit and Delete from a card ----
const editCard = await page.evaluate(async () => {
    let wait = () => new Promise(r => setTimeout(r, 250));
    let tab = document.querySelector('.m-tagdex-tab');
    let source = tab.querySelector('.m-tagdex-source');
    source.value = 'custom_character';
    source.dispatchEvent(new Event('change'));
    await wait();
    window.__requests = [];
    let aria = [...tab.querySelectorAll('.m-tagdex-custom-card')].find(c => c.querySelector('.m-tagdex-card-name').textContent == 'Aria (Robot)');
    aria.querySelector('.m-tagdex-edit-button').click();
    await wait();
    let sheet = [...document.querySelectorAll('.m-sheet')].pop();
    let fields = sheet.querySelectorAll('.tagdex-editor-field');
    let out = {
        title: sheet.querySelector('.tagdex-editor h3').textContent,
        name: fields[0].querySelector('input').value,
        series: fields[1].querySelector('input').value,
        tags: fields[2].querySelector('textarea').value,
        rows: [...sheet.querySelectorAll('.tagdex-editor-lora')].map(r => [r.querySelector('.tagdex-editor-lora-name').value,
            r.querySelector('.tagdex-editor-lora-weight').value, r.querySelector('.tagdex-editor-lora-tags').value].join('|')),
        hasDelete: !!sheet.querySelector('.tagdex-editor-delete')
    };
    fields[0].querySelector('input').value = 'Aria Two';
    sheet.querySelector('.tagdex-editor-form').requestSubmit();
    await wait();
    let saved = window.__requests.find(r => r.route == 'TagDexSaveCustomCharacter');
    out.saved = saved ? saved.args : null;
    out.afterSaveNames = [...tab.querySelectorAll('.m-tagdex-custom-card .m-tagdex-card-name')].map(e => e.textContent);
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    // Delete
    window.__requests = [];
    let two = [...tab.querySelectorAll('.m-tagdex-custom-card')].find(c => c.querySelector('.m-tagdex-card-name').textContent == 'Aria Two');
    two.querySelector('.m-tagdex-edit-button').click();
    await wait();
    sheet = [...document.querySelectorAll('.m-sheet')].pop();
    sheet.querySelector('.tagdex-editor-delete').click();
    await wait();
    let deleted = window.__requests.find(r => r.route == 'TagDexDeleteCustomCharacter');
    out.deleted = deleted ? deleted.args : null;
    out.afterDeleteNames = [...tab.querySelectorAll('.m-tagdex-custom-card .m-tagdex-card-name')].map(e => e.textContent);
    for (let elem of document.querySelectorAll('.m-sheet, .m-sheet-backdrop')) {
        elem.remove();
    }
    source.value = 'danbooru_character';
    source.dispatchEvent(new Event('change'));
    await wait();
    return out;
});
check('editing loads the stored record, LoRA rows included, and offers Delete',
    editCard.title == 'Edit Character' && editCard.name == 'Aria (Robot)' && editCard.series == 'Zenless Zone Zero'
    && editCard.tags == 'aria_robot, robot joints' && editCard.rows.join(',') == 'folder/ariarob|0.8|ariarobzzz' && editCard.hasDelete,
    JSON.stringify(editCard));
check('saving an edit names the original record, and the tab refreshes',
    editCard.saved && editCard.saved.original == 'Aria (Robot)' && editCard.saved.name == 'Aria Two'
    && editCard.afterSaveNames.includes('Aria Two') && !editCard.afterSaveNames.includes('Aria (Robot)'), JSON.stringify(editCard));
check('Delete removes the record and the tab refreshes',
    editCard.deleted && editCard.deleted.name == 'Aria Two' && !editCard.afterDeleteNames.includes('Aria Two'), JSON.stringify(editCard));

// Prompt tags are saved with literal parens escaped; weights, <tags> and existing escapes are kept.
const paren = await page.evaluate(() => {
    let B = String.fromCharCode(92);
    let cases = [
        ['aria (robot)', `aria ${B}(robot${B})`],
        [`aria ${B}(robot${B})`, `aria ${B}(robot${B})`],
        ['(aria (robot):1.1), (masterpiece:1.2)', `(aria ${B}(robot${B}):1.1), (masterpiece:1.2)`],
        ['<lora:x (v2):0.8> smile (open mouth)', `<lora:x (v2):0.8> smile ${B}(open mouth${B})`],
        ['a (b', `a ${B}(b`]
    ];
    return cases.filter(([input, want]) => tagDexCharacterEditor.escapePromptParens(input) !== want).map(c => c[0]);
});
check('prompt paren escaping keeps weights, tags and existing escapes', paren.length == 0, JSON.stringify(paren));

// ---- More: My Library and Conflict Review are gone; Add Character remains ----
const more = await page.evaluate(() => mUI.moreItems.map(item => item.label || item[0]));
check('More offers Add Character and no longer My Library or Conflict Review',
    more.includes('Add Character') && !more.includes('My Library') && !more.includes('Conflict Review'), JSON.stringify(more));

// ---- Without the manage permission, Add warns instead of opening the editor ----
const denied = await page.evaluate(() => {
    let warned = null;
    let originalWarn = mUI.warn;
    mUI.warn = message => warned = message;
    permissions.hasPermission = () => false;
    let before = document.querySelectorAll('.m-sheet').length;
    mTagDex.editCharacter(null);
    permissions.hasPermission = () => true;
    mUI.warn = originalWarn;
    return { warned, opened: document.querySelectorAll('.m-sheet').length != before };
});
check('a user without tagdex_manage is told so and no editor opens', /manage permission/.test(denied.warned || '') && !denied.opened, JSON.stringify(denied));

// ---- Favorites filter ----
await page.evaluate(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-favorite-filter').forEach(button => button.click()));
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card)').length == 1);
const favorites = await page.evaluate(() => ({
    name: document.querySelector('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card) .m-tagdex-card-name').textContent,
    starred: document.querySelector('.m-tagdex-tab .m-tagdex-favorite-button').textContent,
}));
check('favorites filter shows only starred rows, marked as starred', favorites.name == 'Char 7' && favorites.starred == '★', JSON.stringify(favorites));
await page.evaluate(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-favorite-filter').forEach(button => button.click()));
await page.waitForFunction(() => document.querySelectorAll('.m-tagdex-tab .m-tagdex-card:not(.m-tagdex-custom-card)').length == 50);

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
