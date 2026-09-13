using System;
using System.IO;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using SwarmUI.Accounts;
using SwarmUI.Builtin_MobileEnhancementsExtension;
using SwarmUI.Core;
using SwarmUI.Utils;

namespace SwarmUITests;

/// <summary>Tests bounded autocomplete source selection and cancellation.</summary>
[TestFixture]
[NonParallelizable]
public class AutoCompleteListHelperTests : SwarmUITest
{
    /// <summary>Prepares shared test state.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>The API's opt-in exact selector preserves Genpage formatting while the default preserves the standalone fallback.</summary>
    [Test]
    public static async Task ApiExactSelectorPreservesDefaultCompatibility()
    {
        string root = Path.Combine(Path.GetTempPath(), $"swarm-autocomplete-{Guid.NewGuid():N}");
        string previous = Program.DataDir;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "Autocompletions", "set"));
            File.WriteAllText(Path.Combine(root, "Autocompletions", "set", "character_tags.txt"), "character(foo)\n");
            File.WriteAllText(Path.Combine(root, "Autocompletions", "set", "all_tags.txt"), "general(bar)\n");
            Program.DataDir = root;
            AutoCompleteListHelper.Reload();
            User user = RuntimeHelpers.GetUninitializedObject(typeof(User)) as User;
            user.Data = new User.DatabaseEntry() { ID = $"autocomplete-{Guid.NewGuid():N}" };
            user.Settings = new Settings.User();
            user.Settings.AutoComplete.Source = "set/character_tags.txt";
            user.Settings.AutoComplete.EscapeParens = true;
            user.Settings.ParamParsing.ParseAlternativePromptSyntaxes = false;
            Session session = new() { User = user };
            MobileEnhancementsExtension extension = new();

            JObject exact = await extension.GetSimpleAutocompletions(new DefaultHttpContext(), session, true);
            JObject fallback = await extension.GetSimpleAutocompletions(new DefaultHttpContext(), session);

            Assert.That((string)exact["source"], Is.EqualTo("set/character_tags.txt"));
            Assert.That((string)exact["autocompletions"][0], Is.EqualTo("character(foo)\ncharacter(foo)"));
            Assert.That((string)fallback["source"], Is.EqualTo("set/all_tags.txt"));
            Assert.That((string)fallback["autocompletions"][0], Is.EqualTo("general\\(bar\\)\ngeneral(bar)"));
        }
        finally
        {
            Program.DataDir = previous;
            Directory.Delete(root, true);
            AutoCompleteListHelper.Reload();
        }
    }

    /// <summary>Bounded loading honors cancellation before it reads a source.</summary>
    [Test]
    public static void BoundedLoadHonorsCancellation()
    {
        using CancellationTokenSource cancellation = new();
        cancellation.Cancel();
        Assert.ThrowsAsync<OperationCanceledException>(async () => await AutoCompleteListHelper.GetDataAsync("missing.txt", false, "", "None", cancellation.Token));
    }
}
