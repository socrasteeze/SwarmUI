using System;
using System.IO;
using SwarmUI.Core;
using SwarmUI.Utils;

namespace SwarmUI.Builtin_ComfyNodePatchesExtension;

/// <summary>Fork extension that repairs third-party ComfyUI node packs which have broken against the current ComfyUI
/// and whose own upstream is abandoned, so no fixed version can simply be pulled.
///
/// Patches land on files under the ComfyUI backend's 'DLNodes' folder. That folder is gitignored, so nothing here is
/// a tracked repository change - the repair has to be re-applied by code on every launch, which is what this class does.
/// It is safe to write there: for an unpinned node repo SwarmUI only runs 'git pull' (see
/// <see cref="SwarmUI.Builtin_ComfyUIBackend.ComfyUISelfStartBackend.EnsureNodeRepos"/>); the 'reset --hard' branch
/// applies only to repos listed in ComfyNodeGitPins.
///
/// Runs in <see cref="OnInit"/>, which completes well before any backend launches its ComfyUI process, so a repaired
/// file is always in place before ComfyUI imports it.</summary>
public class ComfyNodePatchesExtension : Extension
{
    /// <summary>One exact find-and-replace repair within a file.</summary>
    /// <param name="Needle">Exact original text to find. If it is absent the whole patch is abandoned, because that
    /// means the file is not the version this repair was written against.</param>
    /// <param name="Replacement">Text to substitute for <paramref name="Needle"/>.</param>
    public record class NodePatchEdit(string Needle, string Replacement);

    /// <summary>Marker embedded in every file this class rewrites. Its presence means the file is already repaired,
    /// and is what makes re-running on every launch a no-op instead of a repeated (and corrupting) re-application.</summary>
    public const string PatchMarker = "SwarmUI fork compat patch (ComfyNodePatches)";

    /// <summary>Applies all known node repairs. Deliberately swallows its own failures: a node pack that cannot be
    /// repaired must not take the whole server down with it.</summary>
    public override void OnInit()
    {
        try
        {
            ApplyTeaCacheLtxvImportFix();
        }
        catch (Exception ex)
        {
            Logs.Error($"[ComfyNodePatches] Failed while applying comfy node patches: {ex.ReadableString()}");
        }
    }

    /// <summary>Repairs ComfyUI-TeaCache against ComfyUI v0.33+, which moved 'precompute_freqs_cis' out of module scope
    /// in comfy/ldm/lightricks/model.py and onto LTXVModel as the '_precompute_freqs_cis' method.
    ///
    /// TeaCache imports that symbol at module top level, so on current ComfyUI the import raises and the ENTIRE node
    /// pack fails to load - killing TeaCache acceleration for every supported model (flux, flux-kontext, wan,
    /// hunyuan_video, hidream, lumina_2, ...), even though the symbol's only use is one LTXV-specific line.
    /// The 'teacache' feature flag is gated on the TeaCache node actually appearing in the backend's object_info (fork edit in
    /// ComfyUIBackendExtension.OnPreInit; it was previously set presumptively when the node folder existed), so a failed import now
    /// hides the 'TeaCache Mode' parameter rather than failing at generation time - but the acceleration is still lost without this repair.
    ///
    /// TeaCache upstream (welltop-cn/ComfyUI-TeaCache) has not been touched since 2025-07-12 and does not carry a fix.
    /// The repair makes the import optional and falls back to the model's own relocated method at the call site - which
    /// is valid because that call sits inside a forward() monkeypatched onto the LTXVModel instance, so 'self' is the
    /// model and the first three parameters line up exactly.</summary>
    public void ApplyTeaCacheLtxvImportFix()
    {
        string path = Path.GetFullPath($"{FilePath}../ComfyUIBackend/DLNodes/ComfyUI-TeaCache/nodes.py");
        NodePatchEdit[] edits =
        [
            new("from comfy.ldm.lightricks.model import precompute_freqs_cis",
                $"""
                # --- {PatchMarker} ---
                # ComfyUI v0.33 moved precompute_freqs_cis onto LTXVModel as a method. A hard import here fails and
                # takes down the entire node pack for every model, not just LTXV - so tolerate it and fall back below.
                try:
                    from comfy.ldm.lightricks.model import precompute_freqs_cis
                except ImportError:
                    precompute_freqs_cis = None
                """),
            new("        pe = precompute_freqs_cis(fractional_coords, dim=self.inner_dim, out_dtype=x.dtype)",
                """
                        if precompute_freqs_cis is not None:
                            pe = precompute_freqs_cis(fractional_coords, dim=self.inner_dim, out_dtype=x.dtype)
                        else:
                            # ComfyUI v0.33+: identical computation, now a method on the model this forward is patched onto.
                            pe = self._precompute_freqs_cis(fractional_coords, dim=self.inner_dim, out_dtype=x.dtype)
                """)
        ];
        ApplyPatch(path, "ComfyUI-TeaCache LTXV import", edits);
    }

    /// <summary>Applies a set of edits to one file, if that file exists and is not already patched.
    /// Writes nothing at all unless every edit's needle is present, so a file that upstream has changed underneath us
    /// is left strictly alone rather than half-rewritten.</summary>
    /// <param name="path">Full path to the file to repair.</param>
    /// <param name="description">Human-readable patch name, for logging.</param>
    /// <param name="edits">The edits to apply, all of which must match.</param>
    public void ApplyPatch(string path, string description, NodePatchEdit[] edits)
    {
        if (!File.Exists(path))
        {
            // The node pack simply is not installed. Nothing to repair, and nothing worth warning about.
            Logs.Debug($"[ComfyNodePatches] Skipping '{description}': file not present at {path}");
            return;
        }
        string content = File.ReadAllText(path);
        if (content.Contains(PatchMarker))
        {
            Logs.Debug($"[ComfyNodePatches] Skipping '{description}': already patched.");
            return;
        }
        foreach (NodePatchEdit edit in edits)
        {
            if (!content.Contains(edit.Needle))
            {
                Logs.Warning($"[ComfyNodePatches] Cannot apply '{description}': the file at {path} no longer contains the expected text. It may have been updated upstream - re-check whether this patch is still needed.");
                return;
            }
        }
        foreach (NodePatchEdit edit in edits)
        {
            content = content.Replace(edit.Needle, edit.Replacement);
        }
        SpokeModePolicy.AssertRuntimeMutationAllowed($"patch managed Comfy node source ({description})");
        File.WriteAllText(path, content);
        Logs.Init($"[ComfyNodePatches] Applied '{description}' to {path}");
    }
}
