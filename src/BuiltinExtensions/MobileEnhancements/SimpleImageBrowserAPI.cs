using Newtonsoft.Json.Linq;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats;
using SixLabors.ImageSharp.Formats.Jpeg;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using ISImage = SixLabors.ImageSharp.Image;

namespace SwarmUI.Builtin_MobileEnhancementsExtension;

/// <summary>Provides the narrowly scoped image browser used by the standalone simple client.</summary>
[API.APIClass("Simple image browser")]
public static class SimpleImageBrowserAPI
{
    /// <summary>Maximum number of entries returned from one folder request.</summary>
    public const int MaximumPageSize = 250;

    /// <summary>Maximum source file size accepted by the image reader.</summary>
    public const long MaximumImageBytes = 32L * 1024 * 1024;

    /// <summary>Maximum decoded pixel count accepted by the image reader.</summary>
    public const long MaximumImagePixels = 100L * 1024 * 1024;

    /// <summary>Permission required to enumerate and read images anywhere on the server filesystem.</summary>
    public static PermInfo BrowsePermission = Permissions.Register(new("browse_server_images", "Browse Server Images", "Allows reading images from the entire server filesystem.", PermissionDefault.ADMINS, Permissions.GroupSpecial, PermSafetyLevel.POWERFUL));

    /// <summary>Image filename extensions that this API accepts.</summary>
    public static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff" };

    /// <summary>Lists drives when <paramref name="path"/> is empty, or immediate folders and accepted image files in a server folder.</summary>
    [API.APIDescription("Lists available server drives or the direct contents of a server folder. Results are folders first, then image files, and are paged.", "{ \"path\": \"/images\", \"parent\": \"/\", \"folders\": [{ \"name\": \"Reference\", \"path\": \"/images/Reference\" }], \"files\": [{ \"name\": \"image.png\", \"path\": \"/images/image.png\" }], \"total\": 2, \"next_offset\": null }")]
    public static Task<JObject> ListSimpleImageFolder(Session session,
        [API.APIParameter("Fully qualified server directory path. Leave empty to list available drives.")] string path = "",
        [API.APIParameter("Zero-based result offset.")] int offset = 0,
        [API.APIParameter("Maximum results to return, from 1 to 250.")] int limit = 100,
        [API.APIParameter("Optional case-insensitive filename substring filter for direct files.")] string search = "",
        [API.APIParameter("If true, return all direct folders and page only matching direct image files.")] bool image_page = false,
        [API.APIParameter("Image sort field: Name or Date. Defaults to Name for compatibility.")] string sortBy = "Name",
        [API.APIParameter("Reverse the descending base order. Defaults true so Name remains A-Z for compatibility.")] bool sortReverse = true)
    {
        if (!HasBrowsePermission(session))
        {
            return Task.FromResult(Error("You lack permission to browse server images.", "bad_permissions"));
        }
        return Task.FromResult(ListFolder(path, offset, limit, search, image_page, sortBy, sortReverse));
    }

    /// <summary>Reads one validated image as a data URI, converting TIFF to PNG or optionally producing a small JPEG preview.</summary>
    [API.APIDescription("Reads one validated server image as a data URI. TIFF selections are converted to PNG. Preview responses are JPEG images no larger than 256 by 256 pixels.", "{ \"image\": \"data:image/png;base64,...\" }")]
    public static Task<JObject> ReadSimpleImage(Session session,
        [API.APIParameter("Fully qualified server image path with an allowed image filename extension.")] string path,
        [API.APIParameter("If true, return a JPEG preview no larger than 256 by 256 pixels.")] bool preview = false)
    {
        if (!HasBrowsePermission(session))
        {
            return Task.FromResult(Error("You lack permission to browse server images.", "bad_permissions"));
        }
        return Task.FromResult(ReadImage(path, preview));
    }

    /// <summary>Lists a folder without session handling so focused tests can cover path and paging behavior.</summary>
    public static JObject ListFolder(string path, int offset, int limit, string search = "", bool imagePage = false, string sortBy = "Name", bool sortReverse = true)
    {
        if (offset < 0 || limit < 1 || limit > MaximumPageSize)
        {
            return Error("The requested page is invalid.", "bad_page");
        }
        if (!Enum.TryParse(sortBy, true, out T2IAPI.ImageHistorySortMode sortMode) || !Enum.IsDefined(sortMode))
        {
            return Error($"Invalid sort mode '{sortBy}'.", "bad_sort");
        }
        if (string.IsNullOrWhiteSpace(path))
        {
            return ListDrives(offset, limit, imagePage);
        }
        if (!TryGetDirectoryPath(path, out string fullPath))
        {
            return Error("The folder path is invalid.", "bad_path");
        }
        try
        {
            if (!Directory.Exists(fullPath))
            {
                return Error("The folder does not exist or is unavailable.", "missing_folder");
            }
            List<string> folders = Directory.EnumerateDirectories(fullPath).OrderBy(GetName, PathNameComparer.Instance).ToList();
            List<string> files = Directory.EnumerateFiles(fullPath).Where(IsAllowedImagePath).Where(file => string.IsNullOrWhiteSpace(search) || GetName(file).Contains(search, StringComparison.OrdinalIgnoreCase)).ToList();
            Dictionary<string, long> fileTimes = sortMode == T2IAPI.ImageHistorySortMode.Date
                ? files.ToDictionary(file => file, file => File.GetLastWriteTimeUtc(file).Ticks)
                : null;
            files.Sort((first, second) => CompareImagePaths(first, second, sortMode, sortReverse, fileTimes));
            if (imagePage)
            {
                return BuildImagePage(fullPath, GetParentPath(fullPath), folders, files, offset, limit);
            }
            List<SimplePathRow> entries = folders.Select(p => new SimplePathRow(GetName(p), p, true)).Concat(files.Select(p => new SimplePathRow(GetName(p), p, false))).ToList();
            return BuildPage(fullPath, GetParentPath(fullPath), entries, offset, limit);
        }
        catch (UnauthorizedAccessException)
        {
            return Error("The folder cannot be accessed.", "access_denied");
        }
        catch (IOException)
        {
            return Error("The folder is unavailable.", "folder_unavailable");
        }
        catch (ArgumentException)
        {
            return Error("The folder path is invalid.", "bad_path");
        }
    }

    /// <summary>Sorts machine images before paging, with the same descending base order as ListImages.</summary>
    private static int CompareImagePaths(string first, string second, T2IAPI.ImageHistorySortMode sortMode, bool sortReverse, Dictionary<string, long> fileTimes)
    {
        int result = sortMode == T2IAPI.ImageHistorySortMode.Date
            ? fileTimes[second].CompareTo(fileTimes[first])
            : PathNameComparer.Instance.Compare(second, first);
        if (result == 0)
        {
            result = PathNameComparer.Instance.Compare(second, first);
        }
        return sortReverse ? -result : result;
    }

    /// <summary>Lists one direct output-history folder with folder navigation separate from media-file pagination.</summary>
    public static JObject ListOutputImagePage(Session session, string rawPath, string root, int offset, int limit, string sortBy, bool sortReverse, string search, string[] mediaTypes)
    {
        if (offset < 0 || limit < 1 || limit > MaximumPageSize)
        {
            return Error("The requested page is invalid.", "bad_page");
        }
        if (!Enum.TryParse(sortBy, true, out T2IAPI.ImageHistorySortMode sortMode))
        {
            return Error($"Invalid sort mode '{sortBy}'.", "bad_sort");
        }
        string cleanedRawPath = (rawPath ?? "").Replace('\\', '/').Trim('/');
        if (cleanedRawPath == ".")
        {
            cleanedRawPath = "";
        }
        (string checkedPath, string consoleError, string userError) = WebServer.CheckFilePath(root, cleanedRawPath);
        string path = UserImageHistoryHelper.GetRealPathFor(session.User, checkedPath, root: root);
        if (consoleError is not null)
        {
            Logs.Error(consoleError);
            return Error(userError, "bad_path");
        }
        try
        {
            string browseBase = cleanedRawPath;
            string virtualPrefix = string.IsNullOrEmpty(browseBase) ? "" : browseBase + "/";
            bool hasVirtualChild = UserImageHistoryHelper.SharedSpecialFolders.Keys.Any(folder => folder.Replace('\\', '/').Trim('/').StartsWith(virtualPrefix, StringComparison.OrdinalIgnoreCase));
            if (!Directory.Exists(path) && !hasVirtualChild)
            {
                return Error("404, path not found.", "missing_folder");
            }
            HashSet<string> hiddenRoots = T2IAPI.ParseHiddenFolders(session.User.Settings.HiddenHistoryFolders);
            List<string> folders = ListOutputFolders(session.User, path, root, browseBase, hiddenRoots, mediaTypes);
            HashSet<string> acceptedExtensions = GetOutputExtensions(mediaTypes);
            IEnumerable<string> directFiles = Directory.Exists(path) ? Directory.EnumerateFiles(path) : [];
            List<OutputImageRow> files = directFiles
                .Where(file => IsOutputMediaFile(file, acceptedExtensions, search))
                .Select(file => new OutputImageRow(Path.GetFileName(file), file, File.GetLastWriteTimeUtc(file).Ticks))
                .ToList();
            files.Sort((first, second) => CompareOutputRows(first, second, sortMode, sortReverse));
            int total = files.Count;
            List<OutputImageRow> page = files.Skip(offset).Take(limit).ToList();
            bool starNoFolders = session.User.Settings.StarNoFolders;
            JArray fileRows = new();
            foreach (OutputImageRow file in page)
            {
                OutputMetadataTracker.OutputMetadataEntry metadata = OutputMetadataTracker.GetMetadataFor(file.FullPath.Replace('\\', '/'), root, starNoFolders);
                fileRows.Add(new JObject() { ["src"] = file.Name, ["metadata"] = metadata?.Metadata });
            }
            string parent = GetOutputParent(browseBase);
            return new JObject()
            {
                ["path"] = browseBase,
                ["parent"] = parent is null ? JValue.CreateNull() : new JValue(parent),
                ["folders"] = new JArray(folders),
                ["files"] = fileRows,
                ["total"] = total,
                ["next_offset"] = (long)offset + limit < total ? offset + limit : null
            };
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return Error("Error reading file list.", "list_failed");
        }
    }

    /// <summary>Reads and validates one image without session handling so focused tests can cover file behavior.</summary>
    public static JObject ReadImage(string path, bool preview)
    {
        if (!TryGetFilePath(path, out string fullPath))
        {
            return Error("The image path is invalid.", "bad_path");
        }
        try
        {
            FileInfo info = new(fullPath);
            if (!info.Exists || (info.Attributes & FileAttributes.Directory) != 0)
            {
                return Error("The image does not exist or is unavailable.", "missing_image");
            }
            if (info.Length > MaximumImageBytes)
            {
                return Error("The image is too large.", "image_too_large");
            }
            byte[] data = ReadBoundedFile(fullPath);
            IImageFormat format = ISImage.DetectFormat(data);
            if (!IsAllowedFormat(format))
            {
                return Error("The file is not a supported image.", "unsupported_image");
            }
            DecoderOptions validationOptions = new() { MaxFrames = 1 };
            ImageInfo imageInfo = ISImage.Identify(validationOptions, data);
            if (imageInfo is null || (long)imageInfo.Width * imageInfo.Height > MaximumImagePixels)
            {
                return Error("The image dimensions are too large.", "image_too_large");
            }
            if (!preview)
            {
                using ISImage image = ISImage.Load(validationOptions, data);
                if (format.Name == "TIFF")
                {
                    using MemoryStream png = new();
                    image.SaveAsPng(png);
                    return new JObject() { ["image"] = $"data:image/png;base64,{Convert.ToBase64String(png.ToArray())}" };
                }
                return new JObject() { ["image"] = $"data:{format.DefaultMimeType};base64,{Convert.ToBase64String(data)}" };
            }
            DecoderOptions options = new() { MaxFrames = 1, TargetSize = new Size(256, 256) };
            using ISImage previewImage = ISImage.Load(options, data);
            using MemoryStream output = new();
            previewImage.SaveAsJpeg(output, new JpegEncoder() { Quality = 85 });
            return new JObject() { ["image"] = $"data:image/jpeg;base64,{Convert.ToBase64String(output.ToArray())}" };
        }
        catch (UnauthorizedAccessException)
        {
            return Error("The image cannot be accessed.", "access_denied");
        }
        catch (IOException)
        {
            return Error("The image is unavailable.", "image_unavailable");
        }
        catch (UnknownImageFormatException)
        {
            return Error("The file is not a supported image.", "unsupported_image");
        }
        catch (InvalidImageContentException)
        {
            return Error("The image data is invalid.", "invalid_image");
        }
        catch (NotSupportedException)
        {
            return Error("The image data is invalid.", "invalid_image");
        }
        catch (OutOfMemoryException)
        {
            return Error("The image requires too much memory.", "image_too_large");
        }
        catch (ArgumentException)
        {
            return Error("The image path is invalid.", "bad_path");
        }
    }

    /// <summary>Returns whether an API caller has the dedicated filesystem browser permission.</summary>
    public static bool HasBrowsePermission(Session session)
    {
        return session?.User is not null && session.User.HasPermission(BrowsePermission);
    }

    /// <summary>Returns whether a path names an allowlisted image filename.</summary>
    public static bool IsAllowedImagePath(string path)
    {
        return !string.IsNullOrWhiteSpace(path) && AllowedExtensions.Contains(Path.GetExtension(path));
    }

    /// <summary>Reads a file while enforcing the API byte cap against files that change after metadata inspection.</summary>
    private static byte[] ReadBoundedFile(string path)
    {
        using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length > MaximumImageBytes)
        {
            throw new IOException("Image exceeds the configured size limit.");
        }
        using MemoryStream output = new();
        byte[] buffer = new byte[81920];
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
        {
            if (output.Length + read > MaximumImageBytes)
            {
                throw new IOException("Image exceeds the configured size limit.");
            }
            output.Write(buffer, 0, read);
        }
        return output.ToArray();
    }

    /// <summary>Builds the drive listing without querying volume labels or other removable-drive metadata.</summary>
    private static JObject ListDrives(int offset, int limit, bool imagePage)
    {
        try
        {
            List<SimplePathRow> entries = DriveInfo.GetDrives().OrderBy(drive => drive.Name, StringComparer.OrdinalIgnoreCase)
                .ThenBy(drive => drive.Name, StringComparer.Ordinal).Select(drive => new SimplePathRow(drive.Name, drive.Name, true, IsDriveReady(drive))).ToList();
            if (imagePage)
            {
                JArray folders = new();
                foreach (SimplePathRow entry in entries)
                {
                    folders.Add(new JObject() { ["name"] = entry.Name, ["path"] = entry.Path, ["ready"] = entry.Ready });
                }
                return new JObject()
                {
                    ["path"] = "",
                    ["parent"] = JValue.CreateNull(),
                    ["folders"] = folders,
                    ["files"] = new JArray(),
                    ["total"] = 0,
                    ["next_offset"] = JValue.CreateNull()
                };
            }
            return BuildPage("", null, entries, offset, limit);
        }
        catch (IOException)
        {
            return Error("The available drives cannot be listed.", "drives_unavailable");
        }
        catch (UnauthorizedAccessException)
        {
            return Error("The available drives cannot be listed.", "access_denied");
        }
    }

    /// <summary>Reads only the readiness flag for one drive, treating inaccessible removable media as unavailable.</summary>
    private static bool IsDriveReady(DriveInfo drive)
    {
        try
        {
            return drive.IsReady;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>Builds an image-only page while retaining every immediate folder for navigation.</summary>
    private static JObject BuildImagePage(string path, string parent, List<string> folderPaths, List<string> filePaths, int offset, int limit)
    {
        JArray folders = new(folderPaths.Select(folder => new JObject() { ["name"] = GetName(folder), ["path"] = folder }));
        JArray files = new(filePaths.Skip(offset).Take(limit).Select(file => new JObject() { ["name"] = GetName(file), ["path"] = file }));
        int total = filePaths.Count;
        return new JObject()
        {
            ["path"] = path,
            ["parent"] = parent is null ? JValue.CreateNull() : new JValue(parent),
            ["folders"] = folders,
            ["files"] = files,
            ["total"] = total,
            ["next_offset"] = (long)offset + limit < total ? offset + limit : null
        };
    }

    /// <summary>Lists visible direct output folders, including virtual shared-folder children.</summary>
    private static List<string> ListOutputFolders(User user, string path, string root, string browseBase, HashSet<string> hiddenRoots, string[] mediaTypes)
    {
        HashSet<string> extensions = GetOutputExtensions(mediaTypes);
        HashSet<string> names = new(StringComparer.OrdinalIgnoreCase);
        IEnumerable<string> directFolders = Directory.Exists(path) ? Directory.EnumerateDirectories(path) : [];
        foreach (string folder in directFolders)
        {
            string name = GetName(folder);
            if (!name.StartsWith('.') && !hiddenRoots.Contains(T2IAPI.JoinHistoryPath(browseBase, name)) && ImageHistoryFolders.ContainsMedia(folder, extensions))
            {
                names.Add(name);
            }
        }
        string prefix = string.IsNullOrEmpty(browseBase) ? "" : browseBase + "/";
        foreach (KeyValuePair<string, string> specialEntry in UserImageHistoryHelper.SharedSpecialFolders)
        {
            string specialFolder = specialEntry.Key;
            string normalized = specialFolder.Replace('\\', '/').Trim('/');
            if (!normalized.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            string remainder = normalized[prefix.Length..];
            int slash = remainder.IndexOf('/');
            string name = slash < 0 ? remainder : remainder[..slash];
            if (string.IsNullOrEmpty(name) || name.StartsWith('.') || hiddenRoots.Contains(T2IAPI.JoinHistoryPath(browseBase, name)))
            {
                continue;
            }
            string childRawPath = T2IAPI.JoinHistoryPath(browseBase, name);
            string childPath = UserImageHistoryHelper.GetRealPathFor(user, $"{root}/{childRawPath}", root: root);
            bool hasMappedChildMedia = Directory.Exists(childPath) && ImageHistoryFolders.ContainsMedia(childPath, extensions);
            bool hasNestedVirtualMedia = Directory.Exists(specialEntry.Value) && ImageHistoryFolders.ContainsMedia(specialEntry.Value, extensions);
            if (hasMappedChildMedia || hasNestedVirtualMedia)
            {
                names.Add(name);
            }
        }
        return names.OrderBy(name => name, StringComparer.OrdinalIgnoreCase).ThenBy(name => name, StringComparer.Ordinal).ToList();
    }

    /// <summary>Returns the history extensions selected by an optional media-type filter.</summary>
    private static HashSet<string> GetOutputExtensions(string[] mediaTypes)
    {
        if (mediaTypes is null || mediaTypes.Length == 0)
        {
            return new HashSet<string>(T2IAPI.HistoryExtensions, StringComparer.OrdinalIgnoreCase);
        }
        HashSet<string> types = new(mediaTypes.Where(type => !string.IsNullOrWhiteSpace(type)), StringComparer.OrdinalIgnoreCase);
        HashSet<string> extensions = new(StringComparer.OrdinalIgnoreCase);
        if (types.Contains("image"))
        {
            extensions.UnionWith(["png", "jpg", "gif", "webp"]);
        }
        if (types.Contains("video"))
        {
            extensions.UnionWith(["webm", "mp4", "mov"]);
        }
        if (types.Contains("audio"))
        {
            extensions.UnionWith(["mp3", "aac", "wav", "flac"]);
        }
        return extensions;
    }

    /// <summary>Returns whether a direct output file is visible under the requested media and name filters.</summary>
    private static bool IsOutputMediaFile(string file, HashSet<string> extensions, string search)
    {
        string name = Path.GetFileName(file);
        return !name.StartsWith('.') && !name.EndsWith(".swarmpreview.jpg", StringComparison.OrdinalIgnoreCase) && !name.EndsWith(".swarmpreview.webp", StringComparison.OrdinalIgnoreCase)
            && extensions.Contains(Path.GetExtension(name).TrimStart('.')) && (string.IsNullOrWhiteSpace(search) || name.Contains(search, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Sorts output files with the legacy descending default and a deterministic filename tiebreaker.</summary>
    private static int CompareOutputRows(OutputImageRow first, OutputImageRow second, T2IAPI.ImageHistorySortMode sortMode, bool sortReverse)
    {
        int result = sortMode == T2IAPI.ImageHistorySortMode.Date ? second.FileTime.CompareTo(first.FileTime) : string.Compare(second.Name, first.Name, StringComparison.Ordinal);
        if (result == 0)
        {
            result = string.Compare(second.Name, first.Name, StringComparison.Ordinal);
        }
        return sortReverse ? -result : result;
    }

    /// <summary>Returns the output-history parent path, or null for the output root.</summary>
    private static string GetOutputParent(string path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return null;
        }
        int slash = path.LastIndexOf('/');
        return slash < 0 ? "" : path[..slash];
    }

    /// <summary>Builds the API response with folders and files split for the simple client.</summary>
    private static JObject BuildPage(string path, string parent, List<SimplePathRow> entries, int offset, int limit)
    {
        int total = entries.Count;
        IEnumerable<SimplePathRow> page = entries.Skip(offset).Take(limit);
        JArray folders = new();
        JArray files = new();
        foreach (SimplePathRow entry in page)
        {
            JObject row = new() { ["name"] = entry.Name, ["path"] = entry.Path };
            if (entry.IsDrive)
            {
                row["ready"] = entry.Ready;
            }
            if (entry.IsFolder)
            {
                folders.Add(row);
            }
            else
            {
                files.Add(row);
            }
        }
        return new JObject()
        {
            ["path"] = path,
            ["parent"] = parent is null ? JValue.CreateNull() : new JValue(parent),
            ["folders"] = folders,
            ["files"] = files,
            ["total"] = total,
            ["next_offset"] = (long)offset + limit < total ? offset + limit : null
        };
    }

    /// <summary>Checks and canonicalizes a directory path without allowing device namespaces or alternate data streams.</summary>
    private static bool TryGetDirectoryPath(string path, out string fullPath)
    {
        return TryGetFullyQualifiedPath(path, out fullPath);
    }

    /// <summary>Checks and canonicalizes an allowlisted image file path.</summary>
    private static bool TryGetFilePath(string path, out string fullPath)
    {
        return TryGetFullyQualifiedPath(path, out fullPath) && IsAllowedImagePath(fullPath);
    }

    /// <summary>Rejects relative, device, and alternate-data-stream paths before canonicalizing a normal filesystem path.</summary>
    private static bool TryGetFullyQualifiedPath(string path, out string fullPath)
    {
        fullPath = null;
        if (string.IsNullOrWhiteSpace(path) || path.StartsWith("\\\\.\\", StringComparison.Ordinal) || path.StartsWith("\\\\?\\", StringComparison.Ordinal)
            || !Path.IsPathFullyQualified(path) || HasAlternateDataStream(path))
        {
            return false;
        }
        try
        {
            fullPath = Path.GetFullPath(path);
            return !fullPath.StartsWith("\\\\.\\", StringComparison.Ordinal) && !fullPath.StartsWith("\\\\?\\", StringComparison.Ordinal) && !HasAlternateDataStream(fullPath);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }
    }

    /// <summary>Returns whether a path contains an NTFS alternate-data-stream separator outside the drive designator.</summary>
    private static bool HasAlternateDataStream(string path)
    {
        int firstColon = path.IndexOf(':');
        return firstColon >= 0 && (firstColon != 1 || path.IndexOf(':', firstColon + 1) >= 0);
    }

    /// <summary>Returns a canonical parent path, or null when the supplied path is a filesystem root.</summary>
    private static string GetParentPath(string path)
    {
        string root = Path.GetPathRoot(path);
        if (string.Equals(path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        DirectoryInfo parent = Directory.GetParent(path);
        return parent?.FullName;
    }

    /// <summary>Returns the final filename or directory name from a full path.</summary>
    private static string GetName(string path)
    {
        return Path.GetFileName(path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
    }

    /// <summary>Returns whether ImageSharp recognized an allowed bitmap format.</summary>
    private static bool IsAllowedFormat(IImageFormat format)
    {
        return format is not null && format.Name is "PNG" or "JPEG" or "WEBP" or "GIF" or "BMP" or "TIFF";
    }

    /// <summary>Builds a standard API error object.</summary>
    private static JObject Error(string message, string errorId)
    {
        return new JObject() { ["error"] = message, ["error_id"] = errorId };
    }

    /// <summary>One direct child returned during folder enumeration.</summary>
    private record class SimplePathRow(string Name, string Path, bool IsFolder, bool Ready = true)
    {
        /// <summary>Returns whether this row represents a drive root.</summary>
        public bool IsDrive => IsFolder && string.Equals(Name, Path, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>One output file used for deterministic direct-folder paging.</summary>
    private record class OutputImageRow(string Name, string FullPath, long FileTime);

    /// <summary>Sorts paths by their final component using deterministic ordinal comparison.</summary>
    private sealed class PathNameComparer : IComparer<string>
    {
        /// <summary>The shared comparer instance.</summary>
        public static PathNameComparer Instance = new();

        /// <summary>Compares path final components case-insensitively, then ordinally to break ties.</summary>
        public int Compare(string left, string right)
        {
            int insensitive = StringComparer.OrdinalIgnoreCase.Compare(GetName(left), GetName(right));
            return insensitive != 0 ? insensitive : StringComparer.Ordinal.Compare(GetName(left), GetName(right));
        }
    }
}
