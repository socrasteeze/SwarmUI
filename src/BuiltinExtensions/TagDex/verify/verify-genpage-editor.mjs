/**
 * Genpage Characters-tab harness for the user's own characters (fork). Guards:
 *
 * 1. Markup: the My Library panel is gone; the Add Character button exists, is permission-gated, and is NOT a
 *    `.tagdex-data-control` (so it stays visible before any dataset is present).
 * 2. describe(): a custom record reads "Your character", drops Open on Booru and Insert Character Tag, and gains
 *    Edit Character and Delete Character; a dataset record is unchanged.
 * 3. The shared editor opens as a dialog, saves the flat payload, and the tab then re-reads the dataset list,
 *    switches to My Characters, clears the search and requeries.
 * 4. Delete asks first, calls the delete route, and requeries.
 *
 * Real tagdex_tab.js, tagdex_editor.js, Characters.html and tagdex.css; the server and the core browser are stubbed.
 *
 * Run from the repo root:
 *     node src/BuiltinExtensions/TagDex/verify/verify-genpage-editor.mjs
 * Set SWARM_CHROMIUM to override the browser path. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const TAGDEX = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(name, pass, detail) {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const browser = await chromium.launch(process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('pageerror', e => check(`no page errors (${e.message})`, false));
    await page.setContent(`<html><head><style>${readFileSync(`${TAGDEX}/Assets/tagdex.css`, 'utf8')}</style></head><body>`
        + `${readFileSync(`${TAGDEX}/Tabs/GenerateBottom/Characters.html`, 'utf8')}</body></html>`);
    await page.evaluate(() => {
        window.__requests = [];
        window.__confirms = [];
        window.confirm = message => { window.__confirms.push(message); return true; };
        window.getRequiredElementById = id => document.getElementById(id);
        window.escapeHtmlNoBr = text => `${text}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        window.largeCountStringify = value => `${value}`;
        window.showError = message => { window.__err = message; };
        window.permissions = { hasPermission: () => true };
        window.tagDexCore = { prefs: {}, status: 'ready', shards: [], ensureLoaded: () => {} };
        window.coreModelMap = { 'LoRA': ['folder/ariarob.safetensors', 'Style/ARIA_style'] };
        window.__sources = [
            { id: 'danbooru_character', label: 'Danbooru Characters', kind: 'character', present: true, rows: 5, total_rows: 5 },
            { id: 'custom_character', label: 'My Characters', kind: 'character', present: false, custom: true, rows: 0, total_rows: 0 }
        ];
        window.genericRequest = (route, args, callback, depth, error) => {
            window.__requests.push({ route, args });
            if (route == 'TagDexListSources') {
                callback({ sources: window.__sources, prefs: {} });
            }
            else if (route == 'TagDexGetFacets') {
                callback({ facets: { copyright: [], hair_color: [], hair_length: [], eye_color: [], gender: [] } });
            }
            else if (route == 'TagDexSaveCustomCharacter') {
                window.__sources[1].present = true;
                callback({ success: true, name: 'new_one' });
            }
            else if (route == 'TagDexDeleteCustomCharacter') {
                callback({ success: true });
            }
        };
    });
    await page.addScriptTag({ path: `${TAGDEX}/Assets/tagdex_editor.js` });
    await page.addScriptTag({ path: `${TAGDEX}/Assets/tagdex_tab.js` });
    await page.evaluate(() => {
        // A stand-in for the core browser: the tab only ever asks it to refresh.
        window.__refreshes = 0;
        tagDexTab.browser = { lightRefresh: () => window.__refreshes++, refresh: () => window.__refreshes++ };
        tagDexTab.buildControls();
    });

    // ---- Markup ----
    const markup = await page.evaluate(() => {
        let add = document.getElementById('tagdex_add_character');
        return {
            library: !!document.querySelector('.tagdex-library, #tagdex_library_results'),
            add: !!add,
            gated: add ? add.dataset.requiredpermission : null,
            dataControl: add ? add.classList.contains('tagdex-data-control') : null
        };
    });
    check('the My Library panel is gone', !markup.library, JSON.stringify(markup));
    check('Add Character is permission-gated and visible without any dataset', markup.add && markup.gated == 'tagdex_manage' && markup.dataControl === false, JSON.stringify(markup));

    // ---- describe() ----
    const described = await page.evaluate(() => {
        let custom = { name: 'aria_two', display: 'Aria Two', trigger: '1girl, silver hair', count: 0, kind: 'character', copyright_display: 'Zenless',
            core_tags: ['<lora:folder/ariarob:0.8>', 'ariarobzzz'],
            custom: { name: 'Aria Two', series: 'Zenless', tags: '1girl, silver hair', loras: [{ name: 'folder/ariarob', weight: 0.8, tags: 'ariarobzzz' }] } };
        let normal = { name: 'hatsune_miku', display: 'hatsune miku', trigger: 'hatsune miku, vocaloid', count: 103500, solo_count: 5, kind: 'character',
            url: 'https://danbooru.donmai.us/posts?tags=hatsune_miku', core_tags: ['aqua eyes'] };
        let a = tagDexTab.describe({ data: custom });
        let b = tagDexTab.describe({ data: normal });
        return {
            customLabels: a.buttons.map(x => x.label), customHtml: a.description, customDisplay: a.display,
            normalLabels: b.buttons.map(x => x.label), normalHtml: b.description,
            allTags: TagDexTabClass.allTagsOf(custom)
        };
    });
    check('a custom card reads "Your character", not a post count',
        described.customHtml.includes('Your character') && !described.customHtml.includes('posts') && described.customDisplay == 'Aria Two', described.customHtml);
    check('a custom card menu swaps Booru and Character Tag for Edit and Delete',
        described.customLabels.join('|') == 'Insert Trigger|Insert All Tags|Generate Reference|Use Current Image|Edit Character|Delete Character', described.customLabels.join('|'));
    check('a dataset card menu is unchanged',
        described.normalLabels.join('|') == 'Insert Trigger|Insert All Tags|Insert Character Tag|Generate Reference|Use Current Image|Open on Booru'
        && described.normalHtml.includes('103500 posts'), described.normalLabels.join('|'));
    check('a card click inserts my tags, the LoRA tag and the LoRA tags', described.allTags == '1girl, silver hair, <lora:folder/ariarob:0.8>, ariarobzzz', described.allTags);

    // ---- Add: dialog, flat payload, then the tab follows the new dataset ----
    await page.evaluate(() => {
        document.getElementById('tagdex_search').value = 'miku';
        tagDexTab.search = 'miku';
        document.getElementById('tagdex_add_character').click();
    });
    await page.waitForSelector('dialog.tagdex-editor-dialog[open]');
    const dialog = await page.evaluate(() => {
        let d = document.querySelector('dialog.tagdex-editor-dialog');
        return { title: d.querySelector('h3').textContent, labels: [...d.querySelectorAll('.tagdex-editor-field > span')].map(e => e.textContent),
            del: !!d.querySelector('.tagdex-editor-delete'), width: Math.round(d.getBoundingClientRect().width) };
    });
    check('Add Character opens the shared dialog with Name, Series, Tags and no Delete',
        dialog.title == 'Add Character' && dialog.labels.join('|') == 'Name|Series|Tags' && !dialog.del && dialog.width > 300, JSON.stringify(dialog));
    await page.evaluate(() => {
        let d = document.querySelector('dialog.tagdex-editor-dialog');
        d.querySelector('.tagdex-editor-add').click();
        let row = d.querySelector('.tagdex-editor-lora');
        let name = row.querySelector('.tagdex-editor-lora-name');
        name.value = 'aria';
        name.dispatchEvent(new Event('input'));
        window.__suggest = [...row.querySelectorAll('.tagdex-editor-suggest-item')].map(e => e.textContent);
        row.querySelector('.tagdex-editor-suggest-item').click();
        row.querySelector('.tagdex-editor-lora-tags').value = 'ariarobzzz';
        let fields = d.querySelectorAll('.tagdex-editor-field');
        fields[0].querySelector('input').value = 'New One';
        fields[2].querySelector('textarea').value = '1girl';
        window.__requests = [];
        window.__refreshes = 0;
        d.querySelector('form').requestSubmit();
    });
    await page.waitForFunction(() => window.__refreshes > 0);
    const afterSave = await page.evaluate(() => ({
        suggest: window.__suggest,
        routes: window.__requests.map(r => r.route),
        save: window.__requests.find(r => r.route == 'TagDexSaveCustomCharacter').args,
        source: document.getElementById('tagdex_source').value,
        search: document.getElementById('tagdex_search').value,
        tabSearch: tagDexTab.search,
        open: !!document.querySelector('dialog.tagdex-editor-dialog[open]')
    }));
    check('LoRA suggestions come from coreModelMap without the .safetensors suffix',
        afterSave.suggest.join('|') == 'folder/ariarob|Style/ARIA_style' && afterSave.save.loras[0].name == 'folder/ariarob', JSON.stringify(afterSave.suggest));
    check('saving sends the flat payload (original, name, series, tags, loras)',
        afterSave.save.original == '' && afterSave.save.name == 'New One' && afterSave.save.tags == '1girl'
        && afterSave.save.loras.length == 1 && afterSave.save.loras[0].weight === 1 && afterSave.save.loras[0].tags == 'ariarobzzz', JSON.stringify(afterSave.save));
    check('after a save the tab re-reads datasets, switches to My Characters, clears the search and requeries',
        afterSave.routes.includes('TagDexListSources') && afterSave.source == 'custom_character' && afterSave.search == '' && afterSave.tabSearch == ''
        && !afterSave.open, JSON.stringify(afterSave));

    // ---- Delete ----
    await page.evaluate(() => {
        window.__requests = [];
        window.__refreshes = 0;
        let record = { name: 'new_one', display: 'New One', trigger: '1girl', kind: 'character', count: 0,
            custom: { name: 'New One', series: '', tags: '1girl', loras: [] } };
        tagDexTab.describe({ data: record }).buttons.find(b => b.label == 'Delete Character').onclick();
    });
    await page.waitForFunction(() => window.__refreshes > 0);
    const deleted = await page.evaluate(() => ({
        confirms: window.__confirms.length,
        call: window.__requests.find(r => r.route == 'TagDexDeleteCustomCharacter')?.args
    }));
    check('Delete Character asks first, names the record and refreshes', deleted.confirms >= 1 && deleted.call && deleted.call.name == 'new_one', JSON.stringify(deleted));

    // ---- Edit loads the stored record with Delete available ----
    await page.evaluate(() => {
        let d = document.querySelector('dialog.tagdex-editor-dialog');
        if (d) {
            d.close();
        }
        tagDexTab.editCharacter({ name: 'Aria Two', series: 'Zenless', tags: '1girl', loras: [{ name: 'a/b', weight: 0.5, tags: 't' }] });
    });
    const edit = await page.evaluate(() => {
        let d = document.querySelector('dialog.tagdex-editor-dialog');
        let row = d.querySelector('.tagdex-editor-lora');
        return { title: d.querySelector('h3').textContent, name: d.querySelector('.tagdex-editor-field input').value,
            weight: row.querySelector('.tagdex-editor-lora-weight').value, del: !!d.querySelector('.tagdex-editor-delete') };
    });
    check('Edit loads the record and offers Delete', edit.title == 'Edit Character' && edit.name == 'Aria Two' && edit.weight == '0.5' && edit.del, JSON.stringify(edit));
}
finally {
    await browser.close();
}
const failed = results.filter(result => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
