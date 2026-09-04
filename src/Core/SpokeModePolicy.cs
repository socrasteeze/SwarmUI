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

    /// <summary>Throws when an operation would mutate the spoke's managed runtime or dependencies.</summary>
    public static void AssertRuntimeMutationAllowed(string operation)
    {
        if (IsActive)
        {
            throw new SpokeModeWriteException($"Spoke mode blocks runtime changes ({operation}). Update dependencies on the hub and redeploy the spoke.");
        }
    }
}
