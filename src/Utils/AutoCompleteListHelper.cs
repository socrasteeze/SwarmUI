using FreneticUtilities.FreneticExtensions;
using SwarmUI.Core;
using System.IO;

namespace SwarmUI.Utils;

/// <summary>Helper for custom word autocomplete lists.</summary>
public class AutoCompleteListHelper
{
    /// <summary>Set of all filenames of auto complete files.</summary>
    public static HashSet<string> FileNames = [];

    /// <summary>Map between filenames and actual wordlists.</summary>
    public static ConcurrentDictionary<string, string[]> AutoCompletionLists = new();

    /// <summary>Maximum number of full formatted-list variants retained at once.</summary>
    private const int MaxFormattedAutoCompletionLists = 8;

    /// <summary>Maximum number of UTF-16 characters retained across formatted-list variants.</summary>
    private const long MaxFormattedAutoCompletionCharacters = 32L * 1024 * 1024;

    /// <summary>Maximum source bytes accepted by the async/mobile loading path.</summary>
    private const long MaxAsyncSourceBytes = 32L * 1024 * 1024;

    /// <summary>Maximum non-comment entries accepted by the async/mobile loading path.</summary>
    private const int MaxAsyncEntryCount = 500_000;

    /// <summary>Maximum formatted UTF-16 characters returned by the async/mobile loading path.</summary>
    private const long MaxAsyncFormattedCharacters = 32L * 1024 * 1024;

    /// <summary>Maximum suffix length accepted by the async/mobile loading path.</summary>
    private const int MaxAsyncSuffixLength = 256;

    /// <summary>Maximum number of bounded raw sources retained at once.</summary>
    private const int MaxBoundedRawLists = 4;

    /// <summary>Maximum total UTF-16 characters retained by bounded raw source caches.</summary>
    private const long MaxBoundedRawCharacters = 64L * 1024 * 1024;

    /// <summary>Maximum bounded source failures retained at once.</summary>
    private const int MaxBoundedRawLoadErrors = 16;

    /// <summary>One atomically replaceable generation of autocomplete discovery and cache state.</summary>
    private sealed class AutoCompleteCacheState(HashSet<string> fileNames, ConcurrentDictionary<string, string[]> rawLists)
    {
        /// <summary>Source names belonging to this generation.</summary>
        public readonly HashSet<string> FileNames = fileNames;

        /// <summary>Raw parsed source lists belonging to this generation.</summary>
        public readonly ConcurrentDictionary<string, string[]> RawLists = rawLists;

        /// <summary>Raw lists independently validated for the bounded async/mobile path.</summary>
        public readonly ConcurrentDictionary<string, string[]> BoundedRawLists = new();

        /// <summary>Guards bounded raw cache accounting.</summary>
        public readonly object BoundedRawListsLock = new();

        /// <summary>Total UTF-16 characters retained by <see cref="BoundedRawLists"/>.</summary>
        public long BoundedRawCharacterCount;

        /// <summary>Bounded source-limit failures remembered until the next reload.</summary>
        public readonly ConcurrentDictionary<string, string> BoundedRawLoadErrors = new();

        /// <summary>Bounded formatted lists keyed by source and user formatting options.</summary>
        public readonly Dictionary<(string Name, bool EscapeParens, string Suffix, string SpaceMode), string[]> BoundedFormattedLists = [];

        /// <summary>Bounded formatted-list keys rejected for exceeding the mobile output budget.</summary>
        public readonly HashSet<(string Name, bool EscapeParens, string Suffix, string SpaceMode)> BoundedFormattedLoadErrors = [];

        /// <summary>Guards bounded formatted list state.</summary>
        public readonly object BoundedFormattedListsLock = new();

        /// <summary>Total UTF-16 characters retained by <see cref="BoundedFormattedLists"/>.</summary>
        public long BoundedFormattedCharacterCount;

        /// <summary>Prevents concurrent cold reads from multiplying the bounded source-memory budget.</summary>
        public readonly SemaphoreSlim AsyncLoadGate = new(1, 1);

        /// <summary>Prevents concurrent cold misses from formatting the same full list more than once.</summary>
        public readonly SemaphoreSlim FormatGate = new(1, 1);
    }

    /// <summary>Current cache generation. Reload replaces this reference instead of clearing dictionaries that active readers still use.</summary>
    private static AutoCompleteCacheState CurrentCache = new(FileNames, AutoCompletionLists);

    /// <summary>Gets the correct folder path to use.</summary>
    public static string FolderPath;

    /// <summary>Initializes the helper.</summary>
    public static void Init()
    {
        Reload();
        Program.ModelRefreshEvent += Reload;
    }

    /// <summary>Reloads the list of files.</summary>
    public static void Reload()
    {
        try
        {
            FolderPath = $"{Program.DataDir}/Autocompletions";
            HashSet<string> files = [];
            Directory.CreateDirectory(FolderPath);
            foreach (string file in Directory.GetFiles(FolderPath, "*", SearchOption.AllDirectories))
            {
                if (file.EndsWith(".txt") || file.EndsWith(".csv"))
                {
                    string path = Path.GetRelativePath(FolderPath, file).Replace("\\", "/").TrimStart('/');
                    files.Add(path);
                }
            }
            ConcurrentDictionary<string, string[]> rawLists = new();
            AutoCompleteCacheState next = new(files, rawLists);
            Volatile.Write(ref CurrentCache, next);
            FileNames = files;
            AutoCompletionLists = rawLists;
        }
        catch (Exception ex)
        {
            Logs.Error($"Error while refreshing autocomplete lists: {ex.ReadableString()}");
        }
    }

    /// <summary>Gets a specific data list. This retains the legacy unbounded source contract for existing callers.</summary>
    public static string[] GetData(string name, bool escapeParens, string suffix, string spaceMode)
    {
        while (true)
        {
            AutoCompleteCacheState cache = Volatile.Read(ref CurrentCache);
            if (!cache.FileNames.Contains(name))
            {
                return null;
            }
            string effectiveSuffix = suffix ?? "";
            string effectiveSpaceMode = NormalizeSpaceMode(spaceMode);
            string[] raw = cache.RawLists.GetOrCreate(name, () => ParseData(File.ReadAllText(Path.Combine(FolderPath, name))));
            if (!ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
            {
                continue;
            }
            (string[] Data, long CharacterCount) formatted = FormatData(raw, escapeParens, effectiveSuffix, effectiveSpaceMode, default, long.MaxValue);
            if (ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
            {
                return formatted.Data;
            }
        }
    }

    /// <summary>Gets a bounded formatted data list without blocking a request thread on the first file read.</summary>
    public static async Task<string[]> GetDataAsync(string name, bool escapeParens, string suffix, string spaceMode, CancellationToken cancellationToken = default)
    {
        (string Source, string[] Entries) result = await GetDataAsync(name, null, escapeParens, suffix, spaceMode, cancellationToken);
        return result.Entries;
    }

    /// <summary>Resolves an exact same-directory sibling against one cache generation, then loads it atomically.</summary>
    public static Task<(string Source, string[] Entries)> GetDataWithSiblingFallbackAsync(string configuredName, string configuredStem, string siblingStem,
        bool escapeParens, string suffix, string spaceMode, CancellationToken cancellationToken = default)
    {
        string Resolve(HashSet<string> files, string configured)
        {
            if (string.IsNullOrWhiteSpace(configured)
                || !string.Equals(Path.GetFileNameWithoutExtension(configured), configuredStem, StringComparison.OrdinalIgnoreCase))
            {
                return configured;
            }
            string normalized = configured.Replace('\\', '/');
            string folder = normalized.Contains('/') ? normalized.BeforeLast('/') : "";
            string replacement = files
                .Where(name => string.Equals(name.Contains('/') ? name.BeforeLast('/') : "", folder, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(Path.GetFileNameWithoutExtension(name), siblingStem, StringComparison.OrdinalIgnoreCase))
                .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
            return replacement ?? configured;
        }
        return GetDataAsync(configuredName, Resolve, escapeParens, suffix, spaceMode, cancellationToken);
    }

    /// <summary>Loads bounded async data against one cache generation, retrying the complete resolution after reload.</summary>
    private static async Task<(string Source, string[] Entries)> GetDataAsync(string configuredName, Func<HashSet<string>, string, string> sourceResolver,
        bool escapeParens, string suffix, string spaceMode, CancellationToken cancellationToken)
    {
        string effectiveSuffix = suffix ?? "";
        if (effectiveSuffix.Length > MaxAsyncSuffixLength)
        {
            throw new InvalidDataException($"Autocomplete suffix exceeds the {MaxAsyncSuffixLength}-character mobile limit.");
        }
        string effectiveSpaceMode = NormalizeSpaceMode(spaceMode);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AutoCompleteCacheState cache = Volatile.Read(ref CurrentCache);
            string name = sourceResolver is null ? configuredName : sourceResolver(cache.FileNames, configuredName);
            if (string.IsNullOrWhiteSpace(name) || !cache.FileNames.Contains(name))
            {
                if (ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
                {
                    return (name, null);
                }
                continue;
            }
            (string Name, bool EscapeParens, string Suffix, string SpaceMode) key = (name, escapeParens, effectiveSuffix, effectiveSpaceMode);
            lock (cache.BoundedFormattedListsLock)
            {
                if (cache.BoundedFormattedLoadErrors.Contains(key))
                {
                    if (ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
                    {
                        throw new InvalidDataException("Formatted autocomplete data exceeds the mobile response limit.");
                    }
                    continue;
                }
                if (cache.BoundedFormattedLists.TryGetValue(key, out string[] cached))
                {
                    string[] copy = CloneData(cached, cancellationToken);
                    if (ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
                    {
                        return (name, copy);
                    }
                    continue;
                }
            }
            if (!cache.BoundedRawLists.TryGetValue(name, out string[] raw))
            {
                if (cache.BoundedRawLoadErrors.TryGetValue(name, out string loadError))
                {
                    if (ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
                    {
                        throw new InvalidDataException(loadError);
                    }
                    continue;
                }
                await cache.AsyncLoadGate.WaitAsync(cancellationToken);
                try
                {
                    if (!ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
                    {
                        continue;
                    }
                    if (cache.BoundedRawLoadErrors.TryGetValue(name, out loadError))
                    {
                        throw new InvalidDataException(loadError);
                    }
                    if (!cache.BoundedRawLists.TryGetValue(name, out raw))
                    {
                        try
                        {
                            (string[] Data, long CharacterCount) parsed = await ParseDataAsync(Path.Combine(FolderPath, name), cancellationToken);
                            raw = parsed.Data;
                            if (!ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
                            {
                                continue;
                            }
                            raw = StoreBoundedRaw(cache, name, raw, parsed.CharacterCount);
                        }
                        catch (InvalidDataException ex)
                        {
                            if (!ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
                            {
                                continue;
                            }
                            StoreBoundedRawError(cache, name, ex.Message);
                            throw;
                        }
                    }
                }
                finally
                {
                    cache.AsyncLoadGate.Release();
                }
            }
            if (!ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
            {
                continue;
            }
            await cache.FormatGate.WaitAsync(cancellationToken);
            try
            {
                if (!ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
                {
                    continue;
                }
                lock (cache.BoundedFormattedListsLock)
                {
                    if (cache.BoundedFormattedLoadErrors.Contains(key))
                    {
                        throw new InvalidDataException("Formatted autocomplete data exceeds the mobile response limit.");
                    }
                    if (cache.BoundedFormattedLists.TryGetValue(key, out string[] cached))
                    {
                        string[] cachedCopy = CloneData(cached, cancellationToken);
                        if (ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
                        {
                            return (name, cachedCopy);
                        }
                        continue;
                    }
                }
                (string[] Data, long CharacterCount) formatted;
                try
                {
                    formatted = FormatData(raw, escapeParens, effectiveSuffix, effectiveSpaceMode, cancellationToken, MaxAsyncFormattedCharacters);
                }
                catch (InvalidDataException)
                {
                    if (!ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
                    {
                        continue;
                    }
                    StoreFormattedError(cache, key);
                    throw;
                }
                if (!ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
                {
                    continue;
                }
                string[] stored = StoreBoundedFormatted(cache, key, formatted.Data, formatted.CharacterCount);
                string[] copy = CloneData(stored, cancellationToken);
                if (ReferenceEquals(cache, Volatile.Read(ref CurrentCache)))
                {
                    return (name, copy);
                }
            }
            finally
            {
                cache.FormatGate.Release();
            }
        }
    }

    /// <summary>Stores one bounded raw list under count and retained-character budgets.</summary>
    private static string[] StoreBoundedRaw(AutoCompleteCacheState cache, string name, string[] raw, long characterCount)
    {
        lock (cache.BoundedRawListsLock)
        {
            if (cache.BoundedRawLists.TryGetValue(name, out string[] cached))
            {
                return cached;
            }
            if (cache.BoundedRawLists.Count >= MaxBoundedRawLists
                || cache.BoundedRawCharacterCount + characterCount > MaxBoundedRawCharacters)
            {
                cache.BoundedRawLists.Clear();
                cache.BoundedRawCharacterCount = 0;
            }
            cache.BoundedRawLists[name] = raw;
            cache.BoundedRawCharacterCount += characterCount;
            return raw;
        }
    }

    /// <summary>Remembers a bounded number of source-limit failures until reload.</summary>
    private static void StoreBoundedRawError(AutoCompleteCacheState cache, string name, string message)
    {
        lock (cache.BoundedRawListsLock)
        {
            if (cache.BoundedRawLoadErrors.Count >= MaxBoundedRawLoadErrors)
            {
                cache.BoundedRawLoadErrors.Clear();
            }
            cache.BoundedRawLoadErrors.TryAdd(name, message);
        }
    }

    /// <summary>Stores one formatted list without allowing full-list variants to grow without bound.</summary>
    private static string[] StoreBoundedFormatted(AutoCompleteCacheState cache, (string Name, bool EscapeParens, string Suffix, string SpaceMode) key,
        string[] formatted, long characterCount)
    {
        lock (cache.BoundedFormattedListsLock)
        {
            if (cache.BoundedFormattedLists.TryGetValue(key, out string[] cached))
            {
                return cached;
            }
            if (key.Suffix.Length > MaxAsyncSuffixLength || characterCount > MaxFormattedAutoCompletionCharacters)
            {
                return formatted;
            }
            if (cache.BoundedFormattedLists.Count >= MaxFormattedAutoCompletionLists
                || cache.BoundedFormattedCharacterCount + characterCount > MaxFormattedAutoCompletionCharacters)
            {
                cache.BoundedFormattedLists.Clear();
                cache.BoundedFormattedCharacterCount = 0;
            }
            cache.BoundedFormattedLists[key] = formatted;
            cache.BoundedFormattedCharacterCount += characterCount;
            return formatted;
        }
    }

    /// <summary>Remembers a bounded number of rejected variants so repeated requests do not repeat full formatting.</summary>
    private static void StoreFormattedError(AutoCompleteCacheState cache,
        (string Name, bool EscapeParens, string Suffix, string SpaceMode) key)
    {
        lock (cache.BoundedFormattedListsLock)
        {
            if (cache.BoundedFormattedLoadErrors.Count >= MaxFormattedAutoCompletionLists)
            {
                cache.BoundedFormattedLoadErrors.Clear();
            }
            cache.BoundedFormattedLoadErrors.Add(key);
        }
    }

    /// <summary>Parses one autocomplete source file into its non-comment data lines.</summary>
    private static string[] ParseData(string text)
    {
        return [.. text.Replace('\r', '\n').SplitFast('\n').Select(s => s.Trim()).Where(s => !string.IsNullOrWhiteSpace(s) && !s.StartsWithFast('#'))];
    }

    /// <summary>Reads and parses one autocomplete source with mobile-safe source and entry limits.</summary>
    private static async Task<(string[] Data, long CharacterCount)> ParseDataAsync(string path, CancellationToken cancellationToken)
    {
        FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 65536, FileOptions.Asynchronous | FileOptions.SequentialScan);
        await using (stream)
        {
            if (stream.Length > MaxAsyncSourceBytes)
            {
                throw new InvalidDataException($"Autocomplete source exceeds the {MaxAsyncSourceBytes / (1024 * 1024)} MiB mobile limit.");
            }
            StreamReader reader = new(stream);
            using (reader)
            {
                List<string> result = [];
                long sourceCharacters = 0;
                long retainedCharacters = 0;
                while (await reader.ReadLineAsync(cancellationToken) is string line)
                {
                    sourceCharacters += line.Length + 1L;
                    if (sourceCharacters > MaxAsyncSourceBytes)
                    {
                        throw new InvalidDataException($"Autocomplete source exceeds the {MaxAsyncSourceBytes / (1024 * 1024)} MiB mobile limit.");
                    }
                    line = line.Trim();
                    if (!string.IsNullOrWhiteSpace(line) && !line.StartsWithFast('#'))
                    {
                        result.Add(line);
                        retainedCharacters += line.Length;
                        if (result.Count > MaxAsyncEntryCount)
                        {
                            throw new InvalidDataException($"Autocomplete source exceeds the {MaxAsyncEntryCount:N0}-entry mobile limit.");
                        }
                    }
                }
                return ([.. result], retainedCharacters);
            }
        }
    }

    /// <summary>Applies one user's formatting options to a parsed autocomplete list.</summary>
    private static (string[] Data, long CharacterCount) FormatData(string[] raw, bool escapeParens, string suffix, string spaceMode,
        CancellationToken cancellationToken, long maxCharacters)
    {
        string[] result = new string[raw.Length];
        long characterCount = 0;
        bool doSpace = spaceMode == "Spaces";
        bool doUnderscore = spaceMode == "Underscores";
        for (int i = 0; i < result.Length; i++)
        {
            if ((i & 1023) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            string[] parts = Utilities.SplitStandardCsv(raw[i]);
            if (parts.Length == 2 && long.TryParse(parts[1], out _))
            {
                parts = [parts[0], "0", parts[1], ""];
            }
            string word = parts[0];
            if (doSpace)
            {
                word = word.Replace("_", " ");
            }
            else if (doUnderscore)
            {
                word = word.Replace(" ", "_");
            }
            word += suffix;
            if (escapeParens)
            {
                word = word.Replace("(", "\\(").Replace(")", "\\)");
            }
            string formatted = $"{word}\n{parts.JoinString("\n")}";
            if (formatted.Length > maxCharacters - characterCount)
            {
                throw new InvalidDataException($"Formatted autocomplete data exceeds the {MaxAsyncFormattedCharacters / (1024 * 1024)}-million-character mobile limit.");
            }
            result[i] = formatted;
            characterCount += formatted.Length;
        }
        return (result, characterCount);
    }

    /// <summary>Returns the only space modes that affect formatting, canonicalizing all other values.</summary>
    private static string NormalizeSpaceMode(string spaceMode)
    {
        return spaceMode == "Spaces" || spaceMode == "Underscores" ? spaceMode : "";
    }

    /// <summary>Clones a formatted list without leaving a long copy loop uncancellable.</summary>
    private static string[] CloneData(string[] data, CancellationToken cancellationToken)
    {
        string[] result = new string[data.Length];
        for (int i = 0; i < data.Length; i++)
        {
            if ((i & 1023) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            result[i] = data[i];
        }
        return result;
    }
}
