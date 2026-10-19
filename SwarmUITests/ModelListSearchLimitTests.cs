using System;
using System.Collections.Generic;
using NUnit.Framework;
using SwarmUI.WebAPI;

namespace SwarmUITests;

/// <summary>Search, sort-then-cap, and offset paging for <see cref="ModelListWindow"/>, the helper <see cref="ModelsAPI.ListModels"/> uses.</summary>
[TestFixture]
public class ModelListSearchLimitTests : SwarmUITest
{
    /// <summary>Prepares the basics.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>A name, a title, and a trigger phrase each match on their own, case-insensitively.</summary>
    [Test]
    public static void TestMatches_NameTitleTriggerAndCase()
    {
        Assert.That(ModelListWindow.Matches("ill/miku.safetensors", "", "", "MIKU"), Is.True);
        Assert.That(ModelListWindow.Matches("epoch_1.safetensors", "Hatsune Miku", "", "hatsune"), Is.True);
        Assert.That(ModelListWindow.Matches("epoch_1.safetensors", "", "hatsune miku", "miku"), Is.True);
        Assert.That(ModelListWindow.Matches("epoch_1.safetensors", "Other", "unrelated", "miku"), Is.False);
        Assert.That(ModelListWindow.Matches("a.safetensors", "A", "", "   "), Is.True);
        Assert.That(ModelListWindow.Matches("a.safetensors", "A", "", null), Is.True);
    }

    /// <summary>Every whitespace-separated word must appear. Extra spaces do not add an empty word.</summary>
    [Test]
    public static void TestMatches_MultiWordAnd()
    {
        Assert.That(ModelListWindow.Matches("a.safetensors", "Red Hair Bow", "", "  red   hair "), Is.True);
        Assert.That(ModelListWindow.Matches("a.safetensors", "Red Hair Bow", "", "red hat"), Is.False);
        Assert.That(ModelListWindow.Matches("red.safetensors", "", "hat", "red hat"), Is.True);
    }

    /// <summary>The cap is applied after sorting, so the page is the first names, not the insertion prefix.</summary>
    [Test]
    public static void TestPage_SortThenCap()
    {
        List<ModelListCandidate> rows = Rows("z.safetensors", "a.safetensors", "m.safetensors");
        ModelListPage page = ModelListWindow.Page(rows, ModelsAPI.ModelHistorySortMode.Name, false, 0, 2, 100);
        Assert.That(Names(page), Is.EqualTo(new[] { "a.safetensors", "m.safetensors" }));
        Assert.That(page.Total, Is.EqualTo(3));
        Assert.That(page.Returned, Is.EqualTo(2));
        Assert.That(page.Truncated, Is.True);
    }

    /// <summary>A positive limit is min'd with the sanity cap. A limit of 0 uses the sanity cap alone.</summary>
    [Test]
    public static void TestPage_LimitMinSanityCap()
    {
        List<ModelListCandidate> rows = Rows("a", "b", "c", "d", "e");
        ModelListPage limited = ModelListWindow.Page(rows, ModelsAPI.ModelHistorySortMode.Name, false, 0, 100, 2);
        Assert.That(Names(limited), Is.EqualTo(new[] { "a", "b" }));
        Assert.That(limited.Total, Is.EqualTo(5));
        Assert.That(limited.Truncated, Is.True);
        ModelListPage uncapped = ModelListWindow.Page(rows, ModelsAPI.ModelHistorySortMode.Name, false, 0, 0, 4);
        Assert.That(uncapped.Returned, Is.EqualTo(4));
        Assert.That(Names(uncapped), Is.EqualTo(new[] { "a", "b", "c", "d" }));
    }

    /// <summary>Offset skips sorted rows, then limit takes the next page. Past-the-end offset returns nothing and stays truncated.</summary>
    [Test]
    public static void TestPage_OffsetThenLimit()
    {
        List<ModelListCandidate> rows = Rows("a", "b", "c", "d", "e");
        ModelListPage page = ModelListWindow.Page(rows, ModelsAPI.ModelHistorySortMode.Name, false, 2, 2, 100);
        Assert.That(Names(page), Is.EqualTo(new[] { "c", "d" }));
        Assert.That(page.Total, Is.EqualTo(5));
        Assert.That(page.Returned, Is.EqualTo(2));
        Assert.That(page.Truncated, Is.True);
        ModelListPage past = ModelListWindow.Page(rows, ModelsAPI.ModelHistorySortMode.Name, false, 50, 10, 100);
        Assert.That(past.Returned, Is.EqualTo(0));
        Assert.That(past.Total, Is.EqualTo(5));
        Assert.That(past.Truncated, Is.True);
    }

    /// <summary>A window that contains every match is not truncated. Negative offset and limit behave as zero.</summary>
    [Test]
    public static void TestPage_CompleteAndNegativeInputs()
    {
        List<ModelListCandidate> rows = Rows("b", "a");
        ModelListPage page = ModelListWindow.Page(rows, ModelsAPI.ModelHistorySortMode.Name, false, -4, -1, 100);
        Assert.That(Names(page), Is.EqualTo(new[] { "a", "b" }));
        Assert.That(page.Returned, Is.EqualTo(2));
        Assert.That(page.Total, Is.EqualTo(2));
        Assert.That(page.Truncated, Is.False);
    }

    /// <summary>Reverse flips the sorted order before the cap. Dates are newest first, then oldest first when reversed.</summary>
    [Test]
    public static void TestPage_ReverseAndDates()
    {
        List<ModelListCandidate> rows = new()
        {
            Row("old", 1),
            Row("new", 9),
            Row("mid", 5)
        };
        ModelListPage newest = ModelListWindow.Page(rows, ModelsAPI.ModelHistorySortMode.DateCreated, false, 0, 1, 100);
        Assert.That(Names(newest), Is.EqualTo(new[] { "new" }));
        ModelListPage oldest = ModelListWindow.Page(rows, ModelsAPI.ModelHistorySortMode.DateCreated, true, 0, 1, 100);
        Assert.That(Names(oldest), Is.EqualTo(new[] { "old" }));
        ModelListPage reversedNames = ModelListWindow.Page(Rows("a", "b", "c"), ModelsAPI.ModelHistorySortMode.Name, true, 0, 2, 100);
        Assert.That(Names(reversedNames), Is.EqualTo(new[] { "c", "b" }));
    }

    /// <summary>Title sort uses the title, then the name. Search filtering happens before total is counted.</summary>
    [Test]
    public static void TestPage_TitleSortAndSearchTotal()
    {
        List<ModelListCandidate> rows = new()
        {
            new ModelListCandidate() { Name = "b.safetensors", Title = "Alpha", TriggerPhrase = "" },
            new ModelListCandidate() { Name = "a.safetensors", Title = "Alpha", TriggerPhrase = "" },
            new ModelListCandidate() { Name = "c.safetensors", Title = "Zed", TriggerPhrase = "miku" }
        };
        ModelListPage titled = ModelListWindow.Page(rows, ModelsAPI.ModelHistorySortMode.Title, false, 0, 2, 100);
        Assert.That(Names(titled), Is.EqualTo(new[] { "a.safetensors", "b.safetensors" }));
        List<ModelListCandidate> matched = new();
        foreach (ModelListCandidate row in rows)
        {
            if (ModelListWindow.Matches(row.Name, row.Title, row.TriggerPhrase, "miku"))
            {
                matched.Add(row);
            }
        }
        ModelListPage found = ModelListWindow.Page(matched, ModelsAPI.ModelHistorySortMode.Name, false, 0, 10, 100);
        Assert.That(found.Total, Is.EqualTo(1));
        Assert.That(found.Returned, Is.EqualTo(1));
        Assert.That(found.Truncated, Is.False);
        Assert.That(Names(found), Is.EqualTo(new[] { "c.safetensors" }));
    }

    /// <summary>Name order follows <see cref="StringComparison.CurrentCulture"/>, the same comparer as LINQ OrderBy.
    /// This suite runs with invariant globalization, so that comparer is ordinal and "Beta" precedes "alpha".
    /// Offset pages cover that order once, with no gaps or duplicates.</summary>
    [Test]
    public static void TestPage_CultureAwareNameAndPaging()
    {
        string[] expected = new string[] { "gamma", "Beta", "alpha" };
        Array.Sort(expected, (string left, string right) => string.Compare(left, right, StringComparison.CurrentCulture));
        Assert.That(expected, Is.EqualTo(new string[] { "Beta", "alpha", "gamma" }));
        List<ModelListCandidate> rows = Rows("gamma", "Beta", "alpha");
        ModelListPage full = ModelListWindow.Page(rows, ModelsAPI.ModelHistorySortMode.Name, false, 0, 10, 100);
        Assert.That(Names(full), Is.EqualTo(expected));
        string[] covered = new string[expected.Length];
        HashSet<string> seen = new();
        int cursor = 0;
        for (int offset = 0; offset < expected.Length; offset += 2)
        {
            ModelListPage page = ModelListWindow.Page(rows, ModelsAPI.ModelHistorySortMode.Name, false, offset, 2, 100);
            Assert.That(page.Total, Is.EqualTo(expected.Length));
            foreach (string name in Names(page))
            {
                Assert.That(seen.Add(name), Is.True, name);
                covered[cursor++] = name;
            }
        }
        Assert.That(cursor, Is.EqualTo(expected.Length));
        Assert.That(covered, Is.EqualTo(expected));
        List<ModelListCandidate> sameTitle = new()
        {
            new ModelListCandidate() { Name = "alpha", Title = "Same", TriggerPhrase = "" },
            new ModelListCandidate() { Name = "Beta", Title = "Same", TriggerPhrase = "" }
        };
        ModelListPage titled = ModelListWindow.Page(sameTitle, ModelsAPI.ModelHistorySortMode.Title, false, 0, 10, 100);
        Assert.That(Names(titled), Is.EqualTo(new string[] { "Beta", "alpha" }));
    }

    /// <summary>Builds rows named in the given order, with no dates.</summary>
    static List<ModelListCandidate> Rows(params string[] names)
    {
        List<ModelListCandidate> rows = new();
        foreach (string name in names)
        {
            rows.Add(Row(name, 0));
        }
        return rows;
    }

    /// <summary>One candidate with a created time.</summary>
    static ModelListCandidate Row(string name, long created)
    {
        return new ModelListCandidate()
        {
            Name = name,
            Title = "",
            TriggerPhrase = "",
            TimeCreated = created,
            TimeModified = created
        };
    }

    /// <summary>Names of a page, in order.</summary>
    static string[] Names(ModelListPage page)
    {
        string[] names = new string[page.Rows.Count];
        for (int i = 0; i < page.Rows.Count; i++)
        {
            names[i] = page.Rows[i].Name;
        }
        return names;
    }
}
