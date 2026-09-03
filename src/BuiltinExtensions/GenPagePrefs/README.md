# GenPage Prefs

Stores the Generate tab's six batch-view switches on your SwarmUI account instead of leaving them in browser
storage, so they follow the user rather than the browser profile.

The switches are the ones behind the batch gear icon, above the batch image strip:

| Switch | Stored key | Core default when nothing is stored |
|---|---|---|
| Auto Clear Batch | `autoClearBatch` | off |
| Auto Swap To Previews | `autoLoadPreviews` | off |
| Auto Swap To Images | `autoLoadImages` | on |
| Show Load Spinners | `showLoadSpinners` | on |
| Separate Batches | `separateBatches` | off |
| Play Videos | `playBatchVideos` | on |

## Why

Core keeps these in `localStorage`, and `currentimagehandler.js` reads each key back into `.checked` at script
time. That store is per origin and per browser profile, and any "clear cookies and site data on exit" setting
wipes it. Reaching the same server over a second address, or simply closing the browser, therefore reset the
switches to defaults. Two of the defaults are the opposite of what a user who wants previews and images to swap
automatically would pick, so the reset was visible every time.

## How it works

`Assets/genpage_prefs.js` runs from `sessionReadyCallbacks`, which fires after core's own script-time read, so the
account copy wins. It applies the stored values, attaches a `change` listener to each switch, and writes back on a
400 ms debounce so flipping several in a row costs one request.

It also mirrors every applied value into `localStorage` under the same key core uses. That is deliberate: core's
script-time read is what paints the switches before this extension's request returns, so keeping the local copy
current prevents a visible flip on each page load, and leaves a working fallback when the server call fails.

Storage is one JSON blob in the user's generic data, bucket `genpage_prefs`, entry `batch_toggles`. One blob means
one read, one write, and no migration step when a switch is added or removed.

## API

Both routes are in `GenPagePrefsAPI.cs` and reuse core's existing user-settings permissions rather than
registering new ones, because that is what these are.

| Route | Permission | Purpose |
|---|---|---|
| `GetGenPagePrefs` | `read_user_settings` | Returns `{"prefs": {...}}`. A user who has never saved gets `{}`, not server-side defaults. |
| `SetGenPagePrefs` | `edit_user_settings` | Replaces the stored blob. Filters to the six known keys and coerces each to a boolean. |

## Gotchas

- **Send the toggles flat, not wrapped in a `prefs` field.** A `JObject` API parameter is handed the whole request
  payload with `session_id` stripped, not the field that happens to share the parameter's name. Nesting them makes
  every known key miss, and the route then stores `{}` and reports success. TagDex documents the same trap.
- **`SetGenPagePrefs` replaces, it does not merge.** The client always sends all six, so this is correct as
  written; a future partial caller would silently drop the keys it omitted.
- **A corrupt stored blob is ignored, not fatal.** The read logs a warning and reports defaults, because failing a
  page load over an unparseable preference would be worse than losing the preference.
- **Applying a stored value fires no `change` event.** Setting `.checked` from script does not run core's
  handler, which is fine for the five switches that are only read back later, but `Play Videos` acts on the
  `<video>` elements already on screen. `applyHooks` names core's `togglePlayBatchVideos` so it is called
  explicitly when applying actually flips that switch. A switch added later with the same shape needs an entry
  there too.
- **Release builds cache extension assets in memory.** Edits to `genpage_prefs.js` do nothing until the server
  restarts, and the browser then needs a hard refresh.
- This extension does not remove core's `localStorage` writes; core still makes them, and they are used as the
  pre-paint cache described above.
