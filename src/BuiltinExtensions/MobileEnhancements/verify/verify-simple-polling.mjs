/** Behavioral checks for /simple fallback status polling. */
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import vm from 'vm';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SOURCE = readFileSync(`${REPO}/src/BuiltinExtensions/MobileEnhancements/Assets/m/m_gen.js`, 'utf8');

function check(name, condition, detail = '') {
    assert.equal(condition, true, name);
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
}

function makeTestSocket() {
    let documentListeners = {};
    let windowListeners = {};
    let intervals = new Map();
    let nextTimer = 1;
    let requests = [];
    let errors = [];
    let context = {
        console,
        session_id: 'session',
        WebSocket: { OPEN: 1, CLOSED: 3 },
        document: {
            hidden: false,
            addEventListener(name, callback) { documentListeners[name] = callback; }
        },
        window: {
            addEventListener(name, callback) { windowListeners[name] = callback; }
        },
        navigator: { wakeLock: null, vibrate: null },
        localStorage: { getItem() { return null; } },
        setTimeout() { return 0; },
        setInterval(callback, delay) {
            let id = nextTimer++;
            intervals.set(id, { callback, delay });
            return id;
        },
        clearInterval(id) { intervals.delete(id); },
        genericRequest(route, data, success, depth, failure) { requests.push({ route, success, failure }); },
        showError(error) { errors.push(error); },
        mUI: { warn() { } },
        makeWSRequest() { return null; }
    };
    vm.runInNewContext(`${SOURCE.replace('mGen = new MGenSocket();', 'this.MGenSocket = MGenSocket;')}`, context);
    return {
        context,
        socket: new context.MGenSocket(),
        requests,
        errors,
        intervals,
        hide() { context.document.hidden = true; documentListeners.visibilitychange(); },
        wake() { context.document.hidden = false; documentListeners.visibilitychange(); },
        pageShow() { windowListeners.pageshow(); }
    };
}

let hidden = makeTestSocket();
hidden.socket.queueTotal = 1;
hidden.socket.startPollingIfBusy();
check('fallback baseline is 20 polls per minute', hidden.intervals.size == 1 && [...hidden.intervals.values()][0].delay == 3000);
hidden.hide();
check('hidden page stops the 20-polls-per-minute fallback', hidden.intervals.size == 0 && hidden.socket.pollTimer == null);
hidden.socket.startPollingIfBusy();
check('hidden page cannot restart fallback polling', hidden.intervals.size == 0);

let wakeBusy = makeTestSocket();
wakeBusy.socket.queueTotal = 1;
let wakeEvents = 0;
wakeBusy.socket.onFrame(kind => { if (kind == 'wake') { wakeEvents++; } });
wakeBusy.wake();
check('wake makes one immediate reconciliation request', wakeBusy.requests.length == 1 && wakeBusy.requests[0].route == 'GetCurrentStatus' && wakeEvents == 1);
wakeBusy.requests[0].success({ status: { waiting_gens: 1 } });
check('busy wake response restarts one fallback interval', wakeBusy.intervals.size == 1 && wakeBusy.socket.queueTotal == 1);

let wakeIdle = makeTestSocket();
wakeIdle.socket.queueTotal = 1;
wakeIdle.wake();
wakeIdle.requests[0].success({ status: { waiting_gens: 0, live_gens: 0, waiting_backends: 0 } });
check('idle wake response leaves fallback stopped', wakeIdle.intervals.size == 0 && wakeIdle.socket.queueTotal == 0);

let stale = makeTestSocket();
stale.socket.queueTotal = 1;
stale.wake();
stale.hide();
stale.requests[0].success({ status: { waiting_gens: 1 } });
check('a pre-hide response cannot restart a hidden fallback timer', stale.intervals.size == 0 && !stale.socket.pollInFlight);

let inFlightWake = makeTestSocket();
inFlightWake.socket.queueTotal = 1;
let inFlightWakeEvents = 0;
inFlightWake.socket.onFrame(kind => { if (kind == 'wake') { inFlightWakeEvents++; } });
inFlightWake.socket.startPollingIfBusy();
[...inFlightWake.intervals.values()][0].callback();
inFlightWake.hide();
inFlightWake.wake();
check('wake does not duplicate an interval request already in flight', inFlightWake.requests.length == 1 && inFlightWake.intervals.size == 0 && inFlightWakeEvents == 1);
inFlightWake.requests[0].success({ status: { waiting_gens: 1 } });
check('a late busy response restarts fallback after hide and wake', inFlightWake.intervals.size == 1 && !inFlightWake.socket.pollInFlight);

let openSocket = makeTestSocket();
openSocket.socket.queueTotal = 1;
openSocket.socket.socket = { readyState: openSocket.context.WebSocket.OPEN };
openSocket.wake();
openSocket.socket.startPollingIfBusy();
check('an open generation socket suppresses wake polls and fallback interval', openSocket.requests.length == 0 && openSocket.intervals.size == 0);

let openedAfterTimer = makeTestSocket();
openedAfterTimer.socket.queueTotal = 1;
openedAfterTimer.socket.startPollingIfBusy();
openedAfterTimer.socket.socket = { readyState: openedAfterTimer.context.WebSocket.OPEN };
[...openedAfterTimer.intervals.values()][0].callback();
check('an open generation socket stops an existing fallback timer before polling', openedAfterTimer.requests.length == 0 && openedAfterTimer.intervals.size == 0);

let repeatedWake = makeTestSocket();
repeatedWake.socket.queueTotal = 1;
let repeatedWakeEvents = 0;
repeatedWake.socket.onFrame(kind => { if (kind == 'wake') { repeatedWakeEvents++; } });
repeatedWake.wake();
repeatedWake.pageShow();
repeatedWake.wake();
check('visibilitychange and pageshow coalesce a pending wake poll but preserve wake notifications', repeatedWake.requests.length == 1 && repeatedWakeEvents == 3);

let noSession = makeTestSocket();
noSession.context.session_id = null;
noSession.wake();
check('no session sends no wake status request', noSession.requests.length == 0 && !noSession.socket.pollInFlight);

let retry = makeTestSocket();
retry.socket.queueTotal = 1;
retry.wake();
retry.requests[0].failure('temporary network failure');
check('failed poll clears its in-flight guard and preserves the visible error', !retry.socket.pollInFlight && retry.errors.join() == 'temporary network failure');
check('failed wake leaves one busy fallback retry timer', retry.intervals.size == 1);
[...retry.intervals.values()][0].callback();
check('the fallback interval retries after a failed wake poll', retry.requests.length == 2 && retry.socket.pollInFlight);
