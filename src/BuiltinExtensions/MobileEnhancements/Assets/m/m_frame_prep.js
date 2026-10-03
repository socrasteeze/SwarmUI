/** MobileEnhancements /simple - FL2VA same-frame + init scale helpers.
 *
 * Makes the 360-orbit / same-frame FL2VA workflow feel nearly native on /simple:
 *   1. Detect same-frame presets (known titles + FL2VA+orbit/360/same-frame title match +
 *      optional localStorage extras) and default a "Same as start" toggle ON for them so
 *      End mirrors Start whenever Start is set or changes.
 *   2. Before submit (and on attach when the preset qualifies), scale Start (and
 *      End when mirrored) so the shortest side is 768 and both dims are multiples of 32 -
 *      preserving aspect ratio, then rounding each dimension to the nearest multiple of 32.
 *
 * Client-side canvas resize is intentional: Swarm has no Init-image preprocess hook that
 * matches this node, and /simple already owns the frame slots. Browser canvas does not expose
 * true LANCZOS; imageSmoothingQuality='high' is the closest practical equivalent. A server-side
 * hook (or calling the LayerStyle node in the workflow) would be more accurate if one is added
 * later - this helper is deliberately isolated so that swap is a one-call change.
 *
 * The existing server image browser for the frame + buttons is unchanged. */
class MFramePrep {

    /** Shortest-side target matching the LayerUtility defaults Adam's FL2VA prep uses. */
    static Shortest = 768;

    /** Round-up multiple matching LayerUtility round_to_multiple=32. */
    static Multiple = 32;

    /** Hardcoded same-frame preset titles (folder/name form as Swarm stores them). */
    static KnownSameFrameTitles = [
        'minimax/FL2VA_360_Orbit_Eros'
    ];

    /** Marks an entry already prepared so prepareFramesForGenerate does not re-encode it. */
    static PrepTag = 'fl2va768v2';

    /** localStorage key: comma-separated extra titles treated as same-frame. */
    static ExtraTitlesKey = 'm_client_same_frame_presets';

    /** localStorage key: '0' forces Same-as-start off even on matching presets; '1' forces on;
     * absent means use the preset default (ON for same-frame, OFF otherwise). */
    static SameAsStartKey = 'm_client_same_as_start';

    /** True when the active Create preset is a same-frame / 360-orbit FL2VA style preset. */
    isSameFramePreset() {
        let title = (mState.activePresets && mState.activePresets[0]) || '';
        if (!title) {
            return false;
        }
        if (MFramePrep.KnownSameFrameTitles.includes(title)) {
            return true;
        }
        let lower = title.toLowerCase();
        if (lower.includes('fl2va') && (lower.includes('orbit') || lower.includes('360') || lower.includes('same') || lower.includes('sameframe') || lower.includes('same-frame'))) {
            return true;
        }
        // Optional extras: localStorage m_client_same_frame_presets = "folder/Title,other/Title"
        try {
            let raw = localStorage.getItem(MFramePrep.ExtraTitlesKey) || '';
            let extras = raw.split(',').map(s => s.trim()).filter(Boolean);
            if (extras.includes(title)) {
                return true;
            }
        }
        catch (e) { /* private mode */ }
        // Prefer metadata when present: description/param hint mentioning same-frame / orbit intent.
        let preset = (mState.presets || []).find(p => p.title == title);
        if (preset) {
            let blob = `${preset.description || ''} ${JSON.stringify(preset.param_map || {})}`.toLowerCase();
            if (blob.includes('same-frame') || blob.includes('sameframe') || blob.includes('same as start')
                || (blob.includes('fl2va') && (blob.includes('orbit') || blob.includes('360')))) {
                return true;
            }
        }
        return false;
    }

    /** Effective Same-as-start: user override in localStorage wins; else default ON for same-frame presets. */
    sameAsStartEnabled() {
        try {
            let raw = localStorage.getItem(MFramePrep.SameAsStartKey);
            if (raw == '0') {
                return false;
            }
            if (raw == '1') {
                return true;
            }
        }
        catch (e) { /* private mode */ }
        return this.isSameFramePreset();
    }

    /** Persists an explicit user override for the Same-as-start toggle. */
    setSameAsStart(on) {
        try {
            localStorage.setItem(MFramePrep.SameAsStartKey, on ? '1' : '0');
        }
        catch (e) { /* private mode */ }
    }

    /** Clears the user override so the preset default applies again (used when leaving a same-frame preset). */
    clearSameAsStartOverride() {
        try {
            localStorage.removeItem(MFramePrep.SameAsStartKey);
        }
        catch (e) { /* private mode */ }
    }

    /** Round a positive length to the nearest multiple; never pad the canvas. */
    static roundNearest(n, multiple) {
        return Math.max(multiple, Math.round(n / multiple) * multiple);
    }

    /** Target width/height after scaling the shortest side to 768 and rounding to *32. */
    static targetDims(srcW, srcH, shortest, multiple) {
        shortest = shortest || MFramePrep.Shortest;
        multiple = multiple || MFramePrep.Multiple;
        let ratio = srcW / srcH;
        let tw, th;
        if (ratio > 1) {
            th = shortest;
            tw = th * ratio;
        }
        else {
            tw = shortest;
            th = tw / ratio;
        }
        return [MFramePrep.roundNearest(tw, multiple), MFramePrep.roundNearest(th, multiple)];
    }

    /** Scale the source directly to the target dimensions; no padding is added. */
    static scaleToCanvas(img, targetW, targetH) {
        let canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        let ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, targetW, targetH);
        return canvas;
    }

    /** Loads an entry ({kind,value}) into an HTMLImageElement. */
    loadEntryImage(entry) {
        return new Promise((resolve, reject) => {
            if (!entry) {
                reject(new Error('no entry'));
                return;
            }
            let img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('image load failed'));
            if (entry.kind == 'data') {
                img.src = entry.value;
            }
            else {
                // Path entries are output-root-relative; same URL the frame thumbnails already use.
                let path = (typeof mImages != 'undefined' && mImages.urlToPath) ? (mImages.urlToPath(entry.value) || entry.value) : entry.value;
                img.crossOrigin = 'anonymous';
                img.src = `${getImageOutPrefix()}/${path}`;
            }
        });
    }

    /** Returns a scaled data-URI entry, or the original when it already matches PrepTag / is already sized. */
    async scaleEntry(entry) {
        if (!entry) {
            return null;
        }
        if (entry.prep == MFramePrep.PrepTag) {
            return entry;
        }
        let img = await this.loadEntryImage(entry);
        let srcW = img.naturalWidth;
        let srcH = img.naturalHeight;
        if (!srcW || !srcH) {
            return entry;
        }
        let [tw, th] = MFramePrep.targetDims(srcW, srcH);
        // Already exact - keep the original path entry so localStorage persistence still works.
        if (srcW == tw && srcH == th && entry.kind == 'path') {
            return Object.assign({}, entry, { 'prep': MFramePrep.PrepTag, 'width': tw, 'height': th });
        }
        if (srcW == tw && srcH == th && entry.kind == 'data' && entry.prep == MFramePrep.PrepTag) {
            return entry;
        }
        let canvas = MFramePrep.scaleToCanvas(img, tw, th);
        // JPEG keeps payload small for phone uploads; FL2VA frames are photographs.
        return {
            'kind': 'data',
            'value': canvas.toDataURL('image/jpeg', 0.95),
            'prep': MFramePrep.PrepTag,
            'width': tw,
            'height': th
        };
    }

    /** Shallow-copy an image entry (so Start and End do not share a mutable object). */
    cloneEntry(entry) {
        if (!entry) {
            return null;
        }
        return Object.assign({}, entry);
    }

    /** Copies Start into End when Same-as-start is on. No-op otherwise. */
    mirrorStartToEnd() {
        if (!this.sameAsStartEnabled()) {
            return false;
        }
        if (!mState.initImage) {
            if (mState.videoEndImage) {
                mState.videoEndImage = null;
                return true;
            }
            return false;
        }
        let next = this.cloneEntry(mState.initImage);
        let prev = mState.videoEndImage;
        if (prev && prev.kind == next.kind && prev.value == next.value && prev.prep == next.prep) {
            return false;
        }
        mState.videoEndImage = next;
        return true;
    }

    /** MiniMax H3 hybrid and/or FL2VA. Other arches (Krea, Qwen, ...) stay on the 1024 floor.
     * Hybrid is not enough on its own: the name or preset must also be MiniMax/H3, or say FL2VA. */
    static isLowResAspectContext() {
        if (typeof mState == 'undefined' || !mState) {
            return false;
        }
        let parts = [];
        let push = (v) => {
            if (v != null && String(v) != '') {
                parts.push(String(v));
            }
        };
        push(mState.params && mState.params['videomodel']);
        push(mState.params && mState.params['model']);
        for (let title of (mState.activePresets || [])) {
            push(title);
            let preset = (mState.presets || []).find(p => p.title == title);
            if (!preset) {
                continue;
            }
            push(preset.description);
            let map = preset.param_map || {};
            push(map['videomodel']);
            push(map['model']);
        }
        let blob = parts.join('\n').toLowerCase();
        let fl2va = blob.includes('fl2va');
        let hybridH3 = blob.includes('hybrid') && (blob.includes('minimax') || blob.includes('h3'));
        return fl2va || hybridH3;
    }

    /** Side length for a closest-aspect pick. Short side is the image's own short side, but never
     * below 768, and the side length is aligned up to *32 so rounding cannot slip back under that floor.
     * aspectRefs are the 512-base pairs; extraAspects are numeric width/height ratios. */
    static sideLengthForClosest(aspect, imageW, imageH, aspectRefs, extraAspects) {
        let short = Math.min(imageW || 0, imageH || 0);
        if (!(short > 0)) {
            short = MFramePrep.Shortest;
        }
        short = Math.max(MFramePrep.Shortest, MFramePrep.roundNearest(short, MFramePrep.Multiple));
        let ref = aspectRefs && aspectRefs[aspect];
        let side;
        if (ref) {
            let refShort = Math.min(ref[0], ref[1]);
            side = refShort > 0 ? short * 512 / refShort : MFramePrep.Shortest;
        }
        else {
            let ratio = extraAspects && extraAspects[aspect];
            if (!(ratio > 0)) {
                return MFramePrep.Shortest;
            }
            side = short * Math.sqrt(Math.max(ratio, 1 / ratio));
        }
        let aligned = Math.ceil((side / MFramePrep.Multiple) - 1e-6) * MFramePrep.Multiple;
        return Math.max(MFramePrep.Shortest, aligned);
    }

    /** Scales Start (and End when Same-as-start / End is filled) for qualifying presets.
     * Mutates mState; caller should mState.changed() / rebuild input afterward. */
    async prepareFramesForGenerate() {
        if (!this.isSameFramePreset()) {
            return;
        }
        if (mState.initImage) {
            mState.initImage = await this.scaleEntry(mState.initImage);
        }
        if (this.sameAsStartEnabled()) {
            this.mirrorStartToEnd();
        }
        else if (mState.videoEndImage) {
            mState.videoEndImage = await this.scaleEntry(mState.videoEndImage);
        }
    }
}

/** Shared FL2VA frame-prep helper for /simple. */
mFramePrep = new MFramePrep();
