/** MobileEnhancements standalone client - generation transport.
 * One long-lived WebSocket to GenerateText2ImageWS, reused across batches (the server keeps listening after a
 * batch; socket_intention 'close' is a 2s grace notice, not a close). The socket is treated as a lossy
 * accelerator, never the source of truth: on socket death with work outstanding we fall back to polling
 * GetCurrentStatus, and on page wake we poll + let the Images tab refresh history to pick up missed finals. */
class MGenSocket {

    constructor() {
        /** The live generate WebSocket, or null. */
        this.socket = null;
        /** Aggregate queue counters from the latest status frame. */
        this.queueTotal = 0;
        /** Interval handle for the no-socket status polling fallback. */
        this.pollTimer = null;
        /** Screen wake lock sentinel while generating, or null. */
        this.wakeLock = null;
        /** Timestamp of the last haptic pulse (debounce). */
        this.lastHaptic = 0;
        /** Listeners: fn(kind, data) with kind in 'status'|'progress'|'image'|'discard'|'error'. */
        this.listeners = [];
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                this.onWake();
            }
        });
        window.addEventListener('pageshow', () => this.onWake());
    }

    /** Registers a frame listener. */
    onFrame(callback) {
        this.listeners.push(callback);
    }

    /** Emits to all listeners. */
    emit(kind, data) {
        for (let callback of this.listeners) {
            callback(kind, data);
        }
    }

    /** Sends one generation batch. Reuses the open socket when possible, else opens a fresh one via
     * makeWSRequest (which injects session_id and handles invalid-session retry on open). */
    generate(input) {
        this.acquireWakeLock();
        if (this.socket && this.socket.readyState == WebSocket.OPEN) {
            let data = Object.assign({}, input);
            data['session_id'] = session_id;
            this.socket.send(JSON.stringify(data));
            return;
        }
        this.socket = makeWSRequest('GenerateText2ImageWS', input, data => this.handleFrame(data), 0, err => this.failed(err));
        // The watcher is bound to the socket it was started for. Without that binding it tested `this.socket`,
        // which any other code path could null (onWake does) - and the null test then failed, so it
        // rescheduled itself forever. Every socket the session ever opened left one of those behind, each
        // waking every 2 seconds for the life of the page.
        let watched = this.socket;
        let closeWatch = () => {
            if (this.socket != watched) {
                return;
            }
            if (!watched || watched.readyState == WebSocket.CLOSED) {
                this.socket = null;
                this.startPollingIfBusy();
                return;
            }
            setTimeout(closeWatch, 2000);
        };
        setTimeout(closeWatch, 2000);
    }

    /** Surfaces a failed generation. This must show the error itself: passing an errorHandle to
     * makeWSRequest REPLACES that helper's default showError path, so anything this swallows is gone.
     * Emitting to listeners is not enough - nothing was subscribed to 'error', which is why a failing
     * generation used to look like the Generate button doing nothing at all. */
    failed(err) {
        console.error('generation failed', err);
        this.releaseWakeLock();
        this.stopPolling();
        this.emit('error', err);
        try {
            showError(`Generation failed: ${err}`);
        }
        catch (e) {
            console.error('could not show generation error', e);
        }
    }

    /** Handles one inbound WS frame (makeWSRequest already routes {error} frames to the error handler). */
    handleFrame(data) {
        if (data.status) {
            this.applyStatus(data);
        }
        if (data.gen_progress) {
            this.emit('progress', data.gen_progress);
        }
        if (data.image) {
            this.haptic();
            this.emit('image', data);
        }
        if (data.discard_indices) {
            this.emit('discard', data.discard_indices);
        }
    }

    /** Applies a status object (from a WS frame or a GetCurrentStatus poll). */
    applyStatus(data) {
        let s = data.status || {};
        this.queueTotal = (s.waiting_gens || 0) + (s.live_gens || 0) + (s.waiting_backends || 0);
        if (this.queueTotal == 0) {
            this.releaseWakeLock();
            this.stopPolling();
        }
        this.emit('status', data);
    }

    /** Interrupts everything this user has queued or running in this session. */
    interrupt() {
        genericRequest('InterruptAll', { 'other_sessions': false }, data => {
            this.pollStatus();
        });
    }

    /** One-shot status poll (used when no socket is open to push status for free). */
    pollStatus() {
        genericRequest('GetCurrentStatus', {}, data => this.applyStatus(data));
    }

    /** Starts the 3s status polling fallback if work may be outstanding. */
    startPollingIfBusy() {
        if (this.queueTotal > 0 && !this.pollTimer) {
            this.pollTimer = setInterval(() => this.pollStatus(), 3000);
        }
    }

    /** Stops the polling fallback. */
    stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /** On page wake: the socket may have died silently (iOS kills sockets on lock/app-switch). Poll once and
     * let listeners (Images tab) refresh history for any finals that arrived while asleep. */
    onWake() {
        if (typeof session_id == 'undefined' || !session_id) {
            return;
        }
        if (!this.socket || this.socket.readyState != WebSocket.OPEN) {
            this.socket = null;
            this.pollStatus();
            this.emit('wake', null);
        }
        if (this.queueTotal > 0) {
            this.acquireWakeLock();
        }
    }

    /** Runs a grid generation over the same WS helper. axes = [{mode, vals}] (vals comma-joined string).
     * The axis with the most values is placed first so the contact sheet is a horizontal rectangle or a
     * square, never vertical (fork owner's rule). Output lands in normal history under the fixed `m-grid`
     * folder (outputFolderName below) - there is no per-run timestamp in the name. */
    runGrid(baseParams, axes) {
        let sorted = [...axes].sort((a, b) => MState.toList(b.vals).length - MState.toList(a.vals).length);
        let input = {
            'baseParams': baseParams,
            'gridAxes': sorted.map(a => ({ 'mode': a.mode, 'vals': a.vals })),
            'outputFolderName': 'm-grid',
            'outputType': 'Grid Image',
            'doOverwrite': false,
            'fastSkip': false,
            'generatePage': false,
            'publishGenMetadata': false,
            'dryRun': false,
            'weightOrder': true,
            'continueOnError': true,
            'showOutputs': true,
        };
        this.acquireWakeLock();
        makeWSRequest('GridGenRun', input, data => this.handleFrame(data), 0, err => this.failed(err));
    }

    /** Debounced haptic pulse on image completion. */
    haptic() {
        let now = Date.now();
        if (navigator.vibrate && now - this.lastHaptic > 500 && localStorage.getItem('m_client_haptics') != 'off') {
            this.lastHaptic = now;
            navigator.vibrate(10);
        }
    }

    /** Acquires (or re-acquires) the screen wake lock while generating. Best-effort. */
    acquireWakeLock() {
        if (!navigator.wakeLock || this.wakeLock) {
            return;
        }
        navigator.wakeLock.request('screen').then(lock => {
            this.wakeLock = lock;
            lock.addEventListener('release', () => {
                this.wakeLock = null;
            });
        }).catch(() => { });
    }

    /** Releases the wake lock when idle. Best-effort, like the acquire: a failed release is not worth a toast
     *  (the lock drops on its own when the page is hidden or unloaded), but it is worth a console line - a
     *  silently swallowed one looks identical to a screen that just will not sleep. */
    releaseWakeLock() {
        if (this.wakeLock) {
            this.wakeLock.release().catch(err => console.log(`wake lock release failed (${err})`));
            this.wakeLock = null;
        }
    }
}

mGen = new MGenSocket();
