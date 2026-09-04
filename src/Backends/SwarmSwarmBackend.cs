using FreneticUtilities.FreneticDataSyntax;
using FreneticUtilities.FreneticExtensions;
using FreneticUtilities.FreneticToolkit;
using Newtonsoft.Json.Linq;
using SwarmUI.Core;
using SwarmUI.Media;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.WebSockets;

namespace SwarmUI.Backends;

/// <summary>A backend for Swarm to connect to other Swarm instances to use as the backend.</summary>
public class SwarmSwarmBackend : AbstractT2IBackend
{
    public class SwarmSwarmBackendSettings : AutoConfiguration
    {
        [ConfigComment("The network address of the other Swarm instance.\nUsually starts with 'http://' and ends with ':7801'.")]
        public string Address = "";

        [ConfigComment("Whether the backend is allowed to revert to an 'idle' state if the API address is unresponsive.\nAn idle state is not considered an error, but cannot generate.\nIt will automatically return to 'running' if the API becomes available.")]
        public bool AllowIdle = false;

        [ConfigComment("Whether remote Swarm backends should be followed through.\nIf false, only backends directly local to the remote machine are used.\nIf true, the remote backend can chain further connected backends.")]
        public bool AllowForwarding = true;

        [ConfigComment("Require the remote server to use spoke mode. Enable for hub-to-spoke connections.")]
        public bool RequireSpokeMode = false;

        [ConfigComment("Whether the backend is allowed to use WebSocket connections.\nIf true, the backend will work normally and provide previews and updates and all.\nIf false, the backend will freeze while generating until the generation completes.\nFalse may be needed for some limited network environments.")]
        public bool AllowWebsocket = true;

        [ConfigComment("If the remote instance has an 'Authorization:' header required, specify it here.\nFor example, 'Bearer abc123'.\nIf you don't know what this is, you don't need it.")]
        [ValueIsSecret]
        public string AuthorizationHeader = "";

        [ConfigComment("Any other headers here, newline separated, for example:\nMyHeader: MyVal\nSecondHeader: secondVal")]
        public string OtherHeaders = "";

        [ConfigComment("When attempting to connect to the backend, this is the maximum time Swarm will wait before considering the connection to be failed.\nNote that depending on other configurations, it may fail faster than this.\nFor local network machines, set this to a low value (eg 5) to avoid 'Loading...' delays.")]
        public int ConnectionAttemptTimeoutSeconds = 30;
    }

    /// <summary>Internal HTTP handler.</summary>
    public static HttpClient HttpClient = NetworkBackendUtils.MakeHttpClient();

    /// <summary>Event fired when a new swarm sub-backend is added.</summary>
    public static Action<SwarmSwarmBackend> OnSwarmBackendAdded;

    public SwarmSwarmBackendSettings Settings => SettingsRaw as SwarmSwarmBackendSettings;

    public NetworkBackendUtils.IdleMonitor Idler = new();

    /// <summary>A set of all supported features the remote Swarm instance has.</summary>
    public ConcurrentDictionary<string, string> RemoteFeatureCombo = new();

    /// <summary>A set of all backend-types the remote Swarm instance has.</summary>
    public volatile HashSet<string> RemoteBackendTypes = [];

    /// <inheritdoc/>
    public override IEnumerable<string> SupportedFeatures => RemoteFeatureCombo.Keys;

    /// <summary>Current API session ID.</summary>
    public string Session;

    /// <summary>If true, at least one remote sub-backend is still 'loading'.</summary>
    public volatile bool AnyLoading = true;

    /// <summary>The remote backend ID this specific instance is linked to (if any).</summary>
    public int LinkedRemoteBackendID;

    /// <summary>The backend-type of the remote backend.</summary>
    public string LinkedRemoteBackendType;

    /// <summary>A list of any non-real backends this instance controls.</summary>
    public ConcurrentDictionary<int, BackendHandler.T2IBackendData> ControlledNonrealBackends = new();

    /// <summary>Map of models on the remote server.</summary>
    public ConcurrentDictionary<string, Dictionary<string, JObject>> RemoteModels = null;

    /// <summary>Whether the connected remote server is running the fork's spoke profile.</summary>
    public volatile bool RemoteIsSpokeMode = false;

    /// <summary>Version advertised by the connected remote server.</summary>
    public string RemoteServerVersion = null;

    /// <summary>Whether a complete model inventory has been validated and atomically published for routing.</summary>
    public volatile bool RemoteInventoryReady = false;

    /// <summary>Version of the remote server that produced the currently published model inventory.</summary>
    public string RemoteInventorySourceVersion = null;

    /// <summary>Remote model edit counter associated with the currently published model inventory, or -1 for legacy remotes.</summary>
    public long RemoteInventoryModelEditID = -1;

    /// <summary>Data about the remote backend supplied by extensions.</summary>
    public ConcurrentDictionary<string, object> ExtensionData = new();

    /// <summary>Gets the current target address.</summary>
    public string Address => Settings.Address.TrimEnd('/'); // Remove trailing slash to avoid issues.

    /// <summary>If true, an external handler controls this as a specialty non-real backend. This is a real master instance, but not on the backends list.
    /// For example, <see cref="AutoScalingBackend"/> uses this.</summary>
    public bool IsSpecialControlled = false;

    /// <summary>If true, this instance is the master referencing a single swarm instance, controlling several child backends for the remote backends.</summary>
    public bool IsAControlInstance => IsReal || IsSpecialControlled;

    /// <summary>How many times to re-try the first load if it fails.</summary>
    public int FirstLoadRetries = 0;

    /// <summary>How many seconds to wait between each re-try.</summary>
    public int FirstLoadRetryWaitSeconds = 5;

    /// <summary>Serializes full remote inventory refreshes for this control backend.</summary>
    private readonly SemaphoreSlim RemoteInventoryRefreshSemaphore = new(1, 1);

    /// <summary>Tracks reentrant full refreshes caused by session renewal within the current async flow.</summary>
    private readonly AsyncLocal<bool> RemoteInventoryRefreshLockHeld = new();

    /// <summary>Event fired when a backend is revising its remote data.</summary>
    public static Action<SwarmSwarmBackend> ReviseRemotesEvent;

    /// <summary>The parent backend, if any.</summary>
    public SwarmSwarmBackend Parent;

    /// <summary>Runs one operation under the reentrant per-control-backend inventory refresh lock.</summary>
    private Task RunWithRemoteInventoryRefreshLock(Func<Task> action)
    {
        return RunWithRemoteInventoryLock(action, Program.GlobalProgramCancel);
    }

    /// <summary>Runs shutdown under the inventory lock even after global cancellation begins.</summary>
    private Task RunWithRemoteInventoryShutdownLock(Func<Task> action)
    {
        return RunWithRemoteInventoryLock(action, CancellationToken.None);
    }

    /// <summary>Runs one reentrant inventory-lifecycle operation with the requested wait cancellation.</summary>
    private async Task RunWithRemoteInventoryLock(Func<Task> action, CancellationToken cancellationToken)
    {
        if (RemoteInventoryRefreshLockHeld.Value)
        {
            await action();
            return;
        }
        await RemoteInventoryRefreshSemaphore.WaitAsync(cancellationToken);
        RemoteInventoryRefreshLockHeld.Value = true;
        try
        {
            await action();
        }
        finally
        {
            RemoteInventoryRefreshLockHeld.Value = false;
            RemoteInventoryRefreshSemaphore.Release();
        }
    }

    /// <summary>Gets a request adapter appropriate to this Swarm backend, including eg auth headers.</summary>
    public Action<HttpRequestMessage> RequestAdapter()
    {
        return req =>
        {
            if (!string.IsNullOrWhiteSpace(Settings.AuthorizationHeader))
            {
                req.Headers.Authorization = AuthenticationHeaderValue.Parse(Settings.AuthorizationHeader);
            }
            if (!string.IsNullOrWhiteSpace(Settings.OtherHeaders))
            {
                foreach (string line in Settings.OtherHeaders.Split('\n'))
                {
                    string[] parts = line.Split(':');
                    if (parts.Length != 2)
                    {
                        Logs.Error($"Invalid header line in SwarmSwarmBackend: '{line}'");
                        continue;
                    }
                    req.Headers.Add(parts[0].Trim(), parts[1].Trim());
                }
            }
        };
    }

    /// <summary>Best-effort closes a transient controller session on a spoke; TTL cleanup covers network loss.</summary>
    private async Task CloseRemoteSpokeSession()
    {
        if (!RemoteIsSpokeMode || string.IsNullOrWhiteSpace(Session))
        {
            Session = null;
            return;
        }
        string sessionToClose = Session;
        Session = null;
        try
        {
            using CancellationTokenSource timeout = Utilities.TimedCancel(TimeSpan.FromSeconds(Math.Clamp(Settings.ConnectionAttemptTimeoutSeconds, 1, 5)));
            JObject result = await HttpClient.PostJson($"{Address}/API/CloseSession", new()
            {
                ["session_id"] = sessionToClose
            }, RequestAdapter(), timeout.Token);
            if (result.TryGetValue("error", out JToken error))
            {
                Logs.Debug($"{HandlerTypeData.Name} {BackendData.ID} could not close its remote spoke session: {error}");
            }
        }
        catch (Exception ex)
        {
            Logs.Debug($"{HandlerTypeData.Name} {BackendData.ID} could not close its remote spoke session: {ex.ReadableString()}");
        }
    }

    /// <summary>Validates the remote server and builds its backend state under the control instance's refresh lock.</summary>
    public async Task ValidateAndBuild()
    {
        void requireActiveLifecycle()
        {
            if (ShutDownReserve || Status == BackendStatus.DISABLED)
            {
                throw new SwarmReadableErrorException("Remote Swarm backend is shutting down or disabled.");
            }
        }
        requireActiveLifecycle();
        if (IsAControlInstance)
        {
            try
            {
                await RunWithRemoteInventoryRefreshLock(async () =>
                {
                    requireActiveLifecycle();
                    await ValidateAndBuildInternal();
                    requireActiveLifecycle();
                });
            }
            catch (Exception) when (ShutDownReserve || Status == BackendStatus.DISABLED)
            {
                throw;
            }
            catch (Exception ex)
            {
                string[] requiredSubtypes = [.. Program.T2IModelSets.Keys.Order(StringComparer.Ordinal)];
                InvalidateRemoteModelInventory(requiredSubtypes);
                SetRemoteInventoryFailureStatus(ex);
                throw;
            }
            return;
        }
        requireActiveLifecycle();
        await ValidateAndBuildInternal();
        requireActiveLifecycle();
    }

    /// <summary>Internal implementation of <see cref="ValidateAndBuild"/>. Control callers hold the inventory refresh lock.</summary>
    private async Task ValidateAndBuildInternal()
    {
        using CancellationTokenSource timeout = Utilities.TimedCancel(TimeSpan.FromSeconds(Settings.ConnectionAttemptTimeoutSeconds));
        JObject sessData = await HttpClient.PostJson($"{Address}/API/GetNewSession", new JObject()
        {
            ["spokeController"] = true
        }, RequestAdapter(), timeout.Token);
        AutoThrowException(sessData);
        if (!sessData.TryGetValue("session_id", out JToken sessTok))
        {
            Logs.Debug($"{HandlerTypeData.Name} {BackendData.ID} failed to get session ID from remote swarm at {Address}: yielded raw json {sessData.ToDenseDebugString(true)}");
            throw new Exception("Failed to get session ID from remote swarm. Check debug logs for details.");
        }
        Session = sessTok.ToString();
        RemoteServerVersion = sessData["version"]?.ToString();
        if (sessData.TryGetValue("spoke_mode", out JToken spokeModeToken))
        {
            if (spokeModeToken.Type != JTokenType.Boolean)
            {
                throw new SwarmReadableErrorException("Remote swarm returned an invalid spoke-mode advertisement.");
            }
            RemoteIsSpokeMode = spokeModeToken.Value<bool>();
        }
        else
        {
            RemoteIsSpokeMode = false;
        }
        ValidateSpokeModeRequirement(Settings.RequireSpokeMode, RemoteIsSpokeMode);
        ValidateSpokeControllerAdvertisement(RemoteIsSpokeMode, sessData["spoke_controller"]);
        if (RemoteIsSpokeMode && RemoteServerVersion != Utilities.VaryID)
        {
            throw new SwarmReadableErrorException($"Remote spoke version '{RemoteServerVersion}' does not match local version '{Utilities.VaryID}'. Deploy the same build.");
        }
        string id = sessData["server_id"]?.ToString();
        Logs.Verbose($"{HandlerTypeData.Name} {BackendData.ID} Connected to remote Swarm instance {Address} with server ID '{id}'.");
        if (id == Utilities.LoopPreventionID.ToString())
        {
            Logs.Error($"Swarm is connecting to itself as a backend. This is a bad idea. Check the address being used: {Address}");
            throw new Exception("Swarm connected to itself, backend load failed.");
        }
        if (RemoteIsSpokeMode && IsAControlInstance)
        {
            string[] requiredSubtypes = [.. Program.T2IModelSets.Keys.Order(StringComparer.Ordinal)];
            InvalidateRemoteModelInventory(requiredSubtypes);
            await RequestRemoteModelRefresh();
            await ReviseRemoteDataListInternal(true);
            return;
        }
        await ReviseRemoteDataList(true);
    }

    public static void AutoThrowException(JObject data)
    {
        if (data.TryGetValue("error_id", out JToken errorId) && errorId.ToString() == "invalid_session_id")
        {
            throw new SessionInvalidException();
        }
        if (data.TryGetValue("error", out JToken error))
        {
            string err = error.ToString();
            throw new SwarmReadableErrorException($"Remote swarm gave error: {err}");
        }
    }

    /// <summary>Rejects a remote connection that does not satisfy its configured spoke-mode requirement.</summary>
    public static void ValidateSpokeModeRequirement(bool requireSpokeMode, bool remoteIsSpokeMode)
    {
        if (requireSpokeMode && !remoteIsSpokeMode)
        {
            throw new SwarmReadableErrorException("Remote backend is not in required spoke mode. Start it with launch-spoke.bat.");
        }
    }

    /// <summary>Requires a spoke handshake to confirm that this session has controller authorization.</summary>
    public static void ValidateSpokeControllerAdvertisement(bool remoteIsSpokeMode, JToken controllerToken)
    {
        if (remoteIsSpokeMode && (controllerToken is null || controllerToken.Type != JTokenType.Boolean || !controllerToken.Value<bool>()))
        {
            throw new SwarmReadableErrorException("Remote spoke rejected controller authorization. Check Authorization Header.");
        }
    }

    /// <summary>Rejects a completed spoke backend snapshot that has no usable or pending direct generation backend.</summary>
    public static void ValidateSpokeBackendAvailability(bool validateSpoke, int runningBackends, bool anyLoading)
    {
        if (validateSpoke && runningBackends == 0 && !anyLoading)
        {
            throw new SwarmReadableErrorException("Remote spoke has no running or loading generation backend. Start its local GPU backend.");
        }
    }

    /// <summary>Returns whether a remote generation backend can load models and accept at least one request.</summary>
    public static bool HasRoutableModelCapacity(bool canLoadModels, int maxUsages)
    {
        return canLoadModels && maxUsages > 0;
    }

    /// <summary>Returns whether a remote backend status represents pending initialization.</summary>
    public static bool IsPendingRemoteBackendStatus(string status)
    {
        return status == "loading" || status == "waiting";
    }

    /// <summary>Builds a hub-local, authenticated proxy URL for one remote model preview.</summary>
    public static string BuildRemoteModelPreviewProxyUrl(int backendID, string subtype, string modelName)
    {
        return $"/RemoteModelPreview/{backendID}?subtype={Uri.EscapeDataString(subtype)}&model={Uri.EscapeDataString(modelName)}&editid={ModelsAPI.ModelEditID}";
    }

    /// <summary>Requests and validates a local model rescan on the connected remote server using the current session.</summary>
    private async Task RequestRemoteModelRefresh()
    {
        Logs.Verbose($"Trigger refresh on remote swarm {Address}");
        JObject refreshData = await HttpClient.PostJson($"{Address}/API/TriggerRefresh", new()
        {
            ["session_id"] = Session,
            ["strong"] = true,
            ["force"] = true,
            ["returnData"] = !RemoteIsSpokeMode
        }, RequestAdapter());
        AutoThrowException(refreshData);
        if (RemoteIsSpokeMode && (!refreshData.TryGetValue("success", out JToken successToken)
            || successToken.Type != JTokenType.Boolean || !successToken.Value<bool>()
            || !refreshData.TryGetValue("refreshed", out JToken refreshedToken)
            || refreshedToken.Type != JTokenType.Boolean || !refreshedToken.Value<bool>()))
        {
            throw new SwarmReadableErrorException("Remote spoke did not confirm a completed model refresh.");
        }
    }

    /// <summary>A complete, validated model-routing snapshot from a remote Swarm server.</summary>
    public sealed class RemoteModelInventorySnapshot
    {
        /// <summary>Model names indexed by model subtype.</summary>
        public ConcurrentDictionary<string, List<string>> Models { get; }

        /// <summary>Model metadata indexed first by subtype and then by model name.</summary>
        public ConcurrentDictionary<string, Dictionary<string, JObject>> RemoteModels { get; }

        /// <summary>Version of the remote server that produced this snapshot.</summary>
        public string SourceVersion { get; }

        /// <summary>Remote model edit counter associated with this snapshot, or -1 for legacy remotes.</summary>
        public long ModelEditID { get; }

        /// <summary>Constructs a complete, validated remote model snapshot.</summary>
        public RemoteModelInventorySnapshot(ConcurrentDictionary<string, List<string>> models,
            ConcurrentDictionary<string, Dictionary<string, JObject>> remoteModels, string sourceVersion, long modelEditID)
        {
            Models = models;
            RemoteModels = remoteModels;
            SourceVersion = sourceVersion;
            ModelEditID = modelEditID;
        }
    }

    /// <summary>Gets a required strict boolean field from a compact model inventory object.</summary>
    private static bool RequireInventoryBoolean(JObject data, string field, string context)
    {
        if (!data.TryGetValue(field, out JToken token) || token.Type != JTokenType.Boolean)
        {
            throw new SwarmReadableErrorException($"Remote model inventory {context} has an invalid or missing '{field}' field.");
        }
        return token.Value<bool>();
    }

    /// <summary>Gets a required nonnegative integer field from a compact model inventory object.</summary>
    private static long RequireInventoryInteger(JObject data, string field, string context)
    {
        if (!data.TryGetValue(field, out JToken token) || token.Type != JTokenType.Integer
            || !long.TryParse(token.ToString(), out long value) || value < 0)
        {
            throw new SwarmReadableErrorException($"Remote model inventory {context} has an invalid or missing '{field}' field.");
        }
        return value;
    }

    /// <summary>Gets a required nonempty string field from a compact model inventory object.</summary>
    private static string RequireInventoryString(JObject data, string field, string context)
    {
        if (!data.TryGetValue(field, out JToken token) || token.Type != JTokenType.String || string.IsNullOrWhiteSpace(token.ToString()))
        {
            throw new SwarmReadableErrorException($"Remote model inventory {context} has an invalid or missing '{field}' field.");
        }
        return token.ToString();
    }

    /// <summary>Gets a required object field from a compact model inventory object.</summary>
    private static JObject RequireInventoryObject(JObject data, string field, string context)
    {
        if (!data.TryGetValue(field, out JToken token) || token is not JObject result)
        {
            throw new SwarmReadableErrorException($"Remote model inventory {context} has an invalid or missing '{field}' field.");
        }
        return result;
    }

    /// <summary>Gets a required array field from a compact model inventory object.</summary>
    private static JArray RequireInventoryArray(JObject data, string field, string context)
    {
        if (!data.TryGetValue(field, out JToken token) || token is not JArray result)
        {
            throw new SwarmReadableErrorException($"Remote model inventory {context} has an invalid or missing '{field}' field.");
        }
        return result;
    }

    /// <summary>Validates and parses a compact remote model inventory without publishing any partial state.</summary>
    public static RemoteModelInventorySnapshot ParseCompactModelInventory(JObject data, IEnumerable<string> requiredSubtypes,
        IEnumerable<string> requiredParameterIDs, bool allowRemote, string requiredSourceVersion)
    {
        AutoThrowException(data);
        long protocolVersion = RequireInventoryInteger(data, "version", "response");
        if (protocolVersion != ModelsAPI.ModelInventoryProtocolVersion)
        {
            throw new SwarmReadableErrorException($"Remote model inventory protocol version {protocolVersion} is unsupported.");
        }
        string sourceVersion = RequireInventoryString(data, "source_version", "response");
        if (sourceVersion != requiredSourceVersion)
        {
            throw new SwarmReadableErrorException($"Remote spoke version '{sourceVersion}' does not match local version '{requiredSourceVersion}'.");
        }
        long modelEditID = RequireInventoryInteger(data, "model_edit_id", "response");
        bool responseAllowRemote = RequireInventoryBoolean(data, "allow_remote", "response");
        if (responseAllowRemote != allowRemote)
        {
            throw new SwarmReadableErrorException("Remote model inventory did not honor the requested forwarding mode.");
        }
        bool complete = RequireInventoryBoolean(data, "complete", "response");
        bool truncated = RequireInventoryBoolean(data, "truncated", "response");
        if (!complete || truncated)
        {
            throw new SwarmReadableErrorException("Remote model inventory is incomplete or truncated.");
        }
        long expectedTotal = RequireInventoryInteger(data, "total", "response");
        long expectedReturned = RequireInventoryInteger(data, "returned", "response");
        long expectedParameterCount = RequireInventoryInteger(data, "parameter_count", "response");
        JArray parameterData = RequireInventoryArray(data, "parameter_ids", "response");
        if (expectedParameterCount != parameterData.Count)
        {
            throw new SwarmReadableErrorException("Remote model inventory parameter count does not match its payload.");
        }
        HashSet<string> requiredParameters = new(requiredParameterIDs, StringComparer.Ordinal);
        if (requiredParameters.Any(string.IsNullOrWhiteSpace))
        {
            throw new ArgumentException("Required parameter IDs cannot contain empty names.", nameof(requiredParameterIDs));
        }
        HashSet<string> remoteParameters = new(StringComparer.Ordinal);
        string previousParameter = null;
        foreach (JToken parameterToken in parameterData)
        {
            if (parameterToken.Type != JTokenType.String || string.IsNullOrWhiteSpace(parameterToken.ToString()))
            {
                throw new SwarmReadableErrorException("Remote model inventory contains an invalid parameter ID.");
            }
            string parameter = parameterToken.ToString();
            if (previousParameter is not null && StringComparer.Ordinal.Compare(previousParameter, parameter) >= 0)
            {
                throw new SwarmReadableErrorException("Remote model inventory parameter IDs are duplicated or not deterministically sorted.");
            }
            previousParameter = parameter;
            remoteParameters.Add(parameter);
        }
        if (remoteParameters.Count != requiredParameters.Count || !remoteParameters.SetEquals(requiredParameters))
        {
            throw new SwarmReadableErrorException("Remote spoke generation parameters do not match the local server.");
        }
        long expectedSubtypeCount = RequireInventoryInteger(data, "subtype_count", "response");
        JObject subtypeData = RequireInventoryObject(data, "subtypes", "response");
        if (expectedSubtypeCount != subtypeData.Count)
        {
            throw new SwarmReadableErrorException("Remote model inventory subtype count does not match its payload.");
        }
        HashSet<string> required = new(requiredSubtypes, StringComparer.Ordinal);
        if (required.Any(string.IsNullOrWhiteSpace))
        {
            throw new ArgumentException("Required model subtypes cannot contain empty names.", nameof(requiredSubtypes));
        }
        ConcurrentDictionary<string, List<string>> modelNames = new(StringComparer.Ordinal);
        ConcurrentDictionary<string, Dictionary<string, JObject>> remoteModels = new(StringComparer.Ordinal);
        long actualTotal = 0;
        long actualReturned = 0;
        string previousSubtype = null;
        foreach (JProperty property in subtypeData.Properties())
        {
            string subtype = property.Name;
            if (string.IsNullOrWhiteSpace(subtype) || (previousSubtype is not null && StringComparer.Ordinal.Compare(previousSubtype, subtype) >= 0))
            {
                throw new SwarmReadableErrorException("Remote model inventory subtype names are empty, duplicated, or not deterministically sorted.");
            }
            previousSubtype = subtype;
            if (property.Value is not JObject subtypeObject)
            {
                throw new SwarmReadableErrorException($"Remote model inventory subtype '{subtype}' is malformed.");
            }
            string context = $"subtype '{subtype}'";
            bool subtypeComplete = RequireInventoryBoolean(subtypeObject, "complete", context);
            bool scanSucceeded = RequireInventoryBoolean(subtypeObject, "scan_succeeded", context);
            bool subtypeTruncated = RequireInventoryBoolean(subtypeObject, "truncated", context);
            if (!subtypeComplete || !scanSucceeded || subtypeTruncated)
            {
                throw new SwarmReadableErrorException($"Remote model inventory subtype '{subtype}' has a failed scan, is incomplete, or is truncated.");
            }
            long subtypeTotal = RequireInventoryInteger(subtypeObject, "total", context);
            long subtypeReturned = RequireInventoryInteger(subtypeObject, "returned", context);
            JArray names = RequireInventoryArray(subtypeObject, "names", context);
            if (subtypeTotal != subtypeReturned || subtypeReturned != names.Count)
            {
                throw new SwarmReadableErrorException($"Remote model inventory subtype '{subtype}' count does not match its payload.");
            }
            List<string> parsedNames = new(names.Count);
            string previousName = null;
            foreach (JToken nameToken in names)
            {
                if (nameToken.Type != JTokenType.String || string.IsNullOrWhiteSpace(nameToken.ToString()))
                {
                    throw new SwarmReadableErrorException($"Remote model inventory subtype '{subtype}' contains an invalid model name.");
                }
                string name = nameToken.ToString();
                if (previousName is not null && StringComparer.Ordinal.Compare(previousName, name) >= 0)
                {
                    throw new SwarmReadableErrorException($"Remote model inventory subtype '{subtype}' model names are duplicated or not deterministically sorted.");
                }
                previousName = name;
                parsedNames.Add(name);
            }
            modelNames[subtype] = parsedNames;
            remoteModels[subtype] = new Dictionary<string, JObject>(StringComparer.Ordinal);
            checked
            {
                actualTotal += subtypeTotal;
                actualReturned += subtypeReturned;
            }
        }
        if (modelNames.Count != required.Count || !required.SetEquals(modelNames.Keys))
        {
            throw new SwarmReadableErrorException("Remote spoke model subtypes do not match the local server.");
        }
        if (actualTotal != expectedTotal || actualReturned != expectedReturned || actualTotal != actualReturned)
        {
            throw new SwarmReadableErrorException("Remote model inventory aggregate counts do not match its payload.");
        }
        return new RemoteModelInventorySnapshot(modelNames, remoteModels, sourceVersion, modelEditID);
    }

    /// <summary>Requires a spoke snapshot to contain every model that is local to the hub. Additional spoke models are allowed.</summary>
    public static void ValidateModelInventoryCoverage(RemoteModelInventorySnapshot snapshot,
        IReadOnlyDictionary<string, string[]> requiredModels)
    {
        foreach ((string subtype, string[] requiredNames) in requiredModels.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            if (!snapshot.Models.TryGetValue(subtype, out List<string> remoteNames))
            {
                throw new SwarmReadableErrorException($"Remote spoke model inventory is missing subtype '{subtype}'.");
            }
            HashSet<string> remoteSet = new(remoteNames, StringComparer.Ordinal);
            int missingCount = 0;
            string firstMissing = null;
            foreach (string requiredName in requiredNames)
            {
                if (!remoteSet.Contains(requiredName))
                {
                    missingCount++;
                    firstMissing ??= requiredName;
                }
            }
            if (missingCount > 0)
            {
                throw new SwarmReadableErrorException($"Remote spoke subtype '{subtype}' is missing {missingCount} hub-local model(s), including '{firstMissing}'.");
            }
        }
    }

    /// <summary>Loads every required model subtype into a private snapshot that is safe to publish atomically.</summary>
    private async Task<RemoteModelInventorySnapshot> LoadRemoteModelInventory(string[] requiredSubtypes)
    {
        if (RemoteIsSpokeMode)
        {
            JObject inventoryData = await HttpClient.PostJson($"{Address}/API/ListModelInventory", new()
            {
                ["session_id"] = Session,
                ["allowRemote"] = false
            }, RequestAdapter());
            RemoteModelInventorySnapshot snapshot = ParseCompactModelInventory(inventoryData, requiredSubtypes,
                T2IParamTypes.Types.Keys, false, Utilities.VaryID);
            foreach (string subtype in requiredSubtypes)
            {
                if (!Program.T2IModelSets[subtype].LastRefreshSucceeded)
                {
                    throw new SwarmReadableErrorException($"Local hub model scan for subtype '{subtype}' is incomplete; spoke coverage cannot be validated.");
                }
            }
            Dictionary<string, string[]> requiredModels = requiredSubtypes.ToDictionary(subtype => subtype,
                subtype => Program.T2IModelSets[subtype].Models.Keys.Order(StringComparer.Ordinal).ToArray(), StringComparer.Ordinal);
            ValidateModelInventoryCoverage(snapshot, requiredModels);
            if (!string.IsNullOrWhiteSpace(RemoteServerVersion) && snapshot.SourceVersion != RemoteServerVersion)
            {
                throw new SwarmReadableErrorException("Remote spoke changed versions while its model inventory was loading.");
            }
            return snapshot;
        }
        List<Task<(string Type, List<string> Names, Dictionary<string, JObject> RemoteModels)>> tasks = [];
        foreach (string type in requiredSubtypes)
        {
            string runType = type;
            tasks.Add(Task.Run(async () =>
            {
                JObject modelsData = await HttpClient.PostJson($"{Address}/API/ListModels", new()
                {
                    ["session_id"] = Session,
                    ["path"] = "",
                    ["depth"] = 999,
                    ["subtype"] = runType,
                    ["allowRemote"] = Settings.AllowForwarding,
                    // Embedded previews can exceed .NET's string capacity on large remote trees.
                    // Preview proxying remains separate from model-routing inventory.
                    ["dataImages"] = false
                }, RequestAdapter());
                AutoThrowException(modelsData);
                if (!modelsData.TryGetValue("files", out JToken filesToken) || filesToken is not JArray files)
                {
                    throw new SwarmReadableErrorException($"Remote model list for subtype '{runType}' is missing its files array.");
                }
                bool hasCompletenessMarkers = modelsData.ContainsKey("complete") || modelsData.ContainsKey("scan_succeeded")
                    || modelsData.ContainsKey("truncated") || modelsData.ContainsKey("total") || modelsData.ContainsKey("returned");
                if (hasCompletenessMarkers)
                {
                    string context = $"rich subtype '{runType}'";
                    bool complete = RequireInventoryBoolean(modelsData, "complete", context);
                    bool scanSucceeded = RequireInventoryBoolean(modelsData, "scan_succeeded", context);
                    bool truncated = RequireInventoryBoolean(modelsData, "truncated", context);
                    long total = RequireInventoryInteger(modelsData, "total", context);
                    long returned = RequireInventoryInteger(modelsData, "returned", context);
                    if (returned != files.Count || total < returned)
                    {
                        throw new SwarmReadableErrorException($"Remote model list for subtype '{runType}' count does not match its payload.");
                    }
                    if (!complete || !scanSucceeded || truncated || total != returned)
                    {
                        Logs.Warning($"Remote non-spoke model list for subtype '{runType}' is partial ({returned} of {total}). Raise the remote ModelListSanityCap for full legacy routing.");
                    }
                }
                Dictionary<string, JObject> parsedRemoteModels = new(files.Count, StringComparer.Ordinal);
                foreach (JToken modelToken in files)
                {
                    if (modelToken is not JObject modelData || !modelData.TryGetValue("name", out JToken nameToken)
                        || nameToken.Type != JTokenType.String || string.IsNullOrWhiteSpace(nameToken.ToString()))
                    {
                        throw new SwarmReadableErrorException($"Remote model list for subtype '{runType}' contains a malformed model.");
                    }
                    string name = nameToken.ToString();
                    JObject clonedData = modelData.DeepClone() as JObject;
                    clonedData["local"] = false;
                    if (clonedData["preview_image"]?.Type == JTokenType.String
                        && !string.IsNullOrWhiteSpace(clonedData["preview_image"].ToString())
                        && !clonedData["preview_image"].ToString().StartsWith("data:", StringComparison.OrdinalIgnoreCase))
                    {
                        clonedData["preview_image"] = BuildRemoteModelPreviewProxyUrl(BackendData.ID, runType, name);
                    }
                    if (!parsedRemoteModels.TryAdd(name, clonedData))
                    {
                        throw new SwarmReadableErrorException($"Remote model list for subtype '{runType}' contains duplicate model '{name}'.");
                    }
                }
                List<string> names = [.. parsedRemoteModels.Keys.Order(StringComparer.Ordinal)];
                Logs.Verbose($"{HandlerTypeData.Name} {BackendData.ID} Got {runType} model list, {names.Count} models");
                return (runType, names, parsedRemoteModels);
            }));
        }
        (string Type, List<string> Names, Dictionary<string, JObject> RemoteModels)[] loaded = await Task.WhenAll(tasks);
        ConcurrentDictionary<string, List<string>> modelNames = new(StringComparer.Ordinal);
        ConcurrentDictionary<string, Dictionary<string, JObject>> remoteModels = new(StringComparer.Ordinal);
        foreach ((string type, List<string> names, Dictionary<string, JObject> subtypeModels) in loaded)
        {
            if (!modelNames.TryAdd(type, names) || !remoteModels.TryAdd(type, subtypeModels))
            {
                throw new SwarmReadableErrorException($"Remote model inventory contains duplicate subtype '{type}'.");
            }
        }
        if (modelNames.Count != requiredSubtypes.Length)
        {
            throw new SwarmReadableErrorException("Remote model inventory is missing one or more required subtypes.");
        }
        return new RemoteModelInventorySnapshot(modelNames, remoteModels, RemoteServerVersion, -1);
    }

    /// <summary>Invalidates all remote model data before a full refresh so stale or partial state cannot be routed.</summary>
    private void InvalidateRemoteModelInventory(string[] requiredSubtypes)
    {
        if (Status == BackendStatus.RUNNING)
        {
            SetRemoteInventoryStatus(BackendStatus.LOADING);
        }
        RemoteInventoryReady = false;
        RemoteInventorySourceVersion = null;
        RemoteInventoryModelEditID = -1;
        ConcurrentDictionary<string, List<string>> emptyModels = new(StringComparer.Ordinal);
        foreach (string subtype in requiredSubtypes)
        {
            emptyModels[subtype] = [];
        }
        Models = emptyModels;
        RemoteModels = null;
        foreach (BackendHandler.T2IBackendData data in ControlledNonrealBackends.Values)
        {
            data.Backend.Models = emptyModels;
        }
    }

    /// <summary>Sets control and selected child backend statuses to the same inventory availability state.</summary>
    private void SetRemoteInventoryStatus(BackendStatus status, HashSet<int> childIDs = null)
    {
        Status = status;
        foreach ((int id, BackendHandler.T2IBackendData data) in ControlledNonrealBackends)
        {
            if (childIDs is null || childIDs.Contains(id))
            {
                data.Backend.Status = status;
            }
        }
    }

    /// <summary>Marks the control backend and every child unavailable after an inventory refresh failure.</summary>
    private void SetRemoteInventoryFailureStatus(Exception exception)
    {
        BackendStatus status = Settings.AllowIdle && !NetworkBackendUtils.IdleMonitor.ExceptionIsNonIdleable(exception)
            ? BackendStatus.IDLE
            : BackendStatus.ERRORED;
        SetRemoteInventoryStatus(status);
    }

    /// <summary>Publishes one complete model snapshot to the control backend and all existing child backends.</summary>
    private void PublishRemoteModelInventory(RemoteModelInventorySnapshot snapshot)
    {
        RemoteModels = snapshot.RemoteModels;
        Models = snapshot.Models;
        foreach (BackendHandler.T2IBackendData data in ControlledNonrealBackends.Values)
        {
            data.Backend.Models = snapshot.Models;
        }
        RemoteInventorySourceVersion = snapshot.SourceVersion;
        RemoteInventoryModelEditID = snapshot.ModelEditID;
        RemoteInventoryReady = true;
    }

    public Task TriggerRefresh()
    {
        if (!IsAControlInstance)
        {
            return Task.CompletedTask;
        }
        return RunWithRemoteInventoryRefreshLock(async () =>
        {
            if (ShutDownReserve || Status == BackendStatus.DISABLED)
            {
                return;
            }
            string[] requiredSubtypes = [.. Program.T2IModelSets.Keys.Order(StringComparer.Ordinal)];
            HashSet<int> existingChildIDs = [.. ControlledNonrealBackends.Keys];
            SetRemoteInventoryStatus(BackendStatus.LOADING, existingChildIDs);
            InvalidateRemoteModelInventory(requiredSubtypes);
            try
            {
                await RunWithSession(async () =>
                {
                    InvalidateRemoteModelInventory(requiredSubtypes);
                    await RequestRemoteModelRefresh();
                    if (ShutDownReserve)
                    {
                        return;
                    }
                    List<Task> tasks =
                    [
                        ReviseRemoteDataList(true)
                    ];
                    foreach (BackendHandler.T2IBackendData backend in ControlledNonrealBackends.Values)
                    {
                        tasks.Add((backend.Backend as SwarmSwarmBackend).ReviseRemoteDataList(false));
                    }
                    await Task.WhenAll(tasks);
                    while (AnyLoading && ControlledNonrealBackends.IsEmpty)
                    {
                        await Task.Delay(TimeSpan.FromSeconds(1), Program.GlobalProgramCancel);
                        await ReviseRemoteDataList(true);
                    }
                });
                if (ShutDownReserve)
                {
                    InvalidateRemoteModelInventory(requiredSubtypes);
                    return;
                }
                SetRemoteInventoryStatus(BackendStatus.RUNNING, existingChildIDs);
            }
            catch (Exception ex)
            {
                InvalidateRemoteModelInventory(requiredSubtypes);
                SetRemoteInventoryFailureStatus(ex);
                throw;
            }
        });
    }

    /// <summary>Refreshes remote backend data, serializing complete inventory publication for control backends.</summary>
    public async Task ReviseRemoteDataList(bool fullLoad)
    {
        if (IsAControlInstance && fullLoad)
        {
            await RunWithRemoteInventoryRefreshLock(async () =>
            {
                if (ShutDownReserve || Status == BackendStatus.DISABLED)
                {
                    return;
                }
                bool restoreRunning = Status == BackendStatus.RUNNING;
                HashSet<int> existingChildIDs = restoreRunning ? [.. ControlledNonrealBackends.Keys] : null;
                await ReviseRemoteDataListInternal(fullLoad);
                if (restoreRunning)
                {
                    SetRemoteInventoryStatus(BackendStatus.RUNNING, existingChildIDs);
                }
            });
            return;
        }
        await ReviseRemoteDataListInternal(fullLoad);
    }

    /// <summary>Internal implementation of <see cref="ReviseRemoteDataList(bool)"/>. Caller serializes full control-backend refreshes.</summary>
    private async Task ReviseRemoteDataListInternal(bool fullLoad)
    {
        string[] requiredSubtypes = IsAControlInstance && fullLoad
            ? [.. Program.T2IModelSets.Keys.Order(StringComparer.Ordinal)]
            : null;
        if (requiredSubtypes is not null)
        {
            InvalidateRemoteModelInventory(requiredSubtypes);
        }
        try
        {
            await RunWithSession(async () =>
            {
                JObject backendData = await HttpClient.PostJson($"{Address}/API/ListBackends", new() { ["session_id"] = Session, ["nonreal"] = true, ["full_data"] = true }, RequestAdapter());
                AutoThrowException(backendData);
                if (fullLoad)
                {
                    Logs.Verbose($"{HandlerTypeData.Name} {BackendData.ID} Got backend data list");
                }
                if (IsAControlInstance && fullLoad)
                {
                    RemoteModelInventorySnapshot snapshot = await LoadRemoteModelInventory(requiredSubtypes);
                    PublishRemoteModelInventory(snapshot);
                    Logs.Verbose($"{HandlerTypeData.Name} {BackendData.ID} published a complete model inventory from {Address}.");
                }
                HashSet<string> features = [], types = [];
                bool isLoading = false;
                int runningBackends = 0;
                bool allowBackendForwarding = Settings.AllowForwarding && !RemoteIsSpokeMode;
                HashSet<int> ids = IsAControlInstance ? new(ControlledNonrealBackends.Keys) : null;
                if (!IsAControlInstance)
                {
                    if (backendData.TryGetValue($"{LinkedRemoteBackendID}", out JToken data))
                    {
                        backendData = new JObject()
                        {
                            [$"{LinkedRemoteBackendID}"] = data
                        };
                    }
                    else
                    {
                        return;
                    }
                }
                foreach (JToken backend in backendData.Values())
                {
                    int id = backend["id"].Value<int>();
                    string type = backend["type"].ToString();
                    if (IsAControlInstance && !allowBackendForwarding && type == "swarmswarmbackend")
                    {
                        continue;
                    }
                    JToken canLoadModelsToken = backend["can_load_models"];
                    if (canLoadModelsToken is null)
                    {
                        continue;
                    }
                    if (canLoadModelsToken.Type != JTokenType.Boolean)
                    {
                        throw new SwarmReadableErrorException($"Remote backend {id} returned an invalid can_load_models value.");
                    }
                    bool canLoadModels = canLoadModelsToken.Value<bool>();
                    JToken maxUsagesToken = backend["max_usages"];
                    if (maxUsagesToken is null || maxUsagesToken.Type != JTokenType.Integer
                        || !int.TryParse(maxUsagesToken.ToString(), out int maxUsages) || maxUsages < 0)
                    {
                        throw new SwarmReadableErrorException($"Remote backend {id} returned an invalid max_usages value.");
                    }
                    if (!HasRoutableModelCapacity(canLoadModels, maxUsages))
                    {
                        continue;
                    }
                    string status = backend["status"].ToString();
                    if (status == "running")
                    {
                        runningBackends++;
                        features.UnionWith(backend["features"].ToArray().Select(f => f.ToString()));
                        string title = backend["title"].ToString();
                        types.Add(type);
                        if (IsAControlInstance && !ids.Remove(id))
                        {
                            Logs.Verbose($"{HandlerTypeData.Name} {BackendData.ID} adding remote backend {id} ({type}) '{title}'");
                            // TODO: support remote non-T2I Backends
                            Handler.AddNewNonrealBackend(HandlerTypeData, BackendData, SettingsRaw, (newData) =>
                            {
                                SwarmSwarmBackend newSwarm = newData.AbstractBackend as SwarmSwarmBackend;
                                newSwarm.LinkedRemoteBackendID = id;
                                newSwarm.Models = Models;
                                newSwarm.LinkedRemoteBackendType = type;
                                newSwarm.Title = $"[Remote from {BackendData.ID}: {Title}] {title}";
                                newSwarm.CanLoadModels = true;
                                newSwarm.Parent = this;
                                OnSwarmBackendAdded?.Invoke(newSwarm);
                                ControlledNonrealBackends.TryAdd(id, newData as BackendHandler.T2IBackendData);
                            });
                        }
                        if (ControlledNonrealBackends.TryGetValue(id, out BackendHandler.T2IBackendData data))
                        {
                            data.Backend.MaxUsages = maxUsages;
                            data.Backend.CurrentModelName = (string)backend["current_model"];
                        }
                    }
                    else if (IsPendingRemoteBackendStatus(status))
                    {
                        isLoading = true;
                    }
                }
                ValidateSpokeBackendAvailability(RemoteIsSpokeMode && IsAControlInstance && fullLoad, runningBackends, isLoading);
                if (IsAControlInstance)
                {
                    foreach (int id in ids)
                    {
                        Logs.Verbose($"{HandlerTypeData.Name} {BackendData.ID} removing remote backend {id}.");
                        if (ControlledNonrealBackends.Remove(id, out BackendHandler.T2IBackendData data))
                        {
                            await Handler.DeleteById(data.ID);
                        }
                    }
                }
                foreach (string str in features.Where(f => !RemoteFeatureCombo.ContainsKey(f)))
                {
                    RemoteFeatureCombo.TryAdd(str, str);
                }
                foreach (string str in RemoteFeatureCombo.Keys.Where(f => !features.Contains(f)))
                {
                    RemoteFeatureCombo.TryRemove(str, out _);
                }
                AnyLoading = isLoading;
                RemoteBackendTypes = types;
                ReviseRemotesEvent?.Invoke(this);
            });
        }
        catch (Exception ex)
        {
            if (requiredSubtypes is not null)
            {
                InvalidateRemoteModelInventory(requiredSubtypes);
                SetRemoteInventoryFailureStatus(ex);
            }
            throw;
        }
    }

    public class SessionInvalidException : Exception
    {
    }

    public async Task RunWithSession(Func<Task> run)
    {
        try
        {
            await run();
        }
        catch (SessionInvalidException)
        {
            Logs.Verbose($"{HandlerTypeData.Name} {BackendData.ID} session invalid, resetting...");
            await ValidateAndBuild();
            await RunWithSession(run);
        }
    }

    /// <summary>Performs a cheap steady-state liveness probe and one full inventory refresh after any failed probe.</summary>
    private void ValidateIdleConnection()
    {
        if (!RemoteInventoryReady)
        {
            TriggerRefresh().GetAwaiter().GetResult();
            return;
        }
        try
        {
            ReviseRemoteDataList(false).GetAwaiter().GetResult();
        }
        catch
        {
            string[] requiredSubtypes = [.. Program.T2IModelSets.Keys.Order(StringComparer.Ordinal)];
            InvalidateRemoteModelInventory(requiredSubtypes);
            throw;
        }
    }

    /// <inheritdoc/>
    public override async Task Init()
    {
        Logs.Verbose($"{HandlerTypeData.Name} {BackendData.ID} Init, IsReal={IsReal}, IsControl={IsAControlInstance}, Address={Settings.Address}");
        if (IsAControlInstance)
        {
            CanLoadModels = false;
            Models = [];
        }
        if (string.IsNullOrWhiteSpace(Settings.Address))
        {
            Status = BackendStatus.DISABLED;
            return;
        }
        if (!IsAControlInstance)
        {
            Status = BackendStatus.LOADING;
            try
            {
                await ValidateAndBuild();
                Status = BackendStatus.RUNNING;
            }
            catch (Exception ex)
            {
                Logs.Verbose($"{HandlerTypeData.Name} {BackendData.ID} failed to load, WillIdle={Settings.AllowIdle}, Status={Status}: {ex.ReadableString()}");
                if (Status != BackendStatus.LOADING)
                {
                    return;
                }
                if (Settings.AllowIdle && !NetworkBackendUtils.IdleMonitor.ExceptionIsNonIdleable(ex))
                {
                    Status = BackendStatus.IDLE;
                }
                else
                {
                    Status = BackendStatus.ERRORED;
                    Logs.Error($"Non-real {HandlerTypeData.Name} {BackendData.ID} failed to load: {ex.ReadableString()}");
                }
            }
            return;
        }
        Idler.Stop();
        async Task PostEnable()
        {
            if (Settings.AllowIdle)
            {
                Idler.Backend = this;
                Idler.ValidateCall = ValidateIdleConnection;
                Idler.StatusChangeEvent = status =>
                {
                    foreach (BackendHandler.T2IBackendData data in ControlledNonrealBackends.Values)
                    {
                        data.Backend.Status = status;
                    }
                };
                Idler.Start();
            }
        }
        int attempts = 0;
        while (true)
        {
            try
            {
                Status = BackendStatus.LOADING;
                await ValidateAndBuild();
                _ = Task.Run(async () =>
                {
                    try
                    {
                        while (AnyLoading)
                        {
                            Logs.Debug($"{HandlerTypeData.Name} {BackendData.ID} waiting for remote backends to load, have featureset {RemoteFeatureCombo.Keys.JoinString(", ")}");
                            if (Program.GlobalProgramCancel.IsCancellationRequested
                                || Status != BackendStatus.LOADING)
                            {
                                return;
                            }
                            await Task.Delay(TimeSpan.FromSeconds(1));
                            await ReviseRemoteDataList(true);
                        }
                        Status = BackendStatus.RUNNING;
                    }
                    catch (Exception ex)
                    {
                        if (!Settings.AllowIdle || NetworkBackendUtils.IdleMonitor.ExceptionIsNonIdleable(ex))
                        {
                            Logs.Error($"{HandlerTypeData.Name} {BackendData.ID} failed to load: {ex.ReadableString()}");
                            Status = BackendStatus.ERRORED;
                            return;
                        }
                    }
                    await PostEnable();
                });
                break;
            }
            catch (Exception)
            {
                if (attempts++ < FirstLoadRetries)
                {
                    await Task.Delay(TimeSpan.FromSeconds(FirstLoadRetryWaitSeconds));
                    continue;
                }
                if (!Settings.AllowIdle)
                {
                    throw;
                }
                await PostEnable();
                break;
            }
        }
    }

    /// <inheritdoc/>
    public override async Task Shutdown()
    {
        if (IsAControlInstance)
        {
            Logs.Info($"{HandlerTypeData.Name} {BackendData.ID} shutting down...");
            Idler.Stop();
            await RunWithRemoteInventoryShutdownLock(async () =>
            {
                foreach (BackendHandler.T2IBackendData data in ControlledNonrealBackends.Values)
                {
                    await Handler.DeleteById(data.ID);
                }
                ControlledNonrealBackends.Clear();
                await CloseRemoteSpokeSession();
                RemoteInventoryReady = false;
                RemoteModels = null;
                Status = BackendStatus.DISABLED;
            });
            return;
        }
        await CloseRemoteSpokeSession();
        Status = BackendStatus.DISABLED;
    }

    /// <inheritdoc/>
    public override async Task<bool> LoadModel(T2IModel model, T2IParamInput input)
    {
        if (IsAControlInstance)
        {
            return false;
        }
        if (input is not null && input.Get(T2IParamTypes.NoLoadModels, false))
        {
            CurrentModelName = model.Name;
            return true;
        }
        bool success = false;
        await RunWithSession(async () =>
        {
            JObject req = new()
            {
                ["session_id"] = Session,
                ["model"] = model.Name,
                ["backendId"] = LinkedRemoteBackendID
            };
            JObject response = await HttpClient.PostJson($"{Address}/API/SelectModel", req, RequestAdapter());
            AutoThrowException(response);
            success = response.TryGetValue("success", out JToken successTok) && successTok.Value<bool>();
        });
        if (!success)
        {
            Logs.Debug($"{HandlerTypeData.Name} {BackendData.ID} remote backend failed to load model '{model.Name}'.");
            return false;
        }
        CurrentModelName = model.Name;
        return true;
    }

    /// <summary>Tell the remote SwarmUI instance to shut down fully.</summary>
    public async Task TriggerRemoteShutdown()
    {
        Logs.Verbose($"{HandlerTypeData.Name} {BackendData.ID} triggering remote swarm shutdown at {Address}");
        await SendAPIJSON("ShutdownServer", []);
    }

    /// <summary>Core handler to send a simple API JSON request. Will auto-inject a proper session ID.</summary>
    /// <param name="endpoint">The endpoint, only after the /API/ Part. For example, "GenerateText2Image".</param>
    /// <param name="request">The request JSON body.</param>
    /// <returns>The JSON response.</returns>
    public async Task<JObject> SendAPIJSON(string endpoint, JObject request)
    {
        request = request.DeepClone() as JObject;
        JObject result = null;
        await RunWithSession(async () =>
        {
            request["session_id"] = Session;
            result = await HttpClient.PostJson($"{Address}/API/{endpoint}", request, RequestAdapter());
            AutoThrowException(result);
        });
        return result;
    }

    /// <summary>Builds the required JSON input for a GenerateText2Image API request based on a <see cref="T2IParamInput"/> to generate.</summary>
    public JObject BuildRequest(T2IParamInput user_input)
    {
        JObject req = user_input.ToJSON();
        req[T2IParamTypes.Images.Type.ID] = 1;
        req["session_id"] = Session;
        req[T2IParamTypes.DoNotSave.Type.ID] = true;
        req.Remove(T2IParamTypes.ExactBackendID.Type.ID);
        req.Remove(T2IParamTypes.BackendType.Type.ID);
        if (!IsAControlInstance)
        {
            req[T2IParamTypes.ExactBackendID.Type.ID] = LinkedRemoteBackendID;
        }
        if (user_input.ReceiveRawBackendData is not null)
        {
            req[T2IParamTypes.ForwardRawBackendData.Type.ID] = true;
        }
        req[T2IParamTypes.ForwardSwarmData.Type.ID] = true;
        return req;
    }

    /// <inheritdoc/>
    public override async Task<Image[]> Generate(T2IParamInput user_input)
    {
        user_input.ProcessPromptEmbeds(x => $"<embedding:{x}>");
        JObject generated = SendAPIJSON("GenerateText2Image", BuildRequest(user_input)).Result;
        Image[] images = [.. generated["images"].Select(img => ImageFile.FromDataString(img.ToString()) as Image)];
        return images;
    }

    /// <inheritdoc/>
    public override async Task GenerateLive(T2IParamInput user_input, string batchId, Action<object> takeOutput)
    {
        if (!Settings.AllowWebsocket)
        {
            Image[] results = await Generate(user_input);
            foreach (MediaFile file in results)
            {
                takeOutput(file);
            }
            return;
        }
        user_input.ProcessPromptEmbeds(x => $"<embedding:{x}>");
        await RunWithSession(async () =>
        {
            ClientWebSocket websocket = await NetworkBackendUtils.ConnectWebsocket(Address, "API/GenerateText2ImageWS", ws =>
            {
                if (!string.IsNullOrWhiteSpace(Settings.AuthorizationHeader))
                {
                    ws.Options.SetRequestHeader("Authorization", Settings.AuthorizationHeader);
                }
                if (!string.IsNullOrWhiteSpace(Settings.OtherHeaders))
                {
                    foreach (string line in Settings.OtherHeaders.Split('\n'))
                    {
                        string[] parts = line.Split(':');
                        if (parts.Length != 2)
                        {
                            Logs.Error($"Invalid header line in SwarmSwarmBackend: '{line}'");
                            continue;
                        }
                        ws.Options.SetRequestHeader(parts[0].Trim(), parts[1].Trim());
                    }
                }
            });
            await websocket.SendJson(BuildRequest(user_input), API.WebsocketTimeout);
            Logs.Debug($"[{HandlerTypeData.Name}] WebSocket connected, remote backend {LinkedRemoteBackendID} should begin generating...");
            while (true)
            {
                if (user_input.InterruptToken.IsCancellationRequested)
                {
                    // TODO: This will require separate remote sessions per-user for multiuser support
                    await HttpClient.PostJson($"{Address}/API/InterruptAll", new() { ["session_id"] = Session, ["other_sessions"] = false }, RequestAdapter());
                }
                JObject response = await websocket.ReceiveJson(Utilities.ExtraLargeMaxReceive, true);
                if (response is not null)
                {
                    AutoThrowException(response);
                    if (response.TryGetValue("gen_progress", out JToken val) && val is JObject objVal)
                    {
                        if (objVal.ContainsKey("preview"))
                        {
                            Logs.Verbose($"[{HandlerTypeData.Name}] Got progress image from websocket {batchId}");
                        }
                        else
                        {
                            Logs.Verbose($"[{HandlerTypeData.Name}] Got progress from websocket for {batchId}: {response.ToDenseDebugString(true)}");
                        }
                        string actualId = batchId;
                        if (objVal.TryGetValue("batch_index", out JToken batchIndRemote) && int.TryParse($"{batchIndRemote}", out int batchIndRemoteParsed) && batchIndRemoteParsed > 0 && int.TryParse(batchId, out int localInd))
                        {
                            actualId = $"{localInd + batchIndRemoteParsed}";
                        }
                        objVal["batch_index"] = actualId;
                        objVal["request_id"] = $"{user_input.UserRequestId}";
                        takeOutput(objVal);
                    }
                    else if (response.TryGetValue("image", out val))
                    {
                        Logs.Verbose($"[{HandlerTypeData.Name}] Got image from websocket");
                        takeOutput(ImageFile.FromDataString(val.ToString()));
                    }
                    else if (response.TryGetValue("raw_backend_data", out JToken rawData))
                    {
                        string type = rawData["type"].ToString();
                        string datab64 = rawData["data"].ToString();
                        byte[] data = Convert.FromBase64String(datab64);
                        user_input.ReceiveRawBackendData?.Invoke(type, data);
                    }
                    else if (response.TryGetValue("raw_swarm_data", out JToken rawSwarmDataTok) && rawSwarmDataTok is JObject rawSwarmData)
                    {
                        Logs.Verbose($"Got raw spawn data from websocket: {rawSwarmData.ToDenseDebugString(true)}");
                        if (rawSwarmData.TryGetValue("params_used", out JToken paramsUsed))
                        {
                            foreach (JToken paramUsed in paramsUsed)
                            {
                                user_input.ParamsQueried.Add($"{paramUsed}");
                            }
                        }
                        if (user_input.Get(T2IParamTypes.ForwardSwarmData, false))
                        {
                            takeOutput(response);
                        }
                    }
                    else
                    {
                        Logs.Verbose($"[{HandlerTypeData.Name}] Got other from websocket: {response.ToDenseDebugString(true)}");
                    }
                }
                if (websocket.CloseStatus.HasValue)
                {
                    break;
                }
            }
            await websocket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, Program.GlobalProgramCancel);
        });
    }

    /// <summary>Implementations for <see cref="IsValidForThisBackend(T2IParamInput)"/> mapped by backend type id.</summary>
    public static ConcurrentDictionary<string, Func<SwarmSwarmBackend, T2IParamInput, bool>> ValidityChecks = [];

    /// <inheritdoc/>
    public override bool IsValidForThisBackend(T2IParamInput input)
    {
        if (IsAControlInstance)
        {
            input.RefusalReasons.Add("Control instances cannot generate.");
            return false;
        }
        if (Parent is not null && !Parent.RemoteInventoryReady)
        {
            input.RefusalReasons.Add("Remote model inventory is not complete.");
            return false;
        }
        if (string.IsNullOrWhiteSpace(LinkedRemoteBackendType))
        {
            input.RefusalReasons.Add("No loaded remote backend.");
            return false;
        }
        if (ValidityChecks.TryGetValue(LinkedRemoteBackendType, out Func<SwarmSwarmBackend, T2IParamInput, bool> func))
        {
            return func(this, input);
        }
        return true;
    }

    /// <inheritdoc/>
    public override async Task<bool> FreeMemory(bool systemRam)
    {
        if (IsAControlInstance)
        {
            return false;
        }
        bool result = false;
        await RunWithSession(async () =>
        {
            JObject response = await HttpClient.PostJson($"{Address}/API/FreeBackendMemory", new() { ["session_id"] = Session, ["system_ram"] = systemRam, ["backend"] = $"{LinkedRemoteBackendID}" }, RequestAdapter());
            AutoThrowException(response);
            result = response["result"].Value<bool>();
        });
        return Volatile.Read(ref result);
    }
}
