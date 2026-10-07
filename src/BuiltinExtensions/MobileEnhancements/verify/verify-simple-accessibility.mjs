/** /simple native keyboard accessibility harness for sheets, model cards, and history tiles. */
import { chromium, webkit } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const UI = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m_ui.js`, 'utf8');
const MODELS = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m_models.js`, 'utf8');
const IMAGES = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m_images.js`, 'utf8');
const CSS = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m.css`, 'utf8');
const results = [];
function check(name, pass, detail = '') {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function loadUI(page, markup = '<main class="m-app"><button id="outside">Outside</button><input id="alternate"><input id="third"></main>') {
    await page.setContent(markup);
    await page.addStyleTag({ content: CSS });
    await page.addScriptTag({ content: UI });
}

async function verifySheets(browser, name) {
    let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    let errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await loadUI(page);
    await page.evaluate(() => {
        document.getElementById('outside').addEventListener('click', () => {
            let content = document.createElement('div');
            content.innerHTML = '<div class="m-sheet-title">First</div><input id="field"><button id="last">Last</button>';
            window.closeFirst = mUI.openSheet(content);
        });
    });
    await page.locator('#outside').focus();
    await page.keyboard.press('Enter');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    let initial = await page.evaluate(() => {
        let sheet = document.querySelector('.m-sheet');
        return { active: document.activeElement == sheet, field: document.activeElement.id, role: sheet.getAttribute('role'),
            modal: sheet.getAttribute('aria-modal'), labelledBy: sheet.getAttribute('aria-labelledby'), title: document.querySelector('.m-sheet-title').id };
    });
    check(`${name}: dialog starts on its root without auto-focusing the input`, initial.active && initial.field == '' && initial.role == 'dialog'
        && initial.modal == 'true' && initial.labelledBy == initial.title, JSON.stringify(initial));
    await page.keyboard.press('Shift+Tab');
    let rootBack = await page.evaluate(() => document.activeElement.id);
    await page.keyboard.press('Tab');
    let lastForward = await page.evaluate(() => document.activeElement.id);
    await page.keyboard.press('Shift+Tab');
    let firstBack = await page.evaluate(() => document.activeElement.id);
    check(`${name}: native Tab and Shift+Tab wrap at root, first, and last`, rootBack == 'last' && lastForward == 'field' && firstBack == 'last',
        JSON.stringify({ rootBack, lastForward, firstBack }));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(330);
    let escaped = await page.evaluate(() => ({ active: document.activeElement.id, count: mUI.openSheets,
        hidden: document.querySelector('.m-app').hasAttribute('aria-hidden') }));
    check(`${name}: Escape restores the trigger`, escaped.active == 'outside' && escaped.count == 0 && !escaped.hidden, JSON.stringify(escaped));

    await page.evaluate(() => {
        document.getElementById('outside').focus();
        let parent = document.createElement('div');
        parent.innerHTML = '<div class="m-sheet-title">Parent</div><button>Parent Action</button>';
        window.closeParent = mUI.openSheet(parent);
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await page.evaluate(() => {
        mUI.note('Unrelated toast');
        let child = document.createElement('div');
        child.setAttribute('aria-label', 'Nested Actions');
        child.innerHTML = '<button>Child Action</button>';
        window.closeChild = mUI.openSheet(child);
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    let nested = await page.evaluate(() => {
        let sheets = mUI.sheetStack.map(entry => entry.sheet);
        return { count: sheets.length, hidden: sheets[0].getAttribute('aria-hidden'), inert: sheets[0].inert,
            name: sheets[1].getAttribute('aria-label'), active: document.activeElement == sheets[1], toast: !!document.querySelector('.m-toast') };
    });
    check(`${name}: nested dialog ignores an unrelated toast and hides its parent`, nested.count == 2 && nested.hidden == 'true'
        && nested.inert && nested.name == 'Nested Actions' && nested.active && nested.toast, JSON.stringify(nested));
    await page.keyboard.press('Escape');
    let parentRestored = await page.evaluate(() => document.activeElement == document.querySelector('.m-sheet') && !document.querySelector('.m-sheet').inert);
    await page.keyboard.press('Escape');
    check(`${name}: nested Escape returns through the stack`, parentRestored && await page.evaluate(() => document.activeElement.id == 'outside'));
    await page.waitForTimeout(270);

    await page.evaluate(() => {
        let app = document.querySelector('.m-app');
        app.setAttribute('aria-hidden', 'false');
        app.inert = true;
        let trigger = document.createElement('button');
        trigger.id = 'body-trigger';
        document.body.appendChild(trigger);
        trigger.focus();
        let content = document.createElement('div');
        content.setAttribute('aria-label', 'Titleless Dialog');
        let close = mUI.openSheet(content);
        close();
        close();
    });
    await page.waitForTimeout(20);
    let exact = await page.evaluate(() => ({ aria: document.querySelector('.m-app').getAttribute('aria-hidden'), inert: document.querySelector('.m-app').inert,
        active: document.activeElement.id, count: mUI.openSheets, opened: mUI.sheetStack.length > 0,
        name: [...document.querySelectorAll('.m-sheet')].pop().getAttribute('aria-label') }));
    check(`${name}: close before animation is idempotent and restores exact state`, exact.aria == 'false' && exact.inert && exact.active == 'body-trigger'
        && exact.count == 0 && !exact.opened && exact.name == 'Titleless Dialog', JSON.stringify(exact));
    await page.waitForTimeout(270);

    let race = await page.evaluate(async () => {
        let app = document.querySelector('.m-app');
        app.inert = false;
        document.getElementById('body-trigger').focus();
        let oldContent = document.createElement('div');
        oldContent.setAttribute('aria-label', 'Old');
        let closeOld = mUI.openSheet(oldContent);
        await new Promise(resolve => requestAnimationFrame(resolve));
        closeOld();
        let newContent = document.createElement('div');
        newContent.setAttribute('aria-label', 'New');
        window.closeNew = mUI.openSheet(newContent);
        await new Promise(resolve => requestAnimationFrame(resolve));
        await new Promise(resolve => setTimeout(resolve, 280));
        let sheet = document.querySelector('.m-sheet');
        return { count: document.querySelectorAll('.m-sheet').length, name: sheet.getAttribute('aria-label'), active: document.activeElement == sheet,
            hidden: app.getAttribute('aria-hidden'), inert: app.inert };
    });
    check(`${name}: stale removal cannot steal focus or reveal a reopened dialog`, race.count == 1 && race.name == 'New' && race.active
        && race.hidden == 'true' && race.inert, JSON.stringify(race));
    await page.evaluate(() => window.closeNew());

    let outOfOrder = await page.evaluate(async () => {
        document.getElementById('body-trigger').focus();
        let parent = document.createElement('div');
        parent.setAttribute('aria-label', 'Parent');
        let closeParent = mUI.openSheet(parent);
        await new Promise(resolve => requestAnimationFrame(resolve));
        let child = document.createElement('div');
        child.setAttribute('aria-label', 'Child');
        let closeChild = mUI.openSheet(child);
        await new Promise(resolve => requestAnimationFrame(resolve));
        closeParent();
        let childSheet = [...document.querySelectorAll('.m-sheet')].find(sheet => sheet.getAttribute('aria-label') == 'Child');
        let childActive = document.activeElement == childSheet && !childSheet.inert;
        closeChild();
        closeChild();
        await new Promise(resolve => setTimeout(resolve, 10));
        return { childActive, restored: document.activeElement.id == 'body-trigger', count: mUI.openSheets,
            hidden: document.querySelector('.m-app').getAttribute('aria-hidden'), inert: document.querySelector('.m-app').inert };
    });
    check(`${name}: out-of-order and double close preserve focus and count`, outOfOrder.childActive && outOfOrder.restored && outOfOrder.count == 0
        && outOfOrder.hidden == 'false' && !outOfOrder.inert, JSON.stringify(outOfOrder));

    await page.evaluate(async () => {
        document.getElementById('body-trigger').focus();
        let content = document.createElement('div');
        content.setAttribute('aria-label', 'Focus Race');
        let close = mUI.openSheet(content);
        await new Promise(resolve => requestAnimationFrame(resolve));
        close();
    });
    await page.locator('#alternate').focus();
    await page.keyboard.type('kept');
    await page.waitForTimeout(400);
    let focusRace = await page.evaluate(() => ({ active: document.activeElement.id, value: document.getElementById('alternate').value }));
    check(`${name}: closing-sheet retries do not steal focus during the fade`, focusRace.active == 'alternate' && focusRace.value == 'kept',
        JSON.stringify(focusRace));

    await page.evaluate(async () => {
        document.getElementById('outside').focus();
        let first = document.createElement('div');
        first.setAttribute('aria-label', 'First Rapid');
        let closeFirst = mUI.openSheet(first);
        await new Promise(resolve => requestAnimationFrame(resolve));
        closeFirst();
        document.getElementById('alternate').focus();
        let second = document.createElement('div');
        second.setAttribute('aria-label', 'Second Rapid');
        let closeSecond = mUI.openSheet(second);
        await new Promise(resolve => requestAnimationFrame(resolve));
        closeSecond();
    });
    await page.locator('#third').focus();
    await page.keyboard.type('held');
    await page.waitForTimeout(400);
    let rapidClose = await page.evaluate(() => ({ active: document.activeElement.id, value: document.getElementById('third').value,
        count: mUI.openSheets, sheets: document.querySelectorAll('.m-sheet').length }));
    check(`${name}: rapid second-sheet close invalidates every stale first retry`, rapidClose.active == 'third' && rapidClose.value == 'held'
        && rapidClose.count == 0 && rapidClose.sheets == 0, JSON.stringify(rapidClose));
    check(`${name}: sheet checks produced no page errors`, errors.length == 0, errors.join(' | '));
    await page.close();
}

async function verifyCards(browser, name) {
    let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    let errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await loadUI(page, '<main class="m-app"><section id="models"></section><section id="history"></section></main>');
    await page.evaluate(() => {
        window.counts = { changed: 0, notes: 0, triggers: 0, civitai: 0, viewer: 0 };
        window.mGen = { onFrame: () => { } };
        Object.defineProperty(window, 'localStorage', { value: { getItem: () => null, setItem: () => { } } });
        window.permissions = { hasPermission: () => true };
        window.genericRequest = () => { };
        window.mState = { params: {}, getLoras: () => [], setLoras: () => { }, changed: () => counts.changed++,
            isStarred: () => false, starredFirst: rows => rows };
        window.MState = { sameModel: (a, b) => a == b };
        window.MCreate = { ListCap: 120, filterModels: rows => rows };
        window.mCreate = { insertTriggerPhrase: trigger => { counts.triggers++; counts.triggerText = trigger; }, buildCountRow: () => document.createElement('div') };
        mUI.note = () => counts.notes++;
    });
    await page.addScriptTag({ content: MODELS });
    await page.addScriptTag({ content: IMAGES });
    await page.evaluate(() => {
        mModels.grid = document.getElementById('models');
        mModels.subtype = 'Stable-Diffusion';
        mModels.openCivitaiLoad = () => counts.civitai++;
        let card = mModels.buildCard({ name: 'folder/Model.safetensors', title: 'Model', trigger_phrase: 'subject', local: true });
        card.id = 'model-card';
        mModels.grid.appendChild(card);
        mImages.grid = document.getElementById('history');
        mImages.entries = [
            { src: 'folder/history.png', thumb: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', url: '/history.png' },
            { src: 'folder/history-2.png', thumb: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', url: '/history-2.png' }
        ];
        mImages.rendered = 0;
        mImages.renderMore();
    });
    await page.locator('#model-card').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    let model = await page.evaluate(() => ({ ...counts, selected: mState.params.model, role: document.getElementById('model-card').getAttribute('role') }));
    check(`${name}: model Enter and Space each select once`, model.changed == 2 && model.notes == 2 && model.selected == 'folder/Model.safetensors'
        && model.role == 'button', JSON.stringify(model));
    await page.locator('.m-trigger-chip').focus();
    await page.keyboard.press('Enter');
    await page.locator('.m-model-civitai-btn').focus();
    await page.keyboard.press('Enter');
    let nested = await page.evaluate(() => ({ ...counts }));
    check(`${name}: nested model controls retain native action without card selection`, nested.changed == 2 && nested.triggers == 1 && nested.triggerText == 'subject' && nested.civitai == 1,
        JSON.stringify(nested));
    await page.locator('.m-image-tile-cell').first().focus();
    let label = await page.locator('.m-image-tile-cell').first().getAttribute('aria-label');
    await page.keyboard.press('Enter');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    let history = await page.evaluate(() => ({ viewers: document.querySelectorAll('.m-viewer').length,
        role: document.querySelector('.m-image-tile-cell').getAttribute('role'), dialogRole: document.querySelector('.m-viewer').getAttribute('role'),
        modal: document.querySelector('.m-viewer').getAttribute('aria-modal'), active: document.activeElement.textContent,
        appInert: document.querySelector('.m-app').inert }));
    check(`${name}: labeled history tile opens the real modal viewer and focuses an action`, !!label && history.viewers == 1 && history.role == 'button'
        && history.dialogRole == 'dialog' && history.modal == 'true' && history.active == 'Reuse Params' && history.appInert, JSON.stringify({ label, ...history }));
    await page.keyboard.press('Shift+Tab');
    let backWrap = await page.evaluate(() => document.activeElement.textContent);
    await page.keyboard.press('Tab');
    let forwardWrap = await page.evaluate(() => document.activeElement.textContent);
    check(`${name}: viewer Tab and Shift+Tab stay inside its action row`, backWrap == 'Close' && forwardWrap == 'Reuse Params',
        JSON.stringify({ backWrap, forwardWrap }));
    await page.keyboard.press('ArrowRight');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    let next = await page.evaluate(() => ({ viewers: document.querySelectorAll('.m-viewer').length,
        src: document.querySelector('.m-viewer img').getAttribute('src'), active: document.activeElement.textContent }));
    await page.keyboard.press('ArrowLeft');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    let previous = await page.evaluate(() => ({ viewers: document.querySelectorAll('.m-viewer').length,
        src: document.querySelector('.m-viewer img').getAttribute('src'), active: document.activeElement.textContent }));
    check(`${name}: viewer previous and next replace one layer and retain focus`, next.viewers == 1 && next.src.endsWith('/history-2.png')
        && next.active == 'Reuse Params' && previous.viewers == 1 && previous.src.endsWith('/history.png') && previous.active == 'Reuse Params',
        JSON.stringify({ next, previous }));
    await page.keyboard.press('Escape');
    let viewerClosed = await page.evaluate(() => ({ viewers: document.querySelectorAll('.m-viewer').length,
        active: document.activeElement.getAttribute('aria-label'), appInert: document.querySelector('.m-app').inert }));
    check(`${name}: viewer Escape closes and restores the history tile`, viewerClosed.viewers == 0 && viewerClosed.active == 'folder/history.png'
        && !viewerClosed.appInert, JSON.stringify(viewerClosed));

    await page.evaluate(async () => {
        let content = document.createElement('div');
        content.setAttribute('aria-label', 'Viewer Parent');
        window.closeViewerParent = mUI.openSheet(content);
        await new Promise(resolve => requestAnimationFrame(resolve));
        mImages.openViewer(mImages.entries[0], 0);
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    let nestedViewer = await page.evaluate(() => ({ sheetInert: document.querySelector('.m-sheet').inert,
        viewers: document.querySelectorAll('.m-viewer').length, active: document.activeElement.textContent }));
    await page.keyboard.press('Escape');
    let nestedRestored = await page.evaluate(() => ({ activeSheet: document.activeElement == document.querySelector('.m-sheet'),
        sheetInert: document.querySelector('.m-sheet').inert, viewers: document.querySelectorAll('.m-viewer').length }));
    check(`${name}: viewer nested over a sheet restores that sheet without leaking a layer`, nestedViewer.sheetInert && nestedViewer.viewers == 1
        && nestedViewer.active == 'Reuse Params' && nestedRestored.activeSheet && !nestedRestored.sheetInert && nestedRestored.viewers == 0,
        JSON.stringify({ nestedViewer, nestedRestored }));
    await page.keyboard.press('Escape');
    check(`${name}: card checks produced no page errors`, errors.length == 0, errors.join(' | '));
    await page.close();
}

async function verifySkipNavigation(browser, name) {
    let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    let errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await loadUI(page, '<main class="m-app"><a class="skip-navigation" href="#m-main-content" tabindex="0">Skip Navigation</a>'
        + '<header class="m-header">Header</header><main class="m-panels" id="m-main-content" tabindex="-1">'
        + '<section class="m-panel" data-mtab="create"></section><section class="m-panel" data-mtab="images"></section></main>'
        + '<nav class="m-bottom-nav"><button class="m-nav-item" data-mdest="create">Create</button>'
        + '<button class="m-nav-item" data-mdest="images">Images</button></nav></main>');
    await page.evaluate(() => {
        mUI.registerTab('create', () => { });
        mUI.registerTab('images', () => { });
        location.hash = 'images';
        mUI.initRouter();
        document.body.focus();
    });
    let before = await page.locator('.m-app').boundingBox();
    await page.keyboard.press('Tab');
    let first = await page.evaluate(() => ({ text: document.activeElement.textContent, hash: location.hash }));
    let focused = await page.locator('.skip-navigation').boundingBox();
    await page.keyboard.press('Enter');
    let after = await page.locator('.m-app').boundingBox();
    let result = await page.evaluate(() => ({ active: document.activeElement.id, hash: location.hash,
        tab: document.querySelector('.m-panel.m-tab-active').dataset.mtab }));
    let stable = before && after && Math.abs(before.x - after.x) < 0.1 && Math.abs(before.y - after.y) < 0.1
        && Math.abs(before.width - after.width) < 0.1 && Math.abs(before.height - after.height) < 0.1;
    check(`${name}: /simple skip link is first, visible on focus, and preserves routing`, first.text == 'Skip Navigation' && !!focused
        && result.active == 'm-main-content' && first.hash == '#images' && result.hash == '#images' && result.tab == 'images' && stable,
        JSON.stringify({ first, result, stable }));
    check(`${name}: skip-navigation check produced no page errors`, errors.length == 0, errors.join(' | '));
    await page.close();

    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<a class="skip-navigation" href="#genpage-main-content" tabindex="0">Skip Navigation</a><nav id="toptablist">Navigation</nav>'
        + '<div id="genpage-main-content" tabindex="-1" role="main">Main Content</div>');
    await page.addStyleTag({ content: CSS });
    let genBefore = await page.locator('#genpage-main-content').boundingBox();
    await page.keyboard.press('Tab');
    let genFirst = await page.evaluate(() => document.activeElement.textContent);
    let genFocused = await page.locator('.skip-navigation').boundingBox();
    await page.keyboard.press('Enter');
    let genAfter = await page.locator('#genpage-main-content').boundingBox();
    let genResult = await page.evaluate(() => ({ active: document.activeElement.id, hash: location.hash }));
    let genStable = genBefore && genAfter && Math.abs(genBefore.x - genAfter.x) < 0.1 && Math.abs(genBefore.y - genAfter.y) < 0.1
        && Math.abs(genBefore.width - genAfter.width) < 0.1 && Math.abs(genBefore.height - genAfter.height) < 0.1;
    check(`${name}: Genpage skip link is first, visible on focus, and moves focus without reflow`, genFirst == 'Skip Navigation' && !!genFocused
        && genResult.active == 'genpage-main-content' && genResult.hash == '#genpage-main-content' && genStable, JSON.stringify({ genResult, genStable }));
    check(`${name}: Genpage skip-navigation check produced no page errors`, errors.length == 0, errors.join(' | '));
    await page.close();
}

for (let [type, name] of [[chromium, 'Chromium'], [webkit, 'WebKit']]) {
    let browser = await type.launch();
    await verifySheets(browser, name);
    await verifyCards(browser, name);
    await verifySkipNavigation(browser, name);
    await browser.close();
}
if (results.some(result => !result.pass)) {
    process.exitCode = 1;
}
