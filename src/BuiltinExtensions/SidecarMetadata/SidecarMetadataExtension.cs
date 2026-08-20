using FreneticUtilities.FreneticExtensions;
using FreneticUtilities.FreneticToolkit;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.IO;
using System.Threading;

namespace SwarmUI.Builtin_SidecarMetadataExtension;

/// <summary>Restores Swarm LoRA type/title/usage-hint from StabilityMatrix <c>.cm-info.json</c> sidecars.
/// The Civitai metadata scan writes Swarm's current architecture ID into the safetensors header, which
/// flattened Illustrious/Pony to SDXL and stamped generic SD1 onto Anima files that failed the tensor matcher.
/// The sidecars were not deleted (ClearStrayModelData is off). This reads them back.</summary>
public class SidecarMetadataExtension : Extension
{
    /// <summary>Registers the restore API. Permission matches the metadata editor, because this rewrites headers.</summary>
    public override void OnInit()
    {
        API.RegisterAPICall(RestoreLoraSidecarMetadata, true, Permissions.EditModelMetadata);
    }

    /// <summary>Walks installed LoRAs, and for each sibling <c>.cm-info.json</c> reapplies BaseModel → architecture,
    /// family usage_hint, and ModelName/UserTitle when Swarm's title is missing or is just the filename.
    /// Does not call Civitai. Does not delete sidecars. Does not touch thumbnails or trigger phrases.
    /// Pass <paramref name="dry_run"/> true to count without writing.</summary>
    public static async Task<JObject> RestoreLoraSidecarMetadata(Session session, bool dry_run = true, string subtype = "LoRA")
    {
        await Task.Yield();
        if (!Program.T2IModelSets.TryGetValue(subtype, out T2IModelHandler handler))
        {
            return new JObject() { ["error"] = "Invalid sub-type." };
        }
        int scanned = 0;
        int noSidecar = 0;
        int skipped = 0;
        int updated = 0;
        int errors = 0;
        JArray samples = [];
        using ManyReadOneWriteLock.WriteClaim claim = Program.RefreshLock.LockWrite();
        foreach (T2IModel model in handler.Models.Values.OrderBy(m => m.Name, StringComparer.OrdinalIgnoreCase))
        {
            if (Program.GlobalProgramCancel.IsCancellationRequested)
            {
                break;
            }
            scanned++;
            try
            {
                SidecarPlan plan = PlanFor(handler, model);
                if (plan is null)
                {
                    noSidecar++;
                    continue;
                }
                if (!plan.AnyChange)
                {
                    skipped++;
                    continue;
                }
                if (samples.Count < 25)
                {
                    JObject sample = new() { ["name"] = model.Name };
                    if (plan.TitleChanged)
                    {
                        sample["title"] = $"{plan.OldTitle} -> {plan.NewTitle}";
                    }
                    if (plan.ClassChanged)
                    {
                        sample["architecture"] = $"{plan.OldClassId} -> {plan.NewClassId}";
                    }
                    if (plan.HintChanged)
                    {
                        sample["usage_hint"] = $"{plan.OldHint} -> {plan.NewHint}";
                    }
                    samples.Add(sample);
                }
                if (!dry_run)
                {
                    ApplyPlan(handler, model, plan);
                }
                updated++;
                if (updated % 100 == 0)
                {
                    Logs.Info($"[SidecarMetadata] {(dry_run ? "Dry-run" : "Restored")} {updated} LoRAs so far ({scanned} scanned).");
                }
            }
            catch (Exception ex)
            {
                errors++;
                Logs.Warning($"[SidecarMetadata] Failed on '{model.Name}': {ex.ReadableString()}");
            }
        }
        Logs.Info($"[SidecarMetadata] {(dry_run ? "Dry-run" : "Restore")} done: scanned={scanned} no_sidecar={noSidecar} skipped={skipped} updated={updated} errors={errors}");
        Interlocked.Increment(ref ModelsAPI.ModelEditID);
        return new JObject()
        {
            ["success"] = true,
            ["dry_run"] = dry_run,
            ["scanned"] = scanned,
            ["no_sidecar"] = noSidecar,
            ["skipped"] = skipped,
            ["updated"] = updated,
            ["errors"] = errors,
            ["samples"] = samples
        };
    }

    /// <summary>Computed sidecar overlay for one LoRA. Null when no <c>.cm-info.json</c> exists.</summary>
    public class SidecarPlan
    {
        /// <summary>Whether title, class, or usage_hint would change.</summary>
        public bool AnyChange;

        /// <summary>Whether the title would change.</summary>
        public bool TitleChanged;

        /// <summary>Whether the architecture class would change.</summary>
        public bool ClassChanged;

        /// <summary>Whether the usage_hint would change.</summary>
        public bool HintChanged;

        /// <summary>Current Swarm title.</summary>
        public string OldTitle;

        /// <summary>Title to write, or null to leave the current title.</summary>
        public string NewTitle;

        /// <summary>Current architecture ID, or empty.</summary>
        public string OldClassId;

        /// <summary>Architecture ID to write, or null to leave the current class.</summary>
        public string NewClassId;

        /// <summary>Resolved class to assign. Null when the class is left alone.</summary>
        public T2IModelClass NewClass;

        /// <summary>Current usage_hint.</summary>
        public string OldHint;

        /// <summary>Usage_hint to write, or null to leave the current hint.</summary>
        public string NewHint;
    }

    /// <summary>Reads the sibling StabilityMatrix sidecar and decides what Swarm fields to put back.</summary>
    public static SidecarPlan PlanFor(T2IModelHandler handler, T2IModel model)
    {
        if (string.IsNullOrWhiteSpace(model.RawFilePath))
        {
            return null;
        }
        string sidecar = $"{model.RawFilePath.BeforeLast('.')}.cm-info.json";
        if (!File.Exists(sidecar))
        {
            return null;
        }
        handler.LoadMetadata(model);
        JObject info = File.ReadAllText(sidecar).ParseToJson();
        string baseModel = $"{info["BaseModel"]}";
        string userTitle = $"{info["UserTitle"]}";
        string modelName = $"{info["ModelName"]}";
        string sidecarTitle = !string.IsNullOrWhiteSpace(userTitle) ? userTitle.Trim() : null;
        sidecarTitle ??= !string.IsNullOrWhiteSpace(modelName) ? modelName.Trim() : null;
        T2IModelClass mapped = T2ICivitaiBaseModelMap.TryGetLoraClass(baseModel);
        string familyHint = T2ICivitaiBaseModelMap.UsageHintFromBaseModel(baseModel);
        SidecarPlan plan = new()
        {
            OldTitle = model.Title,
            OldClassId = model.ModelClass?.ID ?? "",
            OldHint = model.Metadata?.UsageHint ?? ""
        };
        bool oldTitleIsFilename = T2ICivitaiBaseModelMap.TitleIsFilename(plan.OldTitle, model.Name)
            || T2ICivitaiBaseModelMap.TitleIsFilename(plan.OldTitle, model.RawFilePath);
        bool preferUserTitle = !string.IsNullOrWhiteSpace(userTitle) && userTitle.Trim() != plan.OldTitle;
        if (sidecarTitle is not null && (oldTitleIsFilename || preferUserTitle) && sidecarTitle != plan.OldTitle)
        {
            plan.NewTitle = sidecarTitle;
            plan.TitleChanged = true;
        }
        if (mapped is not null && T2ICivitaiBaseModelMap.ShouldPreferMappedLoraClass(model.ModelClass, mapped))
        {
            plan.NewClass = mapped;
            plan.NewClassId = mapped.ID;
            plan.ClassChanged = true;
        }
        if (familyHint is not null && !string.Equals(plan.OldHint, familyHint, StringComparison.OrdinalIgnoreCase))
        {
            plan.NewHint = familyHint;
            plan.HintChanged = true;
        }
        plan.AnyChange = plan.TitleChanged || plan.ClassChanged || plan.HintChanged;
        return plan;
    }

    /// <summary>Writes the planned fields into the in-memory model, LiteDB, and the safetensors header.</summary>
    public static void ApplyPlan(T2IModelHandler handler, T2IModel model, SidecarPlan plan)
    {
        lock (handler.ModificationLock)
        {
            if (plan.TitleChanged)
            {
                model.Title = plan.NewTitle;
            }
            if (plan.ClassChanged)
            {
                model.ModelClass = plan.NewClass;
            }
            model.Metadata ??= new();
            if (plan.HintChanged)
            {
                model.Metadata.UsageHint = plan.NewHint;
            }
        }
        handler.ResetMetadataFrom(model);
        model.ResaveModel();
    }
}
