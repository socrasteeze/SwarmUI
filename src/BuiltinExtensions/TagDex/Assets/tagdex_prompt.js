/** TagDex - genpage prompt typeahead hook.
 *
 * Wraps PromptTabCompleteClass.prototype.getPossibleList so character/artist suggestions ride the existing
 * autocomplete popover, rather than merging entries into the `autoCompletionsList` global.
 *
 * Merging into that global was rejected for a concrete reason: loadUserData() rebuilds it from scratch on every
 * call, and it has nine call sites (main.js session-ready, settings_editor.js, params.js, four in presets.js,
 * generatecontrols.js). Injected entries would be wiped whenever the user saved a preset or edited a setting - not
 * just once at boot. It is also set to null outright when the user has no autocompletion source configured, which
 * is the common case.
 *
 * Wrapping the prototype sidesteps all of that: method lookup is dynamic, so the already-constructed
 * `promptTabComplete` singleton picks this up regardless of load order, and our index lives on our own object where
 * nothing upstream can clobber it.
 *
 * Coupling watchlist: prompttools.js getPossibleList (~205) and onInput's entry contract (~356-408).
 */
class TagDexPromptHookClass {

    constructor() {
        /** Whether install() has already run. */
        this.installed = false;
    }

    /** Wraps the completer and registers the explicit <character:> prefix. No-ops off the genpage. */
    install() {
        if (this.installed || typeof PromptTabCompleteClass == 'undefined') {
            return;
        }
        if (typeof PromptTabCompleteClass.prototype.getPossibleList != 'function') {
            console.log('[TagDex] PromptTabCompleteClass.getPossibleList is missing - upstream changed shape, typeahead disabled.');
            return;
        }
        this.installed = true;
        let original = PromptTabCompleteClass.prototype.getPossibleList;
        // Deliberately a function, not an arrow: `this` must remain the PromptTabCompleteClass instance so the
        // original keeps its own lastWord/lastResults bookkeeping.
        PromptTabCompleteClass.prototype.getPossibleList = function (box) {
            let base = original.call(this, box);
            try {
                return tagDexCore.augment(this, box, base, false);
            }
            catch (e) {
                console.log(`[TagDex] Suggestion merge failed, falling back to stock completion: ${e}`);
                return base;
            }
        };
        // Load the index the first time any prompt box is focused, rather than at boot. Users who never touch the
        // feature pay no request and no memory, which matters most on a phone.
        let originalEnable = PromptTabCompleteClass.prototype.enableFor;
        if (typeof originalEnable == 'function') {
            PromptTabCompleteClass.prototype.enableFor = function (box) {
                originalEnable.call(this, box);
                box.addEventListener('focus', () => tagDexCore.ensureLoaded(), { once: true });
            };
        }
        this.registerPrefix();
    }

    /** Registers the explicit `<character:name>` completion prefix.
     * The returned objects deliberately carry no `tag` key. With one, prompttools.js would set the splice anchor to
     * the start of the current word and leave a dangling `<character:` in the prompt; without one the anchor stays
     * at the `<`, so the whole tag is replaced by the trigger. Color still applies via the inline span. */
    registerPrefix() {
        if (typeof promptTabComplete == 'undefined' || !promptTabComplete.registerPrefix) {
            return;
        }
        let completer = (prefix) => {
            tagDexCore.ensureLoaded();
            if (tagDexCore.status != 'ready') {
                return ['\nCharacter data is still loading, or has not been downloaded yet.'];
            }
            if (!prefix || prefix.length < 2) {
                return ['\nType at least two characters to search.'];
            }
            let hits = tagDexCore.match(prefix);
            let results = [];
            for (let i = 0; i < hits.length && results.length < 25; i++) {
                let record = tagDexCore.recordAt(hits[i]);
                let primary = record.trigger.indexOf(',') > 0 ? record.trigger.substring(0, record.trigger.indexOf(',')) : record.trigger;
                let html = `<span class="tag-text tag-type-${record.tagType}">${escapeHtmlNoBr(primary)}</span>`;
                if (record.copyright) {
                    html += ` <span class="parens">${escapeHtmlNoBr(record.copyright.replaceAll('_', ' '))}</span>`;
                }
                let entry = { raw: true, name: record.trigger, clean_html: html };
                if (record.count > 0) {
                    entry.count_display = largeCountStringify(record.count);
                }
                results.push(entry);
            }
            if (results.length == 0) {
                return ['\nNo matching character or artist.'];
            }
            return results;
        };
        promptTabComplete.registerPrefix('character', 'Insert a booru character or artist trigger tag', completer);
        promptTabComplete.registerAltPrefix('char', 'character');
    }
}

tagDexPromptHook = new TagDexPromptHookClass();
tagDexPromptHook.install();
