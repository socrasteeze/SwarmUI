using System.Diagnostics;
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("SwarmUITests")]

namespace SwarmUI.Text2Image;

/// <summary>Thread-safe aggregate counters and work durations for one model refresh.</summary>
internal sealed class ModelRefreshDiagnostics
{
    /// <summary>Number of metadata cache lookups.</summary>
    private long cacheLookups;

    /// <summary>Number of cache rows found.</summary>
    private long cacheHits;

    /// <summary>Number of cache rows not found or unreadable.</summary>
    private long cacheMisses;

    /// <summary>Number of stale model rows.</summary>
    private long staleModels;

    /// <summary>Number of stale sidecar rows.</summary>
    private long staleSidecars;

    /// <summary>Number of cache database acquisition calls.</summary>
    private long cacheOpens;

    /// <summary>Number of model header reads.</summary>
    private long headerReads;

    /// <summary>Number of completed metadata rebuilds.</summary>
    private long rebuilds;

    /// <summary>Number of preview fallback attempts.</summary>
    private long previewAttempts;

    /// <summary>Number of later-root sources whose exact relative model name already loaded from an earlier root.</summary>
    private long duplicateSourceSkips;

    /// <summary>Aggregate cache lock wait duration in Stopwatch ticks.</summary>
    private long cacheLockWaitTicks;

    /// <summary>Aggregate database lookup work duration in Stopwatch ticks.</summary>
    private long cacheWorkTicks;

    /// <summary>Aggregate cache acquisition duration in Stopwatch ticks.</summary>
    private long cacheAcquireTicks;

    /// <summary>Aggregate sidecar check duration in Stopwatch ticks.</summary>
    private long sidecarWorkTicks;

    /// <summary>Aggregate header read duration in Stopwatch ticks.</summary>
    private long headerWorkTicks;

    /// <summary>Aggregate completed metadata rebuild duration in Stopwatch ticks, including nested header and preview work.</summary>
    private long rebuildWorkTicks;

    /// <summary>Aggregate preview fallback duration in Stopwatch ticks.</summary>
    private long previewWorkTicks;

    /// <summary>Record one metadata cache lookup and its outcome.</summary>
    public void RecordCacheLookup(bool hit, bool staleModel, long lockWaitTicks, long workTicks)
    {
        Interlocked.Increment(ref cacheLookups);
        Interlocked.Add(ref cacheLockWaitTicks, lockWaitTicks);
        Interlocked.Add(ref cacheWorkTicks, workTicks);
        if (hit)
        {
            Interlocked.Increment(ref cacheHits);
        }
        else
        {
            Interlocked.Increment(ref cacheMisses);
        }
        if (staleModel)
        {
            Interlocked.Increment(ref staleModels);
        }
    }

    /// <summary>Record cache database acquisition work separately from row lookup work.</summary>
    public void RecordCacheOpen(long elapsedTicks)
    {
        Interlocked.Increment(ref cacheOpens);
        Interlocked.Add(ref cacheAcquireTicks, elapsedTicks);
    }

    /// <summary>Record a sidecar freshness check.</summary>
    public void RecordSidecarCheck(bool stale, long elapsedTicks)
    {
        if (stale)
        {
            Interlocked.Increment(ref staleSidecars);
        }
        Interlocked.Add(ref sidecarWorkTicks, elapsedTicks);
    }

    /// <summary>Record a model header read.</summary>
    public void RecordHeaderRead(long elapsedTicks)
    {
        Interlocked.Increment(ref headerReads);
        Interlocked.Add(ref headerWorkTicks, elapsedTicks);
    }

    /// <summary>Record completed metadata rebuild work.</summary>
    public void RecordRebuild(long elapsedTicks)
    {
        Interlocked.Increment(ref rebuilds);
        Interlocked.Add(ref rebuildWorkTicks, elapsedTicks);
    }

    /// <summary>Record a preview fallback attempt, including attempts with no usable image.</summary>
    public void RecordPreviewAttempt(long elapsedTicks)
    {
        Interlocked.Increment(ref previewAttempts);
        Interlocked.Add(ref previewWorkTicks, elapsedTicks);
    }

    /// <summary>Record one later-root source whose redundant metadata lookup was skipped.</summary>
    public void RecordDuplicateSourceSkip()
    {
        Interlocked.Increment(ref duplicateSourceSkips);
    }

    /// <summary>Format aggregate counts and summed work durations without model names or paths.</summary>
    public string Summary => $"cache-acquires={Interlocked.Read(ref cacheOpens)} cache-lookups={Interlocked.Read(ref cacheLookups)} hits={Interlocked.Read(ref cacheHits)} misses={Interlocked.Read(ref cacheMisses)} duplicate-sources-skipped={Interlocked.Read(ref duplicateSourceSkips)} stale-model={Interlocked.Read(ref staleModels)} stale-sidecar={Interlocked.Read(ref staleSidecars)} cache-lock-wait-work={Milliseconds(Interlocked.Read(ref cacheLockWaitTicks))} ms cache-lookup-work={Milliseconds(Interlocked.Read(ref cacheWorkTicks))} ms cache-acquire-work={Milliseconds(Interlocked.Read(ref cacheAcquireTicks))} ms sidecar-check-work={Milliseconds(Interlocked.Read(ref sidecarWorkTicks))} ms header-reads={Interlocked.Read(ref headerReads)} header-read-work={Milliseconds(Interlocked.Read(ref headerWorkTicks))} ms completed-rebuilds={Interlocked.Read(ref rebuilds)} completed-rebuild-work={Milliseconds(Interlocked.Read(ref rebuildWorkTicks))} ms preview-attempts={Interlocked.Read(ref previewAttempts)} preview-work={Milliseconds(Interlocked.Read(ref previewWorkTicks))} ms";

    /// <summary>Convert aggregate Stopwatch ticks to milliseconds.</summary>
    private static long Milliseconds(long value) => value * 1000 / Stopwatch.Frequency;
}
