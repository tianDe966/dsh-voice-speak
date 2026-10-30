// Synthesis half of dsh-tts-helper. Split from Program.cs on purpose: the JIT
// must not pull in the Speech SDK before Program has installed its resolver.
//
// The license recovery below is a port of the adapter's DRM helper
// (gexgd0419/NaturalVoiceSAPIAdapter, NaturalVoiceSAPIAdapter/Drm.h):
//   V1: printable bytes up to the first run of 16 lowercase-hex digits
//   V0: uint32 LE length, then that many bytes XORed with "##Encrypted##",
//       returned with a "Key:" prefix
// Only the licence text itself is passed to the SDK; nothing is written to disk.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using Microsoft.CognitiveServices.Speech;
using Microsoft.CognitiveServices.Speech.Audio;

internal static class Runner
{
    private const string V0Pad = "##Encrypted##";

    /// <summary>Synthesize one sentence to a WAV file.</summary>
    public static int Run(Options options)
    {
        Stopwatch clock = Stopwatch.StartNew();

        string license = FindLicense(options.VoiceDir);
        if (license == null)
        {
            Console.Error.WriteLine("helper: no embedded license in " + options.VoiceDir);
            return 5;
        }

        EmbeddedSpeechConfig config;
        try
        {
            config = EmbeddedSpeechConfig.FromPath(options.VoiceDir);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("helper: embedded config failed: " + error.Message);
            return 4;
        }
        config.SetSpeechSynthesisOutputFormat(SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm);
        config.SetProperty(PropertyId.SpeechServiceResponse_RequestSentenceBoundary, "true");
        config.SetProperty(PropertyId.SpeechServiceResponse_RequestPunctuationBoundary, "false");

        string voiceName;
        using (SpeechSynthesizer probe = new SpeechSynthesizer(config, null))
        {
            SynthesisVoicesResult voices = probe.GetVoicesAsync().GetAwaiter().GetResult();
            if (voices.Voices.Count == 0)
            {
                Console.Error.WriteLine("helper: no voice model in " + options.VoiceDir + " (" + voices.Reason + ")");
                return 4;
            }
            voiceName = voices.Voices[0].Name;
        }
        config.SetSpeechSynthesisVoice(voiceName, license);

        string ssml = "<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" xml:lang=\"zh-CN\">"
            + "<prosody pitch=\"" + options.Pitch + "\" rate=\"" + options.Rate + "\">"
            + Escape(options.Text) + "</prosody></speak>";

        // The SDK's native file writer fails with SPXERR_FILE_OPEN_FAILED on any
        // path with non-ASCII characters (measured 2026-10-30: a temp path under
        // C:\Users\赵航\... cannot be opened). So a non-ASCII request is rendered
        // to an ASCII scratch path and copied over afterwards; the caller is told
        // which file actually holds the audio.
        string renderPath = options.OutFile;
        if (!IsAscii(renderPath)) renderPath = ScratchPath(renderPath);

        if (File.Exists(renderPath)) File.Delete(renderPath);
        SpeechSynthesisOutcome outcome = Synthesize(config, ssml, renderPath, options.TimeoutMs);
        if (outcome != SpeechSynthesisOutcome.Ok && renderPath != options.OutFile)
        {
            // A plain ASCII path can still fail (directory gone); try the scratch
            // location once before giving up.
            renderPath = ScratchPath(options.OutFile);
            if (File.Exists(renderPath)) File.Delete(renderPath);
            outcome = Synthesize(config, ssml, renderPath, options.TimeoutMs);
        }
        if (outcome != SpeechSynthesisOutcome.Ok)
        {
            Console.Error.WriteLine("helper: synthesis failed: " + outcome);
            return 6;
        }

        long bytes = new FileInfo(renderPath).Length;
        if (bytes <= 44)
        {
            Console.Error.WriteLine("helper: empty audio");
            return 7;
        }
        // Copying the finished WAV back to a non-ASCII request path can itself be
        // denied, and the caller only needs *a* path it can play, so the actual
        // file is reported instead of being relocated.
        Console.WriteLine("ok wav=" + bytes + " synth_ms=" + clock.ElapsedMilliseconds
            + " voice=" + voiceName + " out=" + renderPath);
        return 0;
    }

    /// <summary>True when every character is plain ASCII, which the SDK can open.</summary>
    private static bool IsAscii(string path)
    {
        foreach (char ch in path)
        {
            if (ch > 0x7e) return false;
        }
        return true;
    }

    /// <summary>
    /// An ASCII directory this process can actually write: the helper's own
    /// folder first, then the Windows temp folder, then the user temp (which may
    /// be non-ASCII, hence last). Creating folders under C:\Users\Public or
    /// C:\ProgramData needs admin, so those are not candidates.
    /// </summary>
    private static string ScratchPath(string requested)
    {
        string stem = Path.GetFileNameWithoutExtension(requested);
        if (string.IsNullOrEmpty(stem) || !IsAscii(stem)) stem = Guid.NewGuid().ToString("N");
        string[] roots = new string[]
        {
            Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "tts-tmp"),
            Path.Combine(Environment.GetEnvironmentVariable("WINDIR") ?? "C:\\Windows", "Temp", "dsh-voice-speak"),
            Path.GetTempPath(),
        };
        foreach (string root in roots)
        {
            try
            {
                Directory.CreateDirectory(root);
                string candidate = Path.Combine(root, stem + ".wav");
                using (File.Create(candidate)) { }
                File.Delete(candidate);
                return candidate;
            }
            catch (Exception)
            {
                // Try the next candidate.
            }
        }
        return Path.Combine(Path.GetTempPath(), stem + ".wav");
    }

    private enum SpeechSynthesisOutcome
    {
        Ok,
        Cancelled,
        TimedOut,
        Threw,
    }

    /// <summary>
    /// Speak, but never block forever: a wedged SDK must surface as a failure so
    /// the plugin can fall back to the cloud voice instead of hanging a turn.
    /// A timeout leaves the SDK task running; the process exits right after.
    /// </summary>
    private static SpeechSynthesisOutcome Synthesize(EmbeddedSpeechConfig config, string ssml, string outFile, int timeoutMs)
    {
        try
        {
            using (SpeechSynthesizer synth = new SpeechSynthesizer(config, AudioConfig.FromWavFileOutput(outFile)))
            {
                System.Threading.Tasks.Task<SpeechSynthesisResult> task = synth.SpeakSsmlAsync(ssml);
                if (!task.Wait(timeoutMs))
                {
                    return SpeechSynthesisOutcome.TimedOut;
                }
                return task.Result.Reason == ResultReason.SynthesizingAudioCompleted
                    ? SpeechSynthesisOutcome.Ok
                    : SpeechSynthesisOutcome.Cancelled;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("helper: synth threw: " + error.GetType().Name + ": " + error.Message);
            return SpeechSynthesisOutcome.Threw;
        }
    }

    private static string Escape(string value)
    {
        return value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;")
            .Replace("\"", "&quot;").Replace("'", "&apos;");
    }

    /// <summary>First .bin that yields a license wins; V1 is tried before V0, as upstream does.</summary>
    private static string FindLicense(string voiceDir)
    {
        List<string> files = new List<string>(Directory.GetFiles(voiceDir, "*.bin"));
        files.Sort(StringComparer.Ordinal);
        foreach (string file in files)
        {
            byte[] bytes = File.ReadAllBytes(file);
            string v1 = V1License(bytes);
            if (v1 != null) return v1;
            string v0 = V0Key(bytes);
            if (v0 != null) return "Key:" + v0;
        }
        return null;
    }

    private static string V1License(byte[] bytes)
    {
        StringBuilder text = new StringBuilder();
        int hexRun = 0;
        foreach (byte b in bytes)
        {
            if (b < 0x20 || b > 0x7e) return null;
            char ch = (char)b;
            text.Append(ch);
            bool isHex = (ch >= 'a' && ch <= 'f') || (ch >= '0' && ch <= '9');
            hexRun = isHex ? hexRun + 1 : 0;
            if (hexRun == 16) return text.ToString(0, text.Length - 16);
        }
        return null;
    }

    private static string V0Key(byte[] bytes)
    {
        if (bytes.Length < 4) return null;
        uint length = BitConverter.ToUInt32(bytes, 0);
        if (length > bytes.Length - 4 || length > 64 * 1024) return null;
        byte[] pad = Encoding.ASCII.GetBytes(V0Pad);
        StringBuilder text = new StringBuilder((int)length);
        for (int i = 0; i < length; i += 1)
        {
            text.Append((char)(bytes[4 + i] ^ pad[i % pad.Length]));
        }
        return text.ToString();
    }
}
