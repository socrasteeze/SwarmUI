using NUnit.Framework;
using SwarmUI.Builtin_TagDexExtension;
using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace SwarmUITests;

/// <summary>Regression tests for TagDex's atomic thumbnail-file publisher.</summary>
[TestFixture]
public class TagDexAtomicWriteTests
{
    /// <summary>Creates a unique temporary directory for one test.</summary>
    private static string CreateTempRoot()
    {
        string root = Path.Combine(Path.GetTempPath(), $"swarmui-atomic-write-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        return root;
    }

    /// <summary>Concurrent publishers must leave one complete payload and no shared temporary filename behind.</summary>
    [Test]
    public async Task TestWriteAtomic_ConcurrentWritersLeaveCompletePublishedFile()
    {
        string root = CreateTempRoot();
        try
        {
            string path = Path.Combine(root, "thumb.webp");
            byte[][] payloads = Enumerable.Range(0, 32).Select(i => Enumerable.Repeat((byte)i, 8192 + i).ToArray()).ToArray();
            Task[] writers = payloads.Select(payload => Task.Run(() => TagDexExtension.WriteAtomic(path, payload))).ToArray();
            await Task.WhenAll(writers);
            byte[] actual = File.ReadAllBytes(path);
            Assert.That(payloads.Any(payload => payload.SequenceEqual(actual)), Is.True);
            Assert.That(Directory.EnumerateFiles(root, "*.tmp").Any(), Is.False);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    /// <summary>A failed write must not remove the last published destination or leave a temporary file.</summary>
    [Test]
    public void TestWriteAtomic_FailedWritePreservesLastGoodDestination()
    {
        string root = CreateTempRoot();
        try
        {
            string path = Path.Combine(root, "thumb.webp");
            byte[] original = [1, 2, 3, 4];
            File.WriteAllBytes(path, original);
            Assert.Throws<ArgumentNullException>(() => TagDexExtension.WriteAtomic(path, null));
            Assert.That(File.ReadAllBytes(path), Is.EqualTo(original));
            Assert.That(Directory.EnumerateFiles(root, "*.tmp").Any(), Is.False);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    /// <summary>A publish failure after the temporary file is written must preserve the destination and clean the temporary file.</summary>
    [Test]
    [Platform("Win")]
    public void TestWriteAtomic_FailedPublishPreservesLastGoodDestinationAndCleansTemp()
    {
        string root = CreateTempRoot();
        try
        {
            string path = Path.Combine(root, "thumb.webp");
            byte[] original = [1, 2, 3, 4];
            File.WriteAllBytes(path, original);
            using (FileStream locked = new(path, FileMode.Open, FileAccess.Read, FileShare.None))
            {
                Assert.Throws<UnauthorizedAccessException>(() => TagDexExtension.WriteAtomic(path, [5, 6, 7, 8]));
            }
            Assert.That(File.ReadAllBytes(path), Is.EqualTo(original));
            Assert.That(Directory.EnumerateFiles(root, "*.tmp").Any(), Is.False);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    /// <summary>A platform-neutral destination collision after the temporary write must clean the temporary file.</summary>
    [Test]
    public void TestWriteAtomic_DirectoryCollisionCleansTemp()
    {
        string root = CreateTempRoot();
        try
        {
            string path = Path.Combine(root, "thumb.webp");
            Directory.CreateDirectory(path);
            Exception exception = Assert.Catch<Exception>(() => TagDexExtension.WriteAtomic(path, [5, 6, 7, 8]));
            Assert.That(exception, Is.InstanceOf<IOException>().Or.InstanceOf<UnauthorizedAccessException>());
            Assert.That(Directory.Exists(path), Is.True);
            Assert.That(Directory.EnumerateFiles(root, "*.tmp").Any(), Is.False);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }
}
