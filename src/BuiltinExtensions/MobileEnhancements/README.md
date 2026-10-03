# MobileEnhancements

Fork-owned builtin extension that makes SwarmUI feel robust, fluid, and intuitive on phones and as an installed Progressive Web App (PWA).

Fork-owned assets live in this extension. Small core integration changes are recorded in the Fork Delta in [`AGENTS.md`](/AGENTS.md). See [`docs/MobilePWA-Optimization-Plan.md`](/docs/MobilePWA-Optimization-Plan.md) for the phased plan and coupling watchlist, and [`docs/WebUI-Performance-Review.md`](/docs/WebUI-Performance-Review.md) for the current desktop/PWA audit and verification limits.

## What it does

- **PWA installability**: serves a web manifest (`/manifest.json`) and a root-scoped service worker (`/sw.js`), and injects the `theme-color` / apple-mobile-web-app / touch-icon `<head>` tags. Navigations always use the network; failed navigations can show only the dedicated offline page. Authenticated HTML is never saved in worker caches. Versioned scripts/styles, public icons, and fonts use bounded caches first. API calls, generated media including previews, and TagDex thumbnails pass through to normal HTTP handling. The worker removes its legacy private-media caches during activation and preserves unrelated cache namespaces. Cache writes remain active until complete without delaying the response. Explicit `reload` requests refresh entries, and `no-store` requests bypass worker caching.
- **Viewport fix**: replaces the core `maximum-scale=1.0` viewport (which blocks pinch zoom) with a mobile-friendly one that restores pinch zoom, enables iOS safe-area insets, and lets the on-screen keyboard resize content.
- **Mobile CSS**: scoped under `body.small-window` / `body.coarse-pointer` / `body.pwa-standalone` so desktop is untouched.
- **Civitai share-to-download**: the manifest declares a `share_target`, so when installed the app appears in the OS share sheet. Sharing a Civitai model link routes to the `/ShareTarget` route, which redirects into the app; `mobile_share.js` then opens the Utilities > Model Downloader tab and prefills the shared URL so its Civitai metadata loads automatically. Non-Civitai shares open the downloader empty.


## Browsing and keyboard access

The `/simple` Models tab builds folder cards in batches of 40. Scrolling loads more; **Load More** remains available as a fallback. Genpage History uses its existing progressive renderer with a 50-card first batch. Search, starred ordering, and image actions retain their existing behavior.

**Skip Navigation** moves keyboard focus into the main content. Model and History tiles support Enter and Space. Open sheets and the History viewer contain Tab navigation; Escape closes them and restores focus. The History viewer also supports Left and Right arrow navigation. Sheets, toasts, preview indicators, and viewer travel honor the device's reduced-motion setting.

Genpage applies the saved mobile/desktop layout choice before first paint. The standalone client's fallback status polling pauses while hidden and reconciles the queue when the app returns. These changes require a server restart and client cache refresh before a running Release installation adopts them.

## /simple FL2VA same-frame prep

For MiniMax H3 FL2VA same-frame / 360-orbit presets (at least minimax/FL2VA_360_Orbit_Eros, plus any title matching FL2VA + orbit/360/same-frame, or extras in localStorage.m_client_same_frame_presets):

- **Same as start** toggle (default ON) mirrors Start frame into End whenever Start is set or changes.
- **Auto-scale** scales Start (and End when mirrored) so the shortest side is 768, preserves the aspect ratio, and rounds dimensions to the nearest multiple of 32 without adding padding - client-side canvas processing for the FL2VA workflow. Browser canvas uses imageSmoothingQuality='high' rather than true LANCZOS; a future server-side hook would be more accurate.
- Frame **+** buttons still open the existing server image browser (m_image_browser.js).

Implemented in Assets/m/m_frame_prep.js (wired from m_create.js). Restart the SwarmUI server after pulling so GetLazy reloads OtherAssets.

## /simple image folders

Image history omits folders with no images, video, or audio anywhere below them. Backend placeholders and preview sidecars do not count as saved media. Folders appear automatically when they contain saved media. Listing history does not create or delete folders.

Use an image attachment **+**, or a Start/End frame **+**, to open the image browser. **Output** keeps the existing output favorites in a dropdown, with **Edit** beside it. **Drives** lists the drives on the SwarmUI host. The narrow folder list and four-column image grid scroll separately. Open folders, use **Up**, or enter an absolute folder path and select **Go**. Search matches filenames in the current folder, including files beyond the first page. Folder navigation stays available while searching. Image previews load as they enter view. **Prev** and **Next** stay fixed below the grid and browse 48 images per page. A new search or folder starts on page one.

Drives requires the **Browse Server Images** role permission (`browse_server_images`), enabled by default for administrators. The permission grants image access across the host's filesystem, including mounted drives and readable network shares. Operating system access restrictions still apply. The browser shows folders and supported bitmap images only. It does not change source files. Selected images become normal attachments for prompt images and Start/End frames, including when the PWA runs on a phone.

Supported formats: PNG, JPEG, WebP, GIF, BMP, and TIFF. TIFF selections become PNG attachments so the browser can display and edit them. The source TIFF file stays unchanged. Files must decode as images and must be no larger than 32 MiB. The **From Phone** option continues to use the device picker.

Restart SwarmUI after installing the change, then reload the PWA with its cache cleared. Release servers hold extension assets in memory until restart.

## /simple Create layout

Preset Folder and Preset share the first control row. Checkpoint and LoRA share the next row. Generate stays above the prompt. The photo row contains the attachment button, Clear, autocomplete suggestions, and Enhance, followed by attached thumbnails. Clear removes only prompt photos and is disabled when none are attached. Suggestions do not cover Generate or resize the action row. Seed and Prefix share one row. Steps/CFG, Sampler/Scheduler, and Aspect/Side Length remain paired below it. The Upscale/Method row is hidden.

Prefix has no separate visible label and disables contact autofill hints, automatic capitalization, autocorrection, and spelling checks. Sampler and Scheduler display their selected values without repeated labels. Aspect and Side Length keep accessible names and dimension tooltips without top labels. Reset Params remains at the bottom of Create. Characters remains available from the bottom navigation.

## /simple attached photo cropping

Open an attached photo to edit it. On desktop, drag across the image to create a crop. Drag a corner handle to resize the crop, or drag inside a smaller crop to move it. Mouse drags continue outside the image and stay within its boundaries. Touch cropping still uses the corner handles. Save applies the crop to the attachment; Cancel keeps the original attachment.

## Icons

`Assets/icons/*` are generated from the repo's `src/wwwroot/favicon.ico` (128×128, upscaled). They are a functional placeholder — dropping a higher-resolution source logo in and regenerating the PNGs (192, 512, maskable 512, apple-touch 180) is a clean drop-in improvement. The maskable variant pads the glyph into the ~80% safe zone on the `#161616` theme background. As of 2026-08-28 they are palette-quantized PNGs (`-strip`, adaptive palette, no visible banding on the alpha edge) instead of naive full-RGBA upscales — the four files total well under 150KB, down from ~449KB.

## Coupling notes

Core integration points are listed in the Fork Delta. Runtime coupling includes full-view viewer methods, layout classes, `site.js` requests, and the initial mobile geometry used before `mobile-layout-ready`. Re-check these contracts after upstream merges, especially when the bottom information bar, tab strip, or prompt sizing changes.
