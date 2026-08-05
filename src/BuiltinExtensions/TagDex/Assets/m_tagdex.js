/** TagDex - /simple standalone client hook.
 *
 * The /simple client shares no code with the genpage: it has its own MAutoComplete (an inline chip strip rather
 * than a floating popover). This wraps that class the same way tagdex_prompt.js wraps the genpage's, and both
 * delegate the actual matching and merging to the one shared tagDexCore singleton.
 *
 * One behavioral difference matters. MAutoComplete.buildChip reads `val.clean || val.name` for the chip label and
 * ignores `clean_html`, while the genpage's onInput lets `clean` OVERWRITE `clean_html`. So exactly one of the two
 * can be set, and which one depends on the surface - hence the plainOnly flag threaded into tagDexCore.entryAt.
 *
 * Loaded explicitly by Assets/m/index.html. It is registered in OtherAssets rather than ScriptFiles, because
 * ScriptFiles would inject it into every Razor page, where MAutoComplete does not exist.
 */
class MTagDexClass {

    constructor() {
        /** Whether install() has already run. */
        this.installed = false;
    }

    /** Wraps the /simple completer. No-ops anywhere MAutoComplete is absent. */
    install() {
        if (this.installed || typeof MAutoComplete == 'undefined' || typeof tagDexCore == 'undefined') {
            return;
        }
        if (typeof MAutoComplete.prototype.getPossibleList != 'function') {
            console.log('[TagDex] MAutoComplete.getPossibleList is missing - typeahead disabled on /simple.');
            return;
        }
        this.installed = true;
        let original = MAutoComplete.prototype.getPossibleList;
        // Function, not arrow: `this` must stay the MAutoComplete instance.
        MAutoComplete.prototype.getPossibleList = function (box) {
            let base = original.call(this, box);
            try {
                return tagDexCore.augment(this, box, base, true);
            }
            catch (e) {
                console.log(`[TagDex] Suggestion merge failed on /simple: ${e}`);
                return base;
            }
        };
        // Load the index on first prompt focus rather than at boot, so a phone that never uses the feature pays no
        // request and no memory. This is also why no edit to m_app.js's boot sequence is needed.
        let originalEnable = MAutoComplete.prototype.enableFor;
        if (typeof originalEnable == 'function') {
            MAutoComplete.prototype.enableFor = function (box, paramId) {
                originalEnable.call(this, box, paramId);
                box.addEventListener('focus', () => tagDexCore.ensureLoaded(), { once: true });
            };
        }
        this.registerPrefix();
    }

    /** Registers `<character:name>` on the /simple completer.
     * As on the genpage, the returned objects carry no `tag` key, so buildChip leaves the splice anchor at the `<`
     * and the whole tag is replaced rather than leaving a dangling `<character:`. */
    registerPrefix() {
        if (typeof mAutoComplete == 'undefined' || !mAutoComplete.registerPrefix) {
            return;
        }
        mAutoComplete.registerPrefix('character', 'Booru character or artist trigger', (prefix) => {
            tagDexCore.ensureLoaded();
            if (tagDexCore.status != 'ready') {
                return ['\nCharacter data not downloaded yet.'];
            }
            if (!prefix || prefix.length < 2) {
                return ['\nType at least two characters.'];
            }
            let hits = tagDexCore.match(prefix);
            let results = [];
            for (let i = 0; i < hits.length && results.length < 20; i++) {
                let record = tagDexCore.recordAt(hits[i]);
                let comma = record.trigger.indexOf(',');
                let primary = comma > 0 ? record.trigger.substring(0, comma) : record.trigger;
                let entry = { raw: true, name: record.trigger, clean: primary };
                if (record.count > 0) {
                    entry.count_display = largeCountStringify(record.count);
                }
                results.push(entry);
            }
            if (results.length == 0) {
                return ['\nNo match.'];
            }
            return results;
        });
        mAutoComplete.registerAltPrefix('char', 'character');
    }
}

mTagDex = new MTagDexClass();
mTagDex.install();
