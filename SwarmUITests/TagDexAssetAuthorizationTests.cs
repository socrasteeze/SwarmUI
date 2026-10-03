using Microsoft.AspNetCore.Http;
using NUnit.Framework;
using SwarmUI.Accounts;
using SwarmUI.Builtin_TagDexExtension;
using SwarmUI.Core;
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SwarmUITests;

/// <summary>Regression tests for authentication and permission checks on TagDex asset routes.</summary>
[TestFixture]
[NonParallelizable]
public class TagDexAssetAuthorizationTests
{
    /// <summary>Original process-wide state restored after each test.</summary>
    private string SavedDataDir;
    private string SavedFolderPath;
    private string SavedThumbsPath;
    private bool SavedAuthorizationRequired;
    private SessionHandler SavedSessions;
    private string SavedLocalUserID;
    private ConcurrentDictionary<string, TagDexList> SavedLoaded;
    private ConcurrentDictionary<string, SemaphoreSlim> SavedLoadGates;
    private ConcurrentDictionary<string, System.Collections.Frozen.FrozenSet<string>> SavedThumbIndex;
    private ConcurrentDictionary<string, string> SavedIndexCache;
    private string Root;
    private TagDexExtension Extension;

    /// <summary>Creates isolated application state and users for asset-handler tests.</summary>
    [SetUp]
    public void SetUp()
    {
        SavedDataDir = Program.DataDir;
        SavedFolderPath = TagDexData.FolderPath;
        SavedThumbsPath = TagDexData.ThumbsPath;
        SavedAuthorizationRequired = Program.ServerSettings.UserAuthorization.AuthorizationRequired;
        SavedSessions = Program.Sessions;
        SavedLocalUserID = SessionHandler.LocalUserID;
        SavedLoaded = TagDexData.Loaded;
        SavedLoadGates = TagDexData.LoadGates;
        SavedThumbIndex = TagDexData.ThumbIndex;
        SavedIndexCache = TagDexIndexBlob.Cache;
        Root = Path.Combine(Path.GetTempPath(), $"swarmui-tagdex-assets-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Root);
        Program.DataDir = Root;
        Program.ServerSettings.UserAuthorization.AuthorizationRequired = false;
        SessionHandler sessions = (SessionHandler)RuntimeHelpers.GetUninitializedObject(typeof(SessionHandler));
        sessions.Users = new();
        Program.Sessions = sessions;
        TagDexData.Loaded = new();
        TagDexData.LoadGates = new();
        TagDexData.ThumbIndex = new();
        TagDexIndexBlob.Cache = new();
        TagDexData.Init();
        Extension = new TagDexExtension();
        User denied = (User)RuntimeHelpers.GetUninitializedObject(typeof(User));
        denied.Data = new User.DatabaseEntry() { ID = "denied" };
        denied.CalculatedRole = new Role("denied");
        sessions.Users[denied.UserID] = denied;
        User allowed = (User)RuntimeHelpers.GetUninitializedObject(typeof(User));
        allowed.Data = new User.DatabaseEntry() { ID = "allowed" };
        allowed.CalculatedRole = new Role("allowed");
        allowed.CalculatedRole.Data.PermissionFlags.Add(TagDexExtension.PermUseTagDex.ID);
        sessions.Users[allowed.UserID] = allowed;
    }

    /// <summary>Restores all mutable static state and removes temporary data.</summary>
    [TearDown]
    public void TearDown()
    {
        Program.Sessions = SavedSessions;
        SessionHandler.LocalUserID = SavedLocalUserID;
        Program.DataDir = SavedDataDir;
        Program.ServerSettings.UserAuthorization.AuthorizationRequired = SavedAuthorizationRequired;
        TagDexData.FolderPath = SavedFolderPath;
        TagDexData.ThumbsPath = SavedThumbsPath;
        TagDexData.Loaded = SavedLoaded;
        TagDexData.LoadGates = SavedLoadGates;
        TagDexData.ThumbIndex = SavedThumbIndex;
        TagDexIndexBlob.Cache = SavedIndexCache;
        Directory.Delete(Root, true);
    }

    /// <summary>Creates a request context with an optional single-user header.</summary>
    private static DefaultHttpContext Context(string userId)
    {
        DefaultHttpContext context = new();
        context.Response.Body = new MemoryStream();
        if (userId is not null)
        {
            context.Request.Headers["X-SWARM-USER_ID"] = userId;
        }
        return context;
    }

    /// <summary>An unknown user receives 401 before an index source is resolved.</summary>
    [Test]
    public async Task TestServeIndexBlob_UnknownUserReturns401BeforeDatasetRead()
    {
        SessionHandler.LocalUserID = null;
        DefaultHttpContext context = Context(null);
        context.Request.RouteValues["source"] = "missing";
        context.Request.Headers.IfNoneMatch = "\"would-be-cached\"";
        await Extension.ServeIndexBlob(context);
        Assert.That(context.Response.StatusCode, Is.EqualTo(401));
    }

    /// <summary>A known user without TagDex permission receives 403 before a thumbnail path is resolved.</summary>
    [Test]
    public async Task TestServeThumbnail_DeniedUserReturns403BeforePathRead()
    {
        DefaultHttpContext context = Context("denied");
        context.Request.RouteValues["source"] = "missing";
        context.Request.RouteValues["file"] = "../outside.webp";
        context.Request.Headers.IfNoneMatch = "\"would-be-cached\"";
        await Extension.ServeThumbnail(context);
        Assert.That(context.Response.StatusCode, Is.EqualTo(403));
    }

    /// <summary>An allowed user can read an existing index blob.</summary>
    [Test]
    public async Task TestServeIndexBlob_AllowedUserReturnsIndex()
    {
        File.WriteAllText(Path.Combine(TagDexData.FolderPath, "danbooru_character.csv"),
            "character,trigger,count\nexample,Example Trigger,50\n", Encoding.UTF8);
        DefaultHttpContext context = Context("allowed");
        context.Request.RouteValues["source"] = "danbooru_character";
        context.Request.QueryString = new QueryString("?min=1");
        await Extension.ServeIndexBlob(context);
        context.Response.Body.Position = 0;
        using StreamReader reader = new(context.Response.Body, Encoding.UTF8);
        Assert.That(context.Response.StatusCode, Is.EqualTo(200));
        Assert.That(await reader.ReadToEndAsync(), Does.Contain("example\tExample Trigger"));
        Assert.That(context.Response.Headers.CacheControl.ToString(), Is.EqualTo("private, no-cache"));
        Assert.That(context.Response.Headers.ETag.ToString(), Is.Not.Empty);
    }

    /// <summary>An allowed user can read an existing thumbnail.</summary>
    [Test]
    public async Task TestServeThumbnail_AllowedUserReturnsFile()
    {
        string folder = Path.Combine(TagDexData.ThumbsPath, "danbooru_character");
        Directory.CreateDirectory(folder);
        byte[] expected = [1, 2, 3, 4];
        File.WriteAllBytes(Path.Combine(folder, "example.webp"), expected);
        DefaultHttpContext context = Context("allowed");
        context.Request.RouteValues["source"] = "danbooru_character";
        context.Request.RouteValues["file"] = "example.webp";
        await Extension.ServeThumbnail(context);
        Assert.That(context.Response.StatusCode, Is.EqualTo(200));
        Assert.That(((MemoryStream)context.Response.Body).ToArray(), Is.EqualTo(expected));
        Assert.That(context.Response.Headers.CacheControl.ToString(), Is.EqualTo("private, no-cache"));
        Assert.That(context.Response.Headers.ETag.ToString(), Is.Not.Empty);
    }

    /// <summary>An allowed unchanged index request revalidates to 304 only after authorization.</summary>
    [Test]
    public async Task TestServeIndexBlob_AllowedUnchangedAssetReturns304()
    {
        File.WriteAllText(Path.Combine(TagDexData.FolderPath, "danbooru_character.csv"),
            "character,trigger,count\nexample,Example Trigger,50\n", Encoding.UTF8);
        DefaultHttpContext first = Context("allowed");
        first.Request.RouteValues["source"] = "danbooru_character";
        first.Request.QueryString = new QueryString("?min=1");
        await Extension.ServeIndexBlob(first);
        DefaultHttpContext second = Context("allowed");
        second.Request.RouteValues["source"] = "danbooru_character";
        second.Request.QueryString = new QueryString("?min=1");
        second.Request.Headers.IfNoneMatch = first.Response.Headers.ETag;
        await Extension.ServeIndexBlob(second);
        Assert.That(second.Response.StatusCode, Is.EqualTo(304));
        Assert.That(((MemoryStream)second.Response.Body).Length, Is.EqualTo(0));
    }

    /// <summary>An allowed unchanged thumbnail request revalidates to 304 only after authorization.</summary>
    [Test]
    public async Task TestServeThumbnail_AllowedUnchangedAssetReturns304()
    {
        string folder = Path.Combine(TagDexData.ThumbsPath, "danbooru_character");
        Directory.CreateDirectory(folder);
        File.WriteAllBytes(Path.Combine(folder, "example.webp"), [1, 2, 3, 4]);
        DefaultHttpContext first = Context("allowed");
        first.Request.RouteValues["source"] = "danbooru_character";
        first.Request.RouteValues["file"] = "example.webp";
        await Extension.ServeThumbnail(first);
        DefaultHttpContext second = Context("allowed");
        second.Request.RouteValues["source"] = "danbooru_character";
        second.Request.RouteValues["file"] = "example.webp";
        second.Request.Headers.IfNoneMatch = first.Response.Headers.ETag;
        await Extension.ServeThumbnail(second);
        Assert.That(second.Response.StatusCode, Is.EqualTo(304));
        Assert.That(((MemoryStream)second.Response.Body).Length, Is.EqualTo(0));
    }
}
