# MobileEnhancements

Fork-owned builtin extension that makes SwarmUI feel robust, fluid, and intuitive on phones and as an installed Progressive Web App (PWA).

It is intentionally built as a self-contained extension (new files only, zero edits to core SwarmUI files) so that upstream merges stay clean. See [`docs/MobilePWA-Optimization-Plan.md`](/docs/MobilePWA-Optimization-Plan.md) for the full phased plan, verified design facts, verification gates, and the coupling watchlist to re-check after upstream merges.

## What it does

- **PWA installability**: serves a web manifest (`/manifest.json`) and a root-scoped service worker (`/sw.js`), and injects the `theme-color` / apple-mobile-web-app / touch-icon `<head>` tags. The service worker is deliberately conservative — network-first for HTML/JS/CSS (so a server update is never stuck behind a stale cache), cache-first only for long-lived static assets (icons, fonts), and an offline fallback page for navigations. It never touches `/API/`, `/View/`, `/Output/`, or `/Audio/`.
- **Viewport fix**: replaces the core `maximum-scale=1.0` viewport (which blocks pinch zoom) with a mobile-friendly one that restores pinch zoom, enables iOS safe-area insets, and lets the on-screen keyboard resize content.
- **Mobile CSS**: scoped under `body.small-window` / `body.coarse-pointer` / `body.pwa-standalone` so desktop is untouched.
- **Civitai share-to-download**: the manifest declares a `share_target`, so when installed the app appears in the OS share sheet. Sharing a Civitai model link routes to the `/ShareTarget` route, which redirects into the app; `mobile_share.js` then opens the Utilities > Model Downloader tab and prefills the shared URL so its Civitai metadata loads automatically. Non-Civitai shares open the downloader empty.


## /simple FL2VA same-frame prep

For MiniMax H3 FL2VA same-frame / 360-orbit presets (at least minimax/FL2VA_360_Orbit_Eros, plus any title matching FL2VA + orbit/360/same-frame, or extras in localStorage.m_client_same_frame_presets):

- **Same as start** toggle (default ON) mirrors Start frame into End whenever Start is set or changes.
- **Auto-scale** scales Start (and End when mirrored) so the shortest side is 768, preserves the aspect ratio, and rounds dimensions to the nearest multiple of 32 without adding padding - client-side canvas processing for the FL2VA workflow. Browser canvas uses imageSmoothingQuality='high' rather than true LANCZOS; a future server-side hook would be more accurate.
- Frame **+** buttons still open the existing server image browser (m_image_browser.js).

Implemented in Assets/m/m_frame_prep.js (wired from m_create.js). Restart the SwarmUI server after pulling so GetLazy reloads OtherAssets.

## /simple image folders

Use an image attachment **+**, or a Start/End frame **+**, to open the image browser. **Output** keeps the existing output favorites in a dropdown, with **Edit** beside it. **Drives** lists the drives on the SwarmUI host. The folder list and image grid scroll separately. Open folders, use **Up**, or enter an absolute folder path and select **Go**. Image previews load as they enter view. **Load More** adds the next page in large folders.

Drives requires the **Browse Server Images** role permission (`browse_server_images`), enabled by default for administrators. The permission grants image access across the host's filesystem, including mounted drives and readable network shares. Operating system access restrictions still apply. The browser shows folders and supported bitmap images only. It does not change source files. Selected images become normal attachments for prompt images and Start/End frames, including when the PWA runs on a phone.

Supported formats: PNG, JPEG, WebP, GIF, BMP, and TIFF. Files must decode as images and must be no larger than 32 MiB. The **From Phone** option continues to use the device picker.

Restart SwarmUI after installing the change, then reload the PWA with its cache cleared. Release servers hold extension assets in memory until restart.

## /simple Create layout

Preset Folder and Preset share the first control row. Checkpoint and LoRA share the next row. Generate stays above the prompt. The photo row contains the attachment button, Clear, autocomplete suggestions, and Enhance, followed by attached thumbnails. Clear removes only prompt photos and is disabled when none are attached. Suggestions do not cover Generate or resize the action row. Seed and Prefix share one row. Steps/CFG, Sampler/Scheduler, and Aspect/Side Length remain paired below it. The Upscale/Method row is hidden.

Prefix has no separate visible label and disables contact autofill hints, automatic capitalization, autocorrection, and spelling checks. Sampler and Scheduler display their selected values without repeated labels. Aspect and Side Length keep accessible names and dimension tooltips without top labels. Reset Params remains at the bottom of Create. Characters remains available from the bottom navigation.

## /simple attached photo cropping

Open an attached photo to edit it. On desktop, drag across the image to create a crop. Drag a corner handle to resize the crop, or drag inside a smaller crop to move it. Mouse drags continue outside the image and stay within its boundaries. Touch cropping still uses the corner handles. Save applies the crop to the attachment; Cancel keeps the original attachment.

## Icons

`Assets/icons/*` are generated from the repo's `src/wwwroot/favicon.ico` (128×128, upscaled). They are a functional placeholder — dropping a higher-resolution source logo in and regenerating the PNGs (192, 512, maskable 512, apple-touch 180) is a clean drop-in improvement. The maskable variant pads the glyph into the ~80% safe zone on the `#161616` theme background. As of 2026-08-28 they are palette-quantized PNGs (`-strip`, adaptive palette, no visible banding on the alpha edge) instead of naive full-RGBA upscales — the four files total well under 150KB, down from ~449KB.

## Coupling notes

This extension has zero git-level coupling to core (no shared files), but some behavioral coupling to core internals it drives at runtime (fullview viewer methods, layout bar classes, `site.js` request functions). Those are listed in the plan doc's coupling watchlist — re-check them after each upstream merge.
