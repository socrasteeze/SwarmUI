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

    /// <summary>Wording shared by every sheet prompt, keeping the character consistent and the background clean.
    /// <para>A plain background and even lighting are not stylistic preferences here - they are what makes the
    /// separate panels composite into something that reads as one sheet rather than a collage.</para></summary>
    public const string SheetStyle = "character reference sheet, plain flat neutral background, even flat lighting, no shadows on the background, full body in frame, consistent character design across the whole image";

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
        string body = $"{SheetStyle}. A single image divided into {views.Count} panels side by side, showing the same character in each: {viewList}. Each panel shows {IdentityClause(engine, roles)}.";
        return string.IsNullOrWhiteSpace(userPrompt) ? body : $"{body} {userPrompt.Trim()}";
    }

    /// <summary>Builds the prompt for one panel of a per-panel sheet.</summary>
    public static string BuildPanelPrompt(SheetEngines.SheetEngine engine, List<string> roles, SheetView view, string userPrompt)
    {
        string body = $"{SheetStyle}. A single character, {view.Fragment}. {IdentityClause(engine, roles)}.";
        return string.IsNullOrWhiteSpace(userPrompt) ? body : $"{body} {userPrompt.Trim()}";
    }

    /// <summary>Builds the prompt for a free-text extra panel, eg a specific pose or prop shot.</summary>
    public static string BuildExtraPanelPrompt(SheetEngines.SheetEngine engine, List<string> roles, string request)
    {
        return $"{SheetStyle}. A single character. {IdentityClause(engine, roles)}. {request.Trim()}";
    }
}
