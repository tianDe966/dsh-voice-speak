// dsh-tts-helper — offline Chinese speech synthesis for dsh-voice-speak.
//
// Why this exists: the previous local path went
//   PowerShell -> System.Speech -> SAPI 5 -> NaturalVoiceSAPIAdapter.dll
// which needs a system-wide regsvr32 (admin) registration. The adapter turns
// out to be only a SAPI wrapper: the actual synthesis is the Microsoft
// Embedded Speech SDK, and the license it needs can be recovered from the local
// voice model files. So this helper talks to the SDK directly and needs no
// registration, no admin rights and no PowerShell.
//
// Contract (kept deliberately small):
//   dsh-tts-helper --sdk <dir> --voice <dir> --out <file.wav> --text-b64 <base64>
//                  [--pitch +10%] [--rate -4%] [--timeout-ms 20000]
//   exit 0  ok            (stdout: ok wav=<bytes> synth_ms=<n> voice=<name>)
//   exit 2  bad arguments
//   exit 4  sdk or voice folder unusable (caller should fall back)
//   exit 5  no embedded license found in the voice folder
//   exit 6  synthesis cancelled / failed
//   exit 7  produced no audio
//
// The text travels as base64 so nothing depends on console encodings, and the
// SDK DLLs stay outside this executable's folder: SetDllDirectory + an
// AssemblyResolve hook point .NET at --sdk.
//
// C# 5 syntax only: the machine's compiler is the .NET Framework 4.8 csc.exe.

using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Program
{
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetDllDirectory(string lpPathName);

    /// <summary>
    /// Deliberately dumb entry point: it must not mention any SDK type, or the
    /// JIT would try to load the SDK before the assembly resolver is installed.
    /// </summary>
    private static int Main(string[] args)
    {
        try
        {
            Options options = Options.Parse(args);
            if (options == null)
            {
                Console.Error.WriteLine("usage: dsh-tts-helper --sdk <dir> --voice <dir> --out <wav> --text-b64 <base64> [--pitch +10%] [--rate -4%]");
                return 2;
            }
            if (!Directory.Exists(options.SdkDir) || !Directory.Exists(options.VoiceDir))
            {
                Console.Error.WriteLine("helper: missing sdk or voice directory");
                return 4;
            }

            string sdkDir = options.SdkDir;
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs request)
            {
                string simple = new AssemblyName(request.Name).Name + ".dll";
                string candidate = Path.Combine(sdkDir, simple);
                return File.Exists(candidate) ? Assembly.LoadFrom(candidate) : null;
            };
            SetDllDirectory(sdkDir);

            return Runner.Run(options);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("helper: " + error.GetType().Name + ": " + error.Message);
            return 6;
        }
    }
}

/// <summary>Command line, parsed without touching the SDK.</summary>
internal sealed class Options
{
    public string SdkDir;
    public string VoiceDir;
    public string OutFile;
    public string Text;
    public string Pitch = "+10%";
    public string Rate = "-4%";
    public int TimeoutMs = 20000;

    public static Options Parse(string[] args)
    {
        Options options = new Options();
        for (int i = 0; i < args.Length; i += 1)
        {
            string key = args[i];
            string value = i + 1 < args.Length ? args[i + 1] : null;
            switch (key)
            {
                case "--sdk": options.SdkDir = value; i += 1; break;
                case "--voice": options.VoiceDir = value; i += 1; break;
                case "--out": options.OutFile = value; i += 1; break;
                case "--pitch": options.Pitch = value; i += 1; break;
                case "--rate": options.Rate = value; i += 1; break;
                case "--timeout-ms": options.TimeoutMs = int.Parse(value, CultureInfo.InvariantCulture); i += 1; break;
                case "--text-b64":
                    options.Text = Encoding.UTF8.GetString(Convert.FromBase64String(value));
                    i += 1;
                    break;
                default:
                    return null;
            }
        }
        if (string.IsNullOrEmpty(options.SdkDir) || string.IsNullOrEmpty(options.VoiceDir)
            || string.IsNullOrEmpty(options.OutFile) || options.Text == null)
        {
            return null;
        }
        return options;
    }
}
