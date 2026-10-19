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

/// <summary>Search, sort, and paging for <see cref="ModelsAPI.ListModels"/>. Wildcards use the same window; they match on name and title only.</summary>
public static class ModelListWindow
{
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
