using NUnit.Framework;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using System.Collections.Generic;

namespace SwarmUITests;

/// <summary>Checks narrow LIST recovery for LoRAs moved between catalog folders.</summary>
[TestFixture]
public class MovedLoraPathValidationTests : SwarmUITest
{
    /// <summary>Initializes shared helpers.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>A stale qualified path resolves to the sole exact filename match and returns its canonical catalog entry.</summary>
    [Test]
    public void MovedQualifiedPathResolvesUniqueFilename()
    {
        T2IParamType type = ListType("LoRA", ["current/place/model"]);

        string result = T2IParamTypes.ValidateParam(type, "old/place/model", null);

        Assert.That(result, Is.EqualTo("current/place/model"));
    }

    /// <summary>Multiple moved and current LoRAs retain input order and count in the canonical LIST separator format.</summary>
    [Test]
    public void ThreeItemListRetainsCanonicalOrderAndCount()
    {
        T2IParamType type = ListType("LoRA", ["new/first", "current/second", "new/third"]);

        string result = T2IParamTypes.ValidateParam(type, "old/first,current/second,old/third", null);
        string[] entries = result.Split("\n|||\n");

        Assert.That(entries, Has.Length.EqualTo(3));
        Assert.That(entries, Is.EqualTo(new[] { "new/first", "current/second", "new/third" }));
    }

    /// <summary>Two exact filename matches remain ambiguous and are rejected.</summary>
    [Test]
    public void AmbiguousFilenameIsRejected()
    {
        T2IParamType type = ListType("LoRA", ["current/one/model", "current/two/model"]);

        Assert.Throws<SwarmUserErrorException>(() => T2IParamTypes.ValidateParam(type, "old/place/model", null));
    }

    /// <summary>An existing full path keeps precedence over another entry with the same filename.</summary>
    [Test]
    public void CurrentFullPathWinsBeforeFilenameFallback()
    {
        T2IParamType type = ListType("LoRA", ["current/place/model", "other/place/model"]);

        string result = T2IParamTypes.ValidateParam(type, "current/place/model", null);

        Assert.That(result, Is.EqualTo("current/place/model"));
    }

    /// <summary>A missing filename does not use moved-path recovery.</summary>
    [TestCase("old/place/missing")]
    [TestCase("old/place/")]
    public void MissingNameIsRejected(string input)
    {
        T2IParamType type = ListType("LoRA", ["current/place/model"]);

        Assert.Throws<SwarmUserErrorException>(() => T2IParamTypes.ValidateParam(type, input, null));
    }

    /// <summary>Filename recovery normalizes case, an optional safetensors extension, and Windows separators.</summary>
    [Test]
    public void FilenameFallbackNormalizesCaseExtensionAndSeparators()
    {
        T2IParamType type = ListType("LoRA", ["Current/Place/Model"]);

        string result = T2IParamTypes.ValidateParam(type, "OLD\\PLACE\\MODEL.SAFETENSORS", null);

        Assert.That(result, Is.EqualTo("Current/Place/Model"));
    }

    /// <summary>Other LIST model subtypes retain strict path validation.</summary>
    [Test]
    public void NonLoraSubtypeRejectsMovedFilename()
    {
        T2IParamType type = ListType("Stable-Diffusion", ["current/place/model"]);

        Assert.Throws<SwarmUserErrorException>(() => T2IParamTypes.ValidateParam(type, "old/place/model", null));
    }

    /// <summary>Create a validating LIST parameter with isolated allowed values.</summary>
    private static T2IParamType ListType(string subtype, List<string> values)
    {
        return new("Models", "", "", GetValues: _ => values, Type: T2IParamDataType.LIST, Subtype: subtype);
    }
}
