/**
 * MobileEnhancements — thumbnail source helper (fork extension).
 *
 * The genpage's batch strip asks `getThumbnailSrc` (currentimagehandler.js, a fork addition) for a 256px
 * `?preview=true` variant of each strip image so a ~10rem tile does not download the full-resolution file.
 * That helper only recognises `View/…` srcs, which is what the server hands out when
 * `Paths.AppendUserNameToOutputPath` is true. With it false the srcs are `Output/…` (Session.cs), the helper
 * returns them untouched, and the whole optimisation silently does nothing - the strip is back to full-size
 * downloads. WebServer.ViewOutput serves `?preview=true` on both prefixes identically, so this replaces the
 * global with one that accepts both. Installed by reassignment rather than a core edit: every caller looks the
 * function up by name at call time, and this script loads after core, so the swap is complete before any
 * image is appended. If an upstream merge ever removes the core helper, install() is a no-op and nothing here
 * can throw.
 */
class MobileThumbnailHelper {

    /** Src prefixes the server's output route accepts a `?preview=true` on. Case-sensitive on purpose:
     * WebServer.ViewOutput matches these prefixes case-sensitively and 400s anything else. */
    static PreviewablePrefixes = ['View/', '/View/', 'Output/', '/Output/'];

    /**
     * Returns a thumbnail-sized variant of an output-image src for small strip/batch previews, or the input
     * unchanged if it isn't eligible (data URLs, local `imgs/` paths, or a src that already carries a query
     * string). Same contract as the core helper this replaces, plus the `Output/` prefixes.
     */
    thumbnailSrc(imageSrc) {
        if (imageSrc.includes('?')) {
            return imageSrc;
        }
        for (let i = 0; i < MobileThumbnailHelper.PreviewablePrefixes.length; i++) {
            if (imageSrc.startsWith(MobileThumbnailHelper.PreviewablePrefixes[i])) {
                return `${imageSrc}?preview=true`;
            }
        }
        return imageSrc;
    }

    /** Swaps the core global for this helper's version. No-op when core has no such function. */
    install() {
        if (typeof getThumbnailSrc != 'function') {
            return;
        }
        getThumbnailSrc = (imageSrc) => this.thumbnailSrc(imageSrc);
    }
}

let mobileThumbnailHelper = new MobileThumbnailHelper();
mobileThumbnailHelper.install();
