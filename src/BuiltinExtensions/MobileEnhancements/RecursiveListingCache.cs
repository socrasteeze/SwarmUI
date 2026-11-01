using SwarmUI.WebAPI;
using System;
using System.Collections.Generic;
using System.IO;

namespace SwarmUI.Builtin_MobileEnhancementsExtension;

/// <summary>Bounded in-memory cache of sorted recursive Drives image listings.
/// Later pages reuse a fresh entry. The caller still validates the path on every request.
/// Entries are keyed per user so one account cannot receive another's listing.</summary>
public sealed class RecursiveListingCache
{
    /// <summary>Maximum listings kept. The least recently used entry is dropped past this count.</summary>
    public const int DefaultCapacity = 16;

    /// <summary>How long a stored listing may be reused, in milliseconds.</summary>
    public const long DefaultTtlMilliseconds = 60_000;

    /// <summary>One cached listing identity. Build it with <see cref="CreateKey"/> so path and search normalization match.</summary>
    public readonly record struct Key(string UserId, string FullPath, string Search, T2IAPI.ImageHistorySortMode SortMode, bool SortReverse);

    /// <summary>Maximum retained listings.</summary>
    public int Capacity;

    /// <summary>Reuse window in milliseconds.</summary>
    public long TtlMilliseconds;

    private Func<long> Clock;

    private readonly object Gate = new();

    private readonly Dictionary<Key, LinkedListNode<Slot>> Entries;

    private readonly LinkedList<Slot> Order = new();

    private static readonly StringComparison PathComparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    private static readonly StringComparer PathComparer = OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    /// <summary>Creates a cache. <paramref name="clock"/> returns a millisecond tick and defaults to <see cref="Environment.TickCount64"/>.</summary>
    public RecursiveListingCache(int capacity = DefaultCapacity, long ttlMilliseconds = DefaultTtlMilliseconds, Func<long> clock = null)
    {
        Capacity = capacity < 1 ? DefaultCapacity : capacity;
        TtlMilliseconds = ttlMilliseconds;
        Clock = clock ?? (() => Environment.TickCount64);
        Entries = new Dictionary<Key, LinkedListNode<Slot>>(KeyComparer.Instance);
    }

    /// <summary>Builds the cache key for one user, folder, filename search, and sort.</summary>
    public static Key CreateKey(string userId, string fullPath, string search, T2IAPI.ImageHistorySortMode sortMode, bool sortReverse)
    {
        string normalizedSearch = string.IsNullOrWhiteSpace(search) ? "" : search;
        return new Key(userId ?? "", NormalizePath(fullPath), normalizedSearch, sortMode, sortReverse);
    }

    /// <summary>Returns a fresh listing and marks it most recently used. An expired entry is removed.</summary>
    public bool TryGet(Key key, out List<string> files, out bool truncated)
    {
        lock (Gate)
        {
            if (!Entries.TryGetValue(key, out LinkedListNode<Slot> node))
            {
                files = null;
                truncated = false;
                return false;
            }
            if (Clock() - node.Value.StoredAt >= TtlMilliseconds)
            {
                RemoveNode(node);
                files = null;
                truncated = false;
                return false;
            }
            Order.Remove(node);
            Order.AddFirst(node);
            files = node.Value.Files;
            truncated = node.Value.Truncated;
            return true;
        }
    }

    /// <summary>Stores a sorted listing and refreshes its lifetime. The least recently used other entry is dropped at capacity.</summary>
    public void Store(Key key, List<string> files, bool truncated)
    {
        lock (Gate)
        {
            long now = Clock();
            DropExpired(now);
            if (Entries.TryGetValue(key, out LinkedListNode<Slot> existing))
            {
                existing.Value.Files = files;
                existing.Value.Truncated = truncated;
                existing.Value.StoredAt = now;
                Order.Remove(existing);
                Order.AddFirst(existing);
                return;
            }
            while (Entries.Count >= Capacity)
            {
                LinkedListNode<Slot> last = Order.Last;
                if (last is null)
                {
                    break;
                }
                RemoveNode(last);
            }
            Slot slot = new() { Key = key, Files = files, Truncated = truncated, StoredAt = now };
            Entries[key] = Order.AddFirst(slot);
        }
    }

    /// <summary>Drops listings for a folder, a user, or one user at one folder.
    /// A null <paramref name="userId"/> matches every user. A null <paramref name="fullPath"/> matches every folder.
    /// Both null drops nothing; use <see cref="Clear"/> to empty the cache.</summary>
    public void Invalidate(string userId, string fullPath)
    {
        if (userId is null && fullPath is null)
        {
            return;
        }
        string path = null;
        if (fullPath is not null)
        {
            string canonical = Path.IsPathFullyQualified(fullPath) ? Path.GetFullPath(fullPath) : fullPath;
            path = NormalizePath(canonical);
        }
        lock (Gate)
        {
            LinkedListNode<Slot> node = Order.First;
            while (node is not null)
            {
                LinkedListNode<Slot> next = node.Next;
                bool userMatch = userId is null || string.Equals(node.Value.Key.UserId, userId, StringComparison.Ordinal);
                bool pathMatch = path is null || string.Equals(node.Value.Key.FullPath, path, PathComparison);
                if (userMatch && pathMatch)
                {
                    RemoveNode(node);
                }
                node = next;
            }
        }
    }

    /// <summary>Drops every cached listing.</summary>
    public void Clear()
    {
        lock (Gate)
        {
            Entries.Clear();
            Order.Clear();
        }
    }

    /// <summary>Returns how many listings are retained, including ones whose lifetime has elapsed until the next read or store.</summary>
    public int CountEntries()
    {
        lock (Gate)
        {
            return Entries.Count;
        }
    }

    /// <summary>Canonical folder key. A filesystem root keeps its root form. Other paths lose a trailing separator.</summary>
    public static string NormalizePath(string fullPath)
    {
        if (string.IsNullOrEmpty(fullPath))
        {
            return "";
        }
        string root = Path.GetPathRoot(fullPath) ?? "";
        string trimmed = fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (trimmed.Length == 0)
        {
            return root;
        }
        string trimmedRoot = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (string.Equals(trimmed, trimmedRoot, PathComparison))
        {
            return root.Length == 0 ? trimmed : root;
        }
        return trimmed;
    }

    /// <summary>Removes one node from both collections. Caller holds <see cref="Gate"/>.</summary>
    private void RemoveNode(LinkedListNode<Slot> node)
    {
        Order.Remove(node);
        Entries.Remove(node.Value.Key);
    }

    /// <summary>Drops entries whose lifetime has elapsed. Caller holds <see cref="Gate"/>.</summary>
    private void DropExpired(long now)
    {
        LinkedListNode<Slot> node = Order.First;
        while (node is not null)
        {
            LinkedListNode<Slot> next = node.Next;
            if (now - node.Value.StoredAt >= TtlMilliseconds)
            {
                RemoveNode(node);
            }
            node = next;
        }
    }

    /// <summary>One stored listing plus the tick it was stored.</summary>
    private sealed class Slot
    {
        /// <summary>Identity of this listing.</summary>
        public Key Key;

        /// <summary>Sorted, capped file paths.</summary>
        public List<string> Files;

        /// <summary>True when the scan bound or the match cap stopped the listing.</summary>
        public bool Truncated;

        /// <summary>Clock tick when this listing was stored or refreshed.</summary>
        public long StoredAt;
    }

    /// <summary>Path equality follows the operating system. Search equality is case-insensitive. User ids stay ordinal.</summary>
    private sealed class KeyComparer : IEqualityComparer<Key>
    {
        /// <summary>The shared comparer.</summary>
        public static KeyComparer Instance = new();

        /// <summary>Compares two listing keys.</summary>
        public bool Equals(Key left, Key right)
        {
            return string.Equals(left.UserId, right.UserId, StringComparison.Ordinal)
                && string.Equals(left.FullPath, right.FullPath, PathComparison)
                && string.Equals(left.Search, right.Search, StringComparison.OrdinalIgnoreCase)
                && left.SortMode == right.SortMode
                && left.SortReverse == right.SortReverse;
        }

        /// <summary>Hashes a listing key with the same rules as <see cref="Equals"/>.</summary>
        public int GetHashCode(Key key)
        {
            HashCode hash = new();
            hash.Add(key.UserId, StringComparer.Ordinal);
            hash.Add(key.FullPath, PathComparer);
            hash.Add(key.Search, StringComparer.OrdinalIgnoreCase);
            hash.Add(key.SortMode);
            hash.Add(key.SortReverse);
            return hash.ToHashCode();
        }
    }
}
