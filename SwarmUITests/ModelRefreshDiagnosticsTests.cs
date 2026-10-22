using NUnit.Framework;
using SwarmUI.Text2Image;
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

namespace SwarmUITests;

/// <summary>Checks aggregate refresh counters and synthetic cache freshness behavior.</summary>
[TestFixture]
public class ModelRefreshDiagnosticsTests
{
    /// <summary>Concurrent work is counted exactly and aggregate durations convert Stopwatch ticks to milliseconds.</summary>
    [Test]
    public void SummaryAggregatesConcurrentWorkAndDurations()
    {
        ModelRefreshDiagnostics diagnostics = new();
        Parallel.For(0, 1000, index =>
        {
            diagnostics.RecordCacheLookup(index % 2 == 0, index % 5 == 0, Stopwatch.Frequency / 2, Stopwatch.Frequency);
            diagnostics.RecordSidecarCheck(index % 7 == 0, Stopwatch.Frequency);
            diagnostics.RecordCacheOpen(Stopwatch.Frequency);
            diagnostics.RecordHeaderRead(Stopwatch.Frequency);
            diagnostics.RecordRebuild(Stopwatch.Frequency);
            diagnostics.RecordPreviewAttempt(Stopwatch.Frequency);
            diagnostics.RecordDuplicateSourceSkip();
        });

        string summary = diagnostics.Summary;
        Assert.That(summary, Does.Contain("cache-lookups=1000"));
        Assert.That(summary, Does.Contain("hits=500"));
        Assert.That(summary, Does.Contain("misses=500"));
        Assert.That(summary, Does.Contain("stale-model=200"));
        Assert.That(summary, Does.Contain("stale-sidecar=143"));
        Assert.That(summary, Does.Contain("cache-acquires=1000"));
        Assert.That(summary, Does.Contain("cache-lock-wait-work=500000 ms"));
        Assert.That(summary, Does.Contain("cache-lookup-work=1000000 ms"));
        Assert.That(summary, Does.Contain("cache-acquire-work=1000000 ms"));
        Assert.That(summary, Does.Contain("sidecar-check-work=1000000 ms"));
        Assert.That(summary, Does.Contain("header-reads=1000"));
        Assert.That(summary, Does.Contain("header-read-work=1000000 ms"));
        Assert.That(summary, Does.Contain("completed-rebuilds=1000"));
        Assert.That(summary, Does.Contain("completed-rebuild-work=1000000 ms"));
        Assert.That(summary, Does.Contain("preview-attempts=1000"));
        Assert.That(summary, Does.Contain("preview-work=1000000 ms"));
        Assert.That(summary, Does.Contain("duplicate-sources-skipped=1000"));
    }

    /// <summary>A stale synthetic sidecar is detected without changing either source file.</summary>
    [Test]
    public void SidecarInvalidationLeavesSyntheticFilesUnchanged()
    {
        string root = Path.Combine(Path.GetTempPath(), $"swarm-refresh-diagnostics-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            string modelPath = Path.Combine(root, "synthetic.safetensors");
            string sidecarPath = Path.Combine(root, "synthetic.swarm.json");
            byte[] modelBytes = [1, 2, 3, 4];
            byte[] sidecarBytes = [5, 6, 7, 8];
            File.WriteAllBytes(modelPath, modelBytes);
            File.WriteAllBytes(sidecarPath, sidecarBytes);
            File.SetLastWriteTimeUtc(sidecarPath, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));

            T2IModel model = new(null, root, modelPath, "synthetic.safetensors");
            T2IModelHandler.ModelMetadataStore metadata = new()
            {
                ModelFileVersion = new DateTimeOffset(File.GetLastWriteTimeUtc(modelPath)).ToUnixTimeMilliseconds(),
                SidecarVersionKnown = true,
                SidecarFileVersion = 0
            };
            ModelRefreshDiagnostics diagnostics = new();
            bool stale = T2IModelHandler.SidecarRequiresRebuild(model, metadata, diagnostics);

            Assert.That(stale, Is.True);
            Assert.That(diagnostics.Summary, Does.Contain("stale-sidecar=1"));
            Assert.That(File.ReadAllBytes(modelPath), Is.EqualTo(modelBytes));
            Assert.That(File.ReadAllBytes(sidecarPath), Is.EqualTo(sidecarBytes));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }
}
