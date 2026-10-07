/** Drives the shipped /simple history, image-identity, and prompt-save paths.
 * Node evaluates the scripts in a browser-like global. Playwright, when it can launch, runs the same checks. */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import vm from 'vm';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ASSET = `${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m`;
const SCRATCH = process.argv[2];
const SOURCES = ['m_ui.js', 'm_state.js', 'm_create.js', 'm_images.js'].map(name => readFileSync(`${ASSET}/${name}`, 'utf8'));

const CHECKS = `
async function runChecks() {
    let historyLog = [];
    let identityLog = [];
    let saveLog = [];
    let check = (bucket, name, ok) => {
        if (!ok) {
            throw new Error(name);
        }
        bucket.push('PASS  ' + name);
    };
    let wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let waitFrame = async () => {
        await new Promise(resolve => requestAnimationFrame(() => resolve()));
        await wait(0);
    };
    let fire = (elem, type) => {
        elem.dispatchEvent(new Event(type));
    };
    let writes = [];
    let nativeSet = localStorage.setItem.bind(localStorage);
    let nativeGet = localStorage.getItem.bind(localStorage);
    let memory = {};
    localStorage.setItem = (key, value) => {
        memory[key] = String(value);
        writes.push(key);
        try {
            nativeSet(key, value);
        }
        catch (e) { /* the node shim has no separate native store */ }
    };
    localStorage.getItem = (key) => Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : nativeGet(key);
    let saved = () => JSON.parse(localStorage.getItem('m_client_state') || '{}');
    let requests = [];
    let total = 60;
    genericRequest = (route, data, success) => {
        requests.push({ route: route, data: data });
        if (route == 'ListImages') {
            let offset = data.offset || 0;
            let limit = data.limit;
            let files = [];
            let end = Math.min(total, offset + limit);
            for (let i = offset; i < end; i++) {
                files.push({ src: 'img-' + i + '.png', metadata: '' });
            }
            success({
                folders: ['Starred', 'jobs'],
                files: files,
                total: total,
                next_offset: offset + limit < total ? offset + limit : null
            });
            return;
        }
        if (success) {
            success({});
        }
    };
    let createPanel = document.createElement('section');
    let imagesPanel = document.createElement('section');
    document.body.appendChild(createPanel);
    document.body.appendChild(imagesPanel);
    mCreate.build(createPanel);
    mImages.build(imagesPanel);
    writes.length = 0;

    mImages.refresh();
    let first = requests[requests.length - 1].data;
    check(historyLog, 'first ListImages uses a positive limit', first.limit >= 1 && first.limit <= 250 && first.offset == 0);
    check(historyLog, 'first response is only that page', mImages.entries.length == first.limit && mImages.entries.length < total);
    check(historyLog, 'first API page is fully painted', imagesPanel.querySelectorAll('.m-image-tile-cell').length == first.limit);
    check(historyLog, 'folder names arrive with the page', [...imagesPanel.querySelectorAll('.m-folder-chip')].some(chip => chip.textContent == 'Starred'));
    let firstNames = mImages.entries.map(entry => entry.src);
    fire(mImages.nextPage, 'click');
    let second = requests[requests.length - 1].data;
    check(historyLog, 'Next requests the next explicit offset', requests.length == 2 && second.offset == first.limit && second.offset != 0);
    check(historyLog, 'the second page replaces the first page', mImages.entries.length == total - first.limit && mImages.entries[0].src == 'img-' + first.limit + '.png');
    check(historyLog, 'the second page does not repeat the first', mImages.entries.every(entry => !firstNames.includes(entry.src)));
    let last = mImages.entries[mImages.entries.length - 1];
    let lastTile = null;
    for (let tile of imagesPanel.querySelectorAll('.m-image-tile-cell')) {
        if (tile.getAttribute('aria-label') == last.src) {
            lastTile = tile;
        }
    }
    check(historyLog, 'the later file has a tile', !!lastTile);
    fire(lastTile, 'click');
    await waitFrame();
    let viewerImg = document.querySelector('.m-viewer img');
    check(historyLog, 'opening a listed file uses that file', !!viewerImg && viewerImg.src.indexOf(last.src) >= 0);

    let marker = 'BYTESMARKER9f3a';
    let dataUrl = 'data:image/png;base64,' + marker.repeat(40);
    mState.promptImages = [{ kind: 'data', value: dataUrl }];
    mState.initImage = { kind: 'data', value: dataUrl + 'START' };
    mState.videoEndImage = { kind: 'data', value: dataUrl + 'END' };
    mState.changed();
    await waitFrame();
    let thumb = mCreate.imageStrip.querySelector('img');
    let startImg = mCreate.startFrameSlot.body.querySelector('img');
    let endImg = mCreate.endFrameSlot.body.querySelector('img');
    check(identityLog, 'prompt and frame thumbnails exist', !!thumb && !!startImg && !!endImg);
    let leaked = 0;
    let nativeStringify = JSON.stringify;
    JSON.stringify = function(value) {
        let text = nativeStringify.apply(JSON, arguments);
        if (text.indexOf(marker) >= 0) {
            leaked++;
        }
        return text;
    };
    mState.params['steps'] = '21';
    mState.changed();
    await waitFrame();
    JSON.stringify = nativeStringify;
    check(identityLog, 'an unrelated change does not serialize image bytes', leaked == 0);
    check(identityLog, 'the prompt thumbnail stays the same node', mCreate.imageStrip.querySelector('img') === thumb);
    check(identityLog, 'the start frame stays the same node', mCreate.startFrameSlot.body.querySelector('img') === startImg);
    check(identityLog, 'the end frame stays the same node', mCreate.endFrameSlot.body.querySelector('img') === endImg);

    let typeBurst = async (box, key, text) => {
        let before = writes.length;
        let typed = '';
        for (let i = 0; i < text.length; i++) {
            typed += text[i];
            box.value = typed;
            fire(box, 'input');
        }
        check(saveLog, key + ' burst does not write once per character', writes.length == before);
        await wait(MCreate.PromptSavePauseMs + 40);
        check(saveLog, key + ' pause writes the final text once', writes.length == before + 1 && saved().params[key] == text);
    };
    await typeBurst(mCreate.promptBox, 'prompt', 'a cat in rain');
    await typeBurst(mCreate.negBox, 'negativeprompt', 'blurry hands');

    let flushCase = async (label, flush) => {
        let before = writes.length;
        mCreate.promptBox.value = label;
        fire(mCreate.promptBox, 'input');
        check(saveLog, label + ' has not written yet', writes.length == before);
        flush();
        check(saveLog, label + ' flushes the latest text', writes.length == before + 1 && saved().params['prompt'] == label);
        await wait(MCreate.PromptSavePauseMs + 40);
        check(saveLog, label + ' does not write again after the pause', writes.length == before + 1);
    };
    await flushCase('blur-prompt', () => fire(mCreate.promptBox, 'blur'));
    await flushCase('generate-prompt', () => mCreate.doGenerate());
    await flushCase('leave-prompt', () => window.dispatchEvent(new Event('pagehide')));

    let beforeSteps = writes.length;
    mState.params['steps'] = '19';
    mState.changed();
    check(saveLog, 'a steps change persists without waiting', writes.length == beforeSteps + 1 && saved().params['steps'] == '19');
    let beforeSeed = writes.length;
    mCreate.seedInput.value = '42';
    fire(mCreate.seedInput, 'input');
    check(saveLog, 'a seed keystroke still persists immediately', writes.length == beforeSeed + 1 && saved().params['seed'] == '42');
    return { history: historyLog, identity: identityLog, save: saveLog };
}
`;

function elementShim() {
    class DomEvent {
        constructor(type) {
            this.type = type;
            this.detail = 1;
        }
    }
    class DomClassList {
        constructor(owner) {
            this.owner = owner;
        }
        classes() {
            return this.owner.className ? this.owner.className.split(/\s+/).filter(Boolean) : [];
        }
        write(list) {
            this.owner.className = list.join(' ');
        }
        add(...names) {
            let list = this.classes();
            for (let name of names) {
                if (!list.includes(name)) {
                    list.push(name);
                }
            }
            this.write(list);
        }
        remove(...names) {
            this.write(this.classes().filter(name => !names.includes(name)));
        }
        toggle(name, force) {
            let has = this.contains(name);
            let next = force == null ? !has : !!force;
            if (next) {
                this.add(name);
            }
            else {
                this.remove(name);
            }
        }
        contains(name) {
            return this.classes().includes(name);
        }
    }
    class DomNode {
        constructor(tag) {
            this.tagName = `${tag || ''}`.toUpperCase();
            this.className = '';
            this.classList = new DomClassList(this);
            this.style = {
                setProperty(name, value) {
                    this[name] = value;
                },
                removeProperty(name) {
                    delete this[name];
                }
            };
            this.dataset = {};
            this.childNodes = [];
            this.attributes = {};
            this.parentNode = null;
            this.listeners = {};
            this.textContent = '';
            this.value = '';
            this.offsetParent = null;
            this.clientWidth = 0;
            this.scrollHeight = 0;
        }
        get isConnected() {
            let node = this;
            while (node) {
                if (node == body || node == document) {
                    return true;
                }
                node = node.parentNode;
            }
            return false;
        }
        appendChild(child) {
            if (child.parentNode) {
                child.parentNode.childNodes = child.parentNode.childNodes.filter(node => node != child);
            }
            child.parentNode = this;
            this.childNodes.push(child);
            return child;
        }
        setAttribute(name, value) {
            this.attributes[name] = `${value}`;
        }
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
        }
        hasAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name);
        }
        removeAttribute(name) {
            delete this.attributes[name];
        }
        addEventListener(type, callback) {
            if (!this.listeners[type]) {
                this.listeners[type] = [];
            }
            this.listeners[type].push(callback);
        }
        dispatchEvent(event) {
            event.target = this;
            let list = this.listeners[event.type] || [];
            for (let callback of list) {
                callback(event);
            }
            return true;
        }
        focus() { }
        blur() {
            this.dispatchEvent(new DomEvent('blur'));
        }
        click() {
            let event = new DomEvent('click');
            this.dispatchEvent(event);
        }
        set innerHTML(value) {
            if (`${value}` == '') {
                this.childNodes = [];
            }
        }
        get innerHTML() {
            return '';
        }
        matches(selector) {
            if (selector.startsWith('.')) {
                return this.classList.contains(selector.slice(1).split('.')[0]);
            }
            return this.tagName == selector.toUpperCase();
        }
        querySelectorAll(selector) {
            return queryAll(this, selector);
        }
        querySelector(selector) {
            return queryAll(this, selector)[0] || null;
        }
        closest() {
            return null;
        }
        contains(node) {
            let found = false;
            let walk = (current) => {
                for (let child of current.childNodes) {
                    if (child == node) {
                        found = true;
                    }
                    walk(child);
                }
            };
            walk(this);
            return found;
        }
    }
    function matchStep(node, step) {
        if (!node || !node.matches) {
            return false;
        }
        let simple = step.split(':')[0];
        return node.matches(simple);
    }
    function queryAll(root, selector) {
        let groups = selector.split(',').map(part => part.trim()).filter(Boolean);
        let found = [];
        for (let group of groups) {
            let steps = group.split(/\s+/);
            let current = [root];
            for (let step of steps) {
                let next = [];
                for (let node of current) {
                    let walk = (parent) => {
                        for (let child of parent.childNodes || []) {
                            if (matchStep(child, step)) {
                                next.push(child);
                            }
                            walk(child);
                        }
                    };
                    walk(node);
                }
                current = next;
            }
            for (let node of current) {
                if (!found.includes(node)) {
                    found.push(node);
                }
            }
        }
        return found;
    }
    let body = new DomNode('body');
    let document = {
        body,
        activeElement: body,
        createElement(tag) {
            return new DomNode(tag);
        },
        createTextNode(text) {
            let node = new DomNode('#text');
            node.textContent = text;
            return node;
        },
        addEventListener(type, callback) {
            body.addEventListener(type, callback);
        },
        querySelector(selector) {
            return body.querySelector(selector);
        },
        querySelectorAll(selector) {
            return body.querySelectorAll(selector);
        }
    };
    let windowListeners = {};
    let sandboxWindow = {
        addEventListener(type, callback) {
            if (!windowListeners[type]) {
                windowListeners[type] = [];
            }
            windowListeners[type].push(callback);
        },
        dispatchEvent(event) {
            for (let callback of windowListeners[event.type] || []) {
                callback(event);
            }
            return true;
        },
        visualViewport: null,
        innerHeight: 800
    };
    let store = {};
    let sandbox = {
        window: sandboxWindow,
        document,
        Event: DomEvent,
        HTMLElement: function HTMLElement() {},
        console,
        localStorage: {
            getItem(key) {
                return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
            },
            setItem(key, value) {
                store[key] = String(value);
            },
            removeItem(key) {
                delete store[key];
            }
        },
        setTimeout,
        clearTimeout,
        requestAnimationFrame(callback) {
            return setTimeout(() => callback(Date.now()), 0);
        },
        cancelAnimationFrame(id) {
            clearTimeout(id);
        },
        getImageOutPrefix() {
            return 'Output';
        },
        roundTo(val, step) {
            return Math.round(val / step) * step;
        },
        getTextSelRange() {
            return [0, 0];
        },
        mGen: {
            onFrame() { },
            generate() { },
            interrupt(done) {
                if (done) {
                    done();
                }
            },
            queueTotal: 0
        },
        mEnhance: {
            buildPill() {
                return document.createElement('button');
            }
        },
        mAutoComplete: {
            enableFor() { },
            hide() { }
        },
        genericRequest() { },
        IntersectionObserver: class IntersectionObserver {
            constructor(callback) {
                this.callback = callback;
            }
            observe() { }
            disconnect() { }
            unobserve() { }
        }
    };
    sandbox.window.document = document;
    return sandbox;
}

function writeLogs(dir, result) {
    writeFileSync(`${dir}/simple-history-page.log`, `${result.history.join('\n')}\n`);
    writeFileSync(`${dir}/simple-image-identity.log`, `${result.identity.join('\n')}\n`);
    writeFileSync(`${dir}/simple-prompt-save.log`, `${result.save.join('\n')}\n`);
}

let sandbox = elementShim();
vm.createContext(sandbox);
for (let source of SOURCES) {
    vm.runInContext(source, sandbox);
}
vm.runInContext(CHECKS, sandbox);
let result = await sandbox.runChecks();
if (SCRATCH) {
    writeLogs(SCRATCH, result);
}
console.log(result.history.join('\n'));
console.log(result.identity.join('\n'));
console.log(result.save.join('\n'));

let playwrightLog = '';
let browser = null;
try {
    let playwright = await import('playwright');
    browser = await playwright.chromium.launch({ timeout: 20000 });
    let page = await browser.newPage();
    await page.route('http://simple.test/**', route => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!DOCTYPE html><html><body></body></html>'
    }));
    await page.goto('http://simple.test/', { timeout: 15000 });
    await page.evaluate(() => {
        window.mGen = {
            onFrame() { },
            generate() { },
            interrupt(done) {
                if (done) {
                    done();
                }
            },
            queueTotal: 0
        };
        window.mEnhance = { buildPill() { return document.createElement('button'); } };
        window.mAutoComplete = { enableFor() { }, hide() { } };
        window.getImageOutPrefix = () => 'Output';
        window.roundTo = (val, step) => Math.round(val / step) * step;
        window.getTextSelRange = () => [0, 0];
        window.genericRequest = () => { };
    });
    for (let name of ['m_ui.js', 'm_state.js', 'm_create.js', 'm_images.js']) {
        await page.addScriptTag({ path: `${ASSET}/${name}` });
    }
    let browserResult = await page.evaluate(new Function(`${CHECKS}; return runChecks();`));
    playwrightLog = `PASS  playwright ran the shipped scripts\n${browserResult.history.join('\n')}\n${browserResult.identity.join('\n')}\n${browserResult.save.join('\n')}\n`;
}
catch (error) {
    playwrightLog = `Playwright did not run the checks.\n${error && error.stack ? error.stack : error}\n`;
}
finally {
    if (browser) {
        await browser.close();
    }
}
if (SCRATCH) {
    writeFileSync(`${SCRATCH}/simple-playwright.log`, playwrightLog);
}
console.log(playwrightLog);
