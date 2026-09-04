
using FreneticUtilities.FreneticDataSyntax;
using SwarmUI.Core;
using SwarmUI.DataHolders;
using SwarmUI.Utils;

namespace SwarmUI.Builtin_ComfyUIBackend;

public class ComfyUIAPIBackend : ComfyUIAPIAbstractBackend
{
    public class ComfyUIAPISettings : AutoConfiguration
    {
        /// <summary>Base web address of the ComfyUI instance.</summary>
        [SuggestionPlaceholder(Text = "ComfyUI's address...")]
        [ConfigComment("The address of the ComfyUI instance, eg 'http://localhost:8188'.")]
        public string Address = "";

        [ConfigComment("Whether the backend is allowed to revert to an 'idle' state if the API address is unresponsive.\nAn idle state is not considered an error, but cannot generate.\nIt will automatically return to 'running' if the API becomes available.")]
        public bool AllowIdle = false;

        [ConfigComment("How many extra requests may queue up on this backend while one is processing.")]
        public int OverQueue = 1;

        [ConfigComment("If true, the backend address will use '/api/' for API calls to enable passthrough of a frontend NPM dev server.")]
        public bool EnableFrontendDev = false;
    }

    public ComfyUIAPISettings Settings => SettingsRaw as ComfyUIAPISettings;

    public override string APIAddress => Settings.Address.TrimEnd('/') + (Settings.EnableFrontendDev ? "/api" : "");

    public override string WebAddress => Settings.Address.TrimEnd('/');

    public override bool CanIdle => Settings.AllowIdle;

    public override int OverQueue => Settings.OverQueue;

    /// <summary>Returns whether an external Comfy address resolves syntactically to a loopback URI.</summary>
    public static bool IsLoopbackAddress(string address)
    {
        return Uri.TryCreate(address, UriKind.Absolute, out Uri uri) && uri.IsLoopback;
    }

    public override Task Init()
    {
        if (Program.IsSpokeMode && !IsLoopbackAddress(Settings.Address))
        {
            throw new SwarmReadableErrorException("Spoke mode requires external Comfy API backends to use a loopback address. Bind Comfy to loopback or enforce an equivalent host firewall rule.");
        }
        return InitInternal(CanIdle);
    }
}
