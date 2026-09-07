using SwarmUI.Utils;

namespace SwarmUI.Core;

/// <summary>Error raised when spoke mode rejects a shared model-tree write.</summary>
public class SpokeModeWriteException : SwarmReadableErrorException
{
    /// <summary>Creates a spoke-mode write rejection with a user-readable message.</summary>
    public SpokeModeWriteException(string message) : base(message)
    {
    }
}

/// <summary>Central enforcement policy for runtime spoke mode.</summary>
public static class SpokeModePolicy
{
    /// <summary>Whether spoke-mode restrictions are active for this process.</summary>
    public static bool IsActive => Program.IsSpokeMode;

    /// <summary>Throws when an operation would write to the shared model tree while spoke mode is active.</summary>
    public static void AssertModelTreeWriteAllowed(string operation)
    {
        if (IsActive)
        {
            throw new SpokeModeWriteException($"Spoke mode blocks model-tree writes ({operation}). Manage models on the hub.");
        }
    }

    /// <summary>Absolute path of the spoke's local model cache, or null when none is configured. Resolved relative
    /// to the working directory like every other Paths entry.</summary>
    public static string CacheRoot
    {
        get
        {
            string raw = Program.ServerSettings?.Paths?.SpokeModelCache;
            return string.IsNullOrWhiteSpace(raw) ? null : System.IO.Path.GetFullPath(Utilities.CombinePathWithAbsolute(Environment.CurrentDirectory, raw.Trim()));
        }
    }

    /// <summary>Throws when spoke mode is active and <paramref name="path"/> is not inside the configured model
    /// cache. This is the only write a spoke is permitted anywhere near model files, and it is confined to a folder
    /// the operator named for the purpose - the shared tree stays untouchable.</summary>
    public static void AssertSpokeCacheWriteAllowed(string path, string operation)
    {
        if (!IsActive)
        {
            return;
        }
        string cache = CacheRoot;
        if (cache is null)
        {
            throw new SpokeModeWriteException($"Spoke mode blocks model writes ({operation}): no SpokeModelCache is configured.");
        }
        if (string.IsNullOrWhiteSpace(path) || !SpokeModelCache.IsUnder(System.IO.Path.GetFullPath(path), cache))
        {
            throw new SpokeModeWriteException($"Spoke mode blocks model writes outside the cache ({operation}). Only '{cache}' is writable.");
        }
    }

    /// <summary>Throws when an operation would mutate the spoke's managed runtime or dependencies.</summary>
    public static void AssertRuntimeMutationAllowed(string operation)
    {
        if (IsActive)
        {
            throw new SpokeModeWriteException($"Spoke mode blocks runtime changes ({operation}). Update dependencies on the hub and redeploy the spoke.");
        }
    }
}
