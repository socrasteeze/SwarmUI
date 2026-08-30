using FreneticUtilities.FreneticExtensions;

namespace SwarmUI.Builtin_CharacterSheetExtension;

/// <summary>The view catalogue and prompt templating for character sheets.
/// <para>Kept separate from the engines so the wording can be tuned without touching model detection.</para></summary>
public static class SheetPlan
{
    /// <summary>One view of a character.</summary>
    /// <param name="Key">Stable identifier, used as the API value.</param>
    /// <param name="Label">Short caption drawn on the composited sheet.</param>
    /// <param name="Fragment">Prompt phrasing describing this view.</param>
    public record class SheetView(string Key, string Label, string Fragment);

    /// <summary>Every view the sheet builder can request, in the order a reference sheet conventionally lists them.</summary>
    public static SheetView[] Views =
    [
        new("front", "Front", "front view, facing the camera directly"),
        new("three_quarter", "3/4", "three-quarter view, body turned about 45 degrees from the camera"),
        new("side", "Side", "side profile view, body turned 90 degrees from the camera"),
        new("back", "Back", "back view, facing directly away from the camera"),
        new("close_up", "Close-up", "chest-up close-up of the face and head"),
        new("expression", "Expression", "chest-up close-up with a different facial expression")
    ];

    /// <summary>Looks a view up by key, or null when it is not a known view.</summary>
    public static SheetView ViewFor(string key)
    {
        return Views.FirstOrDefault(v => v.Key == key);
    }

    /// <summary>Wording shared by every prompt, keeping the background clean and the lighting flat.
    /// <para>A plain background and even lighting are not stylistic preferences here - they are what makes the
    /// separate panels composite into something that reads as one sheet rather than a collage.</para>
    /// <para>Deliberately says nothing about sheets or panels. That framing belongs only to one-shot mode: with
    /// it in the shared text, a per-panel generation draws an entire multi-view sheet inside each panel, and the
    /// composite ends up a sheet of sheets. Observed, not theorised.</para></summary>
    public const string BaseStyle = "plain flat neutral background, even flat lighting, no shadows on the background, consistent character design";

    /// <summary>Extra wording for a single-view panel, pinning the output to exactly one figure.
    /// <para>"solo" and the explicit single-figure phrasing are load-bearing: without them the model reads the
    /// turnaround vocabulary as an invitation to draw several views at once.</para></summary>
    public const string SinglePanelStyle = "solo, a single character alone, exactly one figure, one view only, full body in frame";

    /// <summary>Extra wording for a one-shot sheet, where the multi-view framing is the point.</summary>
    public const string OneShotStyle = "character reference sheet, full body in frame, the same character in every panel";

    /// <summary>Builds the identity clause that ties the generation back to the supplied reference images.</summary>
    public static string IdentityClause(SheetEngines.SheetEngine engine, List<string> roles)
    {
        List<string> parts = [];
        for (int i = 0; i < roles.Count; i++)
        {
            string reference = engine.ReferencePhrase(i);
            switch (roles[i])
            {
                case "face":
                    parts.Add($"the exact same person as in {reference}, matching their face, hair and build");
                    break;
                case "outfit":
                    parts.Add($"wearing the outfit shown in {reference}, matching its design, colors and materials");
                    break;
                case "pose":
                    parts.Add($"posed as shown in {reference}");
                    break;
                case "prop":
                    parts.Add($"holding the item shown in {reference}");
                    break;
                case "environment":
                    parts.Add($"in the setting shown in {reference}");
                    break;
            }
        }
        return parts.JoinString(", ");
    }

    /// <summary>Builds the prompt for a single-generation sheet holding every requested view at once.</summary>
    public static string BuildOneShotPrompt(SheetEngines.SheetEngine engine, List<string> roles, List<SheetView> views, string userPrompt)
    {
        string viewList = views.Select(v => v.Fragment).JoinString("; then ");
        string body = $"{OneShotStyle}, {BaseStyle}. A single image divided into {views.Count} panels side by side, showing the same character in each: {viewList}. Each panel shows {IdentityClause(engine, roles)}.";
        return string.IsNullOrWhiteSpace(userPrompt) ? body : $"{body} {userPrompt.Trim()}";
    }

    /// <summary>Builds the prompt for one panel of a per-panel sheet.</summary>
    public static string BuildPanelPrompt(SheetEngines.SheetEngine engine, List<string> roles, SheetView view, string userPrompt)
    {
        string body = $"{SinglePanelStyle}, {BaseStyle}. {view.Fragment}. {IdentityClause(engine, roles)}.";
        return string.IsNullOrWhiteSpace(userPrompt) ? body : $"{body} {userPrompt.Trim()}";
    }

    /// <summary>Builds the prompt for a free-text extra panel, eg a specific pose or prop shot.</summary>
    public static string BuildExtraPanelPrompt(SheetEngines.SheetEngine engine, List<string> roles, string request)
    {
        return $"{SinglePanelStyle}, {BaseStyle}. {IdentityClause(engine, roles)}. {request.Trim()}";
    }
}
