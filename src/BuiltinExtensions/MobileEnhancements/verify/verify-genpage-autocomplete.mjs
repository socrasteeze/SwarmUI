/**
 * Behavior checks for Genpage autocomplete deferral and request ownership.
 * Run from the repository root with: node src/BuiltinExtensions/MobileEnhancements/verify/verify-genpage-autocomplete.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

let main = readFileSync('src/wwwroot/js/genpage/main.js', 'utf8');
let promptTools = readFileSync('src/wwwroot/js/genpage/gentab/prompttools.js', 'utf8');

/** Extracts a balanced function or class declaration. */
function extractDeclaration(source, declaration) {
    let start = source.indexOf(declaration);
    assert.notEqual(start, -1, `${declaration} exists`);
    let open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] == '{') {
            depth++;
        }
        else if (source[i] == '}') {
            depth--;
            if (depth == 0) {
                return source.substring(start, i + 1);
            }
        }
    }
    throw new Error(`${declaration} has unbalanced braces`);
}

let bootRequests = [];
let bootContext = { genericRequest: (...args) => bootRequests.push(args) };
vm.createContext(bootContext);
vm.runInContext(`${extractDeclaration(main, 'function loadUserData(')}; globalThis.loadUserData = loadUserData;`, bootContext);
bootContext.loadUserData();
assert.equal(bootRequests.length, 1, 'boot makes one user-data request');
assert.equal(bootRequests[0][0], 'GetMyUserData');
assert.deepEqual({ ...bootRequests[0][1] }, { includeAutocompletions: false }, 'boot explicitly omits autocomplete data');

let focusLoads = 0;
let focusListeners = {};
let focusBox = { addEventListener(name, callback) { focusListeners[name] = callback; } };
let focusContext = {
    document: { activeElement: null },
    genpageAutoCompletions: { ensureLoaded() { focusLoads++; } },
    WeakSet,
    Set
};
vm.createContext(focusContext);
vm.runInContext(`${extractDeclaration(promptTools, 'class PromptTabCompleteClass')}; globalThis.PromptTabCompleteClass = PromptTabCompleteClass;`, focusContext);
let prompt = new focusContext.PromptTabCompleteClass();
prompt.getPossibleList = () => [];
prompt.enableFor(focusBox);
focusListeners.focus();
focusListeners.input();
assert.equal(focusLoads, 0, 'unfocused programmatic events do not load autocomplete');
focusContext.document.activeElement = focusBox;
focusListeners.focus();
assert.equal(focusLoads, 1, 'first real focus loads autocomplete');

let now = 1000;
let timerSequence = 0;
let timers = [];
let requests = [];
let warnings = [];
let activeBox = {};
let promptCache = {
    enabledBoxes: new WeakSet([activeBox]), calls: 0, lastWord: 'old', lastResults: ['old'],
    onInput() { this.calls++; }
};
let context = {
    session_id: 'session-a', promptTabComplete: promptCache, document: { activeElement: activeBox },
    genericRequest(...args) { requests.push(args); },
    setTimeout(callback, delay) {
        let timer = { id: ++timerSequence, at: now + delay, callback, cleared: false };
        timers.push(timer);
        return timer.id;
    },
    clearTimeout(id) {
        let timer = timers.find(item => item.id == id);
        if (timer) { timer.cleared = true; }
    },
    largeCountStringify: value => `count:${value}`,
    console: { warn(message) { warnings.push(`${message}`); } },
    Date: { now: () => now }, Set, Array, JSON, Error, Promise
};
vm.createContext(context);
let controllerSource = extractDeclaration(main, 'class GenpageAutoCompletions');
vm.runInContext(`let autoCompletionsList = null; ${controllerSource};
    globalThis.controller = new GenpageAutoCompletions();
    globalThis.getList = () => autoCompletionsList;`, context);

/** Runs the next active timer at the requested timestamp. */
function runTimerAt(timestamp) {
    let timer = timers.find(item => !item.cleared && item.at == timestamp);
    assert.ok(timer, `timer exists at ${timestamp}`);
    timer.cleared = true;
    now = timestamp;
    timer.callback();
}

/** Lets async parser continuations schedule their next chunk. */
async function flushAsync() {
    await Promise.resolve();
    await Promise.resolve();
}

context.controller.ensureLoaded();
context.controller.ensureLoaded();
assert.equal(requests.length, 1, 'first use is single-flight');
assert.equal(requests[0][0], 'GetSimpleAutocompletions');
assert.equal(requests[0][1].exactSource, true, 'Genpage requests the exact configured source');
assert.equal(requests[0][5], 15000, 'transport timeout matches the ownership timeout');

let entries = [];
for (let i = 0; i < 2050; i++) {
    entries.push(`name${i}\nClean Name ${i}\n${i % 5}\n${i + 10}\nalias${i}, shared`);
}
let firstSuccess = requests[0][2]({
    configured_source: 'tags.csv', source: 'tags.csv',
    autocompletions: entries
});
await flushAsync();
assert.equal(context.getList(), null, 'partially parsed data is not published');
context.controller.ensureLoaded();
assert.equal(requests.length, 1, 'typing during chunked parsing stays single-flight');
runTimerAt(now);
await flushAsync();
context.controller.ensureLoaded();
assert.equal(requests.length, 1, 'ownership remains active between parser chunks');
runTimerAt(now);
await firstSuccess;
let parsed = context.getList();
assert.equal(parsed.all.length, entries.length, 'all entries are published after parsing');
assert.equal(parsed.n.length, entries.length, 'first-character bucket is retained');
assert.equal(parsed.alias123.length, 1, 'alias buckets are retained');
assert.equal(parsed.shared.length, entries.length, 'shared aliases are retained without duplicate publication');
assert.equal(parsed.all[123].count, 133, 'counts are retained');
assert.equal(parsed.all[123].count_display, 'count:133', 'count display formatting is retained');
assert.equal(promptCache.calls, 1, 'only the registered active prompt is refreshed');
assert.equal(promptCache.lastWord, null, 'incremental prompt cache is cleared on publish');
assert.equal(context.controller.loaded, true, 'completed parsing marks the index ready');

let referenceEntry = entries[123].split('\n');
assert.deepEqual(
    { name: parsed.all[123].name, low: parsed.all[123].low, clean: parsed.all[123].clean, raw: parsed.all[123].raw,
        count: parsed.all[123].count, tag: parsed.all[123].tag, alts: [...parsed.all[123].alts] },
    { name: referenceEntry[0], low: referenceEntry[1].replaceAll(' ', '_').toLowerCase(), clean: referenceEntry[1], raw: entries[123],
        count: parseInt(referenceEntry[3]), tag: referenceEntry[2], alts: referenceEntry[4].split(',').map(value => value.trim().toLowerCase()) },
    'entry parsing matches the legacy Genpage representation');

context.session_id = 'session-b';
context.controller.ensureLoaded();
assert.equal(requests.length, 2, 'a changed session starts a new request');
assert.equal(context.getList(), null, 'a changed session clears the prior user index');
await requests[0][2]({ configured_source: 'old.csv', source: 'old.csv', autocompletions: ['old\nOld'] });
assert.equal(context.getList(), null, 'a callback from the previous session cannot publish');

let timeoutAt = now + 15000;
runTimerAt(timeoutAt);
assert.equal(context.controller.activeRequest, null, 'timeout atomically releases request ownership');
await requests[1][2]({ configured_source: 'late.csv', source: 'late.csv', autocompletions: ['late\nLate'] });
assert.equal(context.getList(), null, 'a late response after timeout is ignored');
context.controller.ensureLoaded();
assert.equal(requests.length, 2, 'timeout retry delay is enforced');
now += 5000;
context.controller.ensureLoaded();
assert.equal(requests.length, 3, 'request retries after five seconds');
requests[1][4]('older request failed late');
assert.ok(context.controller.activeRequest, 'an old error callback cannot clear a newer request');

await requests[2][2]({ configured_source: 'bad.csv', source: 'bad.csv', autocompletions: [17] });
assert.equal(context.controller.activeRequest, null, 'parser errors release ownership');
assert.match(warnings.at(-1), /non-text entry/, 'parser errors are reported without an unhandled rejection');
context.controller.ensureLoaded();
assert.equal(requests.length, 3, 'parser errors use the retry delay');
now += 5000;
context.controller.ensureLoaded();
assert.equal(requests.length, 4, 'parser errors can be retried');

await requests[3][2]({
    configured_source: 'new.csv', source: 'new.csv',
    warning: 'source warning', autocompletions: ['new\nNew\n2\n7\nnew, fresh, fresh']
});
assert.equal(context.getList().fresh.length, 1, 'duplicate aliases do not duplicate a formatted entry');
assert.match(warnings.at(-1), /source warning/, 'server warnings are surfaced');

let settingsA = {
    autocomplete: { value: { source: { value: 'new.csv' }, escapeparens: { value: false }, suffix: { value: '' }, spacingmode: { value: 'None' } } },
    paramparsing: { value: { parsealternativepromptsyntaxes: { value: true } } }
};
context.controller.noteAppliedSettings(settingsA);
context.controller.noteAppliedSettings(settingsA);
assert.ok(context.getList(), 'an unchanged applied settings snapshot keeps the index');
let settingsChanges = [];
let changedSource = structuredClone(settingsA);
changedSource.autocomplete.value.source.value = 'other.csv';
settingsChanges.push(['source', changedSource]);
let changedEscape = structuredClone(changedSource);
changedEscape.autocomplete.value.escapeparens.value = true;
settingsChanges.push(['escape', changedEscape]);
let changedSuffix = structuredClone(changedEscape);
changedSuffix.autocomplete.value.suffix.value = ', ';
settingsChanges.push(['suffix', changedSuffix]);
let changedSpacing = structuredClone(changedSuffix);
changedSpacing.autocomplete.value.spacingmode.value = 'Spaces';
settingsChanges.push(['spacing', changedSpacing]);
for (let [name, settings] of settingsChanges) {
    let requestCount = requests.length;
    context.controller.noteAppliedSettings(settings);
    assert.equal(context.getList(), null, `changed applied ${name} invalidates the index`);
    context.controller.ensureLoaded();
    assert.equal(requests.length, requestCount + 1, `changed applied ${name} fetches on the next focused use`);
    await requests.at(-1)[2]({ configured_source: 'other.csv', source: 'other.csv', autocompletions: [`${name}\n${name}`] });
    assert.equal(context.getList().all[0].name, name, `changed applied ${name} can publish a replacement index`);
}

console.log('PASS  Genpage autocomplete boot deferral, focus gate, context invalidation, bounded single-flight parsing, retries, and legacy formatting');
