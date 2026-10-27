using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;

namespace SwarmUI.WebAPI;

/// <summary>One model eligible for a ListModels page, before sort and the response window.</summary>
public class ModelListCandidate
{
    /// <summary>Full model path.</summary>
    public string Name;

    /// <summary>Display title. Empty when the model has none.</summary>
    public string Title;

    /// <summary>Trigger phrase. Empty when the model has none. Wildcards leave this empty.</summary>
    public string TriggerPhrase;

    /// <summary>Created time. Missing metadata uses <see cref="long.MaxValue"/> so dates sort newest first.</summary>
    public long TimeCreated;

    /// <summary>Modified time. Missing metadata uses <see cref="long.MaxValue"/>.</summary>
    public long TimeModified;

    /// <summary>Compat class ID of the model's class. Empty when the model has no class, which makes it unclassed for <see cref="ModelListWindow.FilterByCompat"/>.</summary>
    public string CompatClass;

    /// <summary>Model class ID, for example a base-model ID or an ID of the form <c>base/lora</c>. Empty when unknown.</summary>
    public string Architecture;

    /// <summary>Builds the JSON row. Called only for rows that survive the window, so a capped list does not materialize the rest.</summary>
    public Func<JObject> Materialize;
}

/// <summary>The page of models ListModels returns after sort, offset, and cap.</summary>
public class ModelListPage
{
    /// <summary>Rows in this response, in sort order.</summary>
    public List<ModelListCandidate> Rows = new();

    /// <summary>Match count before offset and cap.</summary>
    public int Total;

    /// <summary>Rows in <see cref="Rows"/>.</summary>
    public int Returned;

    /// <summary>True when this response is not the full match set.</summary>
    public bool Truncated;
}

/// <summary>What <see cref="ModelListWindow.FilterByCompat"/> kept and removed.</summary>
public class ModelListCompatResult
{
    /// <summary>Candidates that remain, in their original order.</summary>
    public List<ModelListCandidate> Kept = new();

    /// <summary>How many candidates were removed.</summary>
    public int Hidden;
}

/// <summary>Search, sort, and paging for <see cref="ModelsAPI.ListModels"/>. Wildcards use the same window; they match on name and title only.</summary>
public static class ModelListWindow
{
    /// <summary>Splits a comma-separated compat class list into trimmed, non-empty, distinct IDs in their given order. Null or blank gives an empty list.</summary>
    public static List<string> ParseCompatList(string compat)
    {
        List<string> result = new();
        if (string.IsNullOrWhiteSpace(compat))
        {
            return result;
        }
        foreach (string part in compat.Split(','))
        {
            string id = part.Trim();
            if (id.Length > 0 && !result.Contains(id))
            {
                result.Add(id);
            }
        }
        return result;
    }

    /// <summary>True when the compat filter has anything to do: the subtype is a sub-model type (not Wildcards, not Stable-Diffusion) and at least one compat class is active.</summary>
    public static bool CompatFilterApplies(string subtype, IReadOnlyCollection<string> active)
    {
        return active is not null && active.Count > 0 && subtype != "Wildcards" && subtype != "Stable-Diffusion";
    }

    /// <summary>Whether one classed sub-model can load under any of the active compat classes.
    /// This is the rule the standalone client uses for its LoRA, VAE, and ControlNet pickers.
    /// A model with no compat class, or no active class, always matches. Stable-Diffusion rows always match.
    /// An <paramref name="architecture"/> with no '/' is still a sub-model of <paramref name="subtype"/> and is treated as <c>x/lora</c>, <c>x/vae</c>, or <c>x/controlnet</c>,
    /// because that ID is only a label and treating it as a base model would make every variant of one family compatible with the others.</summary>
    public static bool CompatMatches(string subtype, string architecture, string modelCompat, IEnumerable<string> active)
    {
        if (subtype == "Stable-Diffusion" || string.IsNullOrEmpty(modelCompat) || active is null)
        {
            return true;
        }
        string arch = architecture ?? "";
        if (!arch.Contains('/'))
        {
            arch = subtype == "VAE" ? "x/vae" : (subtype == "ControlNet" ? "x/controlnet" : "x/lora");
        }
        bool anyActive = false;
        foreach (string current in active)
        {
            if (string.IsNullOrEmpty(current))
            {
                continue;
            }
            anyActive = true;
            if (CompatMatchesOne(arch, modelCompat, current))
            {
                return true;
            }
        }
        return !anyActive;
    }

    /// <summary>One active compat class against one model. VAEs of the SD3 family mix, a flux-1 VAE loads under hidream-i1, and a flux-1 LoRA loads under chroma. Anything else needs an exact match.</summary>
    private static bool CompatMatchesOne(string arch, string modelCompat, string current)
    {
        bool isVae = arch.EndsWithFast("/vae");
        if (isVae && modelCompat.StartsWithFast("stable-diffusion-v3") && current.StartsWithFast("stable-diffusion-v3"))
        {
            return true;
        }
        if (isVae && modelCompat.StartsWithFast("flux-1") && current.StartsWithFast("hidream-i1"))
        {
            return true;
        }
        if (arch.EndsWithFast("/lora") && modelCompat.StartsWithFast("flux-1") && current.StartsWithFast("chroma"))
        {
            return true;
        }
        return modelCompat == current;
    }

    /// <summary>The lowercase first path segment of a model name, or empty when the name has no folder.</summary>
    public static string RootFolderOf(string name)
    {
        int slash = name is null ? -1 : name.IndexOf('/');
        return slash <= 0 ? "" : name[..slash].ToLowerFast();
    }

    /// <summary>Records that a classed model lives in the root folder of <paramref name="name"/>. A model with no compat class or no folder adds nothing.
    /// <paramref name="evidence"/> maps a lowercase root folder to the compat classes seen on classed models there.</summary>
    public static void AddFolderEvidence(Dictionary<string, HashSet<string>> evidence, string name, string compatClass)
    {
        string folder = RootFolderOf(name);
        if (folder.Length == 0 || string.IsNullOrEmpty(compatClass))
        {
            return;
        }
        if (!evidence.TryGetValue(folder, out HashSet<string> seen))
        {
            seen = new();
            evidence[folder] = seen;
        }
        seen.Add(compatClass);
    }

    /// <summary>Removes candidates that cannot load under any active compat class.
    /// A classed candidate is judged by <see cref="CompatMatches"/>.
    /// An unclassed candidate falls back to <paramref name="folderEvidence"/>: when its root folder has classed models and none of their classes is active, it is hidden.
    /// Unknown is not incompatible, so an unclassed candidate in a folder with no evidence, or at the top level, is kept.
    /// Does nothing when <see cref="CompatFilterApplies"/> is false. <paramref name="folderEvidence"/> may be null when no candidate is unclassed.</summary>
    public static ModelListCompatResult FilterByCompat(IEnumerable<ModelListCandidate> candidates, IReadOnlyCollection<string> active, string subtype, IReadOnlyDictionary<string, HashSet<string>> folderEvidence)
    {
        ModelListCompatResult result = new();
        bool applies = CompatFilterApplies(subtype, active);
        foreach (ModelListCandidate candidate in candidates)
        {
            bool keep = true;
            if (applies)
            {
                if (!string.IsNullOrEmpty(candidate.CompatClass))
                {
                    keep = CompatMatches(subtype, candidate.Architecture, candidate.CompatClass, active);
                }
                else if (folderEvidence is not null && folderEvidence.TryGetValue(RootFolderOf(candidate.Name), out HashSet<string> observed) && observed.Count > 0)
                {
                    keep = false;
                    foreach (string current in active)
                    {
                        if (observed.Contains(current))
                        {
                            keep = true;
                            break;
                        }
                    }
                }
            }
            if (keep)
            {
                result.Kept.Add(candidate);
            }
            else
            {
                result.Hidden++;
            }
        }
        return result;
    }

    /// <summary>True when every whitespace-separated word of <paramref name="search"/> appears in the name, title, or trigger phrase.
    /// An empty or whitespace search matches everything. Comparison is case-insensitive and is a contains check, not a word-boundary check.</summary>
    public static bool Matches(string name, string title, string triggerPhrase, string search)
    {
        if (string.IsNullOrWhiteSpace(search))
        {
            return true;
        }
        string haystack = $"{name}\n{title}\n{triggerPhrase}".ToLowerFast();
        string[] words = search.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
        foreach (string word in words)
        {
            if (!haystack.Contains(word.ToLowerFast()))
            {
                return false;
            }
        }
        return true;
    }

    /// <summary>Sorts <paramref name="matches"/>, skips <paramref name="offset"/>, then keeps at most the effective cap.
    /// A positive <paramref name="limit"/> caps at the smaller of limit and <paramref name="sanityCap"/>.
    /// A limit of 0 uses <paramref name="sanityCap"/> alone. Negative limit and offset are treated as 0.
    /// Name and Title use <see cref="StringComparison.CurrentCulture"/>, matching LINQ OrderBy.
    /// Dates sort newest first. A later reverse flips that whole order.
    /// Equal primary keys break on ordinal Name so paging stays deterministic.</summary>
    public static ModelListPage Page(List<ModelListCandidate> matches, ModelsAPI.ModelHistorySortMode sortMode, bool sortReverse, int offset, int limit, int sanityCap)
    {
        List<ModelListCandidate> ordered = new(matches);
        ordered.Sort((ModelListCandidate a, ModelListCandidate b) => Compare(a, b, sortMode));
        if (sortReverse)
        {
            ordered.Reverse();
        }
        if (offset < 0)
        {
            offset = 0;
        }
        if (limit < 0)
        {
            limit = 0;
        }
        int ceiling = Math.Max(0, sanityCap);
        int cap = limit > 0 ? Math.Min(limit, ceiling) : ceiling;
        int start = offset > ordered.Count ? ordered.Count : offset;
        int count = Math.Min(cap, ordered.Count - start);
        ModelListPage page = new()
        {
            Total = ordered.Count,
            Returned = count,
            Truncated = ordered.Count != count
        };
        for (int i = 0; i < count; i++)
        {
            page.Rows.Add(ordered[start + i]);
        }
        return page;
    }

    /// <summary>Primary Name and Title use <see cref="StringComparison.CurrentCulture"/>. Dates compare newest first. Ordinal Name is the final tiebreak.</summary>
    public static int Compare(ModelListCandidate a, ModelListCandidate b, ModelsAPI.ModelHistorySortMode sortMode)
    {
        int primary;
        if (sortMode == ModelsAPI.ModelHistorySortMode.Title)
        {
            primary = string.Compare(a.Title ?? "", b.Title ?? "", StringComparison.CurrentCulture);
        }
        else if (sortMode == ModelsAPI.ModelHistorySortMode.DateCreated)
        {
            primary = b.TimeCreated.CompareTo(a.TimeCreated);
        }
        else if (sortMode == ModelsAPI.ModelHistorySortMode.DateModified)
        {
            primary = b.TimeModified.CompareTo(a.TimeModified);
        }
        else
        {
            primary = string.Compare(a.Name ?? "", b.Name ?? "", StringComparison.CurrentCulture);
        }
        if (primary != 0)
        {
            return primary;
        }
        return string.CompareOrdinal(a.Name ?? "", b.Name ?? "");
    }
}
