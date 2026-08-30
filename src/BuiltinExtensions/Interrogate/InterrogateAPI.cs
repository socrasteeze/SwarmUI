using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Builtin_ComfyUIBackend;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.Net.WebSockets;

namespace SwarmUI.Builtin_InterrogateExtension;

/// <summary>API routes for turning an image into tags or a prompt.</summary>
[API.APIClass("Routes for interrogating an image - that is, generating tags or a text prompt that describes it.")]
public static class InterrogateAPI
{
    /// <summary>Registers every route in this class.</summary>
    public static void Register()
    {
        API.RegisterAPICall(ListInterrogateBackends, false, InterrogateExtension.PermUseInterrogate);
        API.RegisterAPICall(InterrogateImage, false, InterrogateExtension.PermUseInterrogate);
    }

    [API.APIDescription("Lists the interrogation backends that are usable right now, and any that could be installed.",
        """
        "backends":
        [
            {
                "id": "wd14tagger",
                "display": "WD14 Tagger",
                "description": "...",
                "output_kind": "tags",
                "available": true,
                "install_feature": "wd14tagger"
            }
        ],
        "wd14_models": ["wd-v1-4-moat-tagger-v2.onnx"],
        "florence2_models": ["microsoft/Florence-2-base"]
        """)]
    public static async Task<JObject> ListInterrogateBackends(Session session)
    {
        HashSet<string> features = Program.Backends.GetAllSupportedFeatures();
        JArray backends = [];
        foreach (InterrogateBackends.InterrogateBackend backend in InterrogateBackends.Backends.Values)
        {
            backends.Add(new JObject()
            {
                ["id"] = backend.ID,
                ["display"] = backend.Display,
                ["description"] = backend.Description,
                ["output_kind"] = backend.OutputKind,
                ["available"] = features.Contains(backend.FeatureFlag),
                ["install_feature"] = backend.InstallFeatureID
            });
        }
        return new JObject()
        {
            ["backends"] = backends,
            ["wd14_models"] = new JArray(InterrogateBackends.WD14Models),
            ["florence2_models"] = new JArray(InterrogateBackends.Florence2Models)
        };
    }

    [API.APIDescription("Interrogates one image, returning tags or a descriptive prompt. Streams status updates, then a final result object.",
        """
        "result": "1girl, solo, long hair",
        "backend": "wd14tagger",
        "output_kind": "tags"
        """)]
    public static async Task<JObject> InterrogateImage(WebSocket socket, Session session,
        [API.APIParameter("The image to interrogate, as a base64 string or a `data:` URI.")] string image,
        [API.APIParameter("ID of the interrogation backend to use, from ListInterrogateBackends.")] string backend,
        [API.APIParameter("Optional JSON object of backend-specific options, eg threshold for the tagger.")] string options = null)
    {
        if (!InterrogateBackends.Backends.TryGetValue(backend, out InterrogateBackends.InterrogateBackend backendData))
        {
            await socket.SendAndReportError($"InterrogateImage request from {session.User.UserID}", $"Unknown interrogation backend '{backend}'.", API.WebsocketTimeout);
            return null;
        }
        if (!Program.Backends.GetAllSupportedFeatures().Contains(backendData.FeatureFlag))
        {
            await socket.SendAndReportError($"InterrogateImage request from {session.User.UserID}", $"The '{backendData.Display}' backend needs ComfyUI nodes that are not installed. Install them first.", API.WebsocketTimeout);
            return null;
        }
        // Accept a full data URI as well as bare base64, since the frontend gets both shapes depending on whether
        // the image came from a fresh generation (data URI) or was fetched out of history.
        string imageB64 = image.StartsWith("data:") ? image.After(";base64,") : image;
        if (string.IsNullOrWhiteSpace(imageB64))
        {
            await socket.SendAndReportError($"InterrogateImage request from {session.User.UserID}", "No image data was supplied.", API.WebsocketTimeout);
            return null;
        }
        JObject optionData = null;
        if (!string.IsNullOrWhiteSpace(options))
        {
            try
            {
                optionData = options.ParseToJson();
            }
            catch (Exception)
            {
                await socket.SendAndReportError($"InterrogateImage request from {session.User.UserID}", "Interrogation options were not valid JSON.", API.WebsocketTimeout);
                return null;
            }
        }
        await API.RunWebsocketHandlerCallWS(InterrogateImage_Internal, session, (backendData, imageB64, optionData), socket);
        return null;
    }

    /// <summary>Internal handler: runs the interrogation workflow on a Comfy backend and reports the text back.</summary>
    public static async Task InterrogateImage_Internal(Session session, (InterrogateBackends.InterrogateBackend, string, JObject) input, Action<JObject> output, bool isWS)
    {
        (InterrogateBackends.InterrogateBackend backendData, string imageB64, JObject optionData) = input;
        ComfyUIAPIAbstractBackend comfy = ComfyUIBackendExtension.RunningComfyBackends.FirstOrDefault();
        if (comfy is null)
        {
            output(new JObject() { ["error"] = "No ComfyUI backend is running, so there is nothing to interrogate with." });
            return;
        }
        JObject workflow = backendData.BuildWorkflow(imageB64, optionData);
        // Own the T2IParamInput rather than calling RunArbitraryWorkflowOnFirstBackend, which builds its own
        // internally and therefore gives the caller no way to read the ExtraMeta the returned text lands in.
        T2IParamInput probe = new(null);
        output(new JObject() { ["status"] = "running" });
        try
        {
            await comfy.AwaitJobLive(workflow.ToString(), "0", obj =>
            {
                if (obj is JObject jobj && jobj.ContainsKey("overall_percent"))
                {
                    output(jobj);
                }
            }, probe, Program.GlobalProgramCancel);
        }
        catch (SwarmReadableErrorException ex)
        {
            output(new JObject() { ["error"] = ex.Message });
            return;
        }
        if (!probe.ExtraMeta.TryGetValue($"custom_{InterrogateBackends.ResultKey}", out object result) || string.IsNullOrWhiteSpace($"{result}"))
        {
            Logs.Warning($"Interrogation via '{backendData.ID}' returned no text for {session.User.UserID}.");
            output(new JObject() { ["error"] = "The interrogation ran but returned no text. Check the server logs and the ComfyUI backend." });
            return;
        }
        output(new JObject()
        {
            ["result"] = $"{result}",
            ["backend"] = backendData.ID,
            ["output_kind"] = backendData.OutputKind
        });
    }
}
