/** Behavioral checks for bounded Genpage model-browser startup loading. */
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import vm from 'vm';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MODELS = readFileSync(`${REPO}/src/wwwroot/js/genpage/gentab/models.js`, 'utf8');
const BROWSERS = readFileSync(`${REPO}/src/wwwroot/js/genpage/helpers/browsers.js`, 'utf8');
const LORAS = readFileSync(`${REPO}/src/wwwroot/js/genpage/gentab/loras.js`, 'utf8');

function check(name, condition, detail = '') {
    assert.equal(condition, true, name);
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
}

const modelMethodStart = MODELS.indexOf('    loadIfNeeded() {');
const modelMethodEnd = MODELS.indexOf('\n    isStarred', modelMethodStart);
assert.ok(modelMethodStart >= 0 && modelMethodEnd > modelMethodStart, 'loadIfNeeded source missing');
const loadMethod = MODELS.slice(modelMethodStart, modelMethodEnd).replaceAll(/^    /gm, '');
const browserMethodContext = {};
vm.runInNewContext(`class TestWrapper {\n${loadMethod}\n}\nthis.TestWrapper = TestWrapper;`, browserMethodContext);

const activeSidebar = { id: 'Input-Sidebar-Main-Tab', classList: { contains: () => true } };
const activeModelPane = { id: 'Models-Tab', classList: { contains: () => true } };
const paneState = { contains: () => true };
const panes = { model_list: activeModelPane, vae_list: { id: 'Vaes-Tab', classList: paneState }, lora_list: { id: 'Loras-Tab', classList: paneState } };
const tabs = {};
const requests = [];
const wrappers = Object.keys(panes).map((key) => {
    let wrapper = new browserMethodContext.TestWrapper();
    wrapper.browser = { everLoaded: false, loadRequested: false, navigate(path) { requests.push(key + ':' + path); } };
    return { browser: wrapper.browser, loadIfNeeded: wrapper.loadIfNeeded.bind(wrapper), pane: panes[key] };
});
const start = MODELS.indexOf('function initialModelListLoad()');
const end = MODELS.indexOf('\n}\n', start) + 3;
assert.ok(start >= 0 && end > start, 'initialModelListLoad source missing');
const context = {
    document: {
        querySelector(selector) {
            let match = selector.match(/^a\[href="#(.+)"\]$/);
            if (!match) {
                return null;
            }
            if (!tabs[match[1]]) {
                tabs[match[1]] = { dataset: {}, classList: { contains: (name) => match[1] == 'Models-Tab' && name == 'active' }, addEventListener(type, callback) { this.callback = callback; } };
            }
            return tabs[match[1]];
        }
    },
    allModelBrowsers: wrappers.map((entry) => ({ browser: { container: { closest: () => entry.pane } }, loadIfNeeded: entry.loadIfNeeded }))
};
vm.runInNewContext(`${MODELS.slice(start, end)}; initialModelListLoad();`, context);
check('startup loads only the selected model pane', requests.join(',') == 'model_list:');
check('hidden model panes receive activation listeners', tabs['Vaes-Tab'].callback != null && tabs['Loras-Tab'].callback != null);
tabs['Vaes-Tab'].callback();
tabs['Vaes-Tab'].callback();
check('first activation sends one captured model request', requests.join(',') == 'model_list:,vae_list:');

wrappers[0].browser.everLoaded = false;
wrappers[0].browser.loadRequested = false;
wrappers[0].loadIfNeeded();
check('a failed first load can retry on a later activation', requests.filter((request) => request == 'model_list:').length == 2);

const refreshStart = BROWSERS.indexOf('    refresh() {');
const refreshEnd = BROWSERS.indexOf('\n    lightRefresh()', refreshStart);
assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, 'refresh source missing');
const refreshMethod = BROWSERS.slice(refreshStart, refreshEnd).replaceAll(/^    /gm, '');
const refreshContext = {};
vm.runInNewContext(`class TestBrowser {\n${refreshMethod}\n}\nthis.TestBrowser = TestBrowser;`, refreshContext);
function refreshCount(browser) {
    let count = 0;
    browser.refreshHandler = (callback) => { count++; callback(); };
    browser.updateCalls = 0;
    browser.update = () => { browser.updateCalls++; };
    browser.folder = '';
    browser.depth = 1;
    browser.noContentUpdates = false;
    browser.lastListCache = null;
    browser.runAfterUpdate = [];
    browser.refresh();
    return { handler: count, update: browser.updateCalls || 0 };
}
let genericBrowser = new refreshContext.TestBrowser();
check('generic unopened browsers retain explicit refresh behavior', refreshCount(genericBrowser).handler == 1);
let lazyBrowser = new refreshContext.TestBrowser();
lazyBrowser.deferInitialRefresh = true;
let lazyRefresh = refreshCount(lazyBrowser);
check('unopened lazy model browsers keep the refresh handler but skip listing', lazyRefresh.handler == 1 && lazyRefresh.update == 0);
lazyBrowser.everLoaded = true;
check('loaded lazy model browsers still refresh', refreshCount(lazyBrowser).handler == 1);
let failedBrowser = new refreshContext.TestBrowser();
failedBrowser.deferInitialRefresh = true;
failedBrowser.hasGenerated = true;
check('failed lazy loads remain explicitly retryable', refreshCount(failedBrowser).handler == 1);
const lightStart = BROWSERS.indexOf('    lightRefresh() {');
const lightEnd = BROWSERS.indexOf('\n    rerender()', lightStart);
assert.ok(lightStart >= 0 && lightEnd > lightStart, 'lightRefresh source missing');
const lightMethod = BROWSERS.slice(lightStart, lightEnd).replaceAll(/^    /gm, '');
const lightContext = {};
vm.runInNewContext(`class TestLightBrowser {\n${lightMethod}\n}\nthis.TestLightBrowser = TestLightBrowser;`, lightContext);
let unopenedLight = new lightContext.TestLightBrowser();
unopenedLight.deferInitialRefresh = true;
unopenedLight.lastListCache = { old: true };
unopenedLight.update = () => { unopenedLight.updateCalls = (unopenedLight.updateCalls || 0) + 1; };
unopenedLight.lightRefresh();
check('unopened lazy browsers invalidate cache without listing', unopenedLight.lastListCache == null && !unopenedLight.updateCalls);
let loadedLight = new lightContext.TestLightBrowser();
loadedLight.deferInitialRefresh = true;
loadedLight.everLoaded = true;
loadedLight.update = () => { loadedLight.updateCalls = (loadedLight.updateCalls || 0) + 1; };
loadedLight.lightRefresh();
check('loaded lazy browsers still light-refresh', loadedLight.updateCalls == 1);
check('model wrappers cap their first DOM chunk', MODELS.includes('this.browser.maxPreBuild = 50;'));
check('progressive browser chunks retain every record', BROWSERS.includes('let remainingFiles = files.slice(i);') && BROWSERS.includes('remainingFiles.splice(0, chunkSize)'));
let records = Array.from({ length: 137 }, (_, index) => index);
let first = records.slice(0, 50);
let rest = records.slice(50);
let chunks = [first];
while (rest.length > 0) {
    chunks.push(rest.splice(0, Math.min(50, rest.length)));
}
check('chunk cap partitions without dropping records', chunks.flat().length == records.length && new Set(chunks.flat()).size == records.length);

const renderStart = BROWSERS.indexOf('    buildContentList(container, files, before');
const renderEnd = BROWSERS.indexOf('\n    rerender()', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, 'buildContentList source missing');
const renderMethod = BROWSERS.slice(renderStart, renderEnd).replaceAll(/^    /gm, '');
const popovers = [];
const renderContext = {
    document: { getElementById() { return null; }, createElement() { return renderNode(); }, body: { appendChild(node) { popovers.push(node); } } },
    browserUtil: { makeVisible() {} }, setTimeout(callback) { callback(); },
    createDiv(id, className) { let node = renderNode(); node.id = id; node.className = className; return node; },
    createSpan() { return renderNode(); }, doPopover() {},
};
function renderNode() {
    return { children: [], dataset: {}, classList: { add() {} }, appendChild(child) { this.children.push(child); }, insertBefore(child) { this.children.push(child); }, addEventListener(type, callback) { this[`on${type}`] = callback; }, getElementsByTagName() { return []; }, getElementsByClassName() { return []; } };
}
vm.runInNewContext(`class TestBrowser {\n${renderMethod}\n}\nthis.TestBrowser = TestBrowser;`, renderContext);
let renderedContainer = renderNode();
let renderedFiles = Array.from({ length: 160 }, (_, index) => ({ name: `model-${index}`, data: { src: `model-${index}` } }));
let renderedActions = [];
let renderer = new renderContext.TestBrowser();
renderer.maxPreBuild = 4;
renderer.format = 'List';
renderer.filter = '';
renderer.chunksRendered = 0;
renderer.id = 'models';
renderer.describe = (file) => ({ className: '', description: '', searchable: file.name, image: '', buttons: [{ label: 'Action', onclick: () => renderedActions.push(file.name) }] });
renderer.select = () => {};
renderer.buildContentList(renderedContainer, renderedFiles);
for (let loader of renderedContainer.children.filter((child) => child.className == 'lazyload browser-section-loader')) {
    loader.onclick();
}
let actionNodes = popovers.flatMap((popover) => popover.children || []);
for (let action of actionNodes) {
    action.onclick?.();
}
let menuIds = popovers.map((popover) => popover.id);
check('three or more lazy sections render every record with unique action IDs', renderedContainer.children.filter((child) => child.dataset.name).length == 160 && renderedActions.length == 160 && new Set(menuIds).size == menuIds.length, `${renderedContainer.children.filter((child) => child.dataset.name).length}/${renderedActions.length}/${menuIds.length}`);

const loraMethodStart = LORAS.indexOf('    loadLoraDescription(name, callback) {');
const loraMethodEnd = LORAS.indexOf('\n    loadFromParams', loraMethodStart);
assert.ok(loraMethodStart >= 0 && loraMethodEnd > loraMethodStart, 'loadLoraDescription source missing');
const loraMethod = LORAS.slice(loraMethodStart, loraMethodEnd).replaceAll(/^    /gm, '');
const loraContext = { sdLoraBrowser: { models: {} }, requests: [], genericRequest(route, input, success, delay, failure, timeout) {
    loraContext.requests.push({ route, input, success, failure, timeout });
} };
vm.runInNewContext(`class TestLoraHelper {\n${loraMethod}\n}\nthis.TestLoraHelper = TestLoraHelper;`, loraContext);
let loraHelperTest = new loraContext.TestLoraHelper();
loraHelperTest.loraDescriptionRequests = {};
let callbackCount = 0;
loraHelperTest.loadLoraDescription('test/name', () => { callbackCount++; });
loraHelperTest.loadLoraDescription('test/name', () => { callbackCount++; });
check('selected-LoRA popup metadata uses one bounded request before catalog open', loraContext.requests.length == 1 && loraContext.requests[0].route == 'DescribeModel' && loraContext.requests[0].input.subtype == 'LoRA' && loraContext.requests[0].timeout == 15000);
loraContext.requests[0].success({ model: { name: 'canonical/name.safetensors' } });
check('single-flight LoRA callers both receive the captured description', callbackCount == 2 && loraContext.sdLoraBrowser.models['test/name'] != null && loraContext.sdLoraBrowser.models['canonical/name'] != null);
loraHelperTest.loadLoraDescription('failed/name', () => { });
loraContext.requests[1].failure();
loraHelperTest.loadLoraDescription('failed/name', () => { });
check('a timed-out metadata request clears single-flight state for retry', loraContext.requests.length == 3 && loraContext.requests[2].timeout == 15000);
let popupState = { popupIntent: 0 };
let intentA = ++popupState.popupIntent;
let intentB = ++popupState.popupIntent;
check('a newer LoRA action invalidates an older row callback', intentA != popupState.popupIntent && intentB == popupState.popupIntent);
check('late popup work checks shared intent and current DOM', LORAS.includes('++loraHelper.popupIntent') && LORAS.includes('intent == loraHelper.popupIntent') && LORAS.includes('div.isConnected'));
