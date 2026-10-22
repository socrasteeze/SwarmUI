using FreneticUtilities.FreneticExtensions;
using FreneticUtilities.FreneticToolkit;
using LiteDB;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Media;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.Diagnostics;
using System.IO;
using System.Linq.Expressions;
using System.Runtime.CompilerServices;

namespace SwarmUI.Text2Image;

/// <summary>Central manager for Text2Image models.</summary>
public class T2IModelHandler
{
    /// <summary>Diagnostics that flow from one refresh into its parallel scan work.</summary>
    private static readonly AsyncLocal<ModelRefreshDiagnostics> ActiveRefreshDiagnostics = new();

    /// <summary>Preview-free metadata projections cached for each LiteDB mapper.</summary>
    private static readonly ConditionalWeakTable<BsonMapper, BsonExpression> MetadataProjections = new();

    /// <summary>Typed source for the preview-free LiteDB projection.</summary>
    private static readonly Expression<Func<ModelMetadataStore, ModelMetadataStore>> MetadataProjectionSource = metadata => new ModelMetadataStore()
    {
        ModelName = metadata.ModelName,
        ModelFileVersion = metadata.ModelFileVersion,
        SidecarFileVersion = metadata.SidecarFileVersion,
        SidecarVersionKnown = metadata.SidecarVersionKnown == true,
        ModelClassType = metadata.ModelClassType,
        AnimaDepthClassified = metadata.AnimaDepthClassified == true,
        Title = metadata.Title,
        Author = metadata.Author,
        Description = metadata.Description,
        PreviewExplicitlyCleared = metadata.PreviewExplicitlyCleared == true,
        StandardWidth = metadata.StandardWidth,
        StandardHeight = metadata.StandardHeight,
        IsNegativeEmbedding = metadata.IsNegativeEmbedding == true,
        LoraDefaultWeight = metadata.LoraDefaultWeight,
        LoraDefaultConfinement = metadata.LoraDefaultConfinement,
        License = metadata.License,
        UsageHint = metadata.UsageHint,
        TriggerPhrase = metadata.TriggerPhrase,
        Tags = metadata.Tags,
        MergedFrom = metadata.MergedFrom,
        Date = metadata.Date,
        Preprocessor = metadata.Preprocessor,
        TimeModified = metadata.TimeModified,
        TimeCreated = metadata.TimeCreated,
        Hash = metadata.Hash,
        PredictionType = metadata.PredictionType,
        TextEncoders = metadata.TextEncoders,
        SpecialFormat = metadata.SpecialFormat
    };

    /// <summary>All models known to this handler.</summary>
    public ConcurrentDictionary<string, T2IModel> Models = new();

    /// <summary>Lock used when modifying the model list.</summary>
    public LockObject ModificationLock = new();

    /// <summary>If true, the engine is shutting down.</summary>
    public bool IsShutdown = false;

    /// <summary>Whether the most recent model refresh scanned every configured folder successfully.</summary>
    public volatile bool LastRefreshSucceeded = false;

    /// <summary>Internal model metadata cache data (per folder).</summary>
    public static ConcurrentDictionary<string, ModelDatabase> ModelMetadataCachePerFolder = [];

    /// <summary>Lock for metadata processing.</summary>
    public LockObject MetadataLock = new();

    /// <summary>Lock for the bounded resolved-preview cache.</summary>
    private readonly LockObject PreviewCacheLock = new();

    /// <summary>Resolved preview data retained for recently viewed models.</summary>
    private readonly Dictionary<string, LinkedListNode<ResolvedPreview>> ResolvedPreviews = [];

    /// <summary>Least-recently-used order for resolved preview data.</summary>
    private readonly LinkedList<ResolvedPreview> ResolvedPreviewOrder = new();

    /// <summary>Preview loads currently in progress, keyed by metadata cache and model ID.</summary>
    private readonly ConcurrentDictionary<string, Lazy<string>> PreviewLoads = [];

    /// <summary>Invalidation generation that prevents old in-flight results from reentering the LRU cache.</summary>
    private long PreviewCacheGeneration;

    /// <summary>Total characters retained by <see cref="ResolvedPreviews"/>.</summary>
    private long ResolvedPreviewCharacters;

    /// <summary>Maximum count of resolved previews retained in memory.</summary>
    internal const int ResolvedPreviewEntryLimit = 64;

    /// <summary>Maximum approximate UTF-16 bytes retained by resolved preview strings.</summary>
    internal const long ResolvedPreviewByteLimit = 32L * 1024 * 1024;

    /// <summary>Test seam counting deferred preview source loads.</summary>
    internal long DeferredPreviewLoadCount;

    /// <summary>Test seam for the current bounded preview entry count.</summary>
    internal int ResolvedPreviewCount
    {
        get
        {
            lock (PreviewCacheLock)
            {
                return ResolvedPreviews.Count;
            }
        }
    }

    /// <summary>Test seam for approximate bytes held by resolved preview strings.</summary>
    internal long ResolvedPreviewBytes
    {
        get
        {
            lock (PreviewCacheLock)
            {
                return ResolvedPreviewCharacters * sizeof(char);
            }
        }
    }

    /// <summary>One entry in the bounded resolved-preview cache.</summary>
    private sealed record ResolvedPreview(string Key, string Value);

    /// <summary>The type of model this handler is tracking (eg Stable-Diffusion, LoRA, VAE, Embedding, ...).</summary>
    public string ModelType;

    /// <summary>The full folder path for relevant models.</summary>
    public string[] FolderPaths = [];

    /// <summary>The full folder path to download models to.</summary>
    public string DownloadFolderPath;

    /// <summary>Quick internal tracker for unauthorized access errors, to aggregate the warning.</summary>
    public ConcurrentQueue<string> UnathorizedAccessSet = new();

    /// <summary>Internal tracker for model folders that could not be scanned completely.</summary>
    private readonly ConcurrentQueue<string> ScanErrorSet = new();

    public record class ModelDatabase(string Folder, T2IModelHandler Handler, LiteDatabase Database, ILiteCollection<ModelMetadataStore> Metadata, string FileName = "model_metadata.ldb")
    {
        public volatile int Errors = 0;

        public void HadNewError()
        {
            int newCount = Interlocked.Increment(ref Errors);
            if (newCount < 10)
            {
                return;
            }
            lock (Handler.MetadataLock)
            {
                try
                {
                    Database.Dispose();
                    Errors = -1000;
                }
                catch (Exception) { }
                try
                {
                    File.Delete($"{Folder}/{FileName}");
                }
                catch (Exception) { }
                try
                {
                    File.Delete($"{Folder}/{FileName.Replace(".ldb", "-log.ldb")}");
                }
                catch (Exception) { }
                ModelMetadataCachePerFolder.TryRemove($"{Folder}/{FileName}", out _);
            }
        }

        public void Dispose()
        {
            try
            {
                Database.Dispose();
            }
            catch (Exception ex)
            {
                Logs.Error($"Error disposing image metadata database for folder '{Folder}': {ex.ReadableString()}");
            }
        }
    }

    /// <summary>Helper, data store for model metadata.</summary>
    public class ModelMetadataStore
    {
        [BsonId]
        public string ModelName { get; set; }

        public long ModelFileVersion { get; set; }

        /// <summary>Unix-millisecond last-write time of the adjacent <c>.swarm.json</c>, or 0 when that file was absent.</summary>
        public long SidecarFileVersion { get; set; }

        /// <summary>False on cache rows saved before sidecar mtimes were recorded. Those rows store the current mtime and do not reread.</summary>
        public bool SidecarVersionKnown { get; set; }

        public string ModelClassType { get; set; }

        /// <summary>Backing value for the persistent Anima depth migration marker.</summary>
        private bool animaDepthClassified;

        /// <summary>True once this cache entry has passed the Anima depth classifier. LiteDB requires a writable property.</summary>
        public bool AnimaDepthClassified
        {
            get => animaDepthClassified;
            set => animaDepthClassified = value;
        }

        public string Title { get; set; }

        public string Author { get; set; }

        public string Description { get; set; }

        /// <summary>Preview data persisted in LiteDB. A projected row can resolve this field on first use.</summary>
        public string PreviewImage
        {
            get
            {
                Func<string> resolver = previewResolver;
                return resolver is null ? previewImage : resolver();
            }
            set
            {
                previewImage = value;
                previewResolver = null;
                persistedPreviewResolver = null;
            }
        }

        /// <summary>True when the user explicitly cleared the preview and adjacent fallback must remain disabled.</summary>
        public bool PreviewExplicitlyCleared { get; set; }

        /// <summary>Locally assigned preview value.</summary>
        private string previewImage;

        /// <summary>Deferred source for a projected cache row.</summary>
        [BsonIgnore]
        private volatile Func<string> previewResolver;

        /// <summary>Deferred raw cache field used only when persisting unrelated metadata edits.</summary>
        [BsonIgnore]
        private Func<string> persistedPreviewResolver;

        /// <summary>Defers the preview field without changing its public signature.</summary>
        internal void DeferPreview(Func<string> persistedResolver, Func<string> displayResolver)
        {
            previewImage = null;
            persistedPreviewResolver = persistedResolver;
            previewResolver = displayResolver;
        }

        /// <summary>Copies a deferred preview into the persistent property before a metadata upsert.</summary>
        internal void MaterializePreview()
        {
            string resolved = PreviewForPersistence();
            previewImage = resolved;
            previewResolver = null;
            persistedPreviewResolver = null;
        }

        /// <summary>Reads the exact saved preview without applying display limits or adjacent fallback.</summary>
        internal string PreviewForPersistence()
        {
            Func<string> resolver = persistedPreviewResolver;
            return resolver is null ? previewImage : resolver();
        }

        /// <summary>True when the persistent preview field was omitted from the loaded projection.</summary>
        internal bool PreviewIsDeferred => previewResolver is not null;

        /// <summary>Returns the local preview without invoking a deferred source.</summary>
        internal string LocalPreview => previewImage;

        public int StandardWidth { get; set; }

        public int StandardHeight { get; set; }

        public bool IsNegativeEmbedding { get; set; }

        public string LoraDefaultWeight { get; set; }

        public string LoraDefaultConfinement { get; set; }

        public string License { get; set; }

        public string UsageHint { get; set; }

        public string TriggerPhrase { get; set; }

        public string[] Tags { get; set; }

        public string MergedFrom { get; set; }

        public string Date { get; set; }

        public string Preprocessor { get; set; }

        /// <summary>Time this model was last modified.</summary>
        public long TimeModified { get; set; }

        /// <summary>Time this model was created.</summary>
        public long TimeCreated { get; set; }

        public string Hash { get; set; }

        public string PredictionType { get; set; }

        /// <summary>Special cache of what text encoders the model appears to contain. Primarily for SD3 which has optional text encoders.</summary>
        public string TextEncoders { get; set; }

        /// <summary>Special format indicators, such as "bnb_nf4".</summary>
        public string SpecialFormat { get; set; }
    }

    public T2IModelHandler()
    {
        Program.ModelRefreshEvent += Refresh;
    }

    public void Shutdown()
    {
        if (IsShutdown)
        {
            return;
        }
        IsShutdown = true;
        Program.ModelRefreshEvent -= Refresh;
        lock (MetadataLock)
        {
            foreach (ModelDatabase db in ModelMetadataCachePerFolder.Values)
            {
                db.Database.Dispose();
            }
            ModelMetadataCachePerFolder.Clear();
        }
    }


    /// <summary>Utility to destroy all stored metadata files.</summary>
    public void MassRemoveMetadata()
    {
        SpokeModePolicy.AssertModelTreeWriteAllowed("wipe model metadata");
        lock (MetadataLock)
        {
            foreach (ModelDatabase db in ModelMetadataCachePerFolder.Values)
            {
                try
                {
                    db.Database.Dispose();
                }
                catch (Exception) { }
            }
            ModelMetadataCachePerFolder.Clear();
            static void ClearFolder(string folder)
            {
                try
                {
                    if (File.Exists($"{folder}/model_metadata.ldb"))
                    {
                        File.Delete($"{folder}/model_metadata.ldb");
                    }
                    if (File.Exists($"{folder}/model_metadata-log.ldb"))
                    {
                        File.Delete($"{folder}/model_metadata-log.ldb");
                    }
                }
                catch (Exception) { }
                try
                {
                    foreach (string subFolder in Directory.GetDirectories(folder))
                    {
                        ClearFolder(subFolder);
                    }
                }
                catch (Exception) { }
            }
            foreach (string path in FolderPaths)
            {
                ClearFolder(path);
            }
            ClearFolder(Program.DataDir);
        }
    }

    public HashSet<string> AllModelNames => [.. Models.Keys, .. ModelsAPI.InternalExtraModels(ModelType).Keys];

    public List<T2IModel> ListModelsFor(Session session)
    {
        Dictionary<string, JObject> extra = ModelsAPI.InternalExtraModels(ModelType);
        List<string> names = ListModelNamesFor(session);
        return [.. names.Where(n => n != "(None)").Select(m => GetModel(m, extra))];
    }

    public List<string> ListModelNamesFor(Session session)
    {
        if (IsShutdown)
        {
            return [];
        }
        if (session is null || session.User.IsAllowedAllModels)
        {
            return ["(None)", .. AllModelNames];
        }
        return ["(None)", .. AllModelNames.Where(session.User.IsAllowedModel)];
    }

    public T2IModel GetModel(string name, Dictionary<string, JObject> extra = null)
    {
        if (Models.TryGetValue(name, out T2IModel model) || Models.TryGetValue(name + ".safetensors", out model))
        {
            return model;
        }
        extra ??= ModelsAPI.InternalExtraModels(ModelType);
        if (extra.TryGetValue(name, out JObject extraModelData) || extra.TryGetValue(name + ".safetensors", out extraModelData))
        {
            return T2IModel.FromNetObject(extraModelData);
        }
        return null;
    }

    /// <summary>Refresh the model list.</summary>
    public void Refresh()
    {
        LastRefreshSucceeded = false;
        if (IsShutdown)
        {
            return;
        }
        ConcurrentDictionary<string, T2IModel> previousModels = Models;
        ModelRefreshDiagnostics previousDiagnostics = ActiveRefreshDiagnostics.Value;
        ModelRefreshDiagnostics diagnostics = new();
        ActiveRefreshDiagnostics.Value = diagnostics;
        ConcurrentDictionary<string, T2IModel> newModels = new();
        bool hasUnscannableRoot = false;
        try
        {
            UnathorizedAccessSet.Clear();
            ScanErrorSet.Clear();
            bool refreshSucceeded = true;
            foreach (string path in FolderPaths)
            {
                if (!Directory.Exists(path) && !SpokeModePolicy.IsActive)
                {
                    try
                    {
                        SpokeModePolicy.AssertModelTreeWriteAllowed("create a model directory");
                        Directory.CreateDirectory(path);
                    }
                    catch (Exception ex)
                    {
                        refreshSucceeded = false;
                        hasUnscannableRoot = true;
                        ScanErrorSet.Enqueue(path);
                        Logs.Error($"Failed to create configured {ModelType} model directory '{path}': {ex.ReadableString()}");
                        continue;
                    }
                }
                if (!Directory.Exists(path))
                {
                    refreshSucceeded = false;
                    hasUnscannableRoot = true;
                    ScanErrorSet.Enqueue(path);
                    Logs.Error($"Configured {ModelType} model directory '{path}' does not exist and was not scanned.");
                    continue;
                }
                ConcurrentDictionary<string, T2IModel> rootModels = new();
                int unauthorizedBefore = UnathorizedAccessSet.Count;
                int scanErrorsBefore = ScanErrorSet.Count;
                try
                {
                    AddAllFromFolder(path, "", rootModels, newModels);
                }
                catch (UnauthorizedAccessException)
                {
                    hasUnscannableRoot = true;
                    UnathorizedAccessSet.Enqueue(path);
                }
                catch (Exception ex)
                {
                    hasUnscannableRoot = true;
                    ScanErrorSet.Enqueue(path);
                    Logs.Warning($"Error while scanning {ModelType} model root '{path}': {ex.ReadableString()}");
                }
                if (UnathorizedAccessSet.Count != unauthorizedBefore || ScanErrorSet.Count != scanErrorsBefore)
                {
                    refreshSucceeded = false;
                }
                foreach (KeyValuePair<string, T2IModel> entry in rootModels)
                {
                    if (newModels.TryGetValue(entry.Key, out T2IModel existingModel))
                    {
                        lock (existingModel.OtherPaths)
                        {
                            existingModel.OtherPaths.Add(entry.Value.RawFilePath);
                            existingModel.OtherPaths.AddRange(entry.Value.OtherPaths);
                        }
                    }
                    else
                    {
                        newModels[entry.Key] = entry.Value;
                    }
                }
            }
            lock (ModificationLock)
            {
                Models = hasUnscannableRoot && !previousModels.IsEmpty ? previousModels : newModels;
                LastRefreshSucceeded = refreshSucceeded;
            }
            Logs.Debug($"Have {Models.Count} {ModelType} models.");
            T2IModel[] dupped = [.. Models.Values.Where(m => m.OtherPaths.Count > 0)];
            if (dupped.Length > 0)
            {
                Logs.Debug($"There are {dupped.Length} {ModelType} models that have exactly matched filenames across different folders: '{dupped[0].RawFilePath}' is also stored in '{dupped[0].OtherPaths.JoinString("', '")}'");
            }
            if (UnathorizedAccessSet.Any())
            {
                Logs.Warning($"Got UnauthorizedAccessException while loading {ModelType} model paths: {UnathorizedAccessSet.Select(m => $"'{m}'").JoinString(", ")}");
                UnathorizedAccessSet.Clear();
            }
            ScanErrorSet.Clear();
        }
        catch (Exception e)
        {
            lock (ModificationLock)
            {
                Models = previousModels.IsEmpty ? newModels : previousModels;
                LastRefreshSucceeded = false;
            }
            Logs.Error($"Error while refreshing {ModelType} models: {e}");
        }
        finally
        {
            Logs.Info($"Model refresh diagnostics ({ModelType}): {diagnostics.Summary}");
            ActiveRefreshDiagnostics.Value = previousDiagnostics;
        }
    }

    /// <summary>Get (or create) the metadata cache for a given model folder.</summary>
    public ModelDatabase GetCacheForFolder(string folder)
    {
        lock (MetadataLock)
        {
            try
            {
                folder = SpokeModePolicy.IsActive ? Program.DataDir : folder;
                string fileName = SpokeModePolicy.IsActive ? SpokeModelMetadata.CacheFileName : "model_metadata.ldb";
                return ModelMetadataCachePerFolder.GetOrCreate($"{folder}/{fileName}", () =>
                {
                    string path = $"{folder}/{fileName}";
                    LiteDatabase ldb;
                    try
                    {
                        ldb = new(path);
                    }
                    catch (Exception ex)
                    {
                        Logs.Verbose($"Failed to read Lite Database for '{folder}' and will reset it: {ex}");
                        File.Delete(path);
                        ldb = new(path);
                    }
                    return new(folder, this, ldb, ldb.GetCollection<ModelMetadataStore>("models"), fileName);
                });
            }
            catch (Exception ex)
            {
                Logs.Warning($"Internal error, some model metadata caches will be missing or invalid, see debug log for details.");
                Logs.Debug($"Failed to read Lite Database for '{folder}' and cannot reset it: {ex}");
                return null;
            }
        }
    }

    /// <summary>Updates the metadata cache database to the metadata assigned to this model object.</summary>
    public void ResetMetadataFrom(T2IModel model)
    {
        if (Program.NoPersist)
        {
            return;
        }
        ModelDatabase cache = null;
        try
        {
            bool perFolder = !SpokeModePolicy.IsActive && Program.ServerSettings.Metadata.ModelMetadataPerFolder;
            long modified = ((DateTimeOffset)File.GetLastWriteTimeUtc(model.RawFilePath)).ToUnixTimeMilliseconds();
            string folder = model.RawFilePath.Replace('\\', '/').BeforeAndAfterLast('/', out string fileName);
            cache = GetCacheForFolder(perFolder ? folder : Program.DataDir);
            if (cache is null)
            {
                return;
            }
            lock (ModificationLock)
            {
                model.Metadata ??= new();
                ModelMetadataStore metadata = model.Metadata;
                metadata.ModelFileVersion = modified;
                metadata.ModelName = perFolder ? fileName : model.RawFilePath;
                metadata.Title = model.Title;
                metadata.Description = model.Description;
                if (model.ModelClass is not null)
                {
                    metadata.ModelClassType = model.ModelClass.ID;
                }
                metadata.StandardWidth = model.StandardWidth;
                metadata.StandardHeight = model.StandardHeight;
                metadata.SidecarFileVersion = ReadSwarmSidecarVersion(model);
                metadata.SidecarVersionKnown = true;
                if (!SpokeModePolicy.IsActive)
                {
                    metadata.MaterializePreview();
                }
                lock (MetadataLock)
                {
                    SpokeModelMetadata.TrimForSpoke(metadata);
                    cache.Metadata.Upsert(metadata);
                }
                InvalidateResolvedPreview(model);
                if (!SpokeModePolicy.IsActive)
                {
                    string previewKey = PreviewCacheKey(cache, metadata.ModelName);
                    model.DeferredPreviewKey = previewKey;
                    model.PreviewImage = PlaceholderPreviewImage;
                    metadata.DeferPreview(() => ResolvePersistedPreview(cache, metadata.ModelName), () => ResolveDeferredPreview(model, metadata, cache, metadata.ModelName, previewKey));
                }
            }
        }
        catch (Exception ex)
        {
            Logs.Error($"Failed to reset metadata for model '{model.RawFilePath}': {ex.ReadableString()}");
            cache?.HadNewError();
            throw;
        }
    }

    public static readonly string[] AutoImageFormatSuffixes = [".jpg", ".png", ".preview.png", ".preview.jpg", ".jpeg", ".preview.jpeg", ".thumb.jpg", ".thumb.png", ".preview.webp"];

    /// <summary>Placeholder stored when a model has no preview image.</summary>
    public const string PlaceholderPreviewImage = "imgs/model_placeholder.jpg";

    /// <summary>Maximum accepted preview payload, matching the header-image guard in <see cref="LoadMetadata"/>.</summary>
    public const int MaxPreviewDataLength = 1024 * 1024 * 8;

    /// <summary>Builds the cache identity used for a deferred preview.</summary>
    private static string PreviewCacheKey(ModelDatabase cache, string modelCacheId)
    {
        return $"{cache.Folder}/{cache.FileName}\0{modelCacheId}";
    }

    /// <summary>Loads metadata without parsing or mapping the potentially large preview field.</summary>
    private static ModelMetadataStore FindMetadataWithoutPreview(ModelDatabase cache, string modelCacheId)
    {
        BsonMapper mapper = cache.Database.Mapper;
        BsonDocument document = MetadataLookupQuery(cache, modelCacheId).FirstOrDefault();
        return document is null ? null : mapper.ToObject<ModelMetadataStore>(document);
    }

    /// <summary>Builds an indexed preview-free query. Exposed internally for focused query-plan tests.</summary>
    internal static ILiteQueryableResult<BsonDocument> MetadataLookupQuery(ModelDatabase cache, string modelCacheId)
    {
        // Keep the expression source constant so LiteDB can reuse it across model IDs.
        return cache.Metadata.Query().Where("_id=@0", new BsonValue[] { modelCacheId }).Select(MetadataProjectionFor(cache.Database.Mapper));
    }

    /// <summary>Returns the one compiled preview-free projection retained for a LiteDB mapper.</summary>
    internal static BsonExpression MetadataProjectionFor(BsonMapper mapper)
    {
        return MetadataProjections.GetValue(mapper, current => current.GetExpression(MetadataProjectionSource));
    }

    /// <summary>Reads only the saved preview field for one cache row.</summary>
    private static string FindCachedPreview(ModelDatabase cache, string modelCacheId)
    {
        return cache.Metadata.Query().Where(metadata => metadata.ModelName == modelCacheId).Select(metadata => metadata.PreviewImage).FirstOrDefault();
    }

    /// <summary>Reads one raw persisted preview field under the metadata lock.</summary>
    private string ResolvePersistedPreview(ModelDatabase cache, string modelCacheId)
    {
        lock (MetadataLock)
        {
            return FindCachedPreview(cache, modelCacheId);
        }
    }

    /// <summary>Reads the persisted preview for one loaded model without applying adjacent-image fallback.</summary>
    private string FindPersistedPreview(T2IModel model)
    {
        if (model.Metadata is null)
        {
            return null;
        }
        if (!model.Metadata.PreviewIsDeferred)
        {
            return model.Metadata.LocalPreview;
        }
        bool perFolder = !SpokeModePolicy.IsActive && Program.ServerSettings.Metadata.ModelMetadataPerFolder;
        string folder = model.RawFilePath.Replace('\\', '/').BeforeAndAfterLast('/', out string fileName);
        ModelDatabase cache = GetCacheForFolder(perFolder ? folder : Program.DataDir);
        if (cache is null)
        {
            return null;
        }
        string modelCacheId = perFolder ? fileName : model.RawFilePath;
        lock (MetadataLock)
        {
            return FindCachedPreview(cache, modelCacheId);
        }
    }

    /// <summary>Returns a recently resolved preview and promotes it in LRU order.</summary>
    private bool TryGetResolvedPreview(string key, out string preview)
    {
        lock (PreviewCacheLock)
        {
            if (!ResolvedPreviews.TryGetValue(key, out LinkedListNode<ResolvedPreview> node))
            {
                preview = null;
                return false;
            }
            ResolvedPreviewOrder.Remove(node);
            ResolvedPreviewOrder.AddFirst(node);
            preview = node.Value.Value;
            return true;
        }
    }

    /// <summary>Adds a resolved preview only when no invalidation happened while its source load ran.</summary>
    private void RememberResolvedPreview(string key, string preview, long generation)
    {
        if (!PreviewDataAcceptable(preview))
        {
            return;
        }
        lock (PreviewCacheLock)
        {
            if (PreviewCacheGeneration != generation)
            {
                return;
            }
            if (ResolvedPreviews.Remove(key, out LinkedListNode<ResolvedPreview> oldNode))
            {
                ResolvedPreviewOrder.Remove(oldNode);
                ResolvedPreviewCharacters -= oldNode.Value.Value.Length;
            }
            LinkedListNode<ResolvedPreview> node = ResolvedPreviewOrder.AddFirst(new ResolvedPreview(key, preview));
            ResolvedPreviews[key] = node;
            ResolvedPreviewCharacters += preview.Length;
            while (ResolvedPreviews.Count > ResolvedPreviewEntryLimit || ResolvedPreviewCharacters * sizeof(char) > ResolvedPreviewByteLimit)
            {
                LinkedListNode<ResolvedPreview> last = ResolvedPreviewOrder.Last;
                if (last is null)
                {
                    break;
                }
                ResolvedPreviewOrder.RemoveLast();
                ResolvedPreviews.Remove(last.Value.Key);
                ResolvedPreviewCharacters -= last.Value.Value.Length;
            }
        }
    }

    /// <summary>Removes any retained preview for a model after cache or preview changes.</summary>
    internal void InvalidateResolvedPreview(T2IModel model)
    {
        string key = model?.DeferredPreviewKey;
        if (key is null)
        {
            return;
        }
        lock (PreviewCacheLock)
        {
            if (ResolvedPreviews.Remove(key, out LinkedListNode<ResolvedPreview> node))
            {
                ResolvedPreviewOrder.Remove(node);
                ResolvedPreviewCharacters -= node.Value.Value.Length;
            }
            PreviewCacheGeneration++;
            PreviewLoads.TryRemove(key, out _);
        }
    }

    /// <summary>Resolves one preview from the saved cache field, then from adjacent image files.</summary>
    private string ResolveDeferredPreview(T2IModel model, ModelMetadataStore metadata, ModelDatabase cache, string modelCacheId, string key)
    {
        if (TryGetResolvedPreview(key, out string preview))
        {
            return preview;
        }
        long generation;
        Lazy<string> load;
        lock (PreviewCacheLock)
        {
            if (ResolvedPreviews.TryGetValue(key, out LinkedListNode<ResolvedPreview> existing))
            {
                ResolvedPreviewOrder.Remove(existing);
                ResolvedPreviewOrder.AddFirst(existing);
                return existing.Value.Value;
            }
            generation = PreviewCacheGeneration;
            load = PreviewLoads.GetOrAdd(key, _ => new Lazy<string>(() =>
            {
                Interlocked.Increment(ref DeferredPreviewLoadCount);
                string saved;
                lock (MetadataLock)
                {
                    saved = FindCachedPreview(cache, modelCacheId);
                }
                if (!PreviewImageMissing(saved))
                {
                    return saved;
                }
                return metadata.PreviewExplicitlyCleared ? null : GetAutoFormatImage(model);
            }, LazyThreadSafetyMode.ExecutionAndPublication));
        }
        try
        {
            preview = load.Value;
            RememberResolvedPreview(key, preview, generation);
            return preview;
        }
        finally
        {
            ((ICollection<KeyValuePair<string, Lazy<string>>>)PreviewLoads).Remove(new KeyValuePair<string, Lazy<string>>(key, load));
        }
    }

    /// <summary>Resolves one legacy adjacent preview with the same coalescing and bounds as cached previews.</summary>
    private string ResolveAdjacentPreview(T2IModel model, string key)
    {
        if (TryGetResolvedPreview(key, out string preview))
        {
            return preview;
        }
        long generation;
        Lazy<string> load;
        lock (PreviewCacheLock)
        {
            if (ResolvedPreviews.TryGetValue(key, out LinkedListNode<ResolvedPreview> existing))
            {
                ResolvedPreviewOrder.Remove(existing);
                ResolvedPreviewOrder.AddFirst(existing);
                return existing.Value.Value;
            }
            generation = PreviewCacheGeneration;
            load = PreviewLoads.GetOrAdd(key, _ => new Lazy<string>(() =>
            {
                Interlocked.Increment(ref DeferredPreviewLoadCount);
                return GetAutoFormatImage(model);
            }, LazyThreadSafetyMode.ExecutionAndPublication));
        }
        try
        {
            preview = load.Value;
            RememberResolvedPreview(key, preview, generation);
            return preview;
        }
        finally
        {
            ((ICollection<KeyValuePair<string, Lazy<string>>>)PreviewLoads).Remove(new KeyValuePair<string, Lazy<string>>(key, load));
        }
    }

    /// <summary>How many updated model names <see cref="RefreshMissingPreviews"/> returns.</summary>
    public const int PreviewRefreshNameLimit = 50;

    public static readonly string[] AltModelMetadataJsonFileSuffixes = [".swarm.json", ".json", ".cm-info.json", ".civitai.info"];

    public static readonly string[] AllModelAttachedExtensions = [.. AutoImageFormatSuffixes.Concat(AltModelMetadataJsonFileSuffixes)];

    public static readonly string[] AltMetadataDescriptionKeys = ["VersionName", "VersionDescription", "ModelDescription", "description"];

    public static readonly string[] AltMetadataTriggerWordsKeys = ["TrainedWords", "trainedWords", "ss_tag_frequency"];

    public static readonly string[] AltMetadataNameKeys = ["UserTitle", "ModelName", "name"];

    /// <summary>Path prefix shared by a model's sidecars and adjacent preview files.</summary>
    public static string ModelAttachmentPrefix(T2IModel model)
    {
        return $"{model.OriginatingFolderPath}/{model.Name.BeforeLast('.')}";
    }

    /// <summary>Full path of the <c>.swarm.json</c> sidecar next to this model.</summary>
    public static string SwarmSidecarPath(T2IModel model)
    {
        return ModelAttachmentPrefix(model) + ".swarm.json";
    }

    /// <summary>Full path of the preview JPEG written beside the model's primary file.</summary>
    public static string PreviewJpegPath(T2IModel model)
    {
        return model.RawFilePath.Replace('\\', '/').BeforeLast('.') + ".preview.jpeg";
    }

    /// <summary>True when the cached preview is missing or still the placeholder.</summary>
    public static bool PreviewImageMissing(string preview)
    {
        return string.IsNullOrWhiteSpace(preview) || preview == PlaceholderPreviewImage;
    }

    /// <summary>True when a preview data string is present and within <see cref="MaxPreviewDataLength"/>.</summary>
    public static bool PreviewDataAcceptable(string preview)
    {
        return !string.IsNullOrWhiteSpace(preview) && preview.Length <= MaxPreviewDataLength;
    }

    /// <summary>Unix-millisecond mtime of <c>.swarm.json</c>, or 0 when the file is absent. Does not create or modify the file.</summary>
    public static long ReadSwarmSidecarVersion(T2IModel model)
    {
        string path = SwarmSidecarPath(model);
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return 0;
        }
        return new DateTimeOffset(File.GetLastWriteTimeUtc(path)).ToUnixTimeMilliseconds();
    }

    /// <summary>Loads the first adjacent preview that exists and fits the metadata size limit.</summary>
    public string GetAutoFormatImage(T2IModel model)
    {
        long started = Stopwatch.GetTimestamp();
        try
        {
            return ReadAutoFormatImage(model);
        }
        finally
        {
            ActiveRefreshDiagnostics.Value?.RecordPreviewAttempt(Stopwatch.GetTimestamp() - started);
        }
    }

    /// <summary>Reads the first usable adjacent preview without changing saved metadata.</summary>
    private string ReadAutoFormatImage(T2IModel model)
    {
        if (SpokeModePolicy.IsActive)
        {
            return null;
        }
        string prefix = ModelAttachmentPrefix(model);
        foreach (string suffix in AutoImageFormatSuffixes)
        {
            string path = prefix + suffix;
            try
            {
                FileInfo info = new(path);
                if (!info.Exists)
                {
                    continue;
                }
                if (info.Length > MaxPreviewDataLength)
                {
                    Logs.Warning($"Ignoring preview '{path}' as it is too large (over {info.Length / 1024 / 1024} megabytes)!");
                    continue;
                }
                ImageFile loaded = new Image(File.ReadAllBytes(path), MediaType.GetByExtension(suffix.AfterLast('.')));
                string formatted = loaded.ToMetadataFormat();
                if (!PreviewDataAcceptable(formatted))
                {
                    Logs.Warning($"Ignoring preview '{path}' as it is too large after encoding.");
                    continue;
                }
                return formatted;
            }
            catch (Exception ex)
            {
                Logs.Error($"Caught an exception trying to load legacy model thumbnail at '{path}'");
                Logs.Debug($"Details for above error {ex.ReadableString()}");
            }
        }
        return null;
    }

    /// <summary>Read a model header and record elapsed work, including failed reads.</summary>
    private JObject ReadHeaderForDiagnostics(T2IModel model)
    {
        long started = Stopwatch.GetTimestamp();
        try
        {
            return SpokeModePolicy.IsActive ? SpokeModelMetadata.ReadHeader(model.RawFilePath) : T2IModel.GetMetadataHeaderFrom(model.RawFilePath);
        }
        finally
        {
            ActiveRefreshDiagnostics.Value?.RecordHeaderRead(Stopwatch.GetTimestamp() - started);
        }
    }

    /// <summary>True when a known sidecar mtime no longer matches the file. Legacy rows (version not yet recorded) are not stale.</summary>
    public static bool SidecarRequiresRebuild(T2IModel model, ModelMetadataStore metadata)
    {
        if (metadata is null || !metadata.SidecarVersionKnown)
        {
            return false;
        }
        return metadata.SidecarFileVersion != ReadSwarmSidecarVersion(model);
    }

    /// <summary>Check sidecar freshness and record aggregate work for the active refresh or synthetic tests.</summary>
    internal static bool SidecarRequiresRebuild(T2IModel model, ModelMetadataStore metadata, ModelRefreshDiagnostics diagnostics)
    {
        if (diagnostics is null)
        {
            return SidecarRequiresRebuild(model, metadata);
        }
        long started = Stopwatch.GetTimestamp();
        bool stale = false;
        try
        {
            stale = SidecarRequiresRebuild(model, metadata);
            return stale;
        }
        finally
        {
            diagnostics.RecordSidecarCheck(stale, Stopwatch.GetTimestamp() - started);
        }
    }

    /// <summary>Records the current sidecar mtime on a legacy row. Returns true when the row changed.</summary>
    private static bool NoteLegacySidecarVersion(T2IModel model, ModelMetadataStore metadata)
    {
        if (metadata.SidecarVersionKnown)
        {
            return false;
        }
        metadata.SidecarFileVersion = ReadSwarmSidecarVersion(model);
        metadata.SidecarVersionKnown = true;
        return true;
    }

    /// <summary>Upserts one metadata row. Does not write the model file or any sidecar.</summary>
    private void UpsertCached(ModelDatabase cache, ModelMetadataStore metadata)
    {
        if (cache is null || metadata is null)
        {
            return;
        }
        if (!SpokeModePolicy.IsActive)
        {
            metadata.MaterializePreview();
        }
        lock (MetadataLock)
        {
            try
            {
                SpokeModelMetadata.TrimForSpoke(metadata);
                cache.Metadata.Upsert(metadata);
            }
            catch (Exception ex)
            {
                Logs.Warning($"Error updating metadata cache: {ex.ReadableString()}");
                cache.HadNewError();
            }
        }
    }

    /// <summary>Fills blank previews from adjacent image files and stores them in the metadata cache only.</summary>
    /// <param name="pathPrefix">Empty, or a case-sensitive prefix of the model name. <c>folder</c> matches <c>folder/a.safetensors</c>.</param>
    /// <param name="exactName">When set, only this model name is examined.</param>
    /// <param name="allowed">Permission check. Null allows every name.</param>
    /// <param name="nameLimit">Maximum number of updated names to keep.</param>
    public PreviewRefreshCounts RefreshMissingPreviews(string pathPrefix, string exactName, Func<string, bool> allowed, int nameLimit)
    {
        PreviewRefreshCounts counts = new();
        string prefix = (pathPrefix ?? "").Replace('\\', '/').Trim().TrimEnd('/');
        string exact = (exactName ?? "").Replace('\\', '/').Trim();
        if (nameLimit < 0)
        {
            nameLimit = 0;
        }
        T2IModel[] models = [.. Models.Values];
        foreach (T2IModel model in models)
        {
            if (!string.IsNullOrEmpty(exact) && model.Name != exact)
            {
                continue;
            }
            if (!string.IsNullOrEmpty(prefix) && (model.Name is null || !model.Name.StartsWithFast(prefix)))
            {
                continue;
            }
            if (allowed is not null && !allowed(model.Name))
            {
                continue;
            }
            counts.Checked++;
            if (model.Metadata is null || !PreviewImageMissing(FindPersistedPreview(model)))
            {
                continue;
            }
            string autoImg = GetAutoFormatImage(model);
            if (!PreviewDataAcceptable(autoImg))
            {
                continue;
            }
            lock (ModificationLock)
            {
                model.PreviewImage = autoImg;
                model.Metadata.PreviewImage = autoImg;
                model.Metadata.PreviewExplicitlyCleared = false;
            }
            ResetMetadataFrom(model);
            counts.Updated++;
            if (counts.Names.Count < nameLimit)
            {
                counts.Names.Add(model.Name);
            }
        }
        return counts;
    }

    /// <summary>Writes a JPEG preview beside the model and stores it in the metadata cache. Does not resave the model or any JSON sidecar.</summary>
    public string StorePreviewJpeg(T2IModel model, ImageFile image)
    {
        if (model is null || string.IsNullOrWhiteSpace(model.RawFilePath))
        {
            throw new SwarmReadableErrorException("Model not found.");
        }
        if (image is null)
        {
            throw new SwarmReadableErrorException("Could not read that image.");
        }
        ImageFile jpg = image.ToMetadataJpg();
        if (jpg is null || jpg.RawData is null || jpg.RawData.Length == 0)
        {
            throw new SwarmReadableErrorException("Could not read that image.");
        }
        string data = jpg.AsDataString();
        if (!PreviewDataAcceptable(data))
        {
            throw new SwarmReadableErrorException("Preview image is too large.");
        }
        string previewPath = PreviewJpegPath(model);
        string modelPath = model.RawFilePath.Replace('\\', '/');
        if (!previewPath.EndsWithFast(".preview.jpeg") || previewPath == modelPath)
        {
            throw new SwarmReadableErrorException("Refusing to overwrite the model file.");
        }
        File.WriteAllBytes(previewPath, jpg.RawData);
        lock (ModificationLock)
        {
            model.Metadata ??= new();
            model.PreviewImage = data;
            model.Metadata.PreviewImage = data;
            model.Metadata.PreviewExplicitlyCleared = false;
        }
        ResetMetadataFrom(model);
        return data;
    }

    /// <summary>Counts from <see cref="RefreshMissingPreviews"/>.</summary>
    public class PreviewRefreshCounts
    {
        /// <summary>Models that matched the filter and were examined.</summary>
        public int Checked;

        /// <summary>Models whose blank preview was filled from an adjacent image.</summary>
        public int Updated;

        /// <summary>Names of updated models, capped by the caller.</summary>
        public List<string> Names = [];
    }

    /// <summary>Model compat-class IDs that have variable text encoder content.</summary>
    public static HashSet<string> VariableTextEncModelClasses = ["stable-diffusion-v3-medium", "stable-diffusion-v3.5-large", "stable-diffusion-v3.5-medium", "flux-1"];

    /// <summary>Reclassifies a same-version legacy Anima entry once, preserving all other saved metadata.</summary>
    private void UpgradeAnimaMetadata(T2IModel model, ModelMetadataStore metadata, ModelDatabase cache)
    {
        string id = (metadata.ModelClassType ?? "").ToLowerFast();
        id = T2IModelClassSorter.Remaps.GetValueOrDefault(id, id);
        if (metadata.AnimaDepthClassified || (id != "anima" && id != "anima/lora" && id != "anima/controlnet"))
        {
            return;
        }
        JObject header = new();
        if (model.Name.EndsWith(".safetensors") || model.Name.EndsWith(".sft") || model.Name.EndsWith(".gguf"))
        {
            header = ReadHeaderForDiagnostics(model);
        }
        JObject metaHeader = header["__metadata__"] as JObject ?? [];
        string prefix = $"{model.OriginatingFolderPath}/{model.Name.BeforeLast('.')}";
        foreach (string suffix in AltModelMetadataJsonFileSuffixes)
        {
            if (File.Exists(prefix + suffix))
            {
                JObject sidecar = SpokeModePolicy.IsActive ? SpokeModelMetadata.ReadSidecar(prefix + suffix) : File.ReadAllText(prefix + suffix).ParseToJson();
                foreach (JProperty property in sidecar.Properties())
                {
                    metaHeader[property.Name] = property.Value;
                    header[property.Name] = property.Value;
                }
            }
        }
        metadata.ModelClassType = T2IModelClassSorter.IdentifyClassFor(model, header, ModelType)?.ID ?? metadata.ModelClassType;
        metadata.AnimaDepthClassified = true;
        if (!SpokeModePolicy.IsActive)
        {
            metadata.MaterializePreview();
        }
        lock (MetadataLock)
        {
            try
            {
                SpokeModelMetadata.TrimForSpoke(metadata);
                cache.Metadata.Upsert(metadata);
            }
            catch (Exception ex)
            {
                Logs.Warning($"Error updating Anima metadata cache: {ex.ReadableString()}");
                cache.HadNewError();
            }
        }
    }

    /// <summary>Force-load the metadata for a model.</summary>
    public void LoadMetadata(T2IModel model)
    {
        if (model is null)
        {
            Logs.Warning($"Tried to load metadata for a null model?:\n{Environment.StackTrace}");
            return;
        }
        if (model.ModelClass is not null || (model.Title is not null && model.Title != model.Name.AfterLast('/')))
        {
            Logs.Debug($"Not loading metadata for {model.Name} as it is already loaded.");
            return;
        }
        string folder = model.RawFilePath.Replace('\\', '/').BeforeAndAfterLast('/', out string fileName);
        long modified = new DateTimeOffset(File.GetLastWriteTimeUtc(model.RawFilePath)).ToUnixTimeMilliseconds();
        bool perFolder = !SpokeModePolicy.IsActive && Program.ServerSettings.Metadata.ModelMetadataPerFolder;
        long cacheAcquireStarted = Stopwatch.GetTimestamp();
        ModelDatabase cache = GetCacheForFolder(perFolder ? folder : Program.DataDir);
        ActiveRefreshDiagnostics.Value?.RecordCacheOpen(Stopwatch.GetTimestamp() - cacheAcquireStarted);
        if (cache is null)
        {
            return;
        }
        ModelMetadataStore metadata;
        string modelCacheId = perFolder ? fileName : model.RawFilePath;
        string previewKey = PreviewCacheKey(cache, modelCacheId);
        long cacheLockStarted = Stopwatch.GetTimestamp();
        long cacheLockWaitTicks;
        long cacheWorkTicks;
        lock (MetadataLock)
        {
            cacheLockWaitTicks = Stopwatch.GetTimestamp() - cacheLockStarted;
            long cacheWorkStarted = Stopwatch.GetTimestamp();
            try
            {
                metadata = FindMetadataWithoutPreview(cache, modelCacheId);
            }
            catch (Exception ex)
            {
                Logs.Debug($"Failed to load metadata for {model.Name} from cache:\n{ex.ReadableString()}");
                metadata = null;
            }
            cacheWorkTicks = Stopwatch.GetTimestamp() - cacheWorkStarted;
        }
        if (metadata is not null && !SpokeModePolicy.IsActive)
        {
            model.DeferredPreviewKey = previewKey;
            metadata.DeferPreview(() => ResolvePersistedPreview(cache, modelCacheId), () => ResolveDeferredPreview(model, metadata, cache, modelCacheId, previewKey));
        }
        bool staleModel = metadata is not null && metadata.ModelFileVersion != modified;
        ActiveRefreshDiagnostics.Value?.RecordCacheLookup(metadata is not null, staleModel, cacheLockWaitTicks, cacheWorkTicks);
        if (metadata is not null && metadata.TextEncoders is null && VariableTextEncModelClasses.Contains(metadata.ModelClassType))
        {
            metadata = null;
        }
        bool staleSidecar = false;
        if (metadata is not null && metadata.ModelFileVersion == modified)
        {
            staleSidecar = SidecarRequiresRebuild(model, metadata, ActiveRefreshDiagnostics.Value);
        }
        if (staleSidecar)
        {
            metadata = null;
        }
        if (metadata is null || metadata.ModelFileVersion != modified)
        {
            long rebuildStarted = Stopwatch.GetTimestamp();
            JObject headerData = [];
            JObject metaHeader = [];
            string textEncs = null;
            if (model.Name.EndsWith(".safetensors") || model.Name.EndsWith(".sft") || model.Name.EndsWith(".gguf"))
            {
                headerData = ReadHeaderForDiagnostics(model);
                if (headerData is not null)
                {
                    metaHeader = headerData["__metadata__"] as JObject ?? [];
                    textEncs = "";
                    string[] keys = [.. headerData.Properties().Select(p => p.Name).Where(k => k.StartsWith("text_encoders."))];
                    if (keys.Any(k => k.StartsWith("text_encoders.clip_g."))) { textEncs += "clip_g,"; }
                    if (keys.Any(k => k.StartsWith("text_encoders.clip_l."))) { textEncs += "clip_l,"; }
                    if (keys.Any(k => k.StartsWith("text_encoders.t5xxl."))) { textEncs += "t5xxl,"; }
                    textEncs = textEncs.TrimEnd(',');
                }
            }
            string altModelPrefix = $"{model.OriginatingFolderPath}/{model.Name.BeforeLast('.')}";
            foreach (string altSuffix in AltModelMetadataJsonFileSuffixes)
            {
                if (File.Exists(altModelPrefix + altSuffix))
                {
                    JObject altMetadata = SpokeModePolicy.IsActive ? SpokeModelMetadata.ReadSidecar(altModelPrefix + altSuffix) : File.ReadAllText(altModelPrefix + altSuffix).ParseToJson();
                    foreach (JProperty prop in altMetadata.Properties())
                    {
                        metaHeader[prop.Name] = prop.Value;
                        headerData[prop.Name] = prop.Value;
                    }
                }
            }
            if (metaHeader.Count == 0)
            {
                Logs.Debug($"Not loading metadata for {model.Name} as it lacks a proper header (path='{altModelPrefix}').");
            }
            string altDescription = "", altName = null;
            HashSet<string> triggerPhrases = [];
            void procAltHeader(JObject altMetadata)
            {
                if (altMetadata.TryGetValue("model", out JToken modelSection) && modelSection is JObject modelSectionObj && modelSectionObj.TryGetValue("name", out JToken subNameTok))
                {
                    altName ??= subNameTok.Value<string>();
                }
                foreach (string nameKey in AltMetadataNameKeys)
                {
                    if (altMetadata.TryGetValue(nameKey, out JToken nameTok) && nameTok.Type != JTokenType.Null)
                    {
                        altName ??= nameTok.Value<string>();
                    }
                }
                foreach (string descKey in AltMetadataDescriptionKeys)
                {
                    if (altMetadata.TryGetValue(descKey, out JToken descTok) && descTok.Type != JTokenType.Null)
                    {
                        altDescription += descTok.Value<string>() + "\n";
                    }
                }
                if (Program.ServerSettings.Paths.UseSecondaryTriggerPhraseSources)
                {
                    foreach (string wordsKey in AltMetadataTriggerWordsKeys)
                    {
                        static string[] procWordsFrom(JToken tok)
                        {
                            if (tok.Type == JTokenType.Array)
                            {
                                return tok.ToObject<string[]>();
                            }
                            else if (tok is JObject jobj)
                            {
                                IEnumerable<string[]> wordSets = jobj.Properties().Select(p => p.Value is JObject subData ? procWordsFrom(subData) : [p.Name]);
                                return [.. wordSets.Flatten()];
                            }
                            else if (tok.Type == JTokenType.String)
                            {
                                string trainedWordsTok = tok.Value<string>();
                                if (trainedWordsTok.StartsWithFast('{') && trainedWordsTok.EndsWithFast('}'))
                                {
                                    try
                                    {
                                        return procWordsFrom(trainedWordsTok.ParseToJson());
                                    }
                                    catch (Exception) { } // Ignored
                                }
                                return trainedWordsTok.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
                            }
                            return null;
                        }
                        if (triggerPhrases.IsEmpty() && altMetadata.TryGetValue(wordsKey, out JToken wordsTok) && wordsTok.Type != JTokenType.Null)
                        {
                            string[] trainedWords = procWordsFrom(wordsTok);
                            if (trainedWords is not null && trainedWords.Length > 0)
                            {
                                triggerPhrases.UnionWith(trainedWords);
                            }
                        }
                    }
                }
                if (triggerPhrases.IsEmpty() && altMetadata.TryGetValue("activation text", out JToken actTok) && actTok.Type != JTokenType.Null)
                {
                    triggerPhrases.Add(actTok.Value<string>());
                }
            }
            procAltHeader(metaHeader);
            foreach (string altSuffix in AltModelMetadataJsonFileSuffixes)
            {
                if (File.Exists(altModelPrefix + altSuffix))
                {
                    JObject altMetadata = SpokeModePolicy.IsActive ? SpokeModelMetadata.ReadSidecar(altModelPrefix + altSuffix) : File.ReadAllText(altModelPrefix + altSuffix).ParseToJson();
                    procAltHeader(altMetadata);
                }
            }
            string altTriggerPhrase = triggerPhrases.JoinString(", ");
            T2IModelClass clazz = T2IModelClassSorter.IdentifyClassFor(model, headerData, ModelType);
            string specialFormat = null;
            foreach (string key in headerData.Properties().Select(p => p.Name))
            {
                if (key.Contains("bitsandbytes__nf4"))
                {
                    specialFormat = "bnb_nf4";
                    break;
                }
                if (key.Contains("bitsandbytes__fp4"))
                {
                    specialFormat = "bnb_fp4";
                    break;
                }
                if (key.EndsWith(".scale_weight") || key.EndsWith(".weight_scale"))
                {
                    specialFormat = "fp8_scaled";
                    break;
                }
                if (key.EndsWith(".wscales"))
                {
                    specialFormat = "nunchaku";
                    break;
                }
                if (key.EndsWith(".wtscale"))
                {
                    specialFormat = "nunchaku-fp4";
                    break;
                }
            }
            if (model.Name.EndsWith(".gguf"))
            {
                specialFormat = "gguf";
            }
            if (model.Name.EndsWith("/transformer_blocks.safetensors") && File.Exists(model.RawFilePath.Replace('\\', '/').BeforeLast('/') + "/comfy_config.json"))
            {
                specialFormat = "nunchaku";
                if (headerData.ContainsKey("single_transformer_blocks.0.mlp_fc1.wtscale"))
                {
                    specialFormat = "nunchaku-fp4";
                }
                altName ??= model.Name.BeforeLast('/').AfterLast('/');
            }
            if (specialFormat is not null)
            {
                Logs.Debug($"Model {model.Name} has special format '{specialFormat}'");
            }
            string img = metaHeader?.Value<string>("modelspec.preview_image") ?? metaHeader?.Value<string>("modelspec.thumbnail") ?? metaHeader?.Value<string>("thumbnail") ?? metaHeader?.Value<string>("preview_image");
            if (img is not null && !img.StartsWith("data:image/") && img != "imgs/model_placeholder.jpg")
            {
                Logs.Warning($"Ignoring image in metadata of {model.Name} '{img}'");
                img = null;
            }
            int width, height;
            string res = metaHeader?.Value<string>("modelspec.resolution") ?? metaHeader?.Value<string>("resolution");
            if (res is not null)
            {
                width = int.Parse(res.BeforeAndAfter('x', out string h));
                height = int.Parse(h);
            }
            else
            {
                width = (metaHeader?.ContainsKey("standard_width") ?? false) ? metaHeader.Value<int>("standard_width") : (clazz?.StandardWidth ?? 0);
                height = (metaHeader?.ContainsKey("standard_height") ?? false) ? metaHeader.Value<int>("standard_height") : (clazz?.StandardHeight ?? 0);
            }
            if (img is not null && img.Length > 1024 * 1024 * 8)
            {
                Logs.Warning($"Ignoring image in metadata of {model.Name} as it is too large (over {img.Length / 1024 / 1024} megabytes)!");
                img = null;
            }
            string[] tags = null;
            JToken tagsTok = metaHeader.Property("modelspec.tags")?.Value;
            if (tagsTok is not null && tagsTok.Type != JTokenType.Null)
            {
                if (tagsTok.Type == JTokenType.Array)
                {
                    tags = tagsTok.ToObject<string[]>();
                }
                else
                {
                    tags = tagsTok.Value<string>().Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
                }
            }
            static string limitLength(string str, int max)
            {
                if (str is null || str.Length <= max)
                {
                    return str;
                }
                return str[..(max - 3)] + "...";
            }
            static string pickBest(params string[] options)
            {
                string nonNull = null;
                foreach (string opt in options)
                {
                    if (opt is not null)
                    {
                        nonNull = opt;
                    }
                    if (!string.IsNullOrWhiteSpace(opt))
                    {
                        return opt;
                    }
                }
                if (options.Length > 0)
                {
                    return options[0];
                }
                return nonNull;
            }
            const int basicLimit = 4096;
            string specTitle = pickBest(metaHeader?.Value<string>("modelspec.title"), metaHeader?.Value<string>("title"));
            string fileStem = fileName.BeforeLast('.');
            string resolvedTitle = specTitle;
            if (T2ICivitaiBaseModelMap.TitleIsFilename(resolvedTitle, fileName) && !string.IsNullOrWhiteSpace(altName))
            {
                resolvedTitle = altName;
            }
            resolvedTitle = pickBest(resolvedTitle, altName, fileStem);
            metadata = new()
            {
                ModelFileVersion = modified,
                SidecarFileVersion = ReadSwarmSidecarVersion(model),
                SidecarVersionKnown = true,
                TimeModified = modified,
                TimeCreated = new DateTimeOffset(File.GetCreationTimeUtc(model.RawFilePath)).ToUnixTimeMilliseconds(),
                ModelName = modelCacheId,
                ModelClassType = clazz?.ID,
                AnimaDepthClassified = true,
                Title = limitLength(resolvedTitle, basicLimit),
                Author = limitLength(pickBest(metaHeader?.Value<string>("modelspec.author"), metaHeader?.Value<string>("author")), basicLimit),
                Description = limitLength(pickBest(metaHeader?.Value<string>("modelspec.description"), metaHeader?.Value<string>("description"), altDescription), 1024 * 1024 * 4),
                PreviewImage = img,
                StandardWidth = width,
                StandardHeight = height,
                UsageHint = limitLength(pickBest(metaHeader?.Value<string>("modelspec.usage_hint"), metaHeader?.Value<string>("usage_hint"), T2ICivitaiBaseModelMap.UsageHintFromBaseModel(metaHeader?.Value<string>("BaseModel"))), 8192 * 5),
                MergedFrom = limitLength(pickBest(metaHeader?.Value<string>("modelspec.merged_from"), metaHeader?.Value<string>("merged_from")), 8192 * 10),
                TriggerPhrase = limitLength(pickBest(metaHeader?.Value<string>("modelspec.trigger_phrase"), metaHeader?.Value<string>("trigger_phrase")) ?? altTriggerPhrase, 8192 * 5),
                License = limitLength(pickBest(metaHeader?.Value<string>("modelspec.license"), metaHeader?.Value<string>("license")), basicLimit),
                Date = limitLength(pickBest(metaHeader?.Value<string>("modelspec.date"), metaHeader?.Value<string>("date")), basicLimit),
                Preprocessor = limitLength(pickBest(metaHeader?.Value<string>("modelspec.preprocessor"), metaHeader?.Value<string>("preprocessor")), basicLimit),
                Tags = T2IModel.CleanTags(tags),
                IsNegativeEmbedding = (pickBest(metaHeader?.Value<string>("modelspec.is_negative_embedding"), metaHeader?.Value<string>("is_negative_embedding")) ?? "false").ToLowerFast() == "true",
                LoraDefaultWeight = limitLength(pickBest(metaHeader?.Value<string>("modelspec.lora_default_weight"), metaHeader?.Value<string>("lora_default_weight")), basicLimit),
                LoraDefaultConfinement = limitLength(pickBest(metaHeader?.Value<string>("modelspec.lora_default_confinement"), metaHeader?.Value<string>("lora_default_confinement")), basicLimit),
                PredictionType = limitLength(pickBest(metaHeader?.Value<string>("modelspec.prediction_type"), metaHeader?.Value<string>("prediction_type")), basicLimit),
                Hash = limitLength(pickBest(metaHeader?.Value<string>("modelspec.hash_sha256"), metaHeader?.Value<string>("hash_sha256")), basicLimit),
                TextEncoders = textEncs,
                SpecialFormat = limitLength(pickBest(metaHeader?.Value<string>("modelspec.special_format"), metaHeader?.Value<string>("special_format"), specialFormat), basicLimit)
            };
            lock (MetadataLock)
            {
                try
                {
                    SpokeModelMetadata.TrimForSpoke(metadata);
                    cache.Metadata.Upsert(metadata);
                }
                catch (Exception ex)
                {
                    Logs.Warning($"Error handling metadata database for model {model.RawFilePath}: {ex.ReadableString()}");
                    cache.HadNewError();
                }
            }
            ActiveRefreshDiagnostics.Value?.RecordRebuild(Stopwatch.GetTimestamp() - rebuildStarted);
        }
        else
        {
            bool cacheTouched = NoteLegacySidecarVersion(model, metadata);
            UpgradeAnimaMetadata(model, metadata, cache);
            if (cacheTouched)
            {
                UpsertCached(cache, metadata);
            }
        }
        SpokeModelMetadata.TrimForSpoke(metadata);
        if (!SpokeModePolicy.IsActive)
        {
            model.DeferredPreviewKey = previewKey;
            metadata.DeferPreview(() => ResolvePersistedPreview(cache, modelCacheId), () => ResolveDeferredPreview(model, metadata, cache, modelCacheId, previewKey));
        }
        if (!string.IsNullOrWhiteSpace(metadata.ModelClassType))
        {
            metadata.ModelClassType = T2IModelClassSorter.Remaps.GetValueOrDefault(metadata.ModelClassType, metadata.ModelClassType);
        }
        if (metadata.TimeModified == 0)
        {
            metadata.TimeModified = modified;
            metadata.TimeCreated = modified;
        }
        lock (ModificationLock)
        {
            model.Title = metadata.Title;
            model.Description = metadata.Description;
            model.ModelClass = T2IModelClassSorter.ModelClasses.GetValueOrDefault((metadata.ModelClassType ?? "").ToLowerFast());
            model.PreviewImage = PlaceholderPreviewImage;
            model.StandardWidth = metadata.StandardWidth;
            model.StandardHeight = metadata.StandardHeight;
            model.Metadata = metadata;
        }
    }

    /// <summary>Internal model adder route. Do not call.</summary>
    public void AddAllFromFolder(string pathBase, string folder, ConcurrentDictionary<string, T2IModel> dict)
    {
        AddAllFromFolder(pathBase, folder, dict, null);
    }

    /// <summary>Scans one root and skips metadata work for exact relative model names already loaded from earlier roots.</summary>
    private void AddAllFromFolder(string pathBase, string folder, ConcurrentDictionary<string, T2IModel> dict, IReadOnlyDictionary<string, T2IModel> priorRootModels)
    {
        if (IsShutdown)
        {
            return;
        }
        Logs.Verbose($"[Model Scan] Add all {ModelType} from folder {folder}");
        string prefix = folder == "" ? "" : $"{folder}/";
        string actualFolder = $"{pathBase}/{folder}";
        if (!Directory.Exists(actualFolder))
        {
            Logs.Verbose($"[Model Scan] Skipping folder {actualFolder}");
            return;
        }
        // Allow bounded parallel directory traversal; expensive spoke header reads have a separate shared bound.
        ParallelOptions directoryScanOptions = new() { MaxDegreeOfParallelism = SpokeModePolicy.IsActive ? 4 : -1 };
        Parallel.ForEach(Directory.EnumerateDirectories(actualFolder), directoryScanOptions, subfolder =>
        {
            string simpleName = subfolder.Replace('\\', '/').AfterLast('/');
            string path = $"{prefix}{simpleName}";
            if (simpleName == ".git")
            {
                Logs.Warning($"You have a .git folder in your {ModelType} model folder '{pathBase}/{path}'! That's not supposed to be there.");
                return;
            }
            if (simpleName.StartsWithFast('.'))
            {
                Logs.Verbose($"[Model Scan] Skipping hidden folder {subfolder}");
                return;
            }
            try
            {
                AddAllFromFolder(pathBase, path, dict, priorRootModels);
            }
            catch (UnauthorizedAccessException)
            {
                UnathorizedAccessSet.Enqueue(path);
            }
            catch (Exception ex)
            {
                ScanErrorSet.Enqueue(path);
                Logs.Warning($"Error while scanning model {ModelType} subfolder '{path}': {ex.ReadableString()}");
            }
        });
        ParallelOptions fileScanOptions = new() { MaxDegreeOfParallelism = SpokeModePolicy.IsActive ? 4 : -1 };
        Parallel.ForEach(Directory.EnumerateFiles(actualFolder), fileScanOptions, file =>
        {
            if (Program.GlobalProgramCancel.IsCancellationRequested)
            {
                return;
            }
            string fixedFileName = file.Replace('\\', '/');
            string fn = fixedFileName.AfterLast('/');
            if (fn.StartsWithFast('.'))
            {
                Logs.Verbose($"[Model Scan] Skipping hidden file {fixedFileName}");
                return;
            }
            string fullFilename = $"{prefix}{fn}";
            if (dict.TryGetValue(fullFilename, out T2IModel existingModel))
            {
                lock (existingModel.OtherPaths)
                {
                    existingModel.OtherPaths.Add(fixedFileName);
                }
            }
            else if (T2IModel.NativelySupportedModelExtensions.Contains(fn.AfterLast('.')))
            {
                if (fixedFileName.EndsWith("/unquantized_layers.safetensors") && File.Exists(fixedFileName.BeforeLast('/') + "/comfy_config.json"))
                {
                    return; // Nunchaku secondary file
                }
                T2IModel model = new(this, pathBase, fixedFileName, fullFilename)
                {
                    Title = fullFilename.AfterLast('/'),
                    Description = "(Metadata not yet loaded.)",
                    PreviewImage = "imgs/model_placeholder.jpg",
                };
                dict[fullFilename] = model;
                if (priorRootModels?.ContainsKey(fullFilename) == true)
                {
                    ActiveRefreshDiagnostics.Value?.RecordDuplicateSourceSkip();
                    model.AutoWarn();
                    return;
                }
                try
                {
                    LoadMetadata(model);
                }
                catch (UnauthorizedAccessException)
                {
                    UnathorizedAccessSet.Enqueue(fullFilename);
                }
                catch (Exception ex)
                {
                    if (Program.GlobalProgramCancel.IsCancellationRequested)
                    {
                        throw;
                    }
                    if (ex is IOException || ex is System.Security.SecurityException)
                    {
                        ScanErrorSet.Enqueue(fullFilename);
                    }
                    Logs.Warning($"Failed to load metadata for {fullFilename}:\n{ex.ReadableString()}");
                }
                model.AutoWarn();
            }
            else if (T2IModel.LegacyModelExtensions.Contains(fn.AfterLast('.')))
            {
                T2IModel model = new(this, pathBase, fixedFileName, fullFilename)
                {
                    Description = "(None, use '.safetensors' to enable metadata descriptions)",
                    PreviewImage = "imgs/legacy_ckpt.jpg",
                };
                string previewKey = $"legacy\0{model.RawFilePath}";
                model.DeferredPreviewKey = previewKey;
                model.DeferredPreviewResolver = () => ResolveAdjacentPreview(model, previewKey);
                dict[fullFilename] = model;
                if (priorRootModels?.ContainsKey(fullFilename) == true)
                {
                    ActiveRefreshDiagnostics.Value?.RecordDuplicateSourceSkip();
                    model.AutoWarn();
                    return;
                }
                model.AutoWarn();
            }
        });
    }
}
