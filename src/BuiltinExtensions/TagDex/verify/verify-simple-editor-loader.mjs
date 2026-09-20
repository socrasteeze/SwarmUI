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
    console.log('TagDex /simple editor loader check passed.');
}
finally {
    await browser.close();
}
