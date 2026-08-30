using FreneticUtilities.FreneticExtensions;
using System.Collections.Frozen;
using System.Security.Cryptography;

namespace SwarmUI.Builtin_TagDexExtension;

/// <summary>Which broad kind of tag a dataset holds. Drives the tag color and the display shape.</summary>
public enum TagDexKind
{
    /// <summary>A character tag, eg "hatsune miku, vocaloid". Rendered in danbooru's character green.</summary>
    Character,
    /// <summary>An artist tag, eg "ebifurya". Rendered in danbooru's artist pink.</summary>
    Artist
}

/// <summary>Which facet a recognized core tag belongs to.</summary>
public enum TagDexFacet
{
    /// <summary>Not a recognized facet tag.</summary>
    None,
    /// <summary>Hair color, eg "blonde hair".</summary>
    HairColor,
    /// <summary>Hair length, eg "very long hair". Ordered shortest to longest.</summary>
    HairLength,
    /// <summary>Eye color, eg "aqua eyes".</summary>
    EyeColor,
    /// <summary>Gender marker, eg "1girl".</summary>
    Gender
}

/// <summary>One row of a tag dataset.
/// <para>A struct held in a flat array rather than a class: at 245k rows, object headers alone would cost ~12 MB, and
/// array-of-structs keeps the filter scan linear over contiguous memory. Exactly 48 bytes on x64 - four references
/// (32) plus two ints (8) plus the packed facets (8).</para>
/// <para>The <c>url</c> column is deliberately not stored. It is always
/// <c>https://danbooru.donmai.us/posts?tags={Name}</c> (or the e621 equivalent), so retaining it would add ~23 MB per
/// character list for zero information. <see cref="TagDexList.UrlFor"/> rebuilds it on demand.</para></summary>
public struct TagDexEntry
{
    /// <summary>The canonical booru tag name, eg "hatsune_miku". Already lowercase in every shipped dataset.</summary>
    public string Name;

    /// <summary>The prompt trigger, eg "hatsune miku, vocaloid". This is what gets inserted into a prompt.</summary>
    public string Trigger;

    /// <summary>Raw comma-separated descriptive tags, eg "1girl, aqua eyes, twintails". Null for artist datasets and
    /// for e621 characters, neither of which ship a core_tags column.</summary>
    public string CoreTags;

    /// <summary>The series slug, eg "vocaloid". Pooled across the dataset (22,273 unique values across 244,932 rows).
    /// Null for artist datasets.</summary>
    public string Copyright;

    /// <summary>Total booru post count. The only available proxy for how well a model learned this tag.</summary>
    public int Count;

    /// <summary>Posts featuring this tag alone. A better relevance signal than <see cref="Count"/> for
    /// single-subject prompts. Zero when the dataset ships no solo_count column.</summary>
    public int SoloCount;

    /// <summary>Bitmask over <see cref="TagDexVocab.HairColors"/>.</summary>
    public uint HairColors;

    /// <summary>Bitmask over <see cref="TagDexVocab.EyeColors"/>.</summary>
    public ushort EyeColors;

    /// <summary>Bitmask over <see cref="TagDexVocab.HairLengths"/>, ordered shortest to longest.</summary>
    public byte HairLengths;

    /// <summary>Bitmask over <see cref="TagDexVocab.Genders"/>.</summary>
    public byte Genders;

    /// <summary>Pre-resolved thumbnail path relative to the dataset's thumbnail root, or null when the thumbnail
    /// must be looked up by sanitized name.
    /// <para>Set only by datasets that ship their own images with their own naming. The anima-styles export keys
    /// its files by numeric booru tag ID and shards them 1,000 per folder ("1/87540.webp"), which no amount of
    /// name-sanitizing would reproduce.</para></summary>
    public string ThumbPath;

    /// <summary>Style-distinctiveness score, 0-100. Zero when the dataset does not supply one.</summary>
    public float Uniqueness;

    /// <summary>Average artwork-quality score. Zero when the dataset does not supply one.</summary>
    public float AvgScore;
}

/// <summary>The recognized facet vocabularies, ported from AnimaDex's <c>animadex/db.py</c>.
/// <para>Facets are bitmasks rather than single values because entries genuinely carry more than one. Hatsune Miku's
/// core tags list both "aqua eyes" and "blue eyes", and both "very long hair" and "long hair" - a single-valued facet
/// would silently drop one of each. Bitmasks also reduce filtering to one AND per row.</para></summary>
public static class TagDexVocab
{
    /// <summary>The 23 recognized hair color tags.</summary>
    public static readonly string[] HairColors =
    [
        "aqua hair", "black hair", "blonde hair", "blue hair", "brown hair", "dark blue hair", "gradient hair",
        "green hair", "grey hair", "light blue hair", "light brown hair", "light green hair", "light purple hair",
        "multicolored hair", "orange hair", "pink hair", "purple hair", "red hair", "silver hair", "split-color hair",
        "streaked hair", "two-tone hair", "white hair"
    ];

    /// <summary>The 6 recognized hair length tags, ordered shortest to longest so a UI can present them sensibly.</summary>
    public static readonly string[] HairLengths =
    [
        "very short hair", "short hair", "medium hair", "long hair", "very long hair", "absurdly long hair"
    ];

    /// <summary>The 14 recognized eye color tags.</summary>
    public static readonly string[] EyeColors =
    [
        "aqua eyes", "black eyes", "blue eyes", "brown eyes", "gradient eyes", "green eyes", "grey eyes",
        "multicolored eyes", "orange eyes", "pink eyes", "purple eyes", "red eyes", "two-tone eyes", "yellow eyes"
    ];

    /// <summary>The 4 recognized gender marker tags.</summary>
    public static readonly string[] Genders = ["1boy", "1girl", "1other", "no humans"];

    /// <summary>Human-readable labels for <see cref="Genders"/>, index-parallel.</summary>
    public static readonly string[] GenderLabels = ["Male", "Female", "Ambiguous", "Non-Human"];

    /// <summary>Lookup from a recognized core tag to which facet it belongs to and which bit it occupies.
    /// <para>Frozen because it is built once and read on every parsed row - the .NET 8 tool for exactly that shape.</para></summary>
    public static readonly FrozenDictionary<string, (TagDexFacet Facet, int Bit)> Lookup = BuildLookup();

    /// <summary>Builds <see cref="Lookup"/> from the four vocabularies.</summary>
    private static FrozenDictionary<string, (TagDexFacet, int)> BuildLookup()
    {
        Dictionary<string, (TagDexFacet, int)> map = [];
        for (int i = 0; i < HairColors.Length; i++)
        {
            map[HairColors[i]] = (TagDexFacet.HairColor, i);
        }
        for (int i = 0; i < HairLengths.Length; i++)
        {
            map[HairLengths[i]] = (TagDexFacet.HairLength, i);
        }
        for (int i = 0; i < EyeColors.Length; i++)
        {
            map[EyeColors[i]] = (TagDexFacet.EyeColor, i);
        }
        for (int i = 0; i < Genders.Length; i++)
        {
            map[Genders[i]] = (TagDexFacet.Gender, i);
        }
        return map.ToFrozenDictionary();
    }

    /// <summary>Resolves a facet value name to its bit index, or -1 if unrecognized.</summary>
    public static int BitFor(string[] vocab, string value)
    {
        for (int i = 0; i < vocab.Length; i++)
        {
            if (vocab[i].Equals(value, StringComparison.OrdinalIgnoreCase))
            {
                return i;
            }
        }
        return -1;
    }
}

/// <summary>Filesystem and display name helpers.</summary>
public static class TagDexNames
{
    /// <summary>Characters that are illegal or hazardous in a filename on at least one supported platform.
    /// <para>The colon is the one that matters in practice: 1,433 rows of danbooru_character.csv carry it (every
    /// <c>re:zero...</c> entry). It is illegal on Windows and parses as an NTFS alternate data stream.</para></summary>
    public static readonly char[] UnsafeFileChars = [':', '/', '\\', '<', '>', '"', '|', '?', '*'];

    /// <summary>Maps a tag name to a filesystem-safe stem.
    /// <para>Returns the name unchanged when it is already safe. When sanitization actually altered the string, an
    /// 8-hex-character hash of the original is appended, so two distinct names cannot collide onto one file -
    /// without it, <c>re:zero</c> and <c>re_zero</c> would both resolve to <c>re_zero</c> and silently share a
    /// thumbnail.</para></summary>
    public static string SafeFileName(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return "unnamed";
        }
        bool changed = false;
        StringBuilder builder = new(name.Length + 10);
        foreach (char c in name)
        {
            if (c < ' ' || UnsafeFileChars.Contains(c))
            {
                builder.Append('_');
                changed = true;
            }
            else
            {
                builder.Append(c);
            }
        }
        string cleaned = builder.ToString().TrimEnd(' ', '.');
        if (cleaned.Length == 0)
        {
            cleaned = "unnamed";
            changed = true;
        }
        if (!changed)
        {
            return cleaned;
        }
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(name));
        return $"{cleaned}-{Convert.ToHexString(hash)[..8].ToLowerFast()}";
    }

    /// <summary>U+2215 DIVISION SLASH, visually near-identical to a forward slash.</summary>
    public const char SlashSubstitute = '∕';

    /// <summary>Encodes a copyright value for use as a browser folder name.
    /// <para>73 copyright values contain a forward slash (<c>.hack//</c>, <c>22/7</c>, <c>fate/grand_order</c>). The
    /// frontend's folder tree splits names on <c>/</c> to build its hierarchy, so an unescaped value would synthesize
    /// phantom parent folders. The client keeps a reverse map, so correctness never depends on the glyph.</para></summary>
    public static string ToFolderToken(string copyright)
    {
        if (string.IsNullOrEmpty(copyright))
        {
            return copyright;
        }
        return copyright.Replace('/', SlashSubstitute);
    }

    /// <summary>Reverses <see cref="ToFolderToken"/>.</summary>
    public static string FromFolderToken(string token)
    {
        if (string.IsNullOrEmpty(token))
        {
            return token;
        }
        return token.Replace(SlashSubstitute, '/');
    }

    /// <summary>Converts a booru slug to a display form, eg "hatsune_miku" to "hatsune miku".</summary>
    public static string Humanize(string slug)
    {
        if (string.IsNullOrEmpty(slug))
        {
            return slug;
        }
        return slug.Replace('_', ' ');
    }
}
