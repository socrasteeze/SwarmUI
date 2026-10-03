using NUnit.Framework;
using SwarmUI.Accounts;
using System;
using System.IO;
using System.Linq;

namespace SwarmUITests;

/// <summary>Regression tests for user-database backup retention ordering and bounds.</summary>
[TestFixture]
public class SessionBackupTests
{
    /// <summary>Creates a unique temporary directory for one test.</summary>
    private static string CreateTempRoot()
    {
        string root = Path.Combine(Path.GetTempPath(), $"swarmui-backups-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        return root;
    }

    /// <summary>Creates a recognized backup file.</summary>
    private static void WriteBackup(string folder, int year, int week)
    {
        File.WriteAllText(Path.Combine(folder, $"UsersBackup_{year}_{week}.ldb"), "backup");
    }

    /// <summary>Retention keeps exactly the requested number of recognized files and leaves unknown names alone.</summary>
    [TestCase(0, 0)]
    [TestCase(1, 1)]
    [TestCase(3, 3)]
    public void TestTrimUserDatabaseBackups_UsesExactRetentionAndPreservesUnknownNames(int keep, int expected)
    {
        string folder = CreateTempRoot();
        try
        {
            WriteBackup(folder, 2026, 8);
            WriteBackup(folder, 2026, 9);
            WriteBackup(folder, 2026, 10);
            File.WriteAllText(Path.Combine(folder, "UsersBackup_manual.ldb"), "manual");
            File.WriteAllText(Path.Combine(folder, "UsersBackup_2026_53.ldb"), "manual numeric");
            File.WriteAllText(Path.Combine(folder, "UsersBackup_0_1.ldb"), "manual numeric");
            SessionHandler.TrimUserDatabaseBackups(folder, keep);
            int actual = Directory.EnumerateFiles(folder, "UsersBackup_2026_*.ldb")
                .Count(path => Path.GetFileName(path) is not "UsersBackup_2026_53.ldb");
            Assert.That(actual, Is.EqualTo(expected));
            Assert.That(File.Exists(Path.Combine(folder, "UsersBackup_manual.ldb")), Is.True);
            Assert.That(File.Exists(Path.Combine(folder, "UsersBackup_2026_53.ldb")), Is.True);
            Assert.That(File.Exists(Path.Combine(folder, "UsersBackup_0_1.ldb")), Is.True);
        }
        finally
        {
            Directory.Delete(folder, true);
        }
    }

    /// <summary>Zero retention disables the actual backup operation without creating a backup folder.</summary>
    [Test]
    public void TestBackupUserDatabase_RetentionZeroIsNoOp()
    {
        string root = CreateTempRoot();
        try
        {
            string source = Path.Combine(root, "Users.ldb");
            string backups = Path.Combine(root, "UsersBackups");
            File.WriteAllText(source, "database");
            SessionHandler.BackupUserDatabase(source, backups, 0, new DateTimeOffset(2026, 1, 15, 0, 0, 0, TimeSpan.Zero));
            Assert.That(Directory.Exists(backups), Is.False);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    /// <summary>A failed final publication removes its temporary file and leaves all earlier backups untouched.</summary>
    [Test]
    public void TestBackupUserDatabase_FailedPublishPreservesEarlierBackupsAndCleansTemp()
    {
        string root = CreateTempRoot();
        try
        {
            string source = Path.Combine(root, "Users.ldb");
            string backups = Path.Combine(root, "UsersBackups");
            File.WriteAllText(source, "database");
            Directory.CreateDirectory(backups);
            WriteBackup(backups, 2025, 52);
            Directory.CreateDirectory(Path.Combine(backups, "UsersBackup_2026_2.ldb"));
            Exception exception = Assert.Catch<Exception>(() => SessionHandler.BackupUserDatabase(
                source, backups, 1, new DateTimeOffset(2026, 1, 15, 0, 0, 0, TimeSpan.Zero)));
            Assert.That(exception, Is.InstanceOf<IOException>().Or.InstanceOf<UnauthorizedAccessException>());
            Assert.That(File.Exists(Path.Combine(backups, "UsersBackup_2025_52.ldb")), Is.True);
            Assert.That(File.Exists(Path.Combine(backups, "UsersBackup_2026_2.ldb")), Is.False);
            Assert.That(Directory.EnumerateFiles(backups, "*.tmp").Any(), Is.False);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    /// <summary>Week numbers sort numerically, so week 10 survives ahead of week 9.</summary>
    [Test]
    public void TestTrimUserDatabaseBackups_SortsYearAndWeekNumerically()
    {
        string folder = CreateTempRoot();
        try
        {
            WriteBackup(folder, 2025, 52);
            WriteBackup(folder, 2026, 9);
            WriteBackup(folder, 2026, 10);
            SessionHandler.TrimUserDatabaseBackups(folder, 2);
            Assert.That(File.Exists(Path.Combine(folder, "UsersBackup_2025_52.ldb")), Is.False);
            Assert.That(File.Exists(Path.Combine(folder, "UsersBackup_2026_9.ldb")), Is.True);
            Assert.That(File.Exists(Path.Combine(folder, "UsersBackup_2026_10.ldb")), Is.True);
        }
        finally
        {
            Directory.Delete(folder, true);
        }
    }

    /// <summary>An existing backup for the current week is not overwritten and does not trigger retention.</summary>
    [Test]
    public void TestBackupUserDatabase_ExistingCurrentWeekIsNoOp()
    {
        string root = CreateTempRoot();
        try
        {
            string source = Path.Combine(root, "Users.ldb");
            string backups = Path.Combine(root, "UsersBackups");
            Directory.CreateDirectory(backups);
            File.WriteAllText(source, "new");
            File.WriteAllText(Path.Combine(backups, "UsersBackup_2026_1.ldb"), "old");
            File.WriteAllText(Path.Combine(backups, "UsersBackup_2026_2.ldb"), "current");
            SessionHandler.BackupUserDatabase(source, backups, 1, new DateTimeOffset(2026, 1, 15, 0, 0, 0, TimeSpan.Zero));
            Assert.That(File.ReadAllText(Path.Combine(backups, "UsersBackup_2026_2.ldb")), Is.EqualTo("current"));
            Assert.That(File.Exists(Path.Combine(backups, "UsersBackup_2026_1.ldb")), Is.True);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    /// <summary>A failed new backup copy leaves every earlier backup in place.</summary>
    [Test]
    public void TestBackupUserDatabase_FailedCopyPreservesEarlierBackups()
    {
        string root = CreateTempRoot();
        try
        {
            string backups = Path.Combine(root, "UsersBackups");
            Directory.CreateDirectory(backups);
            WriteBackup(backups, 2025, 52);
            WriteBackup(backups, 2026, 1);
            Assert.Throws<FileNotFoundException>(() => SessionHandler.BackupUserDatabase(
                Path.Combine(root, "missing.ldb"), backups, 1, new DateTimeOffset(2026, 1, 15, 0, 0, 0, TimeSpan.Zero)));
            Assert.That(File.Exists(Path.Combine(backups, "UsersBackup_2025_52.ldb")), Is.True);
            Assert.That(File.Exists(Path.Combine(backups, "UsersBackup_2026_1.ldb")), Is.True);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    /// <summary>A successful copy runs the actual retention path and keeps one backup without an indexing failure.</summary>
    [Test]
    public void TestBackupUserDatabase_RetentionOnePublishesThenKeepsNewest()
    {
        string root = CreateTempRoot();
        try
        {
            string source = Path.Combine(root, "Users.ldb");
            string backups = Path.Combine(root, "UsersBackups");
            File.WriteAllText(source, "current database");
            Directory.CreateDirectory(backups);
            WriteBackup(backups, 2025, 52);
            SessionHandler.BackupUserDatabase(source, backups, 1, new DateTimeOffset(2026, 1, 15, 0, 0, 0, TimeSpan.Zero));
            Assert.That(Directory.EnumerateFiles(backups, "UsersBackup_*.ldb").Count(), Is.EqualTo(1));
            Assert.That(File.ReadAllText(Path.Combine(backups, "UsersBackup_2026_2.ldb")), Is.EqualTo("current database"));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }
}
