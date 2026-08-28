# HANDOFF

**Updated:** 2026-08-27 · **Branch:** main · **Base:** 70b5e459 (= origin/main) · **Tree:** dirty (`AGENTS.md` only)

## State
TagDex Characters tab is fixed and committed; server-side verified against the live instance. Anima
black-image faults root-caused and fixed by a server setting (`Data/Settings.fds`, untracked).

## Done this session
- **TagDex: 3 bugs + 2 new buttons** — commit `e0813155`. Reference generation never worked at all; every
  copyright folder read as empty; added set-from-current-image and delete.
- **Anima black images: fp16 overflow in the DiT.** SwarmUI auto-injects `--fast fp16_accumulation`
  (`ComfyUISelfStartBackend.cs:362`), which sets ComfyUI's `PRIORITIZE_FP16`, which forces the bf16 Anima
  weights to fp16 (`model_management.py:1140`). Disabled via `Performance.AllowGpuSpecificOptimizations:
  false`. Backend now logs `model weight dtype torch.bfloat16, manual cast: None`. One test gen came out
  normal (mean luminance 178); the fault is intermittent, so that is not yet proof.

## Open
1. **Hard-refresh the browser (Ctrl+Shift+R)** before testing the Characters tab. Asset URLs carry
   `?vary=<commit read at startup>`; the server started before `e0813155`, so cached JS still wins.
2. **Re-run the prompts that reliably went black** and confirm they no longer do. This is the only real
   proof the fp16 fix holds.
3. **Move Characters into the Generate bottom bar.** No extension hook exists — `WebServer.cs:345-359`
   discovers `Tabs/Text2Image/*.html` into `T2ITabHeader`/`T2ITabBody` only (rendered at
   `Text2Image.cshtml:58,79`); the bottom strip is hardcoded in `_Generate/GenerateTab.cshtml` (nav items
   ~164-187, panes ~234-258). Cheapest path: mirror the existing hook — discover `Tabs/GenerateBottom/*.html`
   into new `T2IBottomTabHeader`/`T2IBottomTabBody`, insert both as placeholders in `GenerateTab.cshtml`,
   then move `TagDex/Tabs/Text2Image/Characters.html` across. Two small append-only core edits, upstreamable,
   record in Fork Delta. Card layout in the narrower panel is the long pole (chip rows will wrap).
4. **`AGENTS.md` is dirty with edits not from this session** — a GPU-acceleration-gate bullet and a change to
   the post-upstream-merge step. Left uncommitted deliberately; review and commit separately.
5. If black images recur with the DiT in bf16, the next suspect is **`comfy-aimdo`** (`DynamicVRAM support
   detected and enabled`, async weight offloading) — not audited.
6. **TagDex per-user settings are unread** — VAE override, tiled VAE, thumb prompt suffix live in
   `Data/Users.ldb` (LiteDB binary), not inspectable from disk.
7. Carried forward: no auth is set (blank `Network.AuthBypassIPs` if ever enabled); model metadata pull is
   per-model only; 23 sweep candidates parked — `docs/TagDex-Plan.md`, `docs/MobilePWA-Optimization-Plan.md`.

## Decisions
- **`AllowGpuSpecificOptimizations: false`** over `DisableInternalArgs: true` — the surgical alternative means
  hand-maintaining `--front-end-version`, which goes stale on every frontend bump.
- **Kept `--use-sage-attention`.** It cannot reach Anima: the DiT calls `F.scaled_dot_product_attention`
  directly (`comfy/ldm/anima/model.py:80`), and the masked Qwen3 encoder falls back to pytorch attention
  because sageattention 2.2.0's `sageattn()` has no `attn_mask` parameter.
- **Unwrapped `rawInput["rawInput"]`** rather than renaming the parameter — the binder ignores the name
  entirely, so no name would have worked.
- **Delete button is conditional on `record.thumb`** — a card on the placeholder has no file behind it.
- Anima text encoder left alone: `llama_detect` reads the file's own dtype, so it is already bf16. The
  `dtype: torch.float16` line in the backend log is the pre-override default and is misleading.

## Traps
- **`\s` in `Data/Settings.fds` paths is FDS escaping for a literal backslash, not corruption.** `E:\smodels`
  decodes to the real models root. Do not "fix" it — an unescaped path is what is wrong. Same scheme as `\x`
  for null, visible in `Backends.fds`.
- **A running server blocks a rebuild** (locks `SwarmUI.exe`) **and owns `Data/Settings.fds`.** Stop it with
  the `ShutdownServer` API, not a kill; relaunch with `Start_SwarmUI.ps1`, which is idempotent.
- **Build with `-o src/bin/live_release`.** A plain `--configuration Release` writes `src/bin/Release`, which
  the launcher does not run.
- **A `JObject` API parameter receives the whole request payload, not the field matching its name**
  (`APICallReflectBuilder.cs:46`). This is what broke reference generation; it will break the next route too.
- **`AllowGpuSpecificOptimizations: false` also downgrades** `fp8_e4m3fn_fast` to `fp8_e4m3fn` for large
  models (`WorkflowGeneratorModelSupport.cs:1064`) — slower on Flux/Qwen-Image, no quality loss.
- **`?vary=` is the git commit read at startup**, so restarting before committing serves new bytes under the
  old URL — and committing after a restart leaves stale bytes cached.

## Verify
```powershell
dotnet build SwarmUI.sln --configuration Release
dotnet format --verify-no-changes
dotnet format style --verify-no-changes
# Build the binaries the launcher actually runs (stop the server first):
dotnet build src/SwarmUI.csproj --configuration Release -o src/bin/live_release
# No automated tests. Validate by running the live app in a browser.
```
