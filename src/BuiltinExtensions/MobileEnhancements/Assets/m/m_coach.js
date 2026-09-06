/** MobileEnhancements standalone client - Prompt Coach (docs/SimplePromptCoach-Plan.md).
 *
 * Phases shipped: 1 (profile resolver + read-only pill/sheet), 2 (safe setup actions), 3 (Active LoRA rows
 * built from cached picker rows plus lazy, bounded DescribeModel enrichment for uncached active LoRAs, role
 * assignment persisted per LoRA, locked preset-owned rows, section-aware "Prompt" insertion alongside the
 * existing literal "Insert exact trigger", and separate reporting of prompt-syntax `<lora:...>` activations),
 * 4 (a quote/escape-aware top-level tag tokenizer, tag-section classification with an optional TagDex bridge,
 * a previewed/undoable/idempotent normalization action, and a "Build ordered draft" composer that never
 * mutates the source prompt on its own), and a basic 5 (user-authored custom profiles, persisted in the same
 * `promptGuide` block as the built-in Anima doctrine, always explicit - never auto-suggested for any
 * checkpoint). See the plan doc's Delivery phases / Status header for exactly what remains.
 *
 * The effective checkpoint (mState.buildGenInput()['model'], NOT the raw manual pick) owns the profile, so a
 * preset that overrides the checkpoint is what the coach reacts to - matching renderModelButton in
 * m_create.js. Every mutation here is explicit (a tap), previewed in its own confirmation text, idempotent
 * (running it again when nothing is left to change is a no-op), and undoable for one step. Nothing here ever
 * touches mState.params on its own initiative - only in response to a click inside this file. */
class MCoach {

    constructor() {
        /** The pill element beside the prompt heading, kept so state changes can re-render its label. */
        this.pillEl = null;
        /** Single-level undo: a closure that restores whatever the last applied action changed. Overwritten
         * by the next mutation, exactly like the plan's "one-level undo" - there is no undo stack. */
        this.undoFn = null;
        /** Active-LoRA names with a DescribeModel request already in flight, so a sheet re-render (which
         * happens on every mState.changed()) never fires a second request for the same name. */
        this.enrichInFlight = new Set();
        /** Active-LoRA names whose DescribeModel request already came back empty/failed this session, so a
         * missing-metadata LoRA is not re-requested on every re-render for the rest of the sheet's life. */
        this.enrichFailed = new Set();
        /** Whether the "new custom profile" inline form is open. Sheet-local UI state, not persisted. */
        this.customFormOpen = false;
        /** Whether the one-per-page mState.onChange subscription for the pill has been registered. */
        this.pillListenerBound = false;
        /** The open sheet's content element and its rebuild closure, so async work (DescribeModel enrichment)
         * can refresh the sheet in place instead of stacking a second one. Both null while no sheet is open. */
        this.sheetContent = null;
        this.sheetRerender = null;
        /** True while refreshSheet is mid-rebuild, so a synchronous enrichment callback cannot re-enter it. */
        this.rendering = false;
    }

    /** Built-in Anima doctrine (docs/SimplePromptCoach-Plan.md "Initial Anima profiles"). Versioned and kept
     * separate from UI code, per the plan's profile schema: an assignment stores the id, not a copy of the
     * rules, so a doctrine fix here applies without touching stored preferences. */
    static PROFILES = {
        'anima-base': {
            'id': 'anima-base',
            'family': 'anima',
            'revision': 1,
            'label': 'Anima Base',
            'positivePrefix': ['masterpiece', 'best quality', 'score_7', 'safe'],
            'negativeSuggested': ['worst quality', 'low quality', 'score_1', 'score_2', 'score_3', 'artist name',
                'blurry', 'jpeg artifacts', 'chromatic aberration'],
            'scoreForbidden': false,
            'parameterAdvice': { 'steps': [30, 50], 'cfgscale': [4, 5] }
        },
        'anima-aesthetic': {
            'id': 'anima-aesthetic',
            'family': 'anima',
            'revision': 1,
            'label': 'Anima Aesthetic',
            // Default Quality mode is None: the plan is explicit that "masterpiece, best quality" is an
            // optional Human choice here, not a doctrine requirement, so it is not auto-added.
            'positivePrefix': [],
            // No official Aesthetic-specific negative is published; this is the Base list with score_* removed,
            // clearly a derived helper rather than a claimed official one - never let this list grow score tags.
            'negativeSuggested': ['worst quality', 'low quality', 'artist name', 'blurry', 'jpeg artifacts',
                'chromatic aberration'],
            'scoreForbidden': true,
            'parameterAdvice': { 'steps': [30, 50], 'cfgscale': [4, 5] }
        },
        'anima-turbo': {
            'id': 'anima-turbo',
            'family': 'anima',
            'revision': 1,
            'label': 'Anima Turbo',
            // Same tag/caption language as the family: the source doctrine has not published a separate rule.
            'positivePrefix': ['masterpiece', 'best quality', 'score_7', 'safe'],
            'negativeSuggested': ['worst quality', 'low quality', 'score_1', 'score_2', 'score_3', 'artist name',
                'blurry', 'jpeg artifacts', 'chromatic aberration'],
            'scoreForbidden': false,
            'parameterAdvice': { 'steps': [8, 12], 'cfgscale': [1, 1] }
        }
    };

    /** Curated "prefix/quality" vocabulary (quality/meta/period/safety tags), tag-section-classified as
     * 'quality' under any profile. Exact score tags are matched separately via isScoreTag, since they compare
     * literally (case-preserved) rather than through normKey. */
    static QUALITY_WORDS = new Set(['masterpiece', 'best quality', 'high quality', 'normal quality',
        'worst quality', 'low quality', 'safe', 'sensitive', 'questionable', 'explicit', 'jpeg artifacts',
        'chromatic aberration', 'blurry', 'artist name']);

    /** Curated subject-count markers ("1girl", "2boys", "no humans", "year 2024", ...) - the plan's "subject
     * count" stage, kept distinct from 'quality' so an ordered draft places both ahead of character/series/
     * artist without merging two different vocab lists into one bucket. */
    static isSubjectMarker(key) {
        return /^\d+(girl|boy|other)s?$/.test(key) || ['no humans', 'solo', 'duo', 'group'].includes(key)
            || /^year \d{3,4}$/.test(key);
    }

    /** Section slot each classifyToken() kind lands in when building an ordered draft. Six official stages
     * (plan "Tag section model" / the profile schema's `sections`). 'style', 'loraTrigger', and 'unknown' have
     * no official slot of their own - a private LoRA activation phrase or unparsed prompt syntax is not
     * something the composer may reorder relative to the rest of General, only sit among it in its original
     * relative order, so all three land in 'general' rather than inventing extra stages the doctrine does not
     * define. */
    static DRAFT_SLOT = {
        'quality': 'lead', 'subject': 'subject', 'character': 'character', 'series': 'series', 'artist': 'artist',
        'style': 'general', 'general': 'general', 'loraTrigger': 'general', 'unknown': 'general'
    };

    /** LoRA role -> the same six-stage slot a section-aware trigger insertion targets. Style has no official
     * slot either (see DRAFT_SLOT), so it targets 'general', same as an unassigned role. */
    static ROLE_SLOT = { 'Character': 'character', 'Series': 'series', 'Artist': 'artist', 'Style': 'general',
        'General': 'general' };

    /** The six-stage draft/section order itself, reused by both the composer and section-aware insertion. */
    static SECTION_ORDER = ['lead', 'subject', 'character', 'series', 'artist', 'general'];

    /** Case/slash-folded model path, the same normalization key `mState.starKey` uses for stars - a
     * per-checkpoint override should not depend on backslash-vs-forward-slash or extension casing either. */
    static normalizedPath(name) {
        return `${name || ''}`.toLowerCase().replace(/\\/g, '/');
    }

    /** True for an exact `score_1`..`score_9` token - the one underscore form Anima doctrine keeps on purpose,
     * so normKey below must not turn it into "score 7" like every other underscore tag. */
    static isScoreTag(raw) {
        return /^score_[1-9]$/i.test(`${raw}`.trim());
    }

    /** Comparison key for one tag: trimmed, lowercased, underscores to spaces - except an exact score tag,
     * which is compared (and would be inserted) literally. Comparison-only; the raw slice is never touched. */
    static normKey(raw) {
        let text = `${raw}`.trim();
        return MCoach.isScoreTag(text) ? text.toLowerCase() : text.toLowerCase().replace(/_/g, ' ');
    }

    /** True for a token normalization must leave byte-for-byte alone beyond the score-tag rule: Swarm prompt
     * syntax (`<trigger>`, `<segment:...>`, `<random:a,b>`, `<lora:...>`), a wildcard/macro name (`__foo__`),
     * a model path, or anything carrying a backslash escape. The plan's safe-parsing section names all four
     * explicitly - lowercasing `__Wildcard__` or `<Segment:...>` does not tidy a tag, it breaks a reference to
     * something that has to match a filename or a syntax keyword exactly. */
    static isLiteralToken(raw) {
        let text = `${raw}`.trim();
        return /[<>]/.test(text) || /__/.test(text) || /[\\/]/.test(text);
    }

    /** TagDex's kind for a token, but only on an EXACT record match ('character' | 'artist' | null).
     *
     * tagDexCore.match() is a substring search and its `strong` flag only means "the hit began at a word
     * boundary", so "miku" strong-matches `hatsune_miku` and "red" strong-matches any artist whose name starts
     * with it. Treating that as a classification would move ordinary General text into the character/artist
     * section of an ordered draft, which is exactly the "a classifier being unsure is not permission to move
     * text" rule the plan states. So the matched record's own name (or its space-form trigger) has to BE the
     * token. Never runs unless TagDex's index is already loaded on its own - the coach never fetches it. */
    static tagDexKind(key) {
        if (typeof tagDexCore == 'undefined' || !tagDexCore || tagDexCore.status != 'ready') {
            return null;
        }
        let hits = tagDexCore.match(key) || [];
        for (let i = 0; i < hits.length && i < 64; i++) {
            let record = tagDexCore.recordAt(hits[i]);
            if (MCoach.normKey(record.name) == key || MCoach.normKey(record.trigger) == key) {
                return hits[i].shard.kind == 'artist' ? 'artist' : 'character';
            }
        }
        return null;
    }

    /** Top-level comma tokenizer, with byte offsets into the original string. Splits on commas outside `()`,
     * `[]`, `{}`, `<>` nesting - so a weighted group like `(red hair, blue eyes:1.5)` or a Swarm tag like
     * `<random:a,b>` stays one token - AND outside a double-quoted run, so `"a, b"` also stays one token. A
     * backslash escapes exactly the next character (kept in the raw slice verbatim, never treated as a comma,
     * bracket, or quote toggle), covering an escaped comma like `a\, b`. Single quotes are deliberately NOT a
     * quoting character: an apostrophe in ordinary text ("it's") is far more common in prompts than a
     * deliberate single-quoted guard, and treating every apostrophe as a quote toggle would silently eat the
     * rest of the field as one token. `malformed` is true when a `"` or a bracket is left open at end of
     * string - callers that build a draft or a normalization preview must refuse rather than guess past that,
     * per the plan's safe-parsing section. */
    static tokenizeRaw(text) {
        let raw = `${text || ''}`;
        let pieces = [];
        let depth = 0;
        let current = '';
        let start = 0;
        let openers = '([{<';
        let closers = ')]}>';
        let inQuote = false;
        for (let i = 0; i < raw.length; i++) {
            let ch = raw[i];
            if (ch == '\\' && i + 1 < raw.length) {
                current += ch + raw[i + 1];
                i++;
                continue;
            }
            if (inQuote) {
                current += ch;
                if (ch == '"') {
                    inQuote = false;
                }
                continue;
            }
            if (ch == '"') {
                inQuote = true;
                current += ch;
                continue;
            }
            if (openers.includes(ch)) {
                depth++;
            }
            else if (closers.includes(ch)) {
                depth = Math.max(0, depth - 1);
            }
            if (ch == ',' && depth == 0) {
                pieces.push({ 'raw': current, 'start': start, 'end': i });
                current = '';
                start = i + 1;
                continue;
            }
            current += ch;
        }
        pieces.push({ 'raw': current, 'start': start, 'end': raw.length });
        return { 'pieces': pieces, 'malformed': inQuote || depth > 0, 'length': raw.length };
    }

    /** Tokenizes into {raw, key} entries only (no offsets) - the shape every existing comparison (computeMissing,
     * scoreTagHits, normalization, draft building) consumes. Blank-after-trim pieces are dropped, same as before
     * quote/escape support was added. */
    static tokenize(text) {
        return MCoach.tokenizeRaw(text).pieces
            .map(piece => ({ 'raw': piece.raw, 'key': MCoach.normKey(piece.raw) }))
            .filter(t => t.raw.trim() != '');
    }

    /** tokenize() plus the malformed flag, for callers (normalization, ordered draft) that must refuse outright
     * on unbalanced syntax rather than silently working around it. */
    static tokenizeChecked(text) {
        let result = MCoach.tokenizeRaw(text);
        return {
            'tokens': result.pieces.map(piece => ({ 'raw': piece.raw, 'key': MCoach.normKey(piece.raw) }))
                .filter(t => t.raw.trim() != ''),
            'malformed': result.malformed
        };
    }

    /** tokenize() with each surviving token's original byte offsets kept, for the one caller (section-aware
     * trigger insertion) that must splice new text into the source string without disturbing anything else's
     * bytes. */
    static tokenizeWithOffsets(text) {
        let result = MCoach.tokenizeRaw(text);
        return {
            'tokens': result.pieces.map(piece => ({ 'raw': piece.raw, 'key': MCoach.normKey(piece.raw),
                'start': piece.start, 'end': piece.end })).filter(t => t.raw.trim() != ''),
            'malformed': result.malformed
        };
    }

    /** The checkpoint that will actually generate, per buildGenInput - an active preset overriding the manual
     * pick is what the coach must react to, same as MCreate.renderModelButton. */
    effectiveModel() {
        return mState.buildGenInput()['model'];
    }

    /** Built-in profiles plus this device's user-authored custom profiles (phase 5), keyed the same way so a
     * checkpoint override or a mode lookup never has to know which table an id came from. */
    allProfiles() {
        return Object.assign({}, MCoach.PROFILES, mState.promptGuide.customProfiles);
    }

    /** Resolves the doctrine profile for the effective checkpoint.
     * Priority, matching the plan's resolver section:
     *   1. a confirmed per-checkpoint override (`mState.promptGuide.checkpointProfiles`), built-in or custom;
     *   2. an official filename pattern (`anima-base-*` / `anima-aesthetic-*` / `anima-turbo-*`), a suggestion
     *      until confirmed via "Remember for this checkpoint";
     *   3. Anima compat class with no matching filename - family known, variant not, so no profile is chosen
     *      automatically (base/aesthetic/turbo all report the same family/compat class - see the plan's
     *      resolver notes on why neither field may pick a variant alone);
     *   4. no match -> No coach.
     * A custom profile is reachable only via step 1 (an explicit override) - it is never filename- or
     * compat-class-suggested, since it names no known checkpoint family the resolver could recognize.
     * Returns {family, profileId, profile, confidence}. confidence is 'explicit' | 'inferred' | 'unassigned'. */
    resolveProfile() {
        let model = this.effectiveModel();
        if (!model) {
            return { 'family': null, 'profileId': null, 'profile': null, 'confidence': 'unassigned' };
        }
        let overrideId = mState.promptGuide.checkpointProfiles[MCoach.normalizedPath(model)];
        // 'generic' is a confirmed "off" - it must win outright, even over a filename that looks like an
        // official Anima release, or "Generic / off" would not actually be able to silence a false-positive
        // filename match.
        if (overrideId == 'generic') {
            return { 'family': null, 'profileId': null, 'profile': null, 'confidence': 'explicit' };
        }
        let profiles = this.allProfiles();
        if (overrideId && profiles[overrideId]) {
            let profile = profiles[overrideId];
            return { 'family': profile.family || 'custom', 'profileId': overrideId, 'profile': profile, 'confidence': 'explicit' };
        }
        let stem = mUI.modelName(model).toLowerCase();
        let match = stem.match(/^anima[-_](base|aesthetic|turbo)(?:[-_]|$)/);
        if (match) {
            let id = `anima-${match[1]}`;
            return { 'family': 'anima', 'profileId': id, 'profile': MCoach.PROFILES[id], 'confidence': 'inferred' };
        }
        if (mState.compatClassOf('Stable-Diffusion', model) == 'anima') {
            return { 'family': 'anima', 'profileId': null, 'profile': null, 'confidence': 'unassigned' };
        }
        return { 'family': null, 'profileId': null, 'profile': null, 'confidence': 'unassigned' };
    }

    /** Persists a confirmed profile choice for the effective checkpoint ("Remember for this checkpoint").
     * `profileId` of null clears the override (back to Auto). Keyed by normalized path rather than a hash -
     * this client has no model hash without a DescribeModel call, which the coach must not make just to open. */
    setProfileOverride(profileId) {
        let model = this.effectiveModel();
        if (!model) {
            return;
        }
        let key = MCoach.normalizedPath(model);
        if (profileId) {
            mState.promptGuide.checkpointProfiles[key] = profileId;
        }
        else {
            delete mState.promptGuide.checkpointProfiles[key];
        }
        mState.changed();
    }

    /** Saves a new user-authored profile (phase 5) and returns its generated id. Ids are namespaced
     * `custom:<slug>-<timestamp>` so they can never collide with a built-in id or with each other, even for two
     * profiles saved under the same display name. Always explicit: nothing else in this file ever assigns a
     * custom profile id without a direct "Remember for this checkpoint"-equivalent user action. */
    addCustomProfile(def) {
        let slug = `${def.label || 'profile'}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'profile';
        let id = `custom:${slug}-${Date.now().toString(36)}`;
        mState.promptGuide.customProfiles[id] = {
            'id': id,
            'family': 'custom',
            'revision': 1,
            'label': `${def.label || 'Custom profile'}`,
            'positivePrefix': def.positivePrefix || [],
            'negativeSuggested': def.negativeSuggested || [],
            'scoreForbidden': !!def.scoreForbidden,
            'parameterAdvice': def.parameterAdvice || null
        };
        mState.changed();
        return id;
    }

    /** Deletes a custom profile and any checkpoint override pointing at it, so a stale override never resolves
     * to a phantom entry (`allProfiles()[overrideId]` would simply be undefined, which resolveProfile already
     * treats as "no match", but a dangling override the sheet cannot explain is still worth cleaning up). */
    removeCustomProfile(id) {
        delete mState.promptGuide.customProfiles[id];
        for (let key in mState.promptGuide.checkpointProfiles) {
            if (mState.promptGuide.checkpointProfiles[key] == id) {
                delete mState.promptGuide.checkpointProfiles[key];
            }
        }
        mState.changed();
    }

    /** Prompt mode for the resolved family ('tags' default, 'natural', or 'hybrid'). Stored per family, not
     * per checkpoint, so switching between two Anima finetunes keeps the same mode choice. */
    currentMode() {
        let family = this.resolveProfile().family || 'generic';
        return mState.promptGuide.modeByFamily[family] || 'tags';
    }

    /** Sets the prompt mode for the resolved family. Never itself touches the prompt text - mode only gates
     * which mutating actions this file allows to run, per the "tag normalization never applied to prose"
     * product rule. */
    setMode(mode) {
        let family = this.resolveProfile().family || 'generic';
        mState.promptGuide.modeByFamily[family] = mode;
        mState.changed();
    }

    /** The text of one prompt field as generation will actually see it: the raw param with every active
     * preset's param_map already merged in. The plan is explicit that ANALYSIS runs against the effective
     * input while an accepted edit targets the raw field - otherwise a `{value}` preset that already
     * contributes "masterpiece" reads as missing it, and Add missing writes a duplicate that only shows up in
     * the generated metadata. Writes always still go to mState.params[field]. */
    effectiveField(field) {
        return `${mState.buildGenInput()[field] ?? ''}`;
    }

    /** Suggestions from `suggestions` not already present (by comparison key) in `field`'s EFFECTIVE text. */
    computeMissing(field, suggestions) {
        let tokens = MCoach.tokenize(this.effectiveField(field));
        let present = new Set(tokens.map(t => t.key));
        return (suggestions || []).filter(s => !present.has(MCoach.normKey(s)));
    }

    /** Exact before/after text for adding `missing` to `field`, without touching a single byte of the
     * existing content - the missing tokens are prefixed, comma-joined, ahead of whatever was already there. */
    previewAddMissing(field, missing) {
        let before = `${mState.params[field] || ''}`;
        if (missing.length == 0) {
            return { 'before': before, 'after': before };
        }
        let prefix = missing.join(', ');
        let after = before.trim() == '' ? prefix : `${prefix}, ${before}`;
        return { 'before': before, 'after': after };
    }

    /** True when an active preset overwrites `field` outright, so a patch to the raw field would never reach
     * generation. Mirrors applyPresetMap: a preset value containing `{value}` merges the raw text in and is
     * therefore safe to edit under; anything else replaces it. The plan is explicit that this case must be
     * blocked with a reason rather than pretending the edit worked. */
    presetReplacesField(field) {
        for (let title of mState.activePresets) {
            let preset = mState.presets.find(p => p.title == title);
            let val = preset && preset.param_map ? preset.param_map[field] : undefined;
            if (typeof val == 'string' && !val.includes('{value}')) {
                return true;
            }
        }
        return false;
    }

    /** Everything an "Add missing" needs decided in one place, so the preview the user confirms and the write
     * that follows can never disagree: whether the action may run at all (`blocked` is a user-facing reason or
     * null), what is missing, and the exact before/after text. Read-only - calling this never writes. */
    planAddMissing(field, suggestions) {
        if (this.currentMode() == 'natural') {
            return { 'blocked': 'Prose mode: tag prefixes are not inserted into natural-language prompts.', 'missing': [], 'preview': null };
        }
        if (this.presetReplacesField(field)) {
            return { 'blocked': 'Active preset replaces this prompt - the edit would not reach generation.', 'missing': [], 'preview': null };
        }
        let missing = this.computeMissing(field, suggestions);
        return { 'blocked': null, 'missing': missing, 'preview': this.previewAddMissing(field, missing) };
    }

    /** Shows the exact before/after text and writes only if the user confirms. This is the path every sheet
     * button takes: the plan requires each repair to open an exact preview, so no tap in the UI may reach
     * applyAddMissing without one. `done` runs only after an accepted write. */
    confirmAddMissing(field, suggestions, label, done) {
        let plan = this.planAddMissing(field, suggestions);
        if (plan.blocked) {
            mUI.warn(plan.blocked);
            return false;
        }
        if (plan.missing.length == 0) {
            mUI.note(`${label} already covered - nothing to add.`);
            return false;
        }
        mUI.confirm(`Add to ${label}: ${plan.missing.join(', ')}\n\nBefore:\n${plan.preview.before || '(empty)'}`
            + `\n\nAfter:\n${plan.preview.after}`, () => {
            this.applyAddMissing(field, suggestions, label);
            done();
        });
        return true;
    }

    /** Applies "Add missing" for one field against one suggestion list. Refuses in Natural mode (prose is
     * never tag-normalized or prefixed), when an active preset would replace the field, and when there is
     * nothing missing (idempotent: calling this a second time in a row is always a no-op, because the first
     * call already made computeMissing return empty). Returns true when it wrote something. */
    applyAddMissing(field, suggestions, label) {
        let plan = this.planAddMissing(field, suggestions);
        if (plan.blocked) {
            mUI.warn(plan.blocked);
            return false;
        }
        let missing = plan.missing;
        if (missing.length == 0) {
            mUI.note(`${label} already covered - nothing to add.`);
            return false;
        }
        let preview = plan.preview;
        let before = preview.before;
        mState.params[field] = preview.after;
        this.undoFn = () => {
            mState.params[field] = before;
        };
        mState.changed();
        mUI.note(`Added ${missing.length} missing ${label} tag(s). Undo available.`);
        return true;
    }

    /** Reverts the last applied Coach action, one level deep. */
    undo() {
        if (!this.undoFn) {
            return false;
        }
        let fn = this.undoFn;
        this.undoFn = null;
        fn();
        mState.changed();
        mUI.note('Coach change undone.');
        return true;
    }

    /** Exact score tags (`score_1`..`score_9`) present in either prompt field, in first-seen order. Read-only:
     * Aesthetic flags these but the plan is explicit that they are never stripped as a side effect. */
    scoreTagHits() {
        let tokens = [...MCoach.tokenize(this.effectiveField('prompt')), ...MCoach.tokenize(this.effectiveField('negativeprompt'))];
        let seen = new Set();
        let hits = [];
        for (let token of tokens) {
            if (MCoach.isScoreTag(token.raw) && !seen.has(token.key)) {
                seen.add(token.key);
                hits.push(token.raw.trim());
            }
        }
        return hits;
    }

    /** Applies a profile's Steps/CFG advisory to the low end of its recommended range, after the caller has
     * shown the before/after text. Never runs on its own - only from the confirmed sheet action. */
    applyParamAdvice(profile) {
        let advice = profile.parameterAdvice;
        if (!advice) {
            return false;
        }
        // Idempotent, and for a reason beyond tidiness: the advisory row stays on screen after a successful
        // apply (it is the "current vs recommended" readout), so a second tap is easy. Without this guard that
        // second apply would overwrite the undo closure with the values the FIRST apply just wrote, and Undo
        // would silently stop being able to restore what the user actually had.
        if (`${mState.params['steps'] ?? ''}` == `${advice.steps[0]}` && `${mState.params['cfgscale'] ?? ''}` == `${advice.cfgscale[0]}`) {
            mUI.note('Steps/CFG are already at the recommended values.');
            return false;
        }
        let beforeSteps = mState.params['steps'];
        let beforeCfg = mState.params['cfgscale'];
        mState.params['steps'] = `${advice.steps[0]}`;
        mState.params['cfgscale'] = `${advice.cfgscale[0]}`;
        this.undoFn = () => {
            if (beforeSteps == null) {
                delete mState.params['steps'];
            }
            else {
                mState.params['steps'] = beforeSteps;
            }
            if (beforeCfg == null) {
                delete mState.params['cfgscale'];
            }
            else {
                mState.params['cfgscale'] = beforeCfg;
            }
        };
        mState.changed();
        mUI.note(`Steps/CFG set to ${advice.steps[0]} / ${advice.cfgscale[0]}. Undo available.`);
        return true;
    }

    /** Advisory rows for the Setup section, built fresh on every render - each is {kind, text}. Empty when no
     * profile is resolved: an unassigned checkpoint has nothing this section can recommend. */
    advisories(resolved) {
        let rows = [];
        if (!resolved.profile) {
            return rows;
        }
        let profile = resolved.profile;
        let posMissing = this.computeMissing('prompt', profile.positivePrefix);
        if (posMissing.length > 0) {
            rows.push({ 'kind': 'addPositive', 'text': `Add recommended positive prefix (${posMissing.length} missing)` });
        }
        let negMissing = this.computeMissing('negativeprompt', profile.negativeSuggested);
        if (negMissing.length > 0) {
            rows.push({ 'kind': 'addNegative', 'text': `Merge recommended negative (${negMissing.length} missing)` });
        }
        if (profile.scoreForbidden) {
            let hits = this.scoreTagHits();
            if (hits.length > 0) {
                rows.push({ 'kind': 'scoreWarning', 'text': `Aesthetic: score tags are discouraged - found ${hits.join(', ')}` });
            }
        }
        if (profile.parameterAdvice) {
            let advice = profile.parameterAdvice;
            let steps = mState.params['steps'] || '(unset)';
            let cfg = mState.params['cfgscale'] || '(unset)';
            let recSteps = advice.steps[0] == advice.steps[1] ? `${advice.steps[0]}` : `${advice.steps[0]}-${advice.steps[1]}`;
            let recCfg = advice.cfgscale[0] == advice.cfgscale[1] ? `${advice.cfgscale[0]}` : `${advice.cfgscale[0]}-${advice.cfgscale[1]}`;
            rows.push({ 'kind': 'paramAdvice', 'text': `${profile.label}: current Steps ${steps} / CFG ${cfg}; recommended ${recSteps} / ${recCfg}` });
        }
        return rows;
    }

    // ---------------------------------------------------------------------------------------------------
    // Phase 4: tag-section classification, normalization preview, ordered draft composer.
    // ---------------------------------------------------------------------------------------------------

    /** normKey(trigger) -> {role, trigger, name} for every currently active LoRA (including preset-supplied,
     * locked rows - the plan requires their triggers still be RECOGNIZED in prompt text even though the row
     * itself cannot be acted on) that has a cached metadata trigger phrase. Built fresh per call from
     * whatever m_create.js/enrichActiveLoras have already cached; never fetches anything on its own. */
    activeLoraTriggerIndex() {
        let index = new Map();
        for (let row of this.activeLoraRows()) {
            let model = mCreate.loraByName(row.name);
            let trigger = `${model.trigger_phrase || ''}`.trim();
            if (!trigger) {
                continue;
            }
            index.set(MCoach.normKey(trigger), { 'role': this.getLoraRole(row.name), 'trigger': trigger, 'name': row.name });
        }
        return index;
    }

    /** Maps one tokenize() entry to a tag-section kind: 'quality' | 'subject' | 'character' | 'series' |
     * 'artist' | 'style' | 'loraTrigger' | 'general' | 'unknown'. An active LoRA's own literal trigger text is
     * recognized (and reported as its assigned role, or 'loraTrigger' when unassigned) before anything else
     * gets a chance to classify or normalize it - see planNormalize, which exempts these from rewriting
     * regardless of the kind reported here. `<lora:...>` prompt syntax is 'unknown': the plan requires it be
     * reported separately, never folded into a tag section or rewritten. TagDex is consulted only when its
     * index is already 'ready' - it is never fetched or queried into existence by this call, so an unloaded
     * TagDex degrades this to the curated vocab only, exactly like the rest of this file degrades without it. */
    classifyToken(token, triggerIndex) {
        let raw = token.raw.trim();
        let key = token.key;
        if (/^<trigger>$/i.test(raw)) {
            return { 'kind': 'loraTrigger', 'isLoraTrigger': false };
        }
        if (/^<lora:/i.test(raw)) {
            return { 'kind': 'unknown', 'isLoraTrigger': false };
        }
        let triggerHit = triggerIndex.get(key);
        if (triggerHit) {
            let kind = { 'Character': 'character', 'Series': 'series', 'Artist': 'artist', 'Style': 'style' }[triggerHit.role] || 'loraTrigger';
            return { 'kind': kind, 'isLoraTrigger': true };
        }
        if (MCoach.isScoreTag(raw) || MCoach.QUALITY_WORDS.has(key)) {
            return { 'kind': 'quality', 'isLoraTrigger': false };
        }
        if (MCoach.isSubjectMarker(key)) {
            return { 'kind': 'subject', 'isLoraTrigger': false };
        }
        let tagDexKind = MCoach.tagDexKind(key);
        if (tagDexKind) {
            return { 'kind': tagDexKind, 'isLoraTrigger': false };
        }
        return { 'kind': 'general', 'isLoraTrigger': false };
    }

    /** Everything a normalization preview needs decided in one place, mirroring planAddMissing: whether the
     * action may run (`blocked`, a user-facing reason or null), the exact before/after text, and how many
     * tokens would actually change. An exact score tag or an active LoRA's literal trigger text is skipped
     * regardless of its section kind - the product rule against lowercasing/underscoring trained activation
     * words applies here exactly as it does to the LoRA section's own insertion actions. Malformed top-level
     * syntax blocks the action outright rather than guessing past it. */
    planNormalize(field) {
        if (this.currentMode() != 'tags') {
            return { 'blocked': 'Tag mode only: normalization is never run against prose.', 'before': null, 'after': null, 'changed': 0 };
        }
        if (this.presetReplacesField(field)) {
            return { 'blocked': 'Active preset replaces this prompt - the edit would not reach generation.', 'before': null, 'after': null, 'changed': 0 };
        }
        let before = `${mState.params[field] || ''}`;
        let checked = MCoach.tokenizeChecked(before);
        if (checked.malformed) {
            return { 'blocked': 'Unbalanced quote or bracket syntax - fix it before normalizing.', 'before': null, 'after': null, 'changed': 0 };
        }
        let triggerIndex = this.activeLoraTriggerIndex();
        let changed = 0;
        let pieces = checked.tokens.map(token => {
            let raw = token.raw.trim();
            if (MCoach.isScoreTag(raw) || MCoach.isLiteralToken(raw)) {
                return raw;
            }
            let info = this.classifyToken(token, triggerIndex);
            if (info.isLoraTrigger || info.kind == 'unknown') {
                return raw;
            }
            let normalized = raw.toLowerCase().replace(/_/g, ' ');
            if (normalized != raw) {
                changed++;
            }
            return normalized;
        });
        return { 'blocked': null, 'before': before, 'after': pieces.join(', '), 'changed': changed };
    }

    /** Shows the exact before/after text and writes only if the user confirms - same contract as
     * confirmAddMissing. A no-op plan (already normalized) is reported and never opens a dialog. */
    confirmNormalize(field, label, rerender) {
        let plan = this.planNormalize(field);
        if (plan.blocked) {
            mUI.warn(plan.blocked);
            return false;
        }
        if (plan.changed == 0) {
            mUI.note(`${label} is already normalized - nothing to change.`);
            return false;
        }
        mUI.confirm(`Normalize ${plan.changed} tag(s) in ${label} (lowercase, underscores to spaces)\n\nBefore:\n${plan.before}`
            + `\n\nAfter:\n${plan.after}`, () => {
            this.applyNormalize(field, label);
            rerender();
        });
        return true;
    }

    /** Applies a normalization plan. Idempotent for the same reason applyAddMissing is: a second call
     * recomputes planNormalize against the ALREADY-normalized text, which reports changed == 0. */
    applyNormalize(field, label) {
        let plan = this.planNormalize(field);
        if (plan.blocked || plan.changed == 0) {
            return false;
        }
        let before = plan.before;
        mState.params[field] = plan.after;
        this.undoFn = () => {
            mState.params[field] = before;
        };
        mState.changed();
        mUI.note(`Normalized ${plan.changed} tag(s) in ${label}. Undo available.`);
        return true;
    }

    /** Builds a NEW ordered prompt string into an ephemeral draft - it is never written to mState by this
     * call, only by the confirmed "Use draft"/"Insert at cursor" actions below. Sections follow the plan's
     * canonical six-stage order; every token is appended to its bucket in a single left-to-right pass, so
     * unknown/General/style/LoRA-trigger tokens (all sharing the 'general' bucket) keep their original
     * relative order among themselves even though they may be interleaved with reordered character/series/
     * artist tokens in the source. Malformed top-level syntax disables the whole action rather than guessing
     * past it, per the plan's safe-parsing section. */
    buildOrderedDraft(field) {
        if (this.currentMode() != 'tags') {
            return { 'blocked': 'Tag mode only: the ordered draft composer does not run against prose.', 'draft': null, 'before': null };
        }
        // Same guard the Add-missing and normalization paths carry, and for the same reason: "Use draft" and
        // "Insert at cursor" both write the raw field, and under a preset that REPLACES it that write would
        // never reach generation. Blocking with a reason beats a draft the user accepts and never sees.
        if (this.presetReplacesField(field)) {
            return { 'blocked': 'Active preset replaces this prompt - the draft would not reach generation.', 'draft': null, 'before': null };
        }
        let before = `${mState.params[field] || ''}`;
        let checked = MCoach.tokenizeChecked(before);
        if (checked.malformed) {
            return { 'blocked': 'Unbalanced quote or bracket syntax - fix it before building a draft.', 'draft': null, 'before': null };
        }
        let triggerIndex = this.activeLoraTriggerIndex();
        let buckets = { 'lead': [], 'subject': [], 'character': [], 'series': [], 'artist': [], 'general': [] };
        for (let token of checked.tokens) {
            let info = this.classifyToken(token, triggerIndex);
            buckets[MCoach.DRAFT_SLOT[info.kind]].push(token.raw.trim());
        }
        let draftTokens = [];
        for (let slot of MCoach.SECTION_ORDER) {
            draftTokens.push(...buckets[slot]);
        }
        return { 'blocked': null, 'draft': draftTokens.join(', '), 'before': before };
    }

    /** Replaces the whole field with the built draft, previewed and undoable. A no-op (draft already matches
     * the source, byte for byte) is reported without opening a confirm dialog - idempotent by construction,
     * since the draft is rebuilt fresh from whatever the field currently holds. */
    confirmUseDraft(field, rerender) {
        let plan = this.buildOrderedDraft(field);
        if (plan.blocked) {
            mUI.warn(plan.blocked);
            return false;
        }
        if (plan.draft == plan.before) {
            mUI.note('Already in doctrine order - nothing to change.');
            return false;
        }
        mUI.confirm(`Replace the prompt with the ordered draft?\n\nBefore:\n${plan.before || '(empty)'}\n\nAfter:\n${plan.draft}`, () => {
            let before = plan.before;
            mState.params[field] = plan.draft;
            this.undoFn = () => {
                mState.params[field] = before;
            };
            mState.changed();
            mUI.note('Prompt replaced with the ordered draft. Undo available.');
            rerender();
        });
        return true;
    }

    /** Inserts the built draft at the remembered caret via the same insertIntoPrompt path every other trigger
     * insertion in this client uses, previewed first. Restores the pre-insert text on Undo (mCreate.insertIntoPrompt
     * has no undo of its own). */
    confirmInsertDraftAtCursor(field, rerender) {
        let plan = this.buildOrderedDraft(field);
        if (plan.blocked) {
            mUI.warn(plan.blocked);
            return false;
        }
        let before = `${mState.params[field] || ''}`;
        mUI.confirm(`Insert the ordered draft at the cursor?\n\nDraft:\n${plan.draft}`, () => {
            mCreate.insertIntoPrompt(plan.draft);
            this.undoFn = () => {
                mState.params[field] = before;
            };
            mUI.note('Draft inserted. Undo available.');
            rerender();
        });
        return true;
    }

    // ---------------------------------------------------------------------------------------------------
    // Phase 3: LoRA roles, lazy metadata enrichment, locked preset rows, section-aware trigger insertion.
    // ---------------------------------------------------------------------------------------------------

    /** The user-assigned role for one LoRA ('Character'/'Series'/'Artist'/'Style'), or 'General' when none is
     * set. Keyed by the same normalized-name form (MState.starKey) every other model-identity lookup in this
     * client uses, so a Windows-path or extension mismatch never reads back as "no role assigned". */
    getLoraRole(name) {
        return mState.promptGuide.loraRoles[MState.starKey(name)] || 'General';
    }

    /** Sets (or, for 'General'/falsy, clears) a LoRA's assigned role. Clearing rather than storing 'General'
     * explicitly keeps the persisted blob free of default-value noise. */
    setLoraRole(name, role) {
        let key = MState.starKey(name);
        if (!role || role == 'General') {
            delete mState.promptGuide.loraRoles[key];
        }
        else {
            mState.promptGuide.loraRoles[key] = role;
        }
        mState.changed();
    }

    /** Active LoRAs as [{name, weight, locked}], sourced from the EFFECTIVE input (buildGenInput, which
     * includes preset-contributed loras/loraweights) rather than mState.getLoras() (manual-only). `locked` is
     * true for a name that only buildGenInput knows about - i.e. it was added by an active preset, not the
     * user - and the plan requires those rows be shown locked, with no role assignment or insertion action. */
    activeLoraRows() {
        // MState.starKey, not a bare stripModelExt+lowercase: a preset stores `ill\foo` where the picker
        // reported `ill/foo.safetensors`, and a separator mismatch reading as "preset-owned" would lock a row
        // the user added themselves.
        let manualNames = new Set(mState.getLoras().map(l => MState.starKey(l.name)));
        let input = mState.buildGenInput();
        let names = MState.toList(input['loras']);
        let weights = MState.toList(input['loraweights']);
        return names.map((name, i) => ({
            'name': name,
            'weight': weights.length > i ? (parseFloat(weights[i]) || 1) : 1,
            'locked': !manualNames.has(MState.starKey(name))
        }));
    }

    /** Lazily fetches DescribeModel for active LoRAs m_create.js's picker has not already cached - never for
     * the catalog, and never more than once per name per session regardless of how many times the sheet
     * re-renders (enrichInFlight while a request is outstanding, enrichFailed once it has come back empty, and
     * the loraMap cache itself once it succeeds all gate a repeat request for the same name). A successful
     * response is written into mCreate.loraMap under both the full and extension-stripped name, so a later
     * picker or coach open reuses it instead of asking again. */
    enrichActiveLoras(rerender) {
        for (let row of this.activeLoraRows()) {
            let stripped = MState.stripModelExt(row.name);
            let cached = mCreate.loraMap && (mCreate.loraMap.get(row.name) || mCreate.loraMap.get(stripped));
            if (cached || this.enrichInFlight.has(row.name) || this.enrichFailed.has(row.name)) {
                continue;
            }
            this.enrichInFlight.add(row.name);
            genericRequest('DescribeModel', { 'modelName': row.name, 'subtype': 'LoRA' }, data => {
                this.enrichInFlight.delete(row.name);
                if (data && data.model) {
                    if (!mCreate.loraMap) {
                        mCreate.loraMap = new Map();
                    }
                    mCreate.loraMap.set(row.name, data.model);
                    mCreate.loraMap.set(stripped, data.model);
                }
                else {
                    this.enrichFailed.add(row.name);
                }
                rerender();
            }, 0, () => {
                this.enrichInFlight.delete(row.name);
                this.enrichFailed.add(row.name);
            });
        }
    }

    /** Coverage status for one LoRA's exact metadata trigger against the current positive prompt: 'covered'
     * when the bundled `<trigger>` shortcut is present (the plan requires that count as covering every active
     * trigger at once) or the literal phrase already appears, otherwise 'missing'. */
    loraTriggerStatus(trigger) {
        let prompt = `${mState.params['prompt'] || ''}`;
        if (prompt.includes('<trigger>')) {
            return 'covered';
        }
        return prompt.includes(trigger) ? 'covered' : 'missing';
    }

    /** Preview for inserting `trigger` into the tag section `role` implies, splicing new text into the source
     * string at the boundary between whatever's already classified into an earlier section and whatever's
     * classified into a later one - everything else's bytes are untouched, only the insertion itself is new
     * text. Returns {sectioned: false} outside Tags mode or when the prompt's syntax is too broken to section
     * reliably; the caller falls back to the plain caret insertion every other trigger action in this client
     * already uses, which is still better than refusing outright. */
    planSectionInsert(trigger, role) {
        // A preset that replaces the positive prompt blocks BOTH branches - the sectioned splice and the
        // plain caret fallback write the same raw field, and neither would reach generation.
        if (this.presetReplacesField('prompt')) {
            return { 'sectioned': false, 'blocked': 'Active preset replaces this prompt - the insertion would not reach generation.' };
        }
        if (this.currentMode() != 'tags') {
            return { 'sectioned': false, 'blocked': null };
        }
        let before = `${mState.params['prompt'] || ''}`;
        let checked = MCoach.tokenizeWithOffsets(before);
        if (checked.malformed) {
            return { 'sectioned': false, 'blocked': null };
        }
        let triggerIndex = this.activeLoraTriggerIndex();
        let slot = MCoach.ROLE_SLOT[role] || 'general';
        let slotIndex = MCoach.SECTION_ORDER.indexOf(slot);
        let insertBefore = null;
        for (let token of checked.tokens) {
            let info = this.classifyToken(token, triggerIndex);
            if (MCoach.SECTION_ORDER.indexOf(MCoach.DRAFT_SLOT[info.kind]) > slotIndex) {
                insertBefore = token;
                break;
            }
        }
        let after;
        if (!insertBefore) {
            let trimmed = before.trimEnd();
            if (trimmed == '') {
                after = trigger;
            }
            else {
                after = trimmed.endsWith(',') ? `${trimmed} ${trigger}` : `${trimmed}, ${trigger}`;
            }
        }
        else {
            let prefix = before.slice(0, insertBefore.start);
            let insertText = `${trigger},`;
            if (prefix.length > 0 && !/\s$/.test(prefix)) {
                insertText = ` ${insertText}`;
            }
            let nextChar = before[insertBefore.start] || '';
            if (!/\s/.test(nextChar)) {
                insertText += ' ';
            }
            after = prefix + insertText + before.slice(insertBefore.start);
        }
        return { 'sectioned': true, 'blocked': null, 'before': before, 'after': after };
    }

    /** The row's plain "Insert exact trigger": the literal phrase at the remembered caret, through the same
     * insertIntoPrompt path every other trigger chip in this client uses - but behind the same preset guard,
     * since it writes the same raw field. Returns true when it wrote. */
    insertLiteralTrigger(trigger) {
        if (this.presetReplacesField('prompt')) {
            mUI.warn('Active preset replaces this prompt - the insertion would not reach generation.');
            return false;
        }
        mCreate.insertIntoPrompt(trigger);
        mUI.note(`Inserted "${trigger}".`);
        return true;
    }

    /** Preview-then-write for the LoRA row's "Prompt" action: section-aware when possible, previewed via
     * mUI.confirm like every other mutation in this file, undoable for one step. Falls back to the plain
     * literal caret insertion (no dialog - matching the existing "Insert exact trigger" behavior) when
     * section-aware placement is not available. */
    confirmInsertTrigger(trigger, role, rerender) {
        let plan = this.planSectionInsert(trigger, role);
        if (plan.blocked) {
            mUI.warn(plan.blocked);
            return;
        }
        if (!plan.sectioned) {
            this.insertLiteralTrigger(trigger);
            rerender();
            return;
        }
        mUI.confirm(`Insert "${trigger}" into the ${role} section?\n\nBefore:\n${plan.before || '(empty)'}\n\nAfter:\n${plan.after}`, () => {
            let before = plan.before;
            mState.params['prompt'] = plan.after;
            this.undoFn = () => {
                mState.params['prompt'] = before;
            };
            mState.changed();
            mUI.note(`Inserted "${trigger}" into ${role}. Undo available.`);
            rerender();
        });
    }

    /** Builds the slim pill that sits beside the prompt heading in m_create.js. Never launches a wizard on
     * its own - tapping it opens the bottom sheet, exactly like the plan's entry-point mock. */
    buildPill() {
        let pill = mUI.el('button', 'm-coach-pill');
        pill.type = 'button';
        pill.addEventListener('click', () => this.openSheet());
        this.pillEl = pill;
        this.renderPill();
        // Registered once for the life of the page, not once per pill: mState.onChange has no deregistration,
        // so a second Create build would otherwise leave the first, dead pill's callback running forever. The
        // callback reads this.pillEl fresh, so it always renders whichever pill is current.
        if (!this.pillListenerBound) {
            this.pillListenerBound = true;
            mState.onChange(() => this.renderPill());
        }
        return pill;
    }

    /** Refreshes the pill's label from the current resolution/mode/advisory count. */
    renderPill() {
        if (!this.pillEl) {
            return;
        }
        let resolved = this.resolveProfile();
        let modeLabel = { 'tags': 'Tags', 'natural': 'Natural', 'hybrid': 'Hybrid' }[this.currentMode()];
        let profileLabel = resolved.profile ? resolved.profile.label : (resolved.family ? 'Anima - pick variant' : 'No coach');
        let count = this.advisories(resolved).length;
        this.pillEl.textContent = `${profileLabel} · ${modeLabel}${count > 0 ? `        ${count} advisor${count == 1 ? 'y' : 'ies'} ›` : ' ›'}`;
    }

    /** Profile section: effective checkpoint, resolved profile + confidence, the variant chooser (built-in
     * profiles plus any custom ones), "Remember for this checkpoint", and the phase-5 "new custom profile"
     * inline form. */
    buildProfileSection(resolved, rerender) {
        let section = mUI.el('div', 'm-coach-section');
        section.appendChild(mUI.el('div', 'm-coach-section-title', 'Profile'));
        let model = this.effectiveModel();
        section.appendChild(mUI.el('div', 'm-coach-checkpoint', model ? mUI.modelName(model) : 'No checkpoint selected'));
        let confidenceLabel = { 'explicit': 'confirmed', 'inferred': 'suggested', 'unassigned': 'unassigned' }[resolved.confidence];
        section.appendChild(mUI.el('div', 'm-coach-confidence',
            resolved.profile ? `${resolved.profile.label} (${confidenceLabel})` : `No profile (${confidenceLabel})`));
        let choices = mUI.el('div', 'm-coach-profile-choices');
        let overrideId = mState.promptGuide.checkpointProfiles[MCoach.normalizedPath(model)];
        let options = [['', 'Auto'], ['anima-base', 'Anima Base'], ['anima-aesthetic', 'Anima Aesthetic'],
            ['anima-turbo', 'Anima Turbo'], ['generic', 'Generic / off']];
        for (let id in mState.promptGuide.customProfiles) {
            options.push([id, mState.promptGuide.customProfiles[id].label]);
        }
        for (let option of options) {
            let button = mUI.el('button', 'm-coach-profile-choice', option[1]);
            let active = (option[0] == '' && !overrideId) || option[0] == overrideId;
            button.classList.toggle('m-coach-choice-active', active);
            button.addEventListener('click', () => {
                this.setProfileOverride(option[0] == '' ? null : option[0]);
                rerender();
            });
            choices.appendChild(button);
            if (option[0].startsWith('custom:')) {
                let del = mUI.el('button', 'm-coach-profile-delete', '×');
                del.setAttribute('aria-label', `Delete ${option[1]}`);
                del.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.removeCustomProfile(option[0]);
                    rerender();
                });
                choices.appendChild(del);
            }
        }
        section.appendChild(choices);
        let newToggle = mUI.el('button', 'm-coach-custom-toggle', this.customFormOpen ? 'Cancel new profile' : '+ New custom profile');
        newToggle.addEventListener('click', () => {
            this.customFormOpen = !this.customFormOpen;
            rerender();
        });
        section.appendChild(newToggle);
        if (this.customFormOpen) {
            section.appendChild(this.buildCustomProfileForm(rerender));
        }
        return section;
    }

    /** The phase-5 "new custom profile" inline form: name plus comma-separated positive/negative lists. Saves
     * into mState.promptGuide.customProfiles and immediately sets it as the override for the effective
     * checkpoint - the same "confirm once, it's remembered" flow as picking a built-in profile. */
    buildCustomProfileForm(rerender) {
        let wrap = mUI.el('div', 'm-coach-custom-form');
        let nameInput = mUI.el('input', 'm-coach-custom-input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Profile name';
        let posInput = mUI.el('input', 'm-coach-custom-input');
        posInput.type = 'text';
        posInput.placeholder = 'Positive prefix (comma-separated)';
        let negInput = mUI.el('input', 'm-coach-custom-input');
        negInput.type = 'text';
        negInput.placeholder = 'Negative suggested (comma-separated)';
        let save = mUI.el('button', 'm-coach-custom-save', 'Save custom profile');
        save.addEventListener('click', () => {
            let name = nameInput.value.trim();
            if (!name) {
                mUI.warn('Custom profile needs a name.');
                return;
            }
            let splitList = (val) => `${val}`.split(',').map(s => s.trim()).filter(s => s.length > 0);
            let id = this.addCustomProfile({
                'label': name,
                'positivePrefix': splitList(posInput.value),
                'negativeSuggested': splitList(negInput.value),
                'scoreForbidden': false,
                'parameterAdvice': null
            });
            this.setProfileOverride(id);
            this.customFormOpen = false;
            rerender();
        });
        wrap.appendChild(nameInput);
        wrap.appendChild(posInput);
        wrap.appendChild(negInput);
        wrap.appendChild(save);
        return wrap;
    }

    /** Mode section: Tags / Natural language / Hybrid, with the natural-language tip text from the plan. */
    buildModeSection(rerender) {
        let section = mUI.el('div', 'm-coach-section');
        section.appendChild(mUI.el('div', 'm-coach-section-title', 'Mode'));
        let row = mUI.el('div', 'm-coach-mode-row');
        let modes = [['tags', 'Tags'], ['natural', 'Natural language'], ['hybrid', 'Hybrid']];
        let current = this.currentMode();
        for (let mode of modes) {
            let button = mUI.el('button', 'm-coach-mode-choice', mode[1]);
            button.classList.toggle('m-coach-choice-active', mode[0] == current);
            button.addEventListener('click', () => {
                this.setMode(mode[0]);
                rerender();
            });
            row.appendChild(button);
        }
        section.appendChild(row);
        if (current == 'natural') {
            section.appendChild(mUI.el('div', 'm-coach-tip',
                'Use ordinary capitalization for names, write at least two sentences, and describe each '
                + "character's appearance in multi-character scenes. The coach will not rewrite this text."));
        }
        else if (current == 'hybrid') {
            section.appendChild(mUI.el('div', 'm-coach-tip',
                'The coach manages only known prefix/artist/LoRA items here. The freeform caption block is left untouched.'));
        }
        return section;
    }

    /** Setup and advisories section: one row per item from advisories(), with an Apply action where one
     * exists. Score-tag and pure-info rows have no button - they are read-only by design. */
    buildSetupSection(resolved, rerender) {
        let section = mUI.el('div', 'm-coach-section');
        section.appendChild(mUI.el('div', 'm-coach-section-title', 'Setup and advisories'));
        let rows = this.advisories(resolved);
        if (rows.length == 0) {
            section.appendChild(mUI.el('div', 'm-coach-empty',
                resolved.profile ? 'Nothing to fix right now.' : 'Pick a profile above to see setup advice.'));
            return section;
        }
        for (let row of rows) {
            let rowEl = mUI.el('div', 'm-coach-advisory-row');
            rowEl.appendChild(mUI.el('span', 'm-coach-advisory-text', row.text));
            if (row.kind == 'addPositive') {
                let button = mUI.el('button', 'm-coach-apply-button', 'Add missing');
                button.addEventListener('click', () => {
                    this.confirmAddMissing('prompt', resolved.profile.positivePrefix, 'positive', rerender);
                });
                rowEl.appendChild(button);
            }
            else if (row.kind == 'addNegative') {
                let button = mUI.el('button', 'm-coach-apply-button', 'Merge missing');
                button.addEventListener('click', () => {
                    this.confirmAddMissing('negativeprompt', resolved.profile.negativeSuggested, 'negative', rerender);
                });
                rowEl.appendChild(button);
            }
            else if (row.kind == 'paramAdvice') {
                let button = mUI.el('button', 'm-coach-apply-button', 'Apply');
                button.addEventListener('click', () => {
                    mUI.confirm(row.text, () => {
                        this.applyParamAdvice(resolved.profile);
                        rerender();
                    });
                });
                rowEl.appendChild(button);
            }
            section.appendChild(rowEl);
        }
        if (this.undoFn) {
            let undoButton = mUI.el('button', 'm-coach-undo-button', 'Undo last Coach change');
            undoButton.addEventListener('click', () => {
                this.undo();
                rerender();
            });
            section.appendChild(undoButton);
        }
        return section;
    }

    /** Phase-4 "Tag tools" section: the normalization preview action and the ordered-draft composer. Both are
     * Tags-mode-only - the section shows a tip instead of the controls otherwise, since neither action is
     * meaningful (or, per product rule, permitted) against prose or a hybrid caption block. */
    buildTagToolsSection(rerender) {
        let section = mUI.el('div', 'm-coach-section');
        section.appendChild(mUI.el('div', 'm-coach-section-title', 'Tag tools'));
        if (this.currentMode() != 'tags') {
            section.appendChild(mUI.el('div', 'm-coach-tip', 'Switch to Tags mode to normalize tags or build an ordered draft.'));
            return section;
        }
        let normRow = mUI.el('div', 'm-coach-advisory-row');
        normRow.appendChild(mUI.el('span', 'm-coach-advisory-text',
            'Normalize tags: lowercase, underscores to spaces (score_* and LoRA trigger text kept literal)'));
        let normBtn = mUI.el('button', 'm-coach-apply-button', 'Normalize');
        normBtn.addEventListener('click', () => this.confirmNormalize('prompt', 'positive', rerender));
        normRow.appendChild(normBtn);
        section.appendChild(normRow);
        let draftPlan = this.buildOrderedDraft('prompt');
        if (draftPlan.blocked) {
            section.appendChild(mUI.el('div', 'm-coach-tip', draftPlan.blocked));
            return section;
        }
        section.appendChild(mUI.el('div', 'm-coach-draft-preview', draftPlan.draft || '(empty)'));
        let actions = mUI.el('div', 'm-coach-draft-actions');
        let empty = `${mState.params['prompt'] || ''}`.trim() == '';
        let primary = mUI.el('button', 'm-coach-apply-button', empty ? 'Use draft' : 'Insert at cursor');
        primary.addEventListener('click', () => {
            if (empty) {
                this.confirmUseDraft('prompt', rerender);
            }
            else {
                this.confirmInsertDraftAtCursor('prompt', rerender);
            }
        });
        actions.appendChild(primary);
        if (!empty) {
            let replace = mUI.el('button', 'm-coach-apply-button', 'Use draft (replace)');
            replace.addEventListener('click', () => this.confirmUseDraft('prompt', rerender));
            actions.appendChild(replace);
        }
        let copy = mUI.el('button', 'm-coach-apply-button', 'Copy');
        copy.addEventListener('click', () => {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(draftPlan.draft || '').then(() => mUI.note('Draft copied.'), () => mUI.warn('Copy failed.'));
            }
        });
        actions.appendChild(copy);
        section.appendChild(actions);
        return section;
    }

    /** Active-LoRA section: one row per effective LoRA (activeLoraRows, which includes preset-supplied ones).
     * A locked (preset-owned) row shows status only - no role selector, no insertion action, per the plan's
     * "mark preset-owned LoRAs as locked". An unlocked row gets a role selector (persisted via setLoraRole),
     * the existing literal "Insert exact trigger", and the new section-aware "Prompt" action. Metadata for a
     * row m_create.js has not cached yet is fetched lazily via enrichActiveLoras - bounded to active rows,
     * never the catalog. Prompt-syntax `<lora:...>` activations found directly in the prompt text are listed
     * separately, per the plan's "reported separately, not an exhaustive list" requirement. */
    buildLoraSection(resolved) {
        let section = mUI.el('div', 'm-coach-section');
        section.appendChild(mUI.el('div', 'm-coach-section-title', 'Active LoRAs'));
        let rows = this.activeLoraRows();
        if (rows.length == 0) {
            section.appendChild(mUI.el('div', 'm-coach-empty', 'No active LoRAs.'));
        }
        else {
            this.enrichActiveLoras(() => this.refreshSheet());
            let checkpointCompat = mState.activeModelCompat();
            for (let row of rows) {
                let rowEl = mUI.el('div', 'm-coach-lora-row');
                let model = mCreate.loraByName(row.name);
                rowEl.appendChild(mUI.el('div', 'm-coach-lora-name', mUI.modelName(row.name) + (row.locked ? ' (preset)' : '')));
                let trigger = `${model.trigger_phrase || ''}`.trim();
                let statusText = !trigger ? 'No metadata'
                    : this.loraTriggerStatus(trigger) == 'covered' ? `Trigger: ${trigger} (covered)` : `Trigger: ${trigger} (missing)`;
                rowEl.appendChild(mUI.el('div', 'm-coach-lora-sub', statusText));
                let loraCompat = mState.compatClassOf('LoRA', row.name);
                if (checkpointCompat && loraCompat && loraCompat != checkpointCompat) {
                    rowEl.appendChild(mUI.el('div', 'm-coach-lora-warning', `May not load on ${checkpointCompat}`));
                }
                if (row.locked) {
                    rowEl.appendChild(mUI.el('div', 'm-coach-lora-locked', 'Locked - added by an active preset.'));
                    section.appendChild(rowEl);
                    continue;
                }
                let roleRow = mUI.el('div', 'm-coach-role-row');
                let currentRole = this.getLoraRole(row.name);
                for (let role of ['Character', 'Series', 'Artist', 'Style', 'General']) {
                    let btn = mUI.el('button', 'm-coach-role-choice', role);
                    btn.classList.toggle('m-coach-choice-active', role == currentRole);
                    btn.addEventListener('click', () => {
                        this.setLoraRole(row.name, role);
                        this.refreshSheet();
                    });
                    roleRow.appendChild(btn);
                }
                rowEl.appendChild(roleRow);
                if (trigger) {
                    let actions = mUI.el('div', 'm-coach-lora-actions');
                    let insert = mUI.el('button', 'm-coach-lora-insert', 'Insert exact trigger');
                    insert.addEventListener('click', () => {
                        // Literal phrase, via the same caret-aware insertion the prompt box itself uses - not
                        // insertTriggerTag(), which inserts the bundled `<trigger>` shortcut and would silently
                        // discard which exact phrase the user meant to place.
                        this.insertLiteralTrigger(trigger);
                    });
                    actions.appendChild(insert);
                    let promptAction = mUI.el('button', 'm-coach-lora-insert', 'Prompt');
                    promptAction.addEventListener('click', () => {
                        this.confirmInsertTrigger(trigger, currentRole, () => this.refreshSheet());
                    });
                    actions.appendChild(promptAction);
                    rowEl.appendChild(actions);
                }
                section.appendChild(rowEl);
            }
        }
        let checked = MCoach.tokenizeChecked(mState.params['prompt'] || '');
        if (!checked.malformed) {
            let promptLoras = checked.tokens.map(t => t.raw.trim()).filter(raw => /^<lora:/i.test(raw));
            if (promptLoras.length > 0) {
                section.appendChild(mUI.el('div', 'm-coach-lora-prompt-syntax',
                    `Prompt-syntax LoRA(s) found directly in the prompt text (not the LoRA parameter list, not covered above): ${promptLoras.join(', ')}`));
            }
        }
        return section;
    }

    /** Opens the bottom sheet: Profile, Mode, Setup and advisories, Tag tools, Active LoRAs, top to bottom.
     * Rebuilt wholesale on every internal action (profile switch, apply, undo, role change) rather than
     * patched in place - the sheet is short-lived and every section depends on the same resolved profile, so
     * a partial patch would only reintroduce the staleness bugs the rest of this client works to avoid. */
    openSheet() {
        let content = mUI.el('div', 'm-coach-sheet');
        this.sheetContent = content;
        this.sheetRerender = () => this.refreshSheet();
        // Opened (and therefore CONNECTED to the document) before the first render, so refreshSheet's
        // is-the-sheet-still-open guard below sees a live element rather than a detached one.
        mUI.openSheet(content);
        this.refreshSheet();
    }

    /** Rebuilds the open sheet's content in place. Split out from openSheet so lazy async work (DescribeModel
     * enrichment) can trigger exactly a rebuild, not a second stacked sheet. Safe to call with no sheet open -
     * it is a no-op then, since a closed sheet has no rerender registered. */
    refreshSheet() {
        if (!this.sheetContent || !this.sheetRerender) {
            return;
        }
        // mUI.openSheet owns dismissal (backdrop tap / grip drag) and offers no close callback, so "is the
        // sheet still open" is asked of the DOM. Without this a DescribeModel response that lands after the
        // user swiped the sheet away would rebuild a detached tree - and, worse, buildLoraSection would call
        // enrichActiveLoras again for a sheet nobody is looking at. Clearing both fields also lets the next
        // openSheet start from a clean slate.
        if (!this.sheetContent.isConnected) {
            this.sheetContent = null;
            this.sheetRerender = null;
            return;
        }
        // Re-entrancy guard: buildLoraSection kicks off enrichActiveLoras, whose completion callback asks for
        // exactly this rebuild. A transport that answers synchronously would therefore wipe and re-fill
        // `content` from inside the loop that is still appending to it, ending with duplicated or missing
        // sections. The outer pass is about to render the same fresh state anyway, so the inner one is dropped.
        if (this.rendering) {
            return;
        }
        this.rendering = true;
        let content = this.sheetContent;
        let rerender = this.sheetRerender;
        try {
            content.innerHTML = '';
            let resolved = this.resolveProfile();
            content.appendChild(this.buildProfileSection(resolved, rerender));
            content.appendChild(this.buildModeSection(rerender));
            content.appendChild(this.buildSetupSection(resolved, rerender));
            content.appendChild(this.buildTagToolsSection(rerender));
            content.appendChild(this.buildLoraSection(resolved));
        }
        finally {
            this.rendering = false;
        }
    }
}

mCoach = new MCoach();
