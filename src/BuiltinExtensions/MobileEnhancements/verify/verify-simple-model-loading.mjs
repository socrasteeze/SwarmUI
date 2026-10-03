/**
 * /simple Models-tab bounded rendering harness.
 *
 * Checks the live m_models.js source with a small browser fixture. It covers bounded folder cards, all-model
 * reachability, stale ListModels callbacks, hidden-tab observer behavior, search invalidation, and the manual
 * Load More fallback. Run from the repository root:
 *     node src/BuiltinExtensions/MobileEnhancements/verify/verify-simple-model-loading.mjs
 * Set SWARM_WEBKIT=1 for WebKit; SWARM_CHROMIUM can select a Chromium executable.
 */
import { chromium, webkit } from 'playwright';
import { mkdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SOURCE = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m_models.js`, 'utf8');
const CSS = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m.css`, 'utf8');
const results = [];

function check(name, pass, detail = '') {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const engine = process.env.SWARM_WEBKIT == '1' ? webkit : chromium;
const browser = await engine.launch(engine == chromium && process.env.SWARM_CHROMIUM ? { executablePath: process.env.SWARM_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', error => check(`no page errors (${error.message})`, false));
await page.setContent('<main id="host"></main>');
await page.evaluate(() => {
    window.__requests = [];
    window.__warnings = [];
    window.__notes = [];
    window.__observers = [];
    window.IntersectionObserver = class {
        constructor(callback, options) {
            this.callback = callback;
            this.options = options;
            this.targets = new Set();
            this.disconnects = 0;
            window.__observers.push(this);
        }
        observe(target) {
            this.targets.add(target);
        }
        disconnect() {
            this.targets.clear();
            this.disconnects++;
        }
    };
    window.mUI = {
        el: (tag, classes, text = '') => {
            let el = document.createElement(tag);
            el.className = classes;
            el.textContent = text;
            return el;
        },
        modelThumb: model => {
            let image = document.createElement('img');
            image.alt = model.name;
            return image;
        },
        starBadge: () => null,
        modelText: model => {
            let text = document.createElement('div');
            text.className = 'm-model-text';
            text.textContent = model.name;
            return text;
        },
        modelName: name => `${name}`.split('/').pop(),
        modelLines: model => ({ primary: model.name }),
        note: message => window.__notes.push(message),
        warn: message => window.__warnings.push(message),
        openSheet: () => () => { }
    };
    window.mState = {
        params: {},
        loras: [],
        starredFirst: files => [...files].sort((a, b) => a.starred == b.starred ? a.name.localeCompare(b.name) : (a.starred ? -1 : 1)),
        getLoras: () => [...window.mState.loras],
        setLoras: rows => { window.mState.loras = rows; },
        changed: () => { }
    };
    window.MState = { sameModel: (a, b) => a == b };
    window.MCreate = {
        ListCap: 120,
        filterModels: (models, query) => models.filter(model => model.name.toLowerCase().includes(query.toLowerCase()))
    };
    window.mCreate = {
        insertTriggerTag: () => { },
        loraList: null,
        modelList: null,
        indexLoras: () => { },
        enrichLoraMetadata: done => done(),
        buildCountRow: (shown, total) => {
            let row = document.createElement('div');
            row.textContent = `${shown}/${total}`;
            return row;
        }
    };
    window.permissions = { hasPermission: () => false };
    window.genericRequest = (route, args, success, depth, fail) => {
        window.__requests.push({ route, args, success, fail });
    };
});
await page.addScriptTag({ content: SOURCE });

let report = await page.evaluate(() => {
    let host = document.getElementById('host');
    let panel = document.createElement('section');
    panel.className = 'm-panel m-tab-active';
    host.appendChild(panel);
    mModels.build(panel);
    let models = Array.from({ length: 125 }, (_, i) => ({
        name: `folder/Model-${String(i).padStart(3, '0')}.safetensors`,
        local: false,
        starred: i == 124
    }));
    mModels.refresh();
    let request = window.__requests.shift();
    let started = performance.now();
    request.success({ files: models, folders: ['folder'] });
    let candidateMs = performance.now() - started;
    let candidateCards = panel.querySelectorAll('.m-model-card').length;
    let baselineHost = document.createElement('div');
    let baselineStart = performance.now();
    for (let model of models) {
        baselineHost.appendChild(mModels.buildCard(model));
    }
    let baselineMs = performance.now() - baselineStart;
    return { candidateCards, baselineCards: baselineHost.querySelectorAll('.m-model-card').length,
        candidateMs, baselineMs, first: panel.querySelector('.m-model-card .m-model-text').textContent,
        loadMore: !mModels.folderLoadMore.hidden };
});
check('folder view starts at the 40-card chunk', report.candidateCards == 40, JSON.stringify(report));
check('starred ordering survives bounded rendering', report.first == 'folder/Model-124.safetensors', report.first);
check('Load More is available after the initial chunk', report.loadMore);
check('baseline versus candidate card count is deterministic', report.baselineCards == 125 && report.candidateCards == 40,
    `baseline=${report.baselineCards}, candidate=${report.candidateCards}, baselineMs=${report.baselineMs.toFixed(2)}, candidateMs=${report.candidateMs.toFixed(2)}`);

report = await page.evaluate(() => {
    mModels.folderLoadMore.click();
    mModels.folderLoadMore.click();
    mModels.folderLoadMore.click();
    let names = [...mModels.grid.querySelectorAll('.m-model-text')].map(el => el.textContent);
    return { cards: names.length, unique: new Set(names).size, finalButtonHidden: mModels.folderLoadMore.hidden };
});
check('manual fallback reaches every folder model exactly once', report.cards == 125 && report.unique == 125 && report.finalButtonHidden, JSON.stringify(report));

report = await page.evaluate(() => {
    let checkpoint = mModels.grid.querySelector('.m-model-card');
    checkpoint.click();
    let selected = mState.params.model;
    mModels.subtype = 'LoRA';
    mModels.refresh();
    let request = window.__requests.shift();
    request.success({ files: [{ name: 'folder/LoRA-A.safetensors', local: false }], folders: [] });
    mModels.grid.querySelector('.m-model-card').click();
    return { selected, loras: mState.loras.map(row => row.name) };
});
check('bounded cards retain checkpoint and LoRA action bindings', report.selected && report.loras.includes('folder/LoRA-A.safetensors'), JSON.stringify(report));

report = await page.evaluate(() => {
    mModels.subtype = 'Stable-Diffusion';
    mModels.folder = 'old';
    mModels.refresh();
    let oldRequest = window.__requests.shift();
    mModels.folder = 'fresh';
    mModels.refresh();
    let freshRequest = window.__requests.shift();
    freshRequest.success({ files: [{ name: 'fresh/New.safetensors', local: false }], folders: [] });
    oldRequest.success({ files: [{ name: 'old/Old.safetensors', local: false }], folders: [] });
    oldRequest.fail('old failure');
    return { names: [...mModels.grid.querySelectorAll('.m-model-text')].map(el => el.textContent), warnings: [...window.__warnings] };
});
check('stale success and error callbacks cannot replace or warn over the current folder',
    report.names.length == 1 && report.names[0] == 'fresh/New.safetensors' && report.warnings.length == 0, JSON.stringify(report));

report = await page.evaluate(() => {
    mModels.refresh();
    let request = window.__requests.shift();
    request.success({ files: Array.from({ length: 85 }, (_, i) => ({ name: `repeat/${i}`, local: false })), folders: [] });
    let firstCount = mModels.grid.querySelectorAll('.m-model-card').length;
    mModels.refresh();
    request = window.__requests.shift();
    request.success({ files: Array.from({ length: 85 }, (_, i) => ({ name: `repeat/${i}`, local: false })), folders: [] });
    return { firstCount, refreshedCount: mModels.grid.querySelectorAll('.m-model-card').length, disconnects: mModels.folderObserver.disconnects };
});
check('repeat refresh resets cards instead of appending a second copy', report.firstCount == 40 && report.refreshedCount == 40 && report.disconnects >= 2, JSON.stringify(report));

report = await page.evaluate(() => {
    let before = mModels.folderRendered;
    mModels.panel.classList.remove('m-tab-active');
    mModels.folderObserver.callback([{ isIntersecting: true }]);
    let hidden = mModels.folderRendered;
    mModels.panel.classList.add('m-tab-active');
    mModels.folderObserver.callback([{ isIntersecting: true }]);
    return { before, hidden, visible: mModels.folderRendered };
});
check('observer does not drain while hidden and fills more while visible', report.hidden == report.before && report.visible > report.hidden, JSON.stringify(report));

report = await page.evaluate(async () => {
    mModels.folder = 'pending';
    mModels.refresh();
    let oldRequest = window.__requests.shift();
    mModels.search.value = 'needle';
    mModels.search.dispatchEvent(new Event('input', { bubbles: true }));
    oldRequest.success({ files: [{ name: 'pending/old', local: false }], folders: [] });
    let afterOld = mModels.grid.querySelectorAll('.m-model-card').length;
    mCreate.modelList = [{ name: 'search/needle', local: false }];
    await new Promise(resolve => setTimeout(resolve, 180));
    return { afterOld, searchCards: mModels.grid.querySelectorAll('.m-model-card').length,
        observerTargets: mModels.folderObserver.targets.size };
});
check('search invalidates folder responses before its debounce and leaves no folder observer',
    report.afterOld == 0 && report.searchCards == 1 && report.observerTargets == 0, JSON.stringify(report));

report = await page.evaluate(() => {
    let oldObserver = window.IntersectionObserver;
    window.IntersectionObserver = undefined;
    let fallback = new MModels();
    let panel = document.createElement('section');
    panel.className = 'm-panel m-tab-active';
    document.getElementById('host').appendChild(panel);
    fallback.build(panel);
    fallback.folderModels = Array.from({ length: 45 }, (_, i) => ({ name: `fallback/${i}`, local: false }));
    fallback.renderFolderMore();
    let initial = fallback.grid.querySelectorAll('.m-model-card').length;
    let visible = !fallback.folderLoadMore.hidden;
    fallback.folderLoadMore.click();
    window.IntersectionObserver = oldObserver;
    return { initial, final: fallback.grid.querySelectorAll('.m-model-card').length, visible };
});
check('no-IntersectionObserver browsers retain a working Load More fallback', report.initial == 40 && report.final == 45 && report.visible, JSON.stringify(report));

/** Installs the minimum real-DOM collaborators needed to exercise m_models.js with the browser's observer. */
async function prepareRealPage(realPage, models) {
    await realPage.setContent('<style>:root { --background-panel: #222; --background: #111; --text: #eee; --border-color: #555; --emphasis: #8cf; --m-safe-left: 0px; --m-safe-right: 0px; --m-safe-bottom: 0px; } html, body, #host { width: 100%; height: 100%; margin: 0; overflow: hidden; } body { color: var(--text); background: var(--background); }</style><header class="m-header">Models</header><main id="host"><section class="m-panel m-tab-active"></section></main>');
    await realPage.addStyleTag({ content: CSS });
    await realPage.evaluate((rows) => {
        window.mUI = {
            el: (tag, classes, text = '') => {
                let el = document.createElement(tag);
                el.className = classes;
                el.textContent = text;
                return el;
            },
            // Deliberately no preview: this is the shortest practical card shape and stresses a sentinel that
            // remains visible after a chunk at desktop widths.
            modelThumb: () => null,
            starBadge: () => null,
            modelText: model => {
                let text = document.createElement('div');
                text.className = 'm-model-text';
                text.textContent = model.name;
                return text;
            },
            modelName: name => `${name}`.split('/').pop(),
            modelLines: model => ({ primary: model.name }),
            note: () => { },
            warn: message => { window.__realWarnings.push(message); },
            openSheet: () => () => { }
        };
        window.__realWarnings = [];
        window.mState = {
            params: {},
            loras: [],
            starredFirst: files => [...files],
            getLoras: () => [...window.mState.loras],
            setLoras: values => { window.mState.loras = values; },
            changed: () => { }
        };
        window.MState = { sameModel: (a, b) => a == b };
        window.MCreate = { ListCap: 120, filterModels: (list, query) => list.filter(model => model.name.includes(query)) };
        window.mCreate = {
            insertTriggerTag: () => { }, loraList: null, modelList: null, indexLoras: () => { },
            enrichLoraMetadata: done => done(), buildCountRow: () => document.createElement('div')
        };
        window.permissions = { hasPermission: () => false };
        window.genericRequest = (route, args, success) => {
            if (route == 'ListModels') {
                success({ files: rows, folders: ['folder'] });
            }
        };
    }, models);
    await realPage.addScriptTag({ content: SOURCE });
    await realPage.evaluate(() => {
        let panel = document.querySelector('.m-panel');
        mModels.build(panel);
        mModels.refresh();
    });
}

const realPage = await browser.newPage({ viewport: { width: 360, height: 720 } });
const realModels = Array.from({ length: 1000 }, (_, i) => ({ name: `folder/NoPreview-${String(i).padStart(4, '0')}`, local: false }));
mkdirSync(`${REPO}/.local/pwa-desktop-review`, { recursive: true });
for (const width of [360, 768, 1024, 1440]) {
    await realPage.setViewportSize({ width, height: 720 });
    await prepareRealPage(realPage, realModels);
    let before = await realPage.evaluate(() => {
        let panel = document.querySelector('.m-panel');
        return {
            cards: panel.querySelectorAll('.m-model-card').length,
            header: document.querySelector('.m-header').getBoundingClientRect().toJSON(),
            toggle: document.querySelector('.m-models-toggle').getBoundingClientRect().toJSON(),
            search: document.querySelector('.m-models-search').getBoundingClientRect().toJSON(),
            folders: document.querySelector('.m-folder-chips').getBoundingClientRect().toJSON()
        };
    });
    // Let an actual browser observer process the initial, still-visible sentinel. This must advance in
    // bounded chunks rather than synchronously creating all 1,000 cards in refresh().
    await realPage.waitForTimeout(120);
    let loaded = await realPage.evaluate(() => document.querySelectorAll('.m-model-card').length);
    await realPage.evaluate(() => {
        let panel = document.querySelector('.m-panel');
        panel.scrollTop = panel.scrollHeight;
        panel.dispatchEvent(new Event('scroll'));
    });
    await realPage.waitForTimeout(120);
    let after = await realPage.evaluate(() => {
        let panel = document.querySelector('.m-panel');
        // Compare chrome at the same scroll position. A card's viewport y changing after the test scrolls to
        // the bottom is expected movement, not a layout shift.
        panel.scrollTop = 0;
        let first = panel.querySelector('.m-model-card');
        first.click();
        return {
            cards: panel.querySelectorAll('.m-model-card').length,
            selected: mState.params.model,
            overflow: panel.scrollWidth - panel.clientWidth,
            header: document.querySelector('.m-header').getBoundingClientRect().toJSON(),
            toggle: document.querySelector('.m-models-toggle').getBoundingClientRect().toJSON(),
            search: document.querySelector('.m-models-search').getBoundingClientRect().toJSON(),
            folders: document.querySelector('.m-folder-chips').getBoundingClientRect().toJSON()
        };
    });
    let shifts = ['header', 'toggle', 'search', 'folders'].map(key => Math.abs(before[key].y - after[key].y));
    check(`real observer loads bounded chunks at ${width}px`, before.cards == 40 && loaded > 40 && loaded < realModels.length && after.cards > loaded,
        `before=${before.cards}, visible=${loaded}, afterScroll=${after.cards}`);
    check(`real Models layout remains stable at ${width}px`, Math.max(...shifts) <= 1 && after.overflow <= 1 && !!after.selected,
        `shifts=${shifts.join(',')}, overflow=${after.overflow}`);
    await realPage.screenshot({ path: `${REPO}/.local/pwa-desktop-review/models-${width}${engine == webkit ? '-webkit' : ''}.png`, fullPage: false });
}
await realPage.close();

await browser.close();
if (results.some(result => !result.pass)) {
    process.exitCode = 1;
}
