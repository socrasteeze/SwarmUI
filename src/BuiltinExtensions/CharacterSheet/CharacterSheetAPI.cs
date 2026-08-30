using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Media;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.Net.WebSockets;

namespace SwarmUI.Builtin_CharacterSheetExtension;

/// <summary>API routes for building multi-view character reference sheets.</summary>
[API.APIClass("Routes for building multi-view character reference sheets from a set of reference images.")]
public static class CharacterSheetAPI
{
    /// <summary>Registers every route in this class.</summary>
    public static void Register()
    {
        API.RegisterAPICall(CharacterSheetInfo, false, CharacterSheetExtension.PermUseCharacterSheet);
        API.RegisterAPICall(CharacterSheetRun, true, CharacterSheetExtension.PermUseCharacterSheet);
    }

    /// <summary>One panel to generate, resolved before any generation starts.</summary>
    /// <param name="Index">Position in the finished sheet.</param>
    /// <param name="Label">Caption drawn under the panel.</param>
    /// <param name="Prompt">Full prompt for this panel's generation.</param>
    public record class PlannedPanel(int Index, string Label, string Prompt);

    [API.APIDescription("Describes the sheet builder's capabilities for a given model, so the UI can adapt its reference slots.",
        """
        "engine": "minimax_h3",
        "engine_display": "MiniMax H3 (reference)",
        "reference_cap": 9,
        "cap_reason": "...",
        "prefers_one_shot": true,
        "still_frames": 2,
        "views": [{"key": "front", "label": "Front"}]
        """)]
    public static async Task<JObject> CharacterSheetInfo(Session session,
        [API.APIParameter("Name of the model the sheet would be generated with.")] string model)
    {
        T2IModel modelData = null;
        if (!string.IsNullOrWhiteSpace(model))
        {
            // GetModel rather than a raw dictionary hit: the UI reports a model name without its extension, and
            // this helper is the one that already knows to retry with '.safetensors' and to check extra models.
            modelData = Program.T2IModelSets["Stable-Diffusion"].GetModel(model);
        }
        SheetEngines.SheetEngine engine = SheetEngines.Detect(modelData);
        JArray views = [];
        foreach (SheetPlan.SheetView view in SheetPlan.Views)
        {
            views.Add(new JObject() { ["key"] = view.Key, ["label"] = view.Label });
        }
        return new JObject()
        {
            ["engine"] = engine.ID,
            ["engine_display"] = engine.Display,
            ["reference_cap"] = engine.ReferenceCap,
            ["cap_reason"] = engine.CapReason,
            ["prefers_one_shot"] = engine.PrefersOneShot,
            ["still_frames"] = engine.StillFrames.HasValue ? engine.StillFrames.Value : null,
            ["views"] = views
        };
    }

    [API.APIDescription("Builds a character reference sheet. Streams per-panel images as they finish, then the composited sheet.",
        """
        "image": "View/local/raw/...",
        "batch_index": "sheet",
        "metadata": "{...}"
        """)]
    public static async Task<JObject> CharacterSheetRun(WebSocket socket, Session session, JObject rawInput,
        [API.APIParameter("Comma-separated view keys to include, eg 'front,side,back'.")] string views,
        [API.APIParameter("'one_shot' for a single generation holding every view, or 'per_panel' for one generation each.")] string mode,
        [API.APIParameter("Layout identifier: sheet16x9, row, grid2x2, tall_left, or wide_top.")] string layout,
        [API.APIParameter("Optional free-text extra panel requests, one per line.")] string extraPanels = null,
        [API.APIParameter("Whether to draw a caption under each panel.")] bool labelPanels = true,
        [API.APIParameter("Extra prompt text appended to every panel.")] string sheetPrompt = null,
        [API.APIParameter("Whether to also save each panel to image history, not just the finished sheet.")] bool savePanels = false)
    {
        List<string> viewKeys = [.. (views ?? "").Split(',').Select(v => v.Trim()).Where(v => v.Length > 0)];
        List<string> extras = [.. (extraPanels ?? "").Replace("\r", "").Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0)];
        if (viewKeys.Count == 0 && extras.Count == 0)
        {
            await socket.SendAndReportError($"CharacterSheetRun request from {session.User.UserID}", "Pick at least one view or add an extra panel.", API.WebsocketTimeout);
            return null;
        }
        foreach (string key in viewKeys)
        {
            if (SheetPlan.ViewFor(key) is null)
            {
                await socket.SendAndReportError($"CharacterSheetRun request from {session.User.UserID}", $"Unknown view '{key}'.", API.WebsocketTimeout);
                return null;
            }
        }
        await API.RunWebsocketHandlerCallWS(CharacterSheetRun_Internal, session, (rawInput, viewKeys, extras, mode, layout, labelPanels, sheetPrompt, savePanels), socket);
        await socket.SendJson(new JObject() { ["success"] = "complete" }, API.WebsocketTimeout);
        return null;
    }

    /// <summary>Internal handler: plans the panels, generates them, and composites the sheet.</summary>
    public static async Task CharacterSheetRun_Internal(Session session, (JObject, List<string>, List<string>, string, string, bool, string, bool) input, Action<JObject> output, bool isWS)
    {
        (JObject rawInput, List<string> viewKeys, List<string> extras, string mode, string layout, bool labelPanels, string sheetPrompt, bool savePanels) = input;
        T2IParamInput baseParams;
        try
        {
            baseParams = T2IAPI.RequestToParams(session, rawInput["baseParams"] as JObject);
        }
        catch (SwarmReadableErrorException ex)
        {
            output(new JObject() { ["error"] = ex.Message });
            return;
        }
        SheetEngines.SheetEngine engine = SheetEngines.Detect(baseParams.Get(T2IParamTypes.Model));
        List<string> roles = [];
        List<Image> references = [];
        if (rawInput["references"] is JArray refArray)
        {
            foreach (JToken entry in refArray)
            {
                string role = $"{entry["role"]}";
                string data = $"{entry["image"]}";
                if (string.IsNullOrWhiteSpace(data))
                {
                    continue;
                }
                Image image = ParseImage(session, data);
                if (image is null)
                {
                    output(new JObject() { ["error"] = $"The '{role}' reference image could not be read." });
                    return;
                }
                roles.Add(role);
                references.Add(image);
            }
        }
        if (references.Count > engine.ReferenceCap)
        {
            int dropped = references.Count - engine.ReferenceCap;
            // Say what was dropped rather than silently truncating - a face reference quietly falling off the end
            // would look like the model ignoring it.
            output(new JObject() { ["warning"] = $"{dropped} reference image(s) were dropped: {engine.CapReason}" });
            roles = [.. roles.Take(engine.ReferenceCap)];
            references = [.. references.Take(engine.ReferenceCap)];
        }
        List<PlannedPanel> planned = [];
        List<SheetPlan.SheetView> chosenViews = [.. viewKeys.Select(SheetPlan.ViewFor)];
        if (mode == "one_shot" && chosenViews.Count > 0)
        {
            planned.Add(new(0, chosenViews.Select(v => v.Label).JoinString(" / "), SheetPlan.BuildOneShotPrompt(engine, roles, chosenViews, sheetPrompt)));
        }
        else
        {
            foreach (SheetPlan.SheetView view in chosenViews)
            {
                planned.Add(new(planned.Count, view.Label, SheetPlan.BuildPanelPrompt(engine, roles, view, sheetPrompt)));
            }
        }
        for (int i = 0; i < extras.Count; i++)
        {
            planned.Add(new(planned.Count, $"Panel {i + 1}", SheetPlan.BuildExtraPanelPrompt(engine, roles, extras[i])));
        }
        Logs.Info($"[Character Sheet] Building a {planned.Count}-panel sheet for {session.User.UserID} with engine '{engine.ID}'.");
        using Session.GenClaim claim = session.Claim(gens: planned.Count);
        output(BasicAPIFeatures.GetCurrentStatusRaw(session));
        string finalError = null;
        void setError(string message)
        {
            Volatile.Write(ref finalError, message);
            Logs.Warning($"Failed while building a character sheet for {session.User.UserID}: {message}");
        }
        Image[] results = new Image[planned.Count];
        List<Task> tasks = [];
        void removeDoneTasks()
        {
            for (int i = 0; i < tasks.Count; i++)
            {
                if (tasks[i].IsCompleted)
                {
                    if (tasks[i].IsFaulted)
                    {
                        Logs.Error($"Character sheet panel failed: {tasks[i].Exception}");
                    }
                    tasks.RemoveAt(i--);
                }
            }
        }
        int maxDegrees = session.User.CalcMaxT2ISimultaneous;
        foreach (PlannedPanel panel in planned)
        {
            removeDoneTasks();
            while (tasks.Count > maxDegrees)
            {
                await Task.WhenAny(tasks);
                removeDoneTasks();
            }
            if (claim.ShouldCancel)
            {
                break;
            }
            T2IParamInput param = baseParams.Clone();
            param.Set(T2IParamTypes.Prompt, panel.Prompt);
            if (references.Count > 0)
            {
                param.Set(T2IParamTypes.PromptImages, [.. references]);
            }
            if (engine.StillFrames.HasValue)
            {
                // A sheet panel is an image, never a clip, so a video model has to be pinned to a still-frame
                // count. Only 1 and 2 are still-image counts, so an existing value outside that range is a
                // leftover video setting from the parameter panel and is overridden rather than respected.
                if (!param.TryGet(T2IParamTypes.Text2VideoFrames, out int existingFrames) || existingFrames > 2 || existingFrames < 1)
                {
                    param.Set(T2IParamTypes.Text2VideoFrames, engine.StillFrames.Value);
                }
            }
            param.ApplySpecialLogic();
            int index = panel.Index;
            tasks.Add(T2IEngine.CreateImageTask(param, $"{index}", claim, output, setError, isWS, (img, metadata) =>
            {
                Image panelImage = ToImage(img.File);
                if (panelImage is null)
                {
                    setError($"Panel {index + 1} produced a '{img.File?.Type?.Extension}' output rather than an image. If this is a video model, check that the still-frame count is set.");
                    return;
                }
                results[index] = panelImage;
                string url = panelImage.AsDataString();
                if (savePanels)
                {
                    T2IEngine.ImageOutput panelOut = new() { File = img.File, ActualFileTask = img.ActualFileTask };
                    (string savedUrl, _) = session.SaveImage(panelOut, index, param, metadata);
                    if (savedUrl != "ERROR")
                    {
                        url = savedUrl;
                    }
                }
                output(new JObject() { ["image"] = url, ["batch_index"] = $"{index}", ["request_id"] = $"{baseParams.UserRequestId}", ["metadata"] = string.IsNullOrWhiteSpace(metadata) ? null : metadata });
            }));
        }
        while (tasks.Any())
        {
            await Task.WhenAny(tasks);
            removeDoneTasks();
        }
        claim.Dispose();
        output(BasicAPIFeatures.GetCurrentStatusRaw(session));
        finalError = Volatile.Read(ref finalError);
        List<Image> panelImages = [.. results];
        if (panelImages.All(p => p is null))
        {
            output(new JObject() { ["error"] = finalError ?? "Every panel failed to generate." });
            return;
        }
        List<string> labels = labelPanels ? [.. planned.Select(p => p.Label)] : null;
        Image sheet;
        try
        {
            sheet = SheetComposite.Build(panelImages, labels, layout);
        }
        catch (Exception ex)
        {
            Logs.Error($"Failed to composite a character sheet: {ex.ReadableString()}");
            output(new JObject() { ["error"] = "The panels generated but compositing the sheet failed. Check the server logs." });
            return;
        }
        if (sheet is null)
        {
            output(new JObject() { ["error"] = finalError ?? "No panels were produced." });
            return;
        }
        T2IParamInput sheetParams = baseParams.Clone();
        sheetParams.NoUnusedParams = true;
        sheetParams.Set(T2IParamTypes.Prompt, planned.Select(p => p.Label).JoinString(" | "));
        sheetParams.ExtraMeta["character_sheet_engine"] = engine.ID;
        sheetParams.ExtraMeta["character_sheet_layout"] = layout;
        sheetParams.ExtraMeta["character_sheet_panels"] = planned.Count;
        int sheetBatchId = planned.Count + 1;
        (Task<MediaFile> sheetTask, string sheetMeta) = session.ApplyMetadata(sheet, sheetParams, sheetBatchId);
        T2IEngine.ImageOutput sheetOut = new() { File = sheet, ActualFileTask = sheetTask };
        (string sheetUrl, _) = session.SaveImage(sheetOut, sheetBatchId, sheetParams, sheetMeta);
        if (sheetUrl == "ERROR")
        {
            output(new JObject() { ["error"] = "The sheet was built but the server failed to save it." });
            return;
        }
        output(new JObject() { ["image"] = sheetUrl, ["batch_index"] = "sheet", ["request_id"] = $"{baseParams.UserRequestId}", ["metadata"] = sheetMeta });
        if (finalError is not null)
        {
            output(new JObject() { ["warning"] = $"The sheet was built, but at least one panel failed: {finalError}" });
        }
    }

    /// <summary>Turns an image input value into an image, or null when it cannot be read.
    /// <para>Accepts the same three shapes the standard image parameters do - a data URI, bare base64, or a
    /// server-side path under the user's own folders - because Swarm's image inputs hand back whichever of those
    /// the user picked, and a path is what comes out of the input browser.</para></summary>
    public static Image ParseImage(Session session, string data)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(data))
            {
                return null;
            }
            if (data.StartsWith("inputs/") || data.StartsWith("raw/") || data.StartsWith("Starred/"))
            {
                // Path validation, including traversal rejection, lives in this shared helper - do not hand-roll it.
                data = T2IParamTypes.FilePathToDataString(session, data, "for a character sheet reference image");
            }
            // A data URI carries its own mime type, which is the only reliable signal here - bare base64 has none,
            // so it is treated as png, matching how the rest of Swarm handles an untyped image payload.
            if (data.StartsWith("data:"))
            {
                return ImageFile.FromDataString(data) as Image;
            }
            return ImageFile.FromBase64(data, MediaType.ImagePng) as Image;
        }
        catch (Exception ex)
        {
            Logs.Debug($"Could not parse a character sheet reference image: {ex.Message}");
            return null;
        }
    }

    /// <summary>Narrows a generated media file to an image, or null when the generation produced something else.</summary>
    public static Image ToImage(MediaFile file)
    {
        if (file is null || file.Type?.MetaType != MediaMetaType.Image)
        {
            return null;
        }
        return file as Image ?? new Image(file.RawData, file.Type);
    }
}
