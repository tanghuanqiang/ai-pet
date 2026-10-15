using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace AIPet.Desktop
{
    internal static partial class DesktopPet
    {
        private static string SimpleCodexState(string name)
        {
            if (name == "UserPromptSubmit" || name == "DesktopTurnStarted") return "started";
            if (name == "PreToolUse" || name == "PostToolUse" || name == "DesktopToolActivity") return "running";
            if (name == "Stop" || name == "DesktopTurnEndedUnknown") return "finished";
            if (name == "Interrupt" || name == "DesktopTurnInterrupted") return "paused";
            if (name == "PermissionRequest") return "needs-user";
            return null;
        }

        private static void ConnectSimpleCodex(string id)
        {
            if (id == null || !Regex.IsMatch(id, @"\A[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\z"))
                throw new InvalidDataException("请提供真实 Codex 会话标识。");
            ClearDesktopSelection(); selectedCodexSession = null; selectedDesktopRolloutPath = null;
            string root = CodexSessionsRoot();
            if (Directory.Exists(root)) {
                // Only inspect metadata of files naming this exact session, never other task bodies.
                foreach (string file in Directory.GetFiles(root, "rollout-*" + id + ".jsonl", SearchOption.AllDirectories)) {
                    string actual, cwd;
                    if (!TryReadDesktopSession(file, root, out actual, out cwd) || actual != id) continue;
                    selectedDesktopRolloutPath = file; selectedCodexSession = DesktopSessionHash(id);
                    SaveDesktopSelection(); break;
                }
            }
            SaveAiConnection("codex", DesktopSessionHash(id));
        }

        private static void RecordSimpleCodexHook()
        {
            // Hook observers emit no stdout and cannot approve, block, or continue Codex.
            // Prompt and tool payloads are discarded in memory and never written to disk.
            try {
                const int limit = 2 * 1024 * 1024;
                byte[] input = new byte[limit + 1]; int count = 0;
                using (Stream stream = Console.OpenStandardInput()) {
                    while (count < input.Length) {
                        int read = stream.Read(input, count, input.Length - count);
                        if (read == 0) break;
                        count += read;
                    }
                }
                if (count < 2 || count > limit || connectedAiTool != "codex") return;
                string json = new UTF8Encoding(false, true).GetString(input, 0, count);
                EnsureNoDuplicateJsonObjectKeys(json);
                Dictionary<string, object> hook = new JavaScriptSerializer { MaxJsonLength = limit, RecursionLimit = 32 }
                    .DeserializeObject(json) as Dictionary<string, object>;
                string id = ReadString(hook, "session_id");
                string state = SimpleCodexState(ReadString(hook, "hook_event_name"));
                if (String.IsNullOrEmpty(id) || id.Length > 128 || state == null || DesktopSessionHash(id) != connectedAiSession) return;
                Directory.CreateDirectory(aiEventsPath);
                string eventId = Guid.NewGuid().ToString("N"); long now = CurrentUnixMilliseconds();
                WriteCodexEventAtomically(Path.Combine(aiEventsPath, now.ToString("D13") + "." + eventId + ".json"),
                    new JavaScriptSerializer().Serialize(new { version = 1, eventId = eventId, observedAtMs = now,
                        tool = "codex", session = connectedAiSession, state = state }));
                PruneAiEvents();
            }
            catch (Exception) { /* Optional animation must never affect the user's task. */ }
        }
    }
}
