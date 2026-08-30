/** TagDex - shared index, matcher, and entry builder.
 *
 * Surface-agnostic on purpose: the genpage prompt hook (tagdex_prompt.js), the Characters browse tab
 * (tagdex_tab.js), and the /simple client all drive this one singleton.
 *
 * The index is held as a flat string plus typed-array offsets rather than an array of objects. At ~30k entries
 * across two datasets, the object form would mean ~120k live strings resident on a phone, and matching would be
 * 30k JS-level String.includes() calls per keystroke. Here a keystroke is one native indexOf() sweep over a single
 * ~1 MB string, and display objects are materialized only for the handful of rows actually shown.
 *
 * Coupling: the entry objects returned by entryAt() must satisfy the contract in
 * genpage/gentab/prompttools.js onInput() (~lines 356-408). In particular the presence of a 'tag' key is what makes
 * that code splice at the start of the current word instead of at the last '<'. Re-check after upstream merges.
 */
class TagDexCoreClass {

    constructor() {
        /** 'unloaded' | 'loading' | 'ready' | 'empty' | 'failed'. Everything degrades to inert when not 'ready'. */
        this.status = 'unloaded';
        /** Loaded shards, one per active dataset. */
        this.shards = [];
        /** Server-reported dataset list, or null before the first load. */
        this.sources = null;
        /** The user's TagDex preferences, with the same defaults the server uses. */
        this.prefs = { active_sources: ['danbooru_character'], display_min_count: 20, lean_min_count: 100, typeahead_enabled: true, quota_with_list: 8, quota_alone: 25 };
        /** Incremental narrowing cache, mirroring the trick upstream uses in prompttools.js getPossibleList. */
        this.lastWord = null;
        this.lastHits = null;
        /** Ceiling on hits collected in one sweep. Meaningful rather than arbitrary: the blob is sorted by post
         * count descending, so stopping early yields the most popular matches, not a random subset. */
        this.scanCap = 400;
        /** Callbacks waiting on the in-flight load. */
        this.pending = [];
    }

    /** Kicks off the index load if it has not started. Safe to call repeatedly and from anywhere. */
    ensureLoaded(callback = null) {
        if (callback) {
            if (this.status == 'ready' || this.status == 'empty' || this.status == 'failed') {
                callback();
                return;
            }
            this.pending.push(callback);
        }
        if (this.status != 'unloaded') {
            return;
        }
        this.status = 'loading';
        genericRequest('TagDexListSources', {}, data => {
            this.sources = data.sources;
            if (data.prefs) {
                this.prefs = Object.assign(this.prefs, data.prefs);
            }
            let wanted = [];
            for (let i = 0; i < this.sources.length; i++) {
                let source = this.sources[i];
                if (source.present && this.prefs.active_sources.includes(source.id)) {
                    wanted.push(source);
                }
            }
            if (wanted.length == 0) {
                this.finish('empty');
                return;
            }
            this.loadShards(wanted, 0);
        }, 0, () => this.finish('failed'));
    }

    /** Loads each active dataset's blob in sequence, then flips status to ready. */
    loadShards(wanted, index) {
        if (index >= wanted.length) {
            this.finish(this.shards.length > 0 ? 'ready' : 'empty');
            return;
        }
        let source = wanted[index];
        let min = this.prefs.lean_min_count;
        let version = source.index_version || `m${min}`;
        // The URL carries a fingerprint of the loaded dataset, and the response is served immutable, so a repeat
        // visit costs no network at all while a rebuilt dataset re-fetches automatically.
        fetch(`/TagDexIndex/${encodeURIComponent(source.id)}/${encodeURIComponent(version)}?min=${min}`, { credentials: 'same-origin' })
            .then(response => response.ok ? response.text() : Promise.reject(response.status))
            .then(text => {
                this.addShard(source, text);
                this.loadShards(wanted, index + 1);
            })
            .catch(() => {
                console.log(`[TagDex] Could not load index for ${source.id}.`);
                this.loadShards(wanted, index + 1);
            });
    }

    /** Settles the load and drains any waiting callbacks. */
    finish(status) {
        this.status = status;
        let waiting = this.pending;
        this.pending = [];
        for (let i = 0; i < waiting.length; i++) {
            waiting[i]();
        }
    }

    /** Parses one dataset blob into a shard: the raw text, per-record offsets, and the lowercase search haystack. */
    addShard(source, text) {
        if (!text || text.length == 0) {
            return;
        }
        let recStart = [];
        let hayParts = [];
        let pos = 0;
        while (pos < text.length) {
            let end = text.indexOf('\n', pos);
            if (end < 0) {
                end = text.length;
            }
            if (end > pos) {
                recStart.push(pos);
                let firstTab = text.indexOf('\t', pos);
                let name = firstTab < 0 || firstTab > end ? text.substring(pos, end) : text.substring(pos, firstTab);
                let copyright = '';
                if (firstTab >= 0 && firstTab < end) {
                    let secondTab = text.indexOf('\t', firstTab + 1);
                    if (secondTab >= 0 && secondTab < end) {
                        let thirdTab = text.indexOf('\t', secondTab + 1);
                        if (thirdTab >= 0 && thirdTab < end) {
                            copyright = text.substring(secondTab + 1, thirdTab);
                        }
                    }
                }
                hayParts.push(`${name}\t${copyright}`);
            }
            pos = end + 1;
        }
        if (recStart.length == 0) {
            return;
        }
        // Sentinel so entryAt() can slice the last record without a special case.
        recStart.push(text.length + 1);
        let hayStart = new Int32Array(recStart.length);
        let hay = '';
        let offset = 0;
        let pieces = [];
        for (let i = 0; i < hayParts.length; i++) {
            hayStart[i] = offset;
            pieces.push('\n');
            pieces.push(hayParts[i]);
            offset += hayParts[i].length + 1;
        }
        hayStart[hayParts.length] = offset;
        hay = pieces.join('').toLowerCase();
        this.shards.push({
            id: source.id,
            kind: source.kind,
            label: source.label,
            tagType: source.kind == 'artist' ? 1 : 4,
            raw: text,
            recStart: Int32Array.from(recStart),
            hay: hay,
            hayStart: hayStart,
            count: hayParts.length
        });
    }

    /** Total indexed entries across all shards. */
    totalEntries() {
        let total = 0;
        for (let i = 0; i < this.shards.length; i++) {
            total += this.shards[i].count;
        }
        return total;
    }

    /** Finds which entry a haystack offset falls inside, by binary search over the offset table. */
    entryIndexAt(shard, pos) {
        let low = 0;
        let high = shard.count - 1;
        while (low < high) {
            let mid = (low + high + 1) >> 1;
            if (shard.hayStart[mid] <= pos) {
                low = mid;
            }
            else {
                high = mid - 1;
            }
        }
        return low;
    }

    /** Classifies how good a match at `pos` is for entry `index`.
     * A match at the very start of the name and a match right after an underscore count equally as 'strong'. Booru
     * names put the distinguishing word last ("hatsune_miku", "kirisame_marisa"), so ranking a raw prefix above a
     * word-boundary hit would surface mikuma_(kancolle) at 1,245 posts ahead of hatsune_miku at 103,500 for "miku".
     * A mid-word hit, or a hit in the copyright rather than the name, stays weak. */
    isStrongMatch(shard, index, pos) {
        let start = shard.hayStart[index] + 1;
        if (pos == start) {
            return true;
        }
        let tab = shard.hay.indexOf('\t', start);
        if (tab >= 0 && pos > tab) {
            return false;
        }
        return shard.hay.charCodeAt(pos - 1) == 95;
    }

    /** Substring search across every shard. Returns {shard, index, strong} hits in blob order - which is already
     * post-count descending, so no sort is ever needed. */
    match(word) {
        let query = word.toLowerCase().replaceAll(' ', '_');
        if (query.length < 2 || this.status != 'ready') {
            return [];
        }
        if (this.lastWord && query.startsWith(this.lastWord) && this.lastHits) {
            let narrowed = [];
            for (let i = 0; i < this.lastHits.length; i++) {
                let hit = this.lastHits[i];
                let start = hit.shard.hayStart[hit.index] + 1;
                let stop = hit.shard.hayStart[hit.index + 1];
                let found = hit.shard.hay.indexOf(query, start);
                if (found >= start && found < stop) {
                    narrowed.push({ shard: hit.shard, index: hit.index, strong: this.isStrongMatch(hit.shard, hit.index, found) });
                }
            }
            this.lastWord = query;
            this.lastHits = narrowed;
            return narrowed;
        }
        let hits = [];
        for (let s = 0; s < this.shards.length; s++) {
            let shard = this.shards[s];
            let pos = 0;
            while (hits.length < this.scanCap) {
                pos = shard.hay.indexOf(query, pos);
                if (pos < 0) {
                    break;
                }
                let index = this.entryIndexAt(shard, pos);
                hits.push({ shard: shard, index: index, strong: this.isStrongMatch(shard, index, pos) });
                pos = shard.hayStart[index + 1];
                if (pos <= 0) {
                    break;
                }
            }
        }
        this.lastWord = query;
        this.lastHits = hits;
        return hits;
    }

    /** Splits one record out of a shard's blob. Fields: name, trigger, copyright, coreTags, count. */
    fieldsAt(shard, index) {
        let start = shard.recStart[index];
        let end = shard.recStart[index + 1] - 1;
        if (end > shard.raw.length) {
            end = shard.raw.length;
        }
        return shard.raw.substring(start, end).split('\t');
    }

    /** Builds the record shape the browse tab and /simple sheet consume. */
    recordAt(hit) {
        let fields = this.fieldsAt(hit.shard, hit.index);
        let tags = fields[3] ? fields[3].split(',').map(t => t.trim()).filter(t => t.length > 0) : [];
        return {
            source: hit.shard.id,
            kind: hit.shard.kind,
            tagType: hit.shard.tagType,
            name: fields[0],
            trigger: fields[1] || fields[0].replaceAll('_', ' '),
            copyright: fields[2] || '',
            tags: tags,
            count: parseInt(fields[4]) || 0
        };
    }

    /** Builds the suggestion-entry object for the prompt autocomplete popover.
     * Contract per prompttools.js onInput(): 'raw' enters the rich branch, 'name' is what gets inserted, and the
     * presence of 'tag' both colors the row and switches the splice anchor to the current word. */
    entryAt(hit, plainOnly = false) {
        let record = this.recordAt(hit);
        let entry = {
            raw: true,
            name: record.trigger,
            tag: record.tagType,
            tagdex: record
        };
        let display = record.trigger;
        let dash = display.indexOf(',');
        let primary = dash > 0 ? display.substring(0, dash) : display;
        let secondary = record.copyright ? record.copyright.replaceAll('_', ' ') : '';
        if (plainOnly) {
            // The /simple chip renderer reads 'clean' and ignores 'clean_html'. On the genpage the two are mutually
            // exclusive - prompttools.js lets 'clean' overwrite 'clean_html' - so exactly one is ever set.
            entry.clean = secondary ? `${primary} - ${secondary}` : primary;
        }
        else {
            let html = escapeHtmlNoBr(primary);
            if (secondary) {
                html += ` <span class="parens">${escapeHtmlNoBr(secondary)}</span>`;
            }
            entry.clean_html = html;
        }
        if (record.count > 0) {
            entry.count_display = largeCountStringify(record.count);
        }
        return entry;
    }

    /** Reads the effective match mode from whichever autocomplete host is asking. */
    readMatchMode(host) {
        if (host && host.matchMode) {
            return host.matchMode;
        }
        try {
            return getUserSetting('autocomplete.matchmode');
        }
        catch (e) {
            return 'Bucketed';
        }
    }

    /** Returns the part of a trigger that still needs inserting at the host's current word boundary.
     *
     * The stock completers search and replace one space-delimited word. A TagDex trigger can span several words,
     * so accepting `hatsune miku, vocaloid` after typing `hatsune mi` used to retain the completed first word and
     * insert the whole trigger after it. Narrowing only TagDex's inserted value keeps the host's own matching and
     * splice rules intact: `miku` still inserts the full trigger, while `hatsune mi` inserts only its remaining
     * `miku, vocaloid` tail. */
    insertionForPrompt(trigger, prompt, wordIndex) {
        if (!trigger || wordIndex <= 0 || wordIndex >= prompt.length) {
            return trigger;
        }
        let current = prompt.substring(wordIndex).toLowerCase();
        let before = prompt.substring(0, wordIndex);
        let beforeLow = before.toLowerCase();
        let triggerLow = trigger.toLowerCase();
        for (let i = 1; i < trigger.length; i++) {
            if (!/\s/.test(trigger[i - 1]) || /\s/.test(trigger[i])) {
                continue;
            }
            if (!triggerLow.substring(i).startsWith(current)) {
                continue;
            }
            let prefix = triggerLow.substring(0, i);
            if (!beforeLow.endsWith(prefix)) {
                continue;
            }
            let prefixStart = before.length - prefix.length;
            if (prefixStart > 0 && /[A-Za-z0-9_]/.test(before[prefixStart - 1])) {
                continue;
            }
            return trigger.substring(i);
        }
        return trigger;
    }

    /** Merges character suggestions into an autocomplete host's result list.
     * The only thing required of `host` is findLastWordIndex(), which both PromptTabCompleteClass and MAutoComplete
     * expose identically. Using the host's own copy is load-bearing: the caller computes the splice offset with its
     * findLastWordIndex, so a divergent copy here would splice at the wrong place. */
    augment(host, box, base, plainOnly = false) {
        if (this.status != 'ready' || !this.prefs.typeahead_enabled) {
            return base;
        }
        let prompt = getTextContent(box).substring(0, getTextSelRange(box)[0]);
        // Inside an unclosed '<...', the user is writing a prompt tag like <lora: or <wildcard:, and `base` is
        // already the prefix-completer list. Mirrors the check in prompttools.js getPossibleList (~274-281).
        let lastBrace = prompt.lastIndexOf('<');
        if (lastBrace != -1 && prompt.lastIndexOf('>') < lastBrace) {
            return base;
        }
        let wordIndex = host.findLastWordIndex(prompt);
        let word = prompt.substring(wordIndex);
        if (word.length < 2) {
            return base;
        }
        let hits = this.match(word);
        if (hits.length == 0) {
            return base;
        }
        let prefixOnly = this.readMatchMode(host) == 'StartsWith';
        let quota = base && base.length > 0 ? this.prefs.quota_with_list : this.prefs.quota_alone;
        let seen = new Set();
        if (base) {
            for (let i = 0; i < base.length; i++) {
                if (base[i] && base[i].low) {
                    seen.add(base[i].low);
                }
            }
        }
        let front = [];
        let backfill = [];
        for (let i = 0; i < hits.length && front.length + backfill.length < quota; i++) {
            let hit = hits[i];
            if (!hit.strong && prefixOnly) {
                continue;
            }
            let entry = this.entryAt(hit, plainOnly);
            entry.name = this.insertionForPrompt(entry.name, prompt, wordIndex);
            if (seen.has(entry.tagdex.name)) {
                continue;
            }
            seen.add(entry.tagdex.name);
            if (hit.strong) {
                front.push(entry);
            }
            else {
                backfill.push(entry);
            }
        }
        if (front.length == 0 && backfill.length == 0) {
            return base;
        }
        let merged = front.concat(base || []).concat(backfill);
        // Never exceed upstream's own popover cap.
        if (merged.length > 50) {
            merged = merged.slice(0, 50);
        }
        return merged;
    }
}

tagDexCore = new TagDexCoreClass();
