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
        private static readonly Dictionary<string, string> pendingDesktopInputCalls = new Dictionary<string, string>();

        private static void ObserveLiveDesktopForTest(string id, int seconds, string output)
        {
            string isolated = Environment.GetEnvironmentVariable("AI_PET_DATA_DIR");
            if (String.IsNullOrEmpty(isolated) || String.Equals(Path.GetFullPath(isolated).TrimEnd('\\'),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AI Pet Studio"), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Live observation requires an isolated data directory.");
            if (seconds < 1 || seconds > 300 || File.Exists(output)) throw new InvalidDataException("Invalid observation duration or existing output.");
            ConnectSimpleCodex(id);
            if (selectedDesktopRolloutPath == null) throw new InvalidDataException("The selected real desktop session was not found.");
            Directory.CreateDirectory(Path.GetDirectoryName(output));
            List<object> transitions = new List<object>(); string previous = null; bool observed = false;
            System.Diagnostics.Stopwatch elapsed = System.Diagnostics.Stopwatch.StartNew();
            Action<bool> report = delegate(bool running) {
                WriteCodexEventAtomically(output, new JavaScriptSerializer().Serialize(new {
                    running = running, pid = System.Diagnostics.Process.GetCurrentProcess().Id,
                    observedInputRequest = observed, session = connectedAiSession, transitions = transitions }));
            };
            report(true);
            while (elapsed.Elapsed.TotalSeconds < seconds) {
                PollAiConnection();
                if (lastCodexActionEventId != null && lastCodexActionEventId != previous) {
                    previous = lastCodexActionEventId;
                    transitions.Add(new { state = lastAiState, source = lastCodexActionSource, evidence = lastCodexActionEvidence });
                    observed = lastAiState == "needs-user" && lastCodexActionSource == "desktop-rollout";
                    report(true); if (observed) break;
                }
                System.Threading.Thread.Sleep(200);
            }
            report(false);
        }

        private static void ObserveDesktopInputRequest(Dictionary<string, object> record, byte[] bytes, int start, int length, long offset)
        {
            // Desktop compatibility source: recognize a displayed input request, never question-like prose.
            DateTimeOffset recordedAt;
            if (ReadString(record, "type") != "response_item" ||
                !DateTimeOffset.TryParse(ReadString(record, "timestamp"), System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal, out recordedAt)) return;
            long age = CurrentUnixMilliseconds() - (recordedAt.ToUniversalTime().Ticks - 621355968000000000L) / TimeSpan.TicksPerMillisecond;
            if (age < -5000 || age > 15000) return;
            Dictionary<string, object> payload = record.ContainsKey("payload") ? record["payload"] as Dictionary<string, object> : null;
            string kind = ReadString(payload, "type"), id = ReadString(payload, "call_id");
            if (!Regex.IsMatch(id, "^call_[A-Za-z0-9_-]{1,128}$")) return;
            if (kind == "function_call" && ReadString(payload, "name") == "request_user_input_async") {
                Dictionary<string, object> metadata = payload.ContainsKey("internal_chat_message_metadata_passthrough")
                    ? payload["internal_chat_message_metadata_passthrough"] as Dictionary<string, object> : null;
                string turn = ReadString(metadata, "turn_id");
                if (!Regex.IsMatch(turn, "^[a-f0-9-]{36}$")) return;
                if (pendingDesktopInputCalls.Count >= 64) pendingDesktopInputCalls.Clear();
                pendingDesktopInputCalls[id] = turn;
            } else if (kind == "function_call_output" && pendingDesktopInputCalls.ContainsKey(id)) {
                string turn = pendingDesktopInputCalls[id]; pendingDesktopInputCalls.Remove(id);
                string output = ReadString(payload, "output");
                if (output.Length < 2 || output.Length > 1024) return;
                EnsureNoDuplicateJsonObjectKeys(output);
                Dictionary<string, object> result = new JavaScriptSerializer().DeserializeObject(output) as Dictionary<string, object>;
                if (result == null || !result.ContainsKey("accepted") || !(result["accepted"] is bool) || !(bool)result["accepted"]) return;
                WriteDesktopLifecycleEvent("DesktopUserInputRequested", CodexEvidenceJson("desktop-rollout", bytes, start, length, offset, turn));
            }
        }

        private static string SimpleCodexState(string name)
        {
            if (name == "UserPromptSubmit" || name == "DesktopTurnStarted") return "started";
            if (name == "PreToolUse" || name == "PostToolUse" || name == "DesktopToolActivity") return "running";
            if (name == "Stop" || name == "DesktopTurnEndedUnknown") return "finished";
            if (name == "Interrupt" || name == "DesktopTurnInterrupted") return "paused";
            if (name == "PermissionRequest" || name == "DesktopUserInputRequested") return "needs-user";
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
