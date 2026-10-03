using FreneticUtilities.FreneticExtensions;
using System;
using System.Collections.Generic;
using System.IO;

namespace SwarmUI.Builtin_MobileEnhancementsExtension;

/// <summary>Keeps empty output branches and backend placeholders out of image history.</summary>
public static class ImageHistoryFolders
{
    /// <summary>Returns whether a folder contains history media at any depth. Unreadable paths and directory links
    /// stay visible rather than being mistaken for empty folders. This method never changes the filesystem.</summary>
    public static bool ContainsMedia(string folder, HashSet<string> extensions)
    {
        Stack<string> pending = new();
        pending.Push(folder);
        try
        {
            while (pending.TryPop(out string current))
            {
                FileAttributes currentAttributes;
                try
                {
                    currentAttributes = File.GetAttributes(current);
                }
                catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
                {
                    continue;
                }
                if ((currentAttributes & FileAttributes.ReparsePoint) != 0)
                {
                    return true;
                }
                foreach (string entry in Directory.EnumerateFileSystemEntries(current))
                {
                    string name = Path.GetFileName(entry);
                    if (name.StartsWith('.'))
                    {
                        continue;
                    }
                    FileAttributes attributes = File.GetAttributes(entry);
                    if ((attributes & FileAttributes.Directory) != 0)
                    {
                        pending.Push(entry);
                    }
                    else if (extensions.Contains(Path.GetExtension(name).TrimStart('.').ToLowerFast())
                        && !name.EndsWith(".swarmpreview.jpg", StringComparison.OrdinalIgnoreCase)
                        && !name.EndsWith(".swarmpreview.webp", StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
            }
            return false;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return true;
        }
    }
}
