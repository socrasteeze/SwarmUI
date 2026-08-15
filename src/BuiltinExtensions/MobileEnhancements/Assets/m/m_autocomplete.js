/** MobileEnhancements standalone client - prompt autocompletion.
 *
 * A DOM-free-ish port of the genpage PromptTabCompleteClass (genpage/gentab/prompttools.js) plus the
 * completion-list parse from genpage/main.js loadUserData. Three things could not come along:
 *  - getUserSetting() reads #usersettings_<id> elements the genpage settings editor builds, and throws
 *    when they are absent, so match/sort mode come from the GetUserSettings API instead (best effort,
 *    server defaults on failure).
 *  - AdvancedPopover is a genpage helper and is not loaded here; a viewport-anchored floating popover is
 *    also the exact thing that had to be patched twice for the mobile keyboard. This renders a
 *    QuickType-style strip in normal flow immediately above whichever box is being typed in.
 *  - Completing individual LINES inside a wildcard file needs the async getWildcardDataFor/<AUTO-RETRY>
 *    dance. Wildcard file NAMES complete; their contents do not.
 * The completion data loads on first prompt focus, keeping a large tag CSV off the startup-critical path. If no
 * source is configured, the payload remains null and the feature stays invisible. */
class MAutoComplete {

    constructor() {
        /** Parsed completion entries, or null when the user has no autocompletion source configured. */
        this.entries = null;
        /** Whether the lazy autocomplete request is in flight or has completed successfully. */
        this.loadStarted = false;
        /** Monotonic request generation used to ignore a response that arrives after the client timeout. */
        this.loadAttempt = 0;
        /** Earliest time another focus may retry after a failed or timed-out load. */
        this.retryAfter = 0;
        /** Match mode: 'Bucketed' | 'Contains' | 'StartsWith'. Server default is Bucketed. */
        this.matchMode = 'Bucketed';
        /** Sort mode: 'Active' | 'Alphabetical' | 'Frequency' | 'None'. Server default is Active. */
        this.sortMode = 'Active';
        /** Registered '<prefix:' completers. */
        this.prefixes = {};
        /** Incremental narrowing cache, as in the genpage. */
        this.lastWord = null;
        this.lastResults = null;
        /** subtype -> {source, names}: memoized model-name lists for the `<prefix:` completers. See modelNames. */
        this.nameCache = {};
        /** box -> its permanent suggestion-strip element (one per enableFor call, never removed - see
         * enableFor for why it has to be permanent rather than inserted/removed per keystroke). */
        this.slots = new Map();
        /** Whether Enter/Tab take the top suggestion for a plain word, not just inside a `<tag:`. Off by
         * default: the matcher returns hits for essentially any English word, so an always-on Enter silently
         * rewrites natural-language prompts. See enterWouldAccept. */
        this.enterAccepts = localStorage.getItem('m_client_enter_accepts') == 'yes';
        this.registerPrefixes();
    }

    /** How many chips the strip will build at once. The strip is a single horizontal scroller, so anything
     * past the first handful is already unreachable in practice; this only exists to stop an uncapped
     * `<prefix:` completer from building thousands of elements per keystroke. */
    static MaxChips = 60;

    /** A stalled enrichment request must not disable autocomplete for the rest of the page lifetime. */
    static LoadTimeoutMs = 15000;

    /** Small retry backoff prevents repeated focus changes from hammering an offline server. */
    static RetryDelayMs = 5000;

    /** Parses the autocompletions payload from GetSimpleAutocompletions. Null/absent leaves the feature off.
     * Only the flat list is built: the genpage's per-first-character buckets exist for an "optimize"
     * mode whose flag is never actually set to true, so they would be pure memory cost here. */
    loadFrom(userData) {
        let raw = userData.autocompletions;
        if (!raw || raw.length == 0) {
            this.entries = null;
            return;
        }
        let list = [];
        for (let val of raw) {
            let split = val.split('\n');
            let entry = { 'name': split[0], 'low': split[1].replaceAll(' ', '_').toLowerCase(), 'clean': split[1], 'raw': true, 'count': 0, 'tag': 0, 'alts': [] };
            if (split.length > 2) {
                entry.tag = split[2];
            }
            if (split.length > 3) {
                let count = parseInt(split[3]) || 0;
                if (count) {
                    entry.count = count;
                    entry.count_display = largeCountStringify(count);
                }
            }
            if (split.length > 4) {
                entry.alts = split[4].split(',').map(x => x.trim().toLowerCase());
            }
            list.push(entry);
        }
        this.entries = list;
    }

    /** Loads the configured word list once, then refreshes the focused box against the now-ready entries. Prefix
     * completers and TagDex remain usable before this lands because they do not depend on this.entries. */
    ensureLoaded(box) {
        if (this.loadStarted || Date.now() < this.retryAfter) {
            return;
        }
        this.loadStarted = true;
        let attempt = ++this.loadAttempt;
        let timer = null;
        let fail = (error) => {
            if (attempt != this.loadAttempt) {
                return;
            }
            this.loadAttempt++;
            if (timer) {
                clearTimeout(timer);
            }
            this.entries = null;
            this.loadStarted = false;
            this.retryAfter = Date.now() + MAutoComplete.RetryDelayMs;
            console.warn('autocomplete load failed', error);
        };
        timer = setTimeout(() => fail('request timed out'), MAutoComplete.LoadTimeoutMs);
        genericRequest('GetSimpleAutocompletions', {}, data => {
            if (attempt != this.loadAttempt) {
                return;
            }
            clearTimeout(timer);
            if (data.warning) {
                mUI.warn(data.warning);
            }
            this.loadFrom(data);
            this.retryAfter = 0;
            let active = document.activeElement;
            if (active && this.slots.has(active)) {
                this.onInput(active);
            }
        }, 0, fail, MAutoComplete.LoadTimeoutMs);
    }

    /** Best-effort read of the user's match/sort preferences. Silent on failure - the server defaults are
     * good, and a missing ReadUserSettings permission is not worth a toast. */
    loadSettings() {
        genericRequest('GetUserSettings', {}, data => {
            let settings = data.settings || {};
            for (let key in settings) {
                let low = key.toLowerCase();
                let value = settings[key] && settings[key].value != null ? settings[key].value : settings[key];
                if (low == 'autocomplete.matchmode' && value) {
                    this.matchMode = `${value}`;
                }
                else if (low == 'autocomplete.sortmode' && value) {
                    this.sortMode = `${value}`;
                }
            }
        }, 0, () => { });
    }

    /** Registers a '<name:' completer. selfStanding tags take no argument (eg '<break>'). */
    registerPrefix(name, description, completer, selfStanding = false) {
        this.prefixes[name] = { 'name': name, 'description': description, 'completer': completer, 'selfStanding': selfStanding, 'isAlt': false };
    }

    /** Registers an alias of an existing prefix. */
    registerAltPrefix(name, copyFrom) {
        let data = this.prefixes[copyFrom];
        this.prefixes[name] = { 'name': name, 'description': data.description, 'completer': data.completer, 'selfStanding': data.selfStanding, 'isAlt': true };
    }

    /** The prompt-syntax tag set, ported from the genpage. Completers that needed genpage-only globals are
     * rewired onto mState (models/presets/wildcards/param metadata all arrive from ListT2IParams). */
    registerPrefixes() {
        this.registerPrefix('random', 'Select from a set of random words to include', (prefix) => {
            return ['\nComma-separated list to choose from, like "<random:cat,dog,elephant>".', '\nUse "||" instead of "," if your values contain commas. "1-5" picks a number in a range.'];
        });
        this.registerPrefix('random[2-4]', 'Selects multiple options from a set of random words', (prefix) => {
            return ['\nLike "<random[2]:cat,dog,elephant>" to pick two.'];
        });
        this.registerPrefix('alternate', 'Alternate between multiple words or phrases', (prefix) => {
            return ['\nComma-separated list, like "<alternate:cat,dog>".'];
        });
        this.registerPrefix('fromto[0.5]', 'Have the prompt change after a given timestep', (prefix) => {
            return ['\nBrackets take a timestep (10 for step 10, 0.5 for halfway).', '\n"<fromto[10]:cat,dog>" switches from "cat" to "dog" at step 10.'];
        });
        this.registerPrefix('wildcard', 'Select a random line from a wildcard file', (prefix) => {
            // Genpage also completes lines WITHIN a file; that needs an async fetch plus its <AUTO-RETRY>
            // protocol, which is deliberately not ported. File names complete, contents do not.
            return this.getOrderedMatches(mState.wildcards || [], prefix.toLowerCase());
        });
        this.registerAltPrefix('wc', 'wildcard');
        this.registerPrefix('wildcard[2-4]', 'Select multiple random lines from a wildcard file', (prefix) => {
            return this.getOrderedMatches(mState.wildcards || [], prefix.toLowerCase());
        });
        this.registerPrefix('repeat[3]', 'Repeat a value several times', (prefix) => {
            return ['\n"<repeat[3]:very> big" gives "very very very big".'];
        });
        this.registerPrefix('preset', 'Forcibly apply a preset onto the current generation', (prefix) => {
            return this.getOrderedMatches(mState.presets.map(p => p.title), prefix.toLowerCase());
        });
        this.registerAltPrefix('p', 'preset');
        this.registerPrefix('param', 'Read a raw parameter value', (prefix) => {
            return ['\nFor example "<param:cfgscale>" reads the value of CFG Scale.'];
        });
        this.registerPrefix('param[param_id]', 'Set a raw parameter value directly', (prefix) => {
            return ['\nFor example "<param[cfgscale]:1>" sets CFG Scale to 1.'];
        });
        this.registerPrefix('embed', 'Use a pretrained CLIP TI Embedding', (prefix) => {
            return this.matchModelNames('Embedding', prefix.toLowerCase());
        });
        this.registerAltPrefix('embedding', 'embed');
        this.registerPrefix('lora', 'Forcibly apply a pretrained LoRA model', (prefix) => {
            return this.matchModelNames('LoRA', prefix.toLowerCase());
        });
        this.registerPrefix('region', 'Apply a different prompt to a sub-region within the image', (prefix) => {
            return ['\nx,y,width,height eg "0.25,0.25,0.5,0.5"', '\nor x,y,width,height,strength. "region:background" for background only.'];
        });
        this.registerPrefix('object', 'Select a sub-region and inpaint over it with a different prompt', (prefix) => {
            return ['\nx,y,width,height eg "0.25,0.25,0.5,0.5"', '\nor x,y,width,height,strength,strength2.'];
        });
        this.registerPrefix('extend', 'Use an Image2Video model to extend a video repeatedly', (prefix) => {
            return ['\nInput is a frame count, then a prompt, eg "<extend:81> the cat runs".'];
        });
        this.registerPrefix('segment', 'Automatically segment an area by CLIP matcher and inpaint it', (prefix) => {
            let prefixLow = prefix.toLowerCase();
            if (prefixLow.startsWith('yolo-')) {
                let meta = mState.paramMeta['yolomodelinternal'];
                if (meta && meta.values) {
                    return this.getOrderedMatches(meta.values.map(m => `yolo-${m}`), prefixLow);
                }
            }
            return ['\nText to match in the image, like "<segment:face>".', '\nOr "<segment:text,creativity,threshold>" eg "face,0.6,0.5".', '\nUse the "yolo-" prefix to use a YOLOv8 seg model.'];
        });
        this.registerPrefix('setvar[var_name]', 'Store text for reference later in the prompt', (prefix) => {
            return ['\nSave into a named variable, eg "<setvar[colors]: red and blue>", then use "<var:colors>".'];
        });
        this.registerPrefix('var', 'Reference a previously saved variable', (prefix, prompt) => {
            return this.scanNames(prompt, /<setvar\[(.*?)\]:/g, '<setvar[', prefix.toLowerCase(), true)
                || ['\nRecall a value saved with <setvar[name]:...>, used like "<var:name>".'];
        });
        this.registerPrefix('setmacro[macro_name]', 'Store raw text for reference later in the prompt', (prefix) => {
            return ['\nSave raw content, eg "<setmacro[color]:<random:red|blue>>", then use "<macro:color>".'];
        });
        this.registerPrefix('macro', 'Reference a previously saved macro', (prefix, prompt) => {
            return this.scanNames(prompt, /<setmacro\[(.*?)\]:/g, '<setmacro[', prefix.toLowerCase(), false)
                || ['\nRecall a macro saved with <setmacro[name]:...>, used like "<macro:name>".'];
        });
        this.registerPrefix('clear', 'Automatically clear part of the image to transparent', (prefix) => {
            return ['\nText to match in the image, like "<clear:background>".'];
        });
        for (let [name, desc] of [['break', 'Split this prompt across multiple lines of conditioning'], ['base', 'Prompt text used only for the Base pass'], ['refiner', 'Prompt text used only for the Refine/Upscale pass'], ['pixeldecoder', 'Prompt text used only for the PiD pixel-decoder upscale pass'], ['video', 'Prompt text that replaces the prompt for the image-to-video pass'], ['videoswap', 'Prompt text for the image-to-video Swap pass'], ['trigger', "Fills with the current model or LoRA's trigger phrase(s)"]]) {
            this.registerPrefix(name, desc, (prefix) => [], true);
        }
        this.registerPrefix('comment', 'Add a discarded personal comment', (prefix) => {
            return ['\nA personal comment - not treated as part of the real prompt.'];
        });
    }

    /** Model names for a subtype, from the ListT2IParams models map ([[name, classId], ...]).
     * Memoized: this is called on every keystroke inside a `<lora:` tag, and rebuilding an 18.5k-entry array
     * per keypress was pure garbage. Keyed on the source array's identity rather than a manual invalidation
     * call, so a models reload (which replaces the array) is picked up automatically and a stale cache is not
     * representable - there is no "forgot to invalidate" failure mode to get wrong later. */
    modelNames(subtype) {
        let source = mState.models[subtype] || [];
        let cached = this.nameCache[subtype];
        if (cached && cached.source === source) {
            return cached.names;
        }
        let names = source.map(entry => entry[0]);
        let low = names.map(n => n.toLowerCase());
        this.nameCache[subtype] = { 'source': source, 'names': names, 'low': low };
        return names;
    }

    /** Ordered model-name matches for a `<prefix:` completer: prefix matches first, then contains-matches,
     * same ordering getOrderedMatches produces.
     *
     * Exists because getOrderedMatches is a three-pass filter that lowercases every candidate on every pass,
     * and these two completers are the only callers handed a list the size of a model library. On the fork
     * owner's 18.9k LoRAs that was ~57k throwaway lowercase strings PER KEYSTROKE on the phone's main thread.
     * Here the lowercase forms are computed once per library load (see modelNames) and this is a single pass
     * with no intermediate arrays.
     *
     * Deliberately still scans the whole list rather than stopping at the cap: a prefix match found near the
     * end outranks a contains-match found near the start, so early exit would silently change WHICH results
     * appear, not just how fast they arrive. The cap belongs at the display layer, and is applied there. */
    matchModelNames(subtype, prefixLow) {
        let names = this.modelNames(subtype);
        let low = this.nameCache[subtype].low;
        let prefixed = [];
        let contained = [];
        for (let i = 0; i < names.length; i++) {
            let index = low[i].indexOf(prefixLow);
            if (index == 0) {
                prefixed.push(names[i]);
            }
            else if (index > 0) {
                contained.push(names[i]);
            }
        }
        return prefixed.concat(contained);
    }

    /** Finds previously-declared setvar/setmacro names in the prompt. Returns null when there are none. */
    scanNames(prompt, pattern, openTag, prefixLow, allowComma) {
        let possible = [];
        let matches = prompt.match(pattern);
        if (matches) {
            for (let match of matches) {
                let name = match.substring(openTag.length, match.length - ']:'.length);
                if (allowComma && name.includes(',')) {
                    name = name.substring(0, name.indexOf(','));
                }
                if (name.toLowerCase().includes(prefixLow)) {
                    possible.push(name);
                }
            }
        }
        return possible.length == 0 ? null : possible;
    }

    /** Matches-containing first, prefix matches before the rest. Ported verbatim. */
    getOrderedMatches(set, prefixLow) {
        function getNameLow(item) {
            if (typeof item == 'object') {
                return item.name.toLowerCase();
            }
            return item.toLowerCase();
        }
        let matched = set.filter(m => getNameLow(m).includes(prefixLow));
        let prefixed = matched.filter(m => getNameLow(m).startsWith(prefixLow));
        let suffixed = matched.filter(m => !getNameLow(m).startsWith(prefixLow));
        return prefixed.concat(suffixed);
    }

    /** Index just past the last word separator, ported verbatim. */
    findLastWordIndex(text) {
        let index = -1;
        for (let cut of [' ', ',', '.', '\n']) {
            let i = text.lastIndexOf(cut);
            if (i > index) {
                index = i;
            }
        }
        return index + 1;
    }

    /** The candidate list for the current caret position. Ported from PromptTabCompleteClass. */
    getPossibleList(box) {
        let prompt = getTextContent(box).substring(0, getTextSelRange(box)[0]);
        let word = prompt.substring(this.findLastWordIndex(prompt));
        let baseList = [];
        if (word.length > 1 && this.entries) {
            let completionSet = (this.lastWord && word.startsWith(this.lastWord)) ? this.lastResults : this.entries;
            let wordLow = word.toLowerCase();
            let rawMatchSet = [];
            if (completionSet) {
                let startWithList = [];
                let startWithAltList = [];
                let containList = [];
                for (let i = 0; i < completionSet.length; i++) {
                    let entry = completionSet[i];
                    if (entry.low.includes(wordLow) || entry.alts.some(alt => alt.includes(wordLow))) {
                        if (entry.low.startsWith(wordLow)) {
                            startWithList.push(entry);
                        }
                        else if (entry.alts.some(alt => alt.startsWith(wordLow))) {
                            startWithAltList.push(entry);
                        }
                        else {
                            containList.push(entry);
                        }
                        rawMatchSet.push(entry);
                    }
                }
                let doSortList = (list) => {
                    if (this.sortMode == 'Active') {
                        list.sort((a, b) => a.low.length - b.low.length || a.low.localeCompare(b.low));
                    }
                    else if (this.sortMode == 'Alphabetical') {
                        list.sort((a, b) => a.low.localeCompare(b.low));
                    }
                    else if (this.sortMode == 'Frequency') {
                        list.sort((a, b) => b.count - a.count);
                    }
                };
                if (this.matchMode == 'Contains') {
                    doSortList(rawMatchSet);
                    baseList = rawMatchSet;
                }
                else if (this.matchMode == 'StartsWith') {
                    doSortList(startWithList);
                    doSortList(startWithAltList);
                    baseList = startWithList.concat(startWithAltList);
                }
                else {
                    doSortList(startWithList);
                    doSortList(startWithAltList);
                    doSortList(containList);
                    baseList = startWithList.concat(startWithAltList).concat(containList);
                }
                if (baseList.length > 50) {
                    baseList = baseList.slice(0, 50);
                }
            }
            this.lastWord = word;
            this.lastResults = rawMatchSet;
        }
        let lastBrace = prompt.lastIndexOf('<');
        if (lastBrace == -1) {
            return baseList;
        }
        let lastClose = prompt.lastIndexOf('>');
        if (lastClose > lastBrace) {
            return baseList;
        }
        let content = prompt.substring(lastBrace + 1);
        let colon = content.indexOf(':');
        if (colon == -1) {
            content = content.toLowerCase();
            return Object.keys(this.prefixes).filter(p => p.toLowerCase().startsWith(content) && !this.prefixes[p].isAlt).map(p => [p, this.prefixes[p].description]);
        }
        let prefix = content.substring(0, colon);
        let suffix = content.substring(colon + 1);
        if (!(prefix in this.prefixes)) {
            return [];
        }
        // Bound the list BEFORE the map. Chip building already caps at MaxChips, but that only stopped the DOM
        // blowing up - every entry past the cap was still being formatted into a throwaway template string on
        // every keystroke. On the fork owner's library a bare `<lora:` matches all ~18.5k LoRAs, so this map
        // was allocating ~18.5k strings per keypress on the phone's main thread purely to discard all but 60.
        // MaxChips is the honest bound: nothing beyond it can ever be displayed. The completer's own ordering
        // (prefix matches first, then contains-matches) runs before this, so slicing keeps the BEST matches
        // rather than an arbitrary set - which is why this caps here and not inside the completers.
        let completions = this.prefixes[prefix].completer(suffix, prompt);
        if (completions.length > MAutoComplete.MaxChips) {
            completions = completions.slice(0, MAutoComplete.MaxChips);
        }
        return completions.map(p => {
            if (typeof p == 'object' || p.startsWith('\n')) {
                return p;
            }
            if (p.startsWith('\t')) {
                return p.substring(1);
            }
            return `<${prefix}:${p}>`;
        });
    }

    /** Attaches the completer to a textarea. paramId names the mState param the box writes to. Creates one
     * permanent strip element positioned right ABOVE the box, immediately - not lazily on first match - so
     * it always occupies its reserved height (m.css floors .m-ac-slot's min-height). Suggestions appearing
     * and disappearing as you type used to insert/remove the whole element, which shifted every control
     * below it (quick params, the LoRA row) on every keystroke; now only the strip's CONTENTS change.
     *
     * It sits above the box - which on the Create panel means directly under the Generate row - and stays in
     * normal flow. An earlier version pinned it to the top of the on-screen keyboard so chips were within
     * thumb reach. That is now the wrong trade twice over: iOS draws its own form-accessory bar (the up/down
     * arrows and Done) in exactly that band and renders it over web content, so the chips ended up behind it;
     * and with Enter/Tab accepting the highlighted suggestion, reaching a chip with a thumb is no longer the
     * primary path anyway. Reading the strip matters, touching it does not.
     *
     * The strip still lives inside a wrapper. The wrapper is what owns the reserved 44px, which keeps the
     * reservation in one place rather than split between the strip's own min-height and its margin. */
    enableFor(box, paramId) {
        box.dataset.mParam = paramId;
        let slot = mUI.el('div', 'm-ac-slot');
        let strip = mUI.el('div', 'm-ac-strip');
        slot.appendChild(strip);
        box.parentElement.insertBefore(slot, box);
        this.slots.set(box, strip);
        box.addEventListener('focus', () => this.ensureLoaded(box));
        box.addEventListener('input', () => this.onInput(box));
        box.addEventListener('keydown', (e) => this.onKeyDown(box, e));
        box.addEventListener('blur', () => setTimeout(() => {
            if (document.activeElement != box) {
                this.clearSlot(box);
            }
        }, 200));
    }

    /** Whether Enter/Tab should take the top suggestion right now, rather than doing their normal job.
     *
     * "Are chips showing" is NOT a usable test, and assuming it was is what broke natural-language prompts:
     * the matcher's default mode matches any entry CONTAINING the typed word, so every ordinary English word
     * returns a full 50 suggestions. Typing 'Remove the right subject' and pressing return therefore rewrote
     * the last word into a booru tag ('...right to left', '...background sex'), silently destroying an edit
     * instruction. The genpage popover has the same hazard - it auto-selects its first row and Enter takes it
     * - so it is not a safe model to copy here.
     *
     * Two situations are safe:
     *  - Inside an unclosed `<` tag (`<wildcard:R`, `<lora:`, `<character:mik`). The user is unambiguously
     *    completing a tag, and prose cannot wander in there by accident.
     *  - When the user has explicitly opted in (More > Enter accepts suggestion), for tag-list prompting
     *    where every word is meant to become a booru tag.
     * Everything else leaves Enter alone, because a newline in a prompt box is a legitimate thing to want and
     * a corrupted prompt is far worse than a missing shortcut. */
    enterWouldAccept(box) {
        if (this.enterAccepts) {
            return true;
        }
        // Mirrors the tag detection in getPossibleList: an unclosed '<' before the caret.
        let prompt = getTextContent(box).substring(0, getTextSelRange(box)[0]);
        let lastBrace = prompt.lastIndexOf('<');
        return lastBrace != -1 && prompt.lastIndexOf('>') < lastBrace;
    }

    /** Keyboard control of the suggestion strip: Enter or Tab takes the highlighted suggestion, Escape
     * dismisses. Enter/Tab are intercepted only when chips are on screen AND enterWouldAccept says the
     * context is unambiguous - see there for why the second half is not optional.
     *
     * Accepting routes through the chip's own click handler rather than reimplementing the splice. The chip
     * already knows its splice anchor, and the configured suffix (', ') is baked into the entry server-side by
     * AutoCompleteListHelper.GetData - so a second code path here would be a second place for both to drift.
     *
     * Arrow keys are deliberately NOT bound. The strip is horizontal, so Left/Right would be the natural
     * mapping, and those move the caret in a textarea - breaking caret movement to gain chip selection is a
     * bad trade on a client whose primary input is a thumb. */
    onKeyDown(box, e) {
        let strip = this.slots.get(box);
        if (!strip) {
            return;
        }
        // Help entries (the '\n'-prefixed hints) are spans, not buttons, and have nothing to apply.
        let chips = strip.querySelectorAll('.m-ac-chip:not(.m-ac-help)');
        if (chips.length == 0) {
            return;
        }
        if (e.key == 'Escape') {
            e.preventDefault();
            this.clearSlot(box);
            return;
        }
        if ((e.key == 'Enter' || e.key == 'Tab') && this.enterWouldAccept(box)) {
            e.preventDefault();
            let selected = strip.querySelector('.m-ac-chip.m-ac-sel') || chips[0];
            selected.click();
        }
    }

    /** Turns Enter-accepts-anywhere on or off, and remembers it. */
    setEnterAccepts(on) {
        this.enterAccepts = on;
        localStorage.setItem('m_client_enter_accepts', on ? 'yes' : 'no');
    }

    /** Empties one box's strip (contents only - the reserved space stays). */
    clearSlot(box) {
        let strip = this.slots.get(box);
        if (strip) {
            strip.innerHTML = '';
        }
    }

    /** Empties every box's strip. Used when a prompt is cleared/replaced out from under the boxes (Reset
     * Params, Reuse Params) without the box itself ever firing an 'input' event. */
    hide() {
        for (let strip of this.slots.values()) {
            strip.innerHTML = '';
        }
    }

    /** Rebuilds the given box's suggestion strip in place. */
    onInput(box) {
        let strip = this.slots.get(box);
        if (!strip) {
            return;
        }
        let possible = [];
        try {
            possible = this.getPossibleList(box);
        }
        catch (e) {
            console.error('autocomplete failed', e);
            strip.innerHTML = '';
            return;
        }
        strip.innerHTML = '';
        if (possible.length == 0) {
            return;
        }
        let prompt = getTextContent(box).substring(0, getTextSelRange(box)[0]);
        let lastBrace = prompt.lastIndexOf('<');
        let wordIndex = this.findLastWordIndex(prompt);
        // getPossibleList caps its own word-match list at 50, but the `<prefix:` completers do not cap at all:
        // typing a bare `<lora:` on this install returned 18,561 entries, and building that many chip elements
        // on every keystroke will lock up a phone. Only a handful are ever reachable in a horizontal strip.
        let shown = Math.min(possible.length, MAutoComplete.MaxChips);
        for (let i = 0; i < shown; i++) {
            strip.appendChild(this.buildChip(box, possible[i], prompt, lastBrace, wordIndex));
        }
        // Mark what Enter would take - but ONLY when Enter would in fact take it. The highlight is the only
        // signal the user has about whether return is about to edit their prompt or insert a newline, so
        // showing it when Enter is inert would be worse than showing nothing. Deliberately subtle: it means
        // "return will apply this", not "already applied", and those must not look alike.
        let first = strip.querySelector('.m-ac-chip:not(.m-ac-help)');
        if (first && this.enterWouldAccept(box)) {
            first.classList.add('m-ac-sel');
        }
        strip.scrollLeft = 0;
    }

    /** One suggestion chip. Mirrors the genpage's button-building branches. */
    buildChip(box, val, prompt, lastBrace, wordIndex) {
        let label = val;
        let apply = val;
        let index = lastBrace;
        let clickable = true;
        let className = 'm-ac-chip';
        let hint = '';
        if (typeof val == 'object' && !Array.isArray(val)) {
            label = val.clean || val.name || '';
            apply = val.name;
            if ('tag' in val) {
                className = `m-ac-chip tag-text tag-type-${val.tag}`;
                index = wordIndex;
            }
            if (val.count_display) {
                hint = val.count_display;
            }
        }
        else if (Array.isArray(val)) {
            label = val[0];
            hint = val[1];
            apply = this.prefixes[val[0]].selfStanding ? `<${val[0]}>` : `<${val[0]}:`;
        }
        else if (val.startsWith('\n')) {
            clickable = false;
            label = val.substring(1);
            className = 'm-ac-chip m-ac-help';
        }
        let chip = mUI.el(clickable ? 'button' : 'span', className);
        chip.appendChild(mUI.el('span', 'm-ac-chip-label', label));
        if (hint) {
            chip.appendChild(mUI.el('span', 'm-ac-chip-hint', hint));
        }
        if (!clickable) {
            return chip;
        }
        // Keep the caret (and therefore the keyboard) where it is. Without this the tap moves focus to the
        // chip, which on iOS dismisses the keyboard - and the keyboard going down is what un-pins the strip,
        // so the chip would be sliding away underneath the finger at the moment it is being pressed.
        chip.addEventListener('mousedown', (e) => e.preventDefault());
        chip.addEventListener('click', () => {
            let areaPre = prompt.substring(0, index);
            let areaPost = getTextContent(box).substring(getTextSelRange(box)[0]);
            setTextContent(box, areaPre + apply + areaPost);
            setTextSelRange(box, areaPre.length + apply.length, areaPre.length + apply.length);
            mState.params[box.dataset.mParam] = getTextContent(box);
            mState.save();
            box.focus();
            box.dispatchEvent(new Event('input'));
        });
        return chip;
    }
}

mAutoComplete = new MAutoComplete();
