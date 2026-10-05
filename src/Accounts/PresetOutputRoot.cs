using System.IO;
using System.Security.Cryptography;
using System.Text;
using FreneticUtilities.FreneticExtensions;
using LiteDB;
using SwarmUI.Text2Image;
using SwarmUI.Utils;

namespace SwarmUI.Accounts;

/// <summary>Maps a preset Output Root onto a history folder and registers that folder the same way Comfy's output folder is registered.</summary>
public static class PresetOutputRoot
{
    /// <summary>History-folder keys this feature registered. Other keys, including Comfy's, stay in place.</summary>
    public static HashSet<string> OwnedFolderKeys = [];

    /// <summary>Serializes updates to <see cref="OwnedFolderKeys"/> and <see cref="UserImageHistoryHelper.SharedSpecialFolders"/>.</summary>
    static readonly object RefreshLock = new();

    /// <summary>Blank keeps the server output root. A full Windows path is normalized. Anything else is refused.</summary>
    public static string Validate(string raw, IEnumerable<string> readyDriveRoots)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }
        string text = raw.Trim();
        if (text.Contains(';'))
        {
            throw new SwarmUserErrorException("Output Root must be a single path.");
        }
        if (text.StartsWith("\\\\") || text.StartsWith("//"))
        {
            throw new SwarmUserErrorException("Output Root must be on a real drive.");
        }
        if (!IsDriveAbsolute(text))
        {
            throw new SwarmUserErrorException("Output Root must be a full path.");
        }
        char drive = char.ToUpperInvariant(text[0]);
        if (!DriveIsReady(drive, readyDriveRoots))
        {
            throw new SwarmUserErrorException("Output Root must be on a real drive.");
        }
        if (HasIllegalPathChar(text))
        {
            throw new SwarmUserErrorException("Output Root must be a full path.");
        }
        string normalized = Normalize(text, drive);
        if (normalized is null)
        {
            throw new SwarmUserErrorException("Output Root must be a full path.");
        }
        return normalized;
    }

    /// <summary>Last non-blank root wins. A blank does not clear an earlier root.</summary>
    public static string ChooseOutputRoot(IEnumerable<string> roots)
    {
        string chosen = null;
        if (roots is null)
        {
            return null;
        }
        foreach (string root in roots)
        {
            if (!string.IsNullOrWhiteSpace(root))
            {
                chosen = root;
            }
        }
        return chosen;
    }

    /// <summary>Stable history folder names for normalized paths. The name is a folder, never a drive path.</summary>
    public static Dictionary<string, string> AssignFolderNames(IEnumerable<string> normalizedPaths)
    {
        List<string> unique = [];
        foreach (string path in normalizedPaths ?? [])
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                continue;
            }
            bool seen = false;
            foreach (string existing in unique)
            {
                if (PathsEqual(existing, path))
                {
                    seen = true;
                    break;
                }
            }
            if (!seen)
            {
                unique.Add(path);
            }
        }
        Dictionary<string, string> names = new(StringComparer.OrdinalIgnoreCase);
        Dictionary<string, List<string>> groups = [];
        foreach (string path in unique)
        {
            string leaf = LeafName(path);
            if (leaf.Length == 0)
            {
                names[path] = "drive_" + char.ToUpperInvariant(path[0]);
                continue;
            }
            string sanitized = SanitizeFolder(leaf);
            if (sanitized.Length == 0)
            {
                names[path] = "drive_" + char.ToUpperInvariant(path[0]) + "_" + ShortHash(path);
                continue;
            }
            names[path] = sanitized;
            string groupKey = leaf.ToLowerFast();
            if (!groups.TryGetValue(groupKey, out List<string> group))
            {
                group = [];
                groups[groupKey] = group;
            }
            group.Add(path);
        }
        foreach (List<string> group in groups.Values)
        {
            if (group.Count < 2)
            {
                continue;
            }
            group.Sort(StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < group.Count; i++)
            {
                string path = group[i];
                names[path] = SanitizeFolder(LeafName(path)) + "_" + ShortHash(path);
            }
        }
        Disambiguate(unique, names);
        return names;
    }

    /// <summary>Prefixes a relative output path with the history folder. A blank folder leaves the path unchanged.</summary>
    public static string PrefixHistoryPath(string imagePath, string folder)
    {
        if (string.IsNullOrWhiteSpace(folder))
        {
            return imagePath;
        }
        string prefix = folder.Trim().Trim('/');
        if (prefix.Length == 0)
        {
            return imagePath;
        }
        string rest = imagePath ?? "";
        rest = rest.TrimStart('/');
        if (rest.Length == 0)
        {
            return prefix;
        }
        return prefix + "/" + rest;
    }

    /// <summary>Replaces this feature's folder mappings with the valid roots. Invalid roots are skipped. Foreign keys stay.</summary>
    public static Dictionary<string, string> Refresh(IEnumerable<string> rawRoots, IEnumerable<string> readyDriveRoots)
    {
        List<string> valid = [];
        foreach (string raw in rawRoots ?? [])
        {
            try
            {
                string normalized = Validate(raw, readyDriveRoots);
                if (normalized is null)
                {
                    continue;
                }
                bool seen = false;
                foreach (string existing in valid)
                {
                    if (PathsEqual(existing, normalized))
                    {
                        seen = true;
                        break;
                    }
                }
                if (!seen)
                {
                    valid.Add(normalized);
                }
            }
            catch (SwarmUserErrorException)
            {
                Logs.Debug("Output Root skipped an invalid preset path.");
            }
        }
        lock (RefreshLock)
        {
            return Apply(valid);
        }
    }

    /// <summary>Rebuilds the mapping from every stored preset. A failed read leaves the current mapping in place.</summary>
    public static void RefreshFromDatabase(ILiteCollection<T2IPreset> presets, object gate)
    {
        if (presets is null)
        {
            return;
        }
        List<string> roots;
        try
        {
            List<T2IPreset> rows;
            if (gate is null)
            {
                rows = [.. presets.FindAll()];
            }
            else
            {
                lock (gate)
                {
                    rows = [.. presets.FindAll()];
                }
            }
            roots = [];
            foreach (T2IPreset row in rows)
            {
                roots.Add(row?.OutputRoot);
            }
        }
        catch (Exception ex)
        {
            Logs.Warning($"Output Root preset read failed: {ex.Message}");
            return;
        }
        try
        {
            Refresh(roots, ReadyDriveRoots());
        }
        catch (Exception ex)
        {
            Logs.Warning($"Output Root mapping refresh failed: {ex.Message}");
        }
    }

    /// <summary>Rebuilds the mapping after a preset save or delete. Failures are logged and do not escape.</summary>
    public static void RefreshAfterPresetChange(SessionHandler handler)
    {
        if (handler is null)
        {
            return;
        }
        try
        {
            RefreshFromDatabase(handler.T2IPresets, handler.DBLock);
        }
        catch (Exception ex)
        {
            Logs.Warning($"Output Root preset refresh failed: {ex.Message}");
        }
    }

    /// <summary>Validates a root, creates it, and returns the history folder name that was actually registered.</summary>
    public static string EnsureMapped(string normalized, IEnumerable<string> readyDriveRoots)
    {
        string checkedPath = Validate(normalized, readyDriveRoots);
        if (checkedPath is null)
        {
            throw new SwarmUserErrorException("Output Root must be a full path.");
        }
        lock (RefreshLock)
        {
            List<string> paths = [];
            foreach (string key in OwnedFolderKeys)
            {
                if (UserImageHistoryHelper.SharedSpecialFolders.TryGetValue(key, out string mapped) && !string.IsNullOrWhiteSpace(mapped))
                {
                    paths.Add(mapped);
                }
            }
            paths.Add(checkedPath);
            Dictionary<string, string> result = Apply(paths);
            foreach ((string path, string folder) in result)
            {
                if (PathsEqual(path, checkedPath))
                {
                    return folder;
                }
            }
            throw new SwarmUserErrorException("Output Root could not be registered.");
        }
    }

    /// <summary>Applies one preset root to a generation. A blank root changes nothing. A refused root does not start generation.</summary>
    public static void UseForGeneration(T2IParamInput input, string raw)
    {
        string normalized = Validate(raw, ReadyDriveRoots());
        if (normalized is null)
        {
            return;
        }
        try
        {
            Directory.CreateDirectory(normalized);
        }
        catch (Exception ex)
        {
            throw new SwarmUserErrorException($"Output Root could not be created: {ex.Message}");
        }
        input.OutputRootFolder = EnsureMapped(normalized, ReadyDriveRoots());
    }

    /// <summary>Ready drive roots such as "D:\", or an empty list when none can be read.</summary>
    public static List<string> ReadyDriveRoots()
    {
        List<string> roots = [];
        try
        {
            foreach (DriveInfo drive in DriveInfo.GetDrives())
            {
                try
                {
                    if (!drive.IsReady || string.IsNullOrEmpty(drive.Name) || drive.Name.Length < 2 || !IsAsciiLetter(drive.Name[0]))
                    {
                        continue;
                    }
                    roots.Add(drive.Name);
                }
                catch (Exception ex)
                {
                    Logs.Debug($"Output Root drive check skipped: {ex.Message}");
                }
            }
        }
        catch (Exception ex)
        {
            Logs.Debug($"Output Root drive check failed: {ex.Message}");
        }
        return roots;
    }

    /// <summary>Last path segment. A bare drive root has an empty leaf.</summary>
    public static string LeafName(string normalized)
    {
        if (string.IsNullOrEmpty(normalized))
        {
            return "";
        }
        string unified = normalized.Replace('/', '\\');
        if (unified.Length == 3 && IsAsciiLetter(unified[0]) && unified[1] == ':' && unified[2] == '\\')
        {
            return "";
        }
        string trimmed = unified.TrimEnd('\\');
        int slash = trimmed.LastIndexOf('\\');
        if (slash < 0)
        {
            return trimmed;
        }
        return trimmed[(slash + 1)..];
    }

    /// <summary>History-folder form of a leaf. Slashes and filename-forbidden characters are removed. Interior dots stay.</summary>
    public static string SanitizeFolder(string leaf)
    {
        if (string.IsNullOrEmpty(leaf))
        {
            return "";
        }
        string cleaned = Utilities.FilePathForbidden.TrimToNonMatches(leaf);
        return cleaned.Replace("/", "").Replace("\\", "");
    }

    /// <summary>First six lowercase hex characters of the SHA256 of the lowercased path.</summary>
    public static string ShortHash(string path)
    {
        string lower = (path ?? "").ToLowerFast();
        byte[] bytes = SHA256.HashData(Encoding.UTF8.GetBytes(lower));
        return Convert.ToHexString(bytes)[..6].ToLowerInvariant();
    }

    /// <summary>True when two paths are the same drive path, ignoring slash style, trailing slash, and case. A bare drive keeps its slash.</summary>
    public static bool PathsEqual(string a, string b)
    {
        if (a is null || b is null)
        {
            return false;
        }
        return string.Equals(Canonical(a), Canonical(b), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Picks a free history key. A key that is already registered is left alone and this path gets a stable suffix.</summary>
    public static string ClaimKey(string folderName, string normalizedPath)
    {
        string plain = folderName + "/";
        if (!UserImageHistoryHelper.SharedSpecialFolders.ContainsKey(plain))
        {
            return plain;
        }
        string hash = ShortHash(normalizedPath);
        for (int i = 0; i < 16; i++)
        {
            string suffix = i == 0 ? hash : hash + "_" + i;
            string candidate = folderName + "_" + suffix + "/";
            if (!UserImageHistoryHelper.SharedSpecialFolders.ContainsKey(candidate))
            {
                return candidate;
            }
        }
        throw new SwarmUserErrorException("Output Root could not be registered.");
    }

    /// <summary>Gives a later path a hash suffix when two paths want the same history folder name.</summary>
    static void Disambiguate(List<string> paths, Dictionary<string, string> names)
    {
        for (int pass = 0; pass < 8; pass++)
        {
            List<string> ordered = [.. paths];
            ordered.Sort(StringComparer.OrdinalIgnoreCase);
            HashSet<string> used = new(StringComparer.OrdinalIgnoreCase);
            bool moved = false;
            foreach (string path in ordered)
            {
                string name = names[path];
                if (!used.Contains(name))
                {
                    used.Add(name);
                    continue;
                }
                string hash = ShortHash(path);
                string candidate = name.EndsWith("_" + hash, StringComparison.Ordinal) ? name + "_2" : name + "_" + hash;
                int n = 2;
                while (used.Contains(candidate) && n < 16)
                {
                    candidate = name + "_" + hash + "_" + n;
                    n++;
                }
                names[path] = candidate;
                used.Add(candidate);
                moved = true;
            }
            if (!moved)
            {
                return;
            }
        }
    }

    /// <summary>Removes this feature's keys, then registers <paramref name="normalizedPaths"/>. A failure restores the previous keys.</summary>
    static Dictionary<string, string> Apply(List<string> normalizedPaths)
    {
        Dictionary<string, string> names = AssignFolderNames(normalizedPaths);
        Dictionary<string, string> removed = [];
        foreach (string key in OwnedFolderKeys)
        {
            if (UserImageHistoryHelper.SharedSpecialFolders.TryRemove(key, out string value))
            {
                removed[key] = value;
            }
        }
        OwnedFolderKeys.Clear();
        try
        {
            Dictionary<string, string> claimed = new(StringComparer.OrdinalIgnoreCase);
            foreach ((string path, string folder) in names)
            {
                claimed[path] = ClaimKey(folder, path);
            }
            Dictionary<string, string> result = new(StringComparer.OrdinalIgnoreCase);
            foreach ((string path, string key) in claimed)
            {
                OwnedFolderKeys.Add(key);
                UserImageHistoryHelper.SharedSpecialFolders[key] = path;
                result[path] = key.EndsWith('/') ? key[..^1] : key;
            }
            return result;
        }
        catch
        {
            foreach (string key in OwnedFolderKeys)
            {
                UserImageHistoryHelper.SharedSpecialFolders.TryRemove(key, out _);
            }
            OwnedFolderKeys.Clear();
            foreach ((string key, string value) in removed)
            {
                UserImageHistoryHelper.SharedSpecialFolders[key] = value;
                OwnedFolderKeys.Add(key);
            }
            throw;
        }
    }

    /// <summary>Collapses slashes, dots, and a trailing slash. Returns null when the path climbs above the drive.</summary>
    static string Normalize(string text, char drive)
    {
        string unified = text.Replace('/', '\\');
        while (unified.Contains("\\\\"))
        {
            unified = unified.Replace("\\\\", "\\");
        }
        string rest = unified.Length > 2 ? unified[2..] : "";
        string[] parts = rest.Split('\\', StringSplitOptions.RemoveEmptyEntries);
        List<string> stack = [];
        foreach (string part in parts)
        {
            if (part == ".")
            {
                continue;
            }
            if (part == "..")
            {
                if (stack.Count == 0)
                {
                    return null;
                }
                stack.RemoveAt(stack.Count - 1);
                continue;
            }
            stack.Add(part);
        }
        if (stack.Count == 0)
        {
            return drive + ":\\";
        }
        return drive + ":\\" + string.Join("\\", stack);
    }

    /// <summary>Slash and case canonical form used only for identity.</summary>
    static string Canonical(string path)
    {
        string unified = path.Trim().Replace('/', '\\');
        while (unified.Contains("\\\\"))
        {
            unified = unified.Replace("\\\\", "\\");
        }
        if (unified.Length >= 2 && IsAsciiLetter(unified[0]) && unified[1] == ':')
        {
            unified = char.ToUpperInvariant(unified[0]) + unified[1..];
        }
        if (unified.Length == 2 && unified[1] == ':')
        {
            return unified + "\\";
        }
        if (unified.Length == 3 && unified[1] == ':' && unified[2] == '\\')
        {
            return unified;
        }
        if (unified.EndsWith('\\'))
        {
            unified = unified.TrimEnd('\\');
        }
        return unified;
    }

    /// <summary>True for a letter, a colon, and a slash, such as D:\ or D:/.</summary>
    static bool IsDriveAbsolute(string text)
    {
        if (text.Length < 3 || !IsAsciiLetter(text[0]) || text[1] != ':')
        {
            return false;
        }
        return text[2] == '\\' || text[2] == '/';
    }

    /// <summary>True when <paramref name="drive"/> is named by one of the injected ready roots.</summary>
    static bool DriveIsReady(char drive, IEnumerable<string> readyDriveRoots)
    {
        if (readyDriveRoots is null)
        {
            return false;
        }
        foreach (string root in readyDriveRoots)
        {
            if (string.IsNullOrWhiteSpace(root))
            {
                continue;
            }
            string trimmed = root.Trim();
            if (trimmed.Length >= 2 && IsAsciiLetter(trimmed[0]) && trimmed[1] == ':' && char.ToUpperInvariant(trimmed[0]) == drive)
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>Control characters, an extra colon, and Windows-illegal path characters. A tilde is allowed here.</summary>
    static bool HasIllegalPathChar(string text)
    {
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (c < 32 || (c == ':' && i != 1))
            {
                return true;
            }
            if (c == '<' || c == '>' || c == '"' || c == '|' || c == '?' || c == '*')
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>ASCII A-Z or a-z.</summary>
    static bool IsAsciiLetter(char c)
    {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
    }
}
