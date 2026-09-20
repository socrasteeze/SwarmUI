using NUnit.Framework;
using Newtonsoft.Json.Linq;
using SwarmUI.Builtin_TagDexExtension;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using SwarmUI.Core;
using SwarmUI.Text2Image;

namespace SwarmUITests;

/// <summary>Tests exact identity and collision-safe naming for library LoRA acquisition.</summary>
public class TagDexLibraryTests
{
    /// <summary>SHA validation rejects short and non-hex aliases.</summary>
    [Test]
    public void Sha256ValidationIsExact()
    {
        Assert.That(TagDexLibrary.IsSha256(new string('a', 64)), Is.True);
        Assert.That(TagDexLibrary.IsSha256(new string('a', 63)), Is.False);
        Assert.That(TagDexLibrary.IsSha256(new string('z', 64)), Is.False);
    }

    /// <summary>Different archives with the same display metadata cannot select the same destination.</summary>
    [Test]
    public void DownloadNameIncludesArchiveIdentity()
    {
        string first = TagDexLibrary.DownloadName("Character/Style", "v1", new string('a', 64));
        string second = TagDexLibrary.DownloadName("Character/Style", "v1", new string('b', 64));
        Assert.That(first, Is.Not.EqualTo(second));
        Assert.That(first, Does.EndWith("-aaaaaaaaaaaa.safetensors"));
        Assert.That(first, Does.Not.Contain("/"));
    }

    /// <summary>The API binder's outer routing fields never leak into the AnimaDex JSON body.</summary>
    [Test]
    public void SaveRequestUnwrapsNestedBody()
    {
        JObject data = new() { ["name"] = "Test" };
        JObject request = new()
        {
            ["action"] = "create_character",
            ["id"] = "",
            ["body"] = new JObject() { ["data"] = data }
        };
        JObject body = TagDexExtension.LibrarySaveBody(request);
        Assert.That(body["data"]?["name"]?.ToString(), Is.EqualTo("Test"));
        Assert.That(body["action"], Is.Null);
    }

    /// <summary>A changed file must pass a fresh full-file hash before its receipt remains valid.</summary>
    [Test]
    public void ReceiptRejectsChangedBytes()
    {
        string path = Path.Combine(Path.GetTempPath(), $"tagdex-{Guid.NewGuid():N}.safetensors");
        try
        {
            byte[] expected = Encoding.UTF8.GetBytes("synthetic-lora");
            File.WriteAllBytes(path, expected);
            string hash = Convert.ToHexString(SHA256.HashData(expected)).ToLowerInvariant();
            FileInfo info = new(path);
            TagDexLibrary.InstallReceipt receipt = new(hash, "test.safetensors", path, info.Length, info.LastWriteTimeUtc.Ticks);
            Assert.That(TagDexLibrary.ReceiptMatches(receipt), Is.True);
            File.WriteAllBytes(path, Encoding.UTF8.GetBytes("corrupt-lora"));
            File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddSeconds(2));
            Assert.That(TagDexLibrary.ReceiptMatches(receipt), Is.False);
        }
        finally
        {
            File.Delete(path);
        }
    }

    /// <summary>Matching size and timestamp cannot hide changed model bytes.</summary>
    [Test]
    public void ReceiptRejectsChangedBytesWithPreservedIdentity()
    {
        string path = Path.Combine(Path.GetTempPath(), $"tagdex-{Guid.NewGuid():N}.safetensors");
        try
        {
            byte[] expected = Encoding.UTF8.GetBytes("first-model");
            File.WriteAllBytes(path, expected);
            string hash = Convert.ToHexString(SHA256.HashData(expected)).ToLowerInvariant();
            FileInfo info = new(path);
            TagDexLibrary.InstallReceipt receipt = new(hash, "test.safetensors", path, info.Length, info.LastWriteTimeUtc.Ticks);
            File.WriteAllBytes(path, Encoding.UTF8.GetBytes("other-model"));
            File.SetLastWriteTimeUtc(path, new DateTime(receipt.ModifiedUtc, DateTimeKind.Utc));
            Assert.That(TagDexLibrary.ReceiptMatches(receipt), Is.False);
        }
        finally
        {
            File.Delete(path);
        }
    }

    /// <summary>A stale timestamp does not reject unchanged verified bytes.</summary>
    [Test]
    public void ReceiptRehashesUnchangedBytes()
    {
        string path = Path.Combine(Path.GetTempPath(), $"tagdex-{Guid.NewGuid():N}.safetensors");
        try
        {
            byte[] expected = Encoding.UTF8.GetBytes("synthetic-lora");
            File.WriteAllBytes(path, expected);
            string hash = Convert.ToHexString(SHA256.HashData(expected)).ToLowerInvariant();
            FileInfo info = new(path);
            TagDexLibrary.InstallReceipt receipt = new(hash, "test.safetensors", path, info.Length, info.LastWriteTimeUtc.Ticks - 1);
            Assert.That(TagDexLibrary.ReceiptMatches(receipt), Is.True);
        }
        finally
        {
            File.Delete(path);
        }
    }

    /// <summary>Family compatibility ignores punctuation but never fuzzy-matches a different family.</summary>
    [Test]
    public void FamilyCompatibilityIsNormalizedAndExact()
    {
        Assert.That(TagDexLibrary.FamilyMatches("stable-diffusion-xl", "Stable Diffusion XL"), Is.True);
        Assert.That(TagDexLibrary.FamilyMatches("anima", "anima/lora"), Is.True);
        Assert.That(TagDexLibrary.FamilyMatches("anima", "stable-diffusion-xl-v1"), Is.False);
        Assert.That(TagDexLibrary.FamilyMatches("stable-diffusion-xl", "stable-diffusion-1"), Is.False);
    }

    /// <summary>An exact file with a mismatched family never becomes ready.</summary>
    [Test]
    public void ExactCandidateStillChecksFamily()
    {
        T2IModel model = new(null, "", "", "test") { Metadata = new() { ModelClassType = "stable-diffusion-xl" } };
        Assert.That(TagDexLibrary.ModelFamilyStatus(model, "anima"), Is.EqualTo("incompatible"));
    }

    /// <summary>A receipt cannot bless a same-name model that resolves to different bytes.</summary>
    [Test]
    [NonParallelizable]
    public void ReceiptRejectsLogicalNameShadow()
    {
        string priorFolder = TagDexData.FolderPath;
        Dictionary<string, T2IModelHandler> priorSets = Program.T2IModelSets;
        string folder = Path.Combine(Path.GetTempPath(), $"tagdex-shadow-{Guid.NewGuid():N}");
        Directory.CreateDirectory(folder);
        try
        {
            string receiptFile = Path.Combine(folder, "receipt.safetensors");
            string shadowFile = Path.Combine(folder, "shadow.safetensors");
            File.WriteAllText(receiptFile, "verified bytes");
            File.WriteAllText(shadowFile, "different bytes");
            string hash = TagDexLibrary.FullHash(receiptFile);
            FileInfo info = new(receiptFile);
            TagDexData.FolderPath = folder;
            TagDexLibrary.SaveReceipts(new() { [hash] = new(hash, "same.safetensors", receiptFile, info.Length, info.LastWriteTimeUtc.Ticks) });
            T2IModelHandler handler = new() { ModelType = "LoRA" };
            handler.Models["same.safetensors"] = new(handler, folder, shadowFile, "same.safetensors");
            Program.T2IModelSets = new() { ["LoRA"] = handler };
            JObject record = new()
            {
                ["id"] = "v",
                ["revision"] = "r",
                ["data"] = new JObject()
                {
                    ["recipe"] = new JObject()
                    {
                        ["base_family"] = "",
                        ["checkpoint"] = "chosen",
                        ["loras"] = new JArray(new JObject()
                        {
                            ["archive_sha256"] = hash,
                            ["weights_sha256"] = null,
                            ["name"] = "same",
                            ["version"] = "",
                            ["weight"] = 1
                        })
                    }
                }
            };
            JObject resolved = TagDexLibrary.ResolveRecipe(record);
            Assert.That(resolved["loras"]?[0]?["status"]?.ToString(), Is.EqualTo("unverified"));
        }
        finally
        {
            Program.T2IModelSets = priorSets;
            TagDexData.FolderPath = priorFolder;
            Directory.Delete(folder, true);
        }
    }

    /// <summary>Resolve stays local when verified files and the selected checkpoint are available.</summary>
    [Test]
    [NonParallelizable]
    public async Task ResolveReadyDoesNotCallArchive()
    {
        string priorFolder = TagDexData.FolderPath;
        Dictionary<string, T2IModelHandler> priorSets = Program.T2IModelSets;
        string folder = Path.Combine(Path.GetTempPath(), $"tagdex-offline-{Guid.NewGuid():N}");
        Directory.CreateDirectory(folder);
        try
        {
            string loraPath = Path.Combine(folder, "lora.safetensors");
            File.WriteAllText(loraPath, "local exact lora");
            string sha = TagDexLibrary.FullHash(loraPath);
            T2IModelHandler loras = new() { ModelType = "LoRA" };
            loras.Models["lora.safetensors"] = new(loras, folder, loraPath, "lora.safetensors")
            {
                Metadata = new() { ModelClassType = "anima/lora" }
            };
            T2IModelHandler checkpoints = new() { ModelType = "Stable-Diffusion" };
            checkpoints.Models["checkpoint.safetensors"] = new(checkpoints, folder, loraPath, "checkpoint.safetensors")
            {
                Metadata = new() { ModelClassType = "anima/checkpoint" }
            };
            Program.T2IModelSets = new() { ["LoRA"] = loras, ["Stable-Diffusion"] = checkpoints };
            TagDexData.FolderPath = folder;
            FileInfo info = new(loraPath);
            TagDexLibrary.SaveReceipts(new() { [sha] = new(sha, "lora.safetensors", loraPath, info.Length, info.LastWriteTimeUtc.Ticks) });
            List<string> paths = [];
            await WithArchive(async context =>
            {
                paths.Add(context.Request.Url.AbsolutePath);
                JObject body = context.Request.Url.AbsolutePath.Contains("/variants/") ? new JObject()
                {
                    ["ok"] = true,
                    ["record"] = new JObject()
                    {
                        ["id"] = "variant",
                        ["revision"] = "revision",
                        ["conflict"] = false,
                        ["data"] = new JObject()
                        {
                            ["character_id"] = "character",
                            ["name"] = "Variant",
                            ["archived"] = false,
                            ["recipe"] = new JObject()
                            {
                                ["prompt"] = "",
                                ["negative_prompt"] = "",
                                ["base_family"] = "",
                                ["checkpoint"] = "",
                                ["loras"] = new JArray(new JObject()
                                {
                                    ["archive_sha256"] = sha,
                                    ["weights_sha256"] = null,
                                    ["name"] = "LoRA",
                                    ["version"] = "v1",
                                    ["weight"] = 1
                                })
                            }
                        }
                    }
                } : new JObject()
                {
                    ["ok"] = true,
                    ["record"] = new JObject() { ["id"] = "character", ["conflict"] = false, ["data"] = new JObject() { ["archived"] = false } }
                };
                byte[] bytes = Encoding.UTF8.GetBytes(body.ToString(Newtonsoft.Json.Formatting.None));
                context.Response.ContentType = "application/json";
                context.Response.ContentLength64 = bytes.Length;
                await context.Response.OutputStream.WriteAsync(bytes);
                context.Response.Close();
            }, async url =>
            {
                File.WriteAllText(Path.Combine(folder, "local.json"), $"{{\"library\":{{\"enabled\":true,\"url\":\"{url}\",\"key\":\"key\"}},\"archive\":{{\"enabled\":true,\"url\":\"http://127.0.0.1:1\",\"token\":\"offline\"}}}}");
                JObject result = await new TagDexExtension().TagDexLibraryResolve(null, "variant", "revision", "checkpoint.safetensors");
                Assert.That(result.Value<bool>("ready"), Is.True);
            }, 2);
            Assert.That(paths, Is.EqualTo(new[] { "/api/library/variants/variant", "/api/library/characters/character" }));
        }
        finally
        {
            Program.T2IModelSets = priorSets;
            TagDexData.FolderPath = priorFolder;
            Directory.Delete(folder, true);
        }
    }

    /// <summary>A blank recipe family still rejects a mixed stack using the selected checkpoint family.</summary>
    [Test]
    [NonParallelizable]
    public void BlankFamilyUsesCheckpointArchitecture()
    {
        Dictionary<string, T2IModelHandler> priorSets = Program.T2IModelSets;
        try
        {
            T2IModelHandler checkpoints = new() { ModelType = "Stable-Diffusion" };
            checkpoints.Models["anima.safetensors"] = new(checkpoints, "", "", "anima.safetensors")
            {
                Metadata = new() { ModelClassType = "anima/checkpoint" }
            };
            Program.T2IModelSets = new() { ["Stable-Diffusion"] = checkpoints };
            string inferred = TagDexLibrary.CheckpointFamily("anima.safetensors");
            T2IModel anima = new(null, "", "", "anima") { Metadata = new() { ModelClassType = "anima/lora" } };
            T2IModel sdxl = new(null, "", "", "sdxl") { Metadata = new() { ModelClassType = "stable-diffusion-xl" } };
            Assert.That(TagDexLibrary.ModelFamilyStatus(anima, inferred), Is.EqualTo("ready"));
            Assert.That(TagDexLibrary.ModelFamilyStatus(sdxl, inferred), Is.EqualTo("incompatible"));
        }
        finally
        {
            Program.T2IModelSets = priorSets;
        }
    }

    /// <summary>A local archive fixture proves authenticated exact-byte acquisition.</summary>
    [Test]
    public async Task ArchiveDownloadVerifiesHashAndToken()
    {
        byte[] payload = Encoding.UTF8.GetBytes("synthetic-archive-lora");
        string sha = Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant();
        bool sawToken = false;
        await WithArchive(async context =>
        {
            Assert.That(context.Request.Url.AbsolutePath, Is.EqualTo($"/api/models/{sha}/file"));
            sawToken = context.Request.Headers["Authorization"] == "Bearer test-token";
            context.Response.ContentLength64 = payload.Length;
            await context.Response.OutputStream.WriteAsync(payload);
            context.Response.Close();
        }, async url =>
        {
            string path = Path.Combine(Path.GetTempPath(), $"tagdex-download-{Guid.NewGuid():N}.tmp");
            try
            {
                await TagDexLibrary.DownloadArchive(new(true, url, "test-token", 30), sha, path, (_, _, _) => { }, CancellationToken.None);
                Assert.That(File.ReadAllBytes(path), Is.EqualTo(payload));
                Assert.That(sawToken, Is.True);
            }
            finally
            {
                File.Delete(path);
            }
        });
    }


    /// <summary>The detail proxy follows bounded pages until every child is present.</summary>
    [Test]
    [NonParallelizable]
    public async Task DetailProxyLoadsEveryChildPage()
    {
        string priorFolder = TagDexData.FolderPath;
        string folder = Path.Combine(Path.GetTempPath(), $"tagdex-pages-{Guid.NewGuid():N}");
        Directory.CreateDirectory(folder);
        try
        {
            int calls = 0;
            await WithArchive(async context =>
            {
                calls++;
                int offset = int.Parse(context.Request.QueryString["offset"]);
                int count = offset == 0 ? 250 : 55;
                JArray variants = new(Enumerable.Range(offset, count).Select(i => new JObject() { ["id"] = i }));
                byte[] body = Encoding.UTF8.GetBytes(new JObject()
                {
                    ["ok"] = true,
                    ["record"] = new JObject() { ["id"] = "character" },
                    ["variants"] = variants,
                    ["total"] = 305,
                    ["offset"] = offset,
                    ["limit"] = 250
                }.ToString(Newtonsoft.Json.Formatting.None));
                context.Response.ContentType = "application/json";
                context.Response.ContentLength64 = body.Length;
                await context.Response.OutputStream.WriteAsync(body);
                context.Response.Close();
            }, async url =>
            {
                TagDexData.FolderPath = folder;
                File.WriteAllText(Path.Combine(folder, "local.json"), $"{{\"library\":{{\"enabled\":true,\"url\":\"{url}\",\"key\":\"key\"}}}}");
                JObject result = await TagDexExtension.FetchCompleteCollection("characters/test", "variants");
                Assert.That((result["variants"] as JArray)?.Count, Is.EqualTo(305));
                Assert.That(calls, Is.EqualTo(2));
            }, 2);
        }
        finally
        {
            TagDexData.FolderPath = priorFolder;
            Directory.Delete(folder, true);
        }
    }

    /// <summary>Corrupt archive bytes never publish as a verified temporary download.</summary>
    [Test]
    public void ArchiveDownloadRejectsHashMismatch()
    {
        byte[] payload = Encoding.UTF8.GetBytes("corrupt");
        string expected = new string('a', 64);
        Assert.ThrowsAsync<SwarmUI.Utils.SwarmReadableErrorException>(async () => await WithArchive(async context =>
        {
            context.Response.ContentLength64 = payload.Length;
            await context.Response.OutputStream.WriteAsync(payload);
            context.Response.Close();
        }, async url =>
        {
            string path = Path.Combine(Path.GetTempPath(), $"tagdex-download-{Guid.NewGuid():N}.tmp");
            try
            {
                await TagDexLibrary.DownloadArchive(new(true, url, "", 30), expected, path, (_, _, _) => { }, CancellationToken.None);
            }
            finally
            {
                File.Delete(path);
            }
        }));
    }

    /// <summary>Archive redirects are rejected before credentials can be forwarded.</summary>
    [Test]
    public void ArchiveDownloadRejectsRedirect()
    {
        Assert.ThrowsAsync<SwarmUI.Utils.SwarmReadableErrorException>(async () => await WithArchive(context =>
        {
            context.Response.StatusCode = 302;
            context.Response.RedirectLocation = "http://example.invalid/stolen";
            context.Response.Close();
            return Task.CompletedTask;
        }, async url =>
        {
            string path = Path.Combine(Path.GetTempPath(), $"tagdex-download-{Guid.NewGuid():N}.tmp");
            try
            {
                await TagDexLibrary.DownloadArchive(new(true, url, "secret", 30), new string('a', 64), path, (_, _, _) => { }, CancellationToken.None);
            }
            finally
            {
                File.Delete(path);
            }
        }));
    }

    /// <summary>Runs one isolated localhost archive request.</summary>
    private static async Task WithArchive(Func<HttpListenerContext, Task> handler, Func<string, Task> test, int requests = 1)
    {
        TcpListener reservation = new(IPAddress.Loopback, 0);
        reservation.Start();
        int port = ((IPEndPoint)reservation.LocalEndpoint).Port;
        reservation.Stop();
        using HttpListener listener = new();
        string url = $"http://127.0.0.1:{port}";
        listener.Prefixes.Add($"{url}/");
        listener.Start();
        Task server = Task.Run(async () =>
        {
            for (int i = 0; i < requests; i++)
            {
                await handler(await listener.GetContextAsync());
            }
        });
        await test(url);
        await server;
    }

    /// <summary>The proxy sends only the library key and preserves a stale-write response.</summary>
    [Test]
    [NonParallelizable]
    public async Task LibraryProxyAuthenticatesAndPreservesConflict()
    {
        string priorFolder = TagDexData.FolderPath;
        string folder = Path.Combine(Path.GetTempPath(), $"tagdex-config-{Guid.NewGuid():N}");
        Directory.CreateDirectory(folder);
        try
        {
            await WithArchive(async context =>
            {
                Assert.That(context.Request.Headers["X-AnimaDex-Library-Key"], Is.EqualTo("library-test-key"));
                Assert.That(context.Request.Headers["X-AnimaDex-Replica-Key"], Is.Null);
                context.Response.StatusCode = 409;
                byte[] body = Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":\"stale\",\"code\":\"stale_revision\"}");
                context.Response.ContentType = "application/json";
                context.Response.ContentLength64 = body.Length;
                await context.Response.OutputStream.WriteAsync(body);
                context.Response.Close();
            }, async url =>
            {
                TagDexData.FolderPath = folder;
                File.WriteAllText(Path.Combine(folder, "local.json"), $"{{\"library\":{{\"enabled\":true,\"url\":\"{url}\",\"key\":\"library-test-key\"}}}}");
                JObject result = await TagDexLibrary.LibraryRequest(HttpMethod.Put, "characters/test", new JObject());
                Assert.That(result.Value<string>("code"), Is.EqualTo("stale_revision"));
                Assert.That(result.Value<int>("http_status"), Is.EqualTo(409));
            });
        }
        finally
        {
            TagDexData.FolderPath = priorFolder;
            Directory.Delete(folder, true);
        }
    }

    /// <summary>Optional live wire check against the isolated AnimaDex fixture.</summary>
    [Test]
    [NonParallelizable]
    public async Task AnimaDexFixtureRoundTrip()
    {
        string url = Environment.GetEnvironmentVariable("TAGDEX_FIXTURE_URL");
        string key = Environment.GetEnvironmentVariable("TAGDEX_FIXTURE_KEY");
        if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(key))
        {
            Assert.Ignore("Set TAGDEX_FIXTURE_URL and TAGDEX_FIXTURE_KEY for the isolated wire check.");
        }
        string priorFolder = TagDexData.FolderPath;
        string folder = Path.Combine(Path.GetTempPath(), $"tagdex-wire-{Guid.NewGuid():N}");
        Directory.CreateDirectory(folder);
        try
        {
            TagDexData.FolderPath = folder;
            File.WriteAllText(Path.Combine(folder, "local.json"), $"{{\"library\":{{\"enabled\":true,\"url\":\"{url}\",\"key\":\"{key}\"}}}}");
            TagDexExtension extension = new();
            JObject list = await extension.TagDexLibraryCharacters(null, "Fixture Character", 0, 250, false);
            Assert.That(list.Value<bool>("ok"), Is.True);
            JObject fixture = (list["results"] as JArray)?.Values<JObject>().FirstOrDefault(item => item["data"]?.Value<string>("name") == "Fixture Character");
            string fixtureId = fixture?.Value<string>("id");
            JObject detail = await extension.TagDexLibraryCharacter(null, fixtureId);
            Assert.That((detail["variants"] as JArray)?.Count, Is.EqualTo(55));
            string variantId = detail["variants"]?.First?["id"]?.ToString();
            JObject variant = await extension.TagDexLibraryVariant(null, variantId);
            Assert.That((variant["images"] as JArray)?.Count, Is.EqualTo(55));
            JObject archive = await extension.TagDexLibraryArchive(null, "Fixture", "", 0, 25);
            Assert.That(archive.Value<bool>("ok"), Is.True);
            string archiveSha = archive["results"]?.First?["archive_sha256"]?.ToString();
            JObject archiveDetail = await extension.TagDexLibraryArchive(null, "", archiveSha, 0, 25);
            Assert.That(archiveDetail["model"]?["archive_sha256"]?.ToString(), Is.EqualTo(archiveSha));
            JObject created = await TagDexLibrary.LibraryRequest(HttpMethod.Post, "characters", new JObject()
            {
                ["data"] = new JObject() { ["name"] = $"Wire {Guid.NewGuid():N}", ["series"] = "Fixture", ["catalogue_ref"] = null, ["archived"] = false }
            });
            Assert.That(created.Value<bool>("ok"), Is.True);
            JObject record = created["record"] as JObject;
            JObject updated = await TagDexLibrary.LibraryRequest(HttpMethod.Put, $"characters/{record.Value<string>("id")}", new JObject()
            {
                ["base_revision"] = record.Value<string>("revision"),
                ["data"] = new JObject() { ["name"] = record["data"]?["name"], ["series"] = "Fixture Updated", ["catalogue_ref"] = null, ["archived"] = true }
            });
            Assert.That(updated.Value<bool>("ok"), Is.True);
        }
        finally
        {
            TagDexData.FolderPath = priorFolder;
            Directory.Delete(folder, true);
        }
    }
}
