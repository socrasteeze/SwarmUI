using FreneticUtilities.FreneticExtensions;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using System.Text.RegularExpressions;

namespace SwarmUI.Builtin_TagDexExtension;

/// <summary>Server-side <c>&lt;characters:favorite|random&gt;</c> and <c>&lt;artists:favorite|random&gt;</c> prompt tags.
/// <para>Resolved per image from the wildcard random, so batches vary and a reused wildcard seed reproduces the pick.
/// <c>favorite</c> draws from the requesting user's TagDex stars and falls back to <c>random</c> when there are none.</para>
/// <para>Character picks are female-only: an entry must carry <c>1girl</c> and must not carry <c>1boy</c>. Entries
/// with no core tags (every e621 character) have no gender information, so they are never picked.</para></summary>
public static class TagDexPromptTags
{
    /// <summary>Minimum booru post count for the <c>random</c> pool. Below this the model has rarely learned the tag.</summary>
    public const int RandomMinCount = 500;

    /// <summary>Artist-dataset meta tags that are not real artists.</summary>
    public static readonly HashSet<string> ExcludedArtists = ["banned_artist"];

    /// <summary>Matches a parenthesis not already escaped with a backslash.</summary>
    public static readonly Regex UnescapedParen = new(@"(?<!\\)([()])", RegexOptions.Compiled);

    /// <summary>Registers both tags with core prompt handling.</summary>
    public static void Register()
    {
        T2IPromptHandling.PromptTagProcessors["characters"] = (data, context) => Resolve(data, context, TagDexKind.Character);
        T2IPromptHandling.PromptTagProcessors["artists"] = (data, context) => Resolve(data, context, TagDexKind.Artist);
        T2IPromptHandling.PromptTagLengthEstimators["characters"] = (data, context) => "";
        T2IPromptHandling.PromptTagLengthEstimators["artists"] = (data, context) => "";
    }

    /// <summary>Escapes bare parentheses so "saber (fate)" is not read as prompt weighting.</summary>
    public static string EscapeParens(string text)
    {
        return UnescapedParen.Replace(text, @"\$1");
    }

    /// <summary>True if an entry may appear in a character pick: tagged 1girl, never 1boy.</summary>
    public static bool IsFemaleOnly(in TagDexEntry entry)
    {
        int girl = 1 << TagDexVocab.BitFor(TagDexVocab.Genders, "1girl");
        int boy = 1 << TagDexVocab.BitFor(TagDexVocab.Genders, "1boy");
        return (entry.Genders & girl) != 0 && (entry.Genders & boy) == 0;
    }

    /// <summary>True if an entry is eligible for its kind, ignoring post count.</summary>
    public static bool IsEligible(in TagDexEntry entry, TagDexKind kind)
    {
        if (kind == TagDexKind.Character)
        {
            return IsFemaleOnly(entry);
        }
        return !ExcludedArtists.Contains(entry.Name);
    }

    /// <summary>The prompt text for one pick. Characters are name plus every core tag; artists are their trigger.</summary>
    public static string Format(in TagDexEntry entry, TagDexKind kind)
    {
        if (kind == TagDexKind.Character)
        {
            string name = EscapeParens(TagDexNames.Humanize(entry.Name));
            return string.IsNullOrWhiteSpace(entry.CoreTags) ? name : $"{name}, {entry.CoreTags}";
        }
        return EscapeParens(entry.Trigger);
    }

    /// <summary>Builds the candidate pool. Favorites come from every loaded source of the kind; random uses the
    /// post-count floor. Order is deterministic (source order, then the list's count-descending order).</summary>
    public static List<TagDexEntry> BuildPool(TagDexKind kind, HashSet<string> favorites)
    {
        List<TagDexEntry> pool = [];
        foreach (TagDexSource source in TagDexData.Sources)
        {
            // Custom characters are picked by hand from their card, never at random: they carry no post count and
            // their tag line lives in Trigger, which Format does not use.
            if (source.Kind != kind || source.Format == TagDexFormat.Custom || !TagDexData.IsPresent(source))
            {
                continue;
            }
            TagDexList list = TagDexData.EnsureLoaded(source.ID);
            if (list is null)
            {
                continue;
            }
            if (favorites is not null)
            {
                foreach (string name in TagDexFavorites.ForSource(favorites, source.ID).OrderBy(n => n, StringComparer.Ordinal))
                {
                    if (list.ByName.TryGetValue(name, out int index) && IsEligible(list.Entries[index], kind))
                    {
                        pool.Add(list.Entries[index]);
                    }
                }
                continue;
            }
            foreach (TagDexEntry entry in list.Entries)
            {
                if (entry.Count >= RandomMinCount && IsEligible(entry, kind))
                {
                    pool.Add(entry);
                }
            }
        }
        return pool;
    }

    /// <summary>Handles one <c>&lt;characters:...&gt;</c> or <c>&lt;artists:...&gt;</c> tag.</summary>
    public static string Resolve(string data, T2IPromptHandling.PromptTagContext context, TagDexKind kind)
    {
        string tagName = kind == TagDexKind.Character ? "characters" : "artists";
        string mode = context.Parse(data).Trim().ToLowerFast();
        if (mode != "favorite" && mode != "favorites" && mode != "random")
        {
            context.TrackWarning($"<{tagName}:{data}> is not valid. Use <{tagName}:favorite> or <{tagName}:random>.");
            return null;
        }
        List<TagDexEntry> pool = [];
        if (mode != "random" && context.Input.SourceSession is not null)
        {
            pool = BuildPool(kind, TagDexFavorites.For(context.Input.SourceSession));
        }
        if (pool.Count == 0)
        {
            pool = BuildPool(kind, null);
        }
        if (pool.Count == 0)
        {
            context.TrackWarning($"<{tagName}:{mode}> found nothing to pick from. Download a TagDex {tagName[..^1]} dataset first.");
            return "";
        }
        TagDexEntry pick = pool[context.Input.GetWildcardRandom().Next(pool.Count)];
        return Format(pick, kind);
    }
}
