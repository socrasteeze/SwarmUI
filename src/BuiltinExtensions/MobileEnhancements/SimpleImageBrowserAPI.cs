using Newtonsoft.Json.Linq;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats;
using SixLabors.ImageSharp.Formats.Jpeg;
using SwarmUI.Accounts;
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
        [API.APIParameter("Maximum results to return, from 1 to 250.")] int limit = 100)
    {
        if (!HasBrowsePermission(session))
        {
            return Task.FromResult(Error("You lack permission to browse server images.", "bad_permissions"));
        }
        return Task.FromResult(ListFolder(path, offset, limit));
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
    public static JObject ListFolder(string path, int offset, int limit)
    {
        if (offset < 0 || limit < 1 || limit > MaximumPageSize)
        {
            return Error("The requested page is invalid.", "bad_page");
        }
        if (string.IsNullOrWhiteSpace(path))
        {
            return ListDrives(offset, limit);
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
            List<string> files = Directory.EnumerateFiles(fullPath).Where(IsAllowedImagePath).OrderBy(GetName, PathNameComparer.Instance).ToList();
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
    private static JObject ListDrives(int offset, int limit)
    {
        try
        {
            List<SimplePathRow> entries = DriveInfo.GetDrives().OrderBy(drive => drive.Name, StringComparer.OrdinalIgnoreCase)
                .ThenBy(drive => drive.Name, StringComparer.Ordinal).Select(drive => new SimplePathRow(drive.Name, drive.Name, true, IsDriveReady(drive))).ToList();
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
