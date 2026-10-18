using NUnit.Framework;
using SwarmUI.Media;
using SwarmUI.Text2Image;

namespace SwarmUITests;

/// <summary>Which preview string ViewSpecial is allowed to serve, and which adjacent suffixes count as previews.</summary>
[TestFixture]
public class ModelPreviewDataTests : SwarmUITest
{
    /// <summary>Initializes invariant culture the same way the other metadata tests do.</summary>
    [OneTimeSetUp]
    public static void PreInit()
    {
        Setup();
    }

    /// <summary>A legacy model stores the preview on the model and leaves metadata null.</summary>
    [Test]
    public static void PreviewDataFor_LegacyDataAndNullMetadata_ReturnsTheData()
    {
        T2IModel model = new(null, null, "legacy.ckpt", "legacy.ckpt")
        {
            PreviewImage = "data:image/jpeg;base64,abc",
            Metadata = null
        };
        Assert.That(T2IModel.PreviewDataFor(model), Is.EqualTo("data:image/jpeg;base64,abc"));
    }

    /// <summary>A placeholder path is not served. Metadata data is. A placeholder with no metadata data is not.</summary>
    [Test]
    public static void PreviewDataFor_Placeholder_UsesMetadataDataOrNull()
    {
        T2IModel withMeta = new(null, null, "legacy.pt", "legacy.pt")
        {
            PreviewImage = "imgs/legacy_ckpt.jpg",
            Metadata = new T2IModelHandler.ModelMetadataStore()
            {
                PreviewImage = "data:image/png;base64,xyz"
            }
        };
        T2IModel placeholderOnly = new(null, null, "legacy.bin", "legacy.bin")
        {
            PreviewImage = "imgs/model_placeholder.jpg",
            Metadata = new T2IModelHandler.ModelMetadataStore()
            {
                PreviewImage = "imgs/model_placeholder.jpg"
            }
        };
        Assert.That(T2IModel.PreviewDataFor(withMeta), Is.EqualTo("data:image/png;base64,xyz"));
        Assert.That(T2IModel.PreviewDataFor(placeholderOnly), Is.Null);
    }

    /// <summary>No preview on either field, or a null model, serves nothing.</summary>
    [Test]
    public static void PreviewDataFor_BothNull_ReturnsNull()
    {
        T2IModel model = new(null, null, "model.safetensors", "model.safetensors")
        {
            PreviewImage = null,
            Metadata = null
        };
        Assert.That(T2IModel.PreviewDataFor(model), Is.Null);
        Assert.That(T2IModel.PreviewDataFor(null), Is.Null);
    }

    /// <summary>webp previews are recognized, and the image loader can resolve that extension.</summary>
    [Test]
    public static void AutoImageFormatSuffixes_AppendsPreviewWebp()
    {
        string[] suffixes = T2IModelHandler.AutoImageFormatSuffixes;
        Assert.That(suffixes[^1], Is.EqualTo(".preview.webp"));
        Assert.That(suffixes[..^1], Is.EqualTo(new[] { ".jpg", ".png", ".preview.png", ".preview.jpg", ".jpeg", ".preview.jpeg", ".thumb.jpg", ".thumb.png" }));
        MediaType webp = MediaType.GetByExtension("webp");
        Assert.That(webp, Is.Not.Null);
        Assert.That(webp.MimeType, Is.EqualTo("image/webp"));
        Assert.That(webp.MetaType, Is.EqualTo(MediaMetaType.Animation));
    }
}
