import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

let browser = await chromium.launch();
try {
    let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    let requested = false;
    await page.route('**/ExtensionFile/TagDexExtension/Assets/tagdex_editor.js', route => {
        requested = true;
        route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('src/BuiltinExtensions/TagDex/Assets/tagdex_editor.js', 'utf8') });
    });
    await page.setContent('<html><head><base href="http://fixture.local/"></head><body></body></html>');
    await page.evaluate(() => {
        window.__more = {};
        window.mUI = {
            registerMoreItem: (label, callback) => window.__more[label] = callback,
            registerNavTab: () => {},
            openSheet: content => { document.body.appendChild(content); return () => content.remove(); },
            note: () => {}, warn: message => { throw new Error(message); },
            el: (tag, classes, text) => { let element = document.createElement(tag); element.className = classes; element.textContent = text || ''; return element; }
        };
        window.genericRequest = () => {};
    });
    await page.addScriptTag({ path: path.resolve('src/BuiltinExtensions/TagDex/Assets/m_tagdex.js') });
    await page.evaluate(() => window.__more['Add Character']());
    await page.waitForSelector('.tagdex-editor');
    if (!requested) {
        throw new Error('/simple did not request the shared editor asset.');
    }
    let shape = await page.evaluate(() => ({
        editor: typeof tagDexCharacterEditor,
        labels: [...document.querySelectorAll('.tagdex-editor-field > span')].map(e => e.textContent),
        loraHeading: [...document.querySelectorAll('.tagdex-editor h4')].map(e => e.textContent),
        moreItems: Object.keys(window.__more)
    }));
    if (shape.editor != 'object' || shape.labels.join('|') != 'Name|Series|Tags' || shape.loraHeading.join('|') != 'LoRAs') {
        throw new Error(`The lazily loaded editor has the wrong shape: ${JSON.stringify(shape)}`);
    }
    if (shape.moreItems.includes('My Library') || shape.moreItems.includes('Conflict Review')) {
        throw new Error(`/simple still registers a removed library item: ${JSON.stringify(shape.moreItems)}`);
    }
    console.log('TagDex /simple editor loader check passed.');
}
finally {
    await browser.close();
}
