using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace AIPet.Desktop
{
    internal static partial class DesktopPet
    {
        private sealed class CodexWatch
        {
            public string Id, Hash, Path, Cwd, State, Turn, Evidence;
            public long Offset, SignalAt, StartedAt, EmittedAt, RecentActivity;
            public bool SkipLine;
            public Dictionary<string, string> Inputs = new Dictionary<string, string>();
        }
        private static readonly Dictionary<string, CodexWatch> codexWatches = new Dictionary<string, CodexWatch>(StringComparer.OrdinalIgnoreCase);
        private static string codexFollowPath, codexFollowText, codexFollowMode = "manual", codexSwitchReason;
        private static long codexDiscoveryAt, codexReleaseAt, codexSwitchedAt;
        private static bool applyingAutomaticCodex;
        private static Action<string, string> automaticCodexObserver;
        private const long CodexSignalLifetime = 5L * 60 * 1000;

        private static void InitializeCodexFollow(string root)
        {
            codexFollowPath = Path.Combine(root, "codex-follow.json");
            codexFollowMode = File.Exists(Path.Combine(root, "ai-connection.json")) ? "manual" : "auto";
            ReloadCodexFollow();
        }

        private static void ReloadCodexFollow()
        {
            try {
                if (!File.Exists(codexFollowPath)) return;
                string text = ReadBoundedJson(codexFollowPath);
                if (text == codexFollowText) return;
                Dictionary<string, object> data = new JavaScriptSerializer().DeserializeObject(text) as Dictionary<string, object>;
                string mode = ReadString(data, "mode");
                if (data == null || Convert.ToInt32(data["version"], CultureInfo.InvariantCulture) != 1 ||
                    (mode != "auto" && mode != "manual" && mode != "off")) return;
                bool changed = mode != codexFollowMode;
                codexFollowMode = mode; codexFollowText = text;
                if (changed) {
                    codexWatches.Clear(); codexDiscoveryAt = codexReleaseAt = codexSwitchedAt = 0; codexSwitchReason = null;
                    if (mode == "auto") { lastAiState = lastAiOutcome = null; ResetConnectedPlayback(); }
                }
            } catch (Exception) { /* Keep the last valid mode during atomic replacement. */ }
        }

        private static void SetCodexFollowMode(string mode)
        {
            if (mode != "auto" && mode != "manual" && mode != "off") throw new InvalidDataException("Unknown Codex follow mode.");
            Directory.CreateDirectory(experienceRoot);
            WriteCodexEventAtomically(codexFollowPath, new JavaScriptSerializer().Serialize(new { version = 1, mode = mode }));
            ReloadCodexFollow();
        }

        private static bool ActiveCodexWatch(CodexWatch watch, long now)
        {
            return watch != null && (watch.State == "started" || watch.State == "running" || watch.State == "needs-user") &&
                now - watch.SignalAt <= CodexSignalLifetime && now >= watch.SignalAt - 5000;
        }

        private static void DiscoverAutomaticCodex(long now)
        {
            if (now - codexDiscoveryAt < 5000) return;
            codexDiscoveryAt = now;
            string root = CodexSessionsRoot(); if (!Directory.Exists(root)) return;
            FileInfo[] files = new DirectoryInfo(root).GetFiles("rollout-*.jsonl", SearchOption.AllDirectories);
            Array.Sort(files, delegate(FileInfo a, FileInfo b) { return b.LastWriteTimeUtc.CompareTo(a.LastWriteTimeUtc); });
            int inspected = 0;
            foreach (FileInfo file in files) {
                if (inspected++ >= 128) break;
                if (DateTime.UtcNow - file.LastWriteTimeUtc > TimeSpan.FromDays(1)) continue;
                if (codexWatches.ContainsKey(file.FullName)) continue;
                string id, cwd;
                try { if (!TryReadDesktopSession(file.FullName, root, out id, out cwd, true)) continue; }
                catch (Exception) { continue; }
                CodexWatch duplicate = null;
                foreach (CodexWatch known in codexWatches.Values) if (known.Id == id) { duplicate = known; break; }
                if (duplicate != null) {
                    if (File.Exists(duplicate.Path)) continue;
                    codexWatches.Remove(duplicate.Path);
                }
                if (codexWatches.Count >= 32) {
                    CodexWatch oldest = null;
                    foreach (CodexWatch candidate in codexWatches.Values)
                        if (!ActiveCodexWatch(candidate, now) && (oldest == null || candidate.SignalAt < oldest.SignalAt)) oldest = candidate;
                    if (oldest == null) break;
                    codexWatches.Remove(oldest.Path);
                }
                long offset = Math.Max(0, file.Length - 512 * 1024);
                codexWatches[file.FullName] = new CodexWatch { Id = id, Hash = DesktopSessionHash(id), Path = file.FullName,
                    Cwd = cwd, Offset = offset, SkipLine = offset > 0 };
            }
        }

        private static void ReadAutomaticCodex(CodexWatch watch, long now)
        {
            FileInfo info = new FileInfo(watch.Path);
            if (!info.Exists || info.Length < watch.Offset) { watch.State = null; watch.Inputs.Clear(); watch.Offset = info.Exists ? info.Length : 0; return; }
            if (info.Length == watch.Offset) return;
            const int limit = 512 * 1024;
            byte[] bytes = new byte[(int)Math.Min(limit, info.Length - watch.Offset)];
            using (FileStream file = new FileStream(watch.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
                file.Position = watch.Offset;
                int count = 0, read;
                while (count < bytes.Length && (read = file.Read(bytes, count, bytes.Length - count)) > 0) count += read;
                if (count != bytes.Length) Array.Resize(ref bytes, count);
            }
            int newline = Array.LastIndexOf(bytes, (byte)'\n');
            if (newline < 0) {
                if (bytes.Length == limit) { watch.Offset += bytes.Length; watch.SkipLine = true; }
                return;
            }
            long origin = watch.Offset; watch.Offset += newline + 1;
            int start = 0;
            Dictionary<string, string> previousInputs = pendingDesktopInputCalls;
            long previousActivity = lastDesktopRecentActivityAtMs;
            try {
                pendingDesktopInputCalls = watch.Inputs; lastDesktopRecentActivityAtMs = watch.RecentActivity;
                for (int i = 0; i <= newline; i++) {
                    if (bytes[i] != (byte)'\n') continue;
                    if (!watch.SkipLine) {
                        try {
                            // The existing strict lifecycle/input parser is shared with
                            // manual follow. Capture only its sanitized observation.
                            const string prefix = "{\"timestamp\":\"";
                            int length = i - start;
                            if (length >= 32 && length <= 256 * 1024) {
                                string header = Encoding.UTF8.GetString(bytes, start, Math.Min(length, 80));
                                int end = header.IndexOf('"', prefix.Length);
                                DateTimeOffset recorded;
                                if (header.StartsWith(prefix, StringComparison.Ordinal) && end > prefix.Length &&
                                    DateTimeOffset.TryParse(header.Substring(prefix.Length, end - prefix.Length), CultureInfo.InvariantCulture,
                                        DateTimeStyles.AssumeUniversal, out recorded)) {
                                    long timestamp = (recorded.UtcDateTime.Ticks - 621355968000000000L) / TimeSpan.TicksPerMillisecond;
                                    if (timestamp <= now + 5000 && now - timestamp <= 120000) {
                                        automaticCodexObserver = delegate(string eventName, string evidence) { ObserveAutomaticCodex(watch, eventName, evidence, timestamp); };
                                        ReadDesktopLifecycleLine(bytes, start, length, origin + start);
                                    }
                                }
                            }
                        } catch (Exception) { /* One malformed line cannot stop other sessions. */ }
                    }
                    automaticCodexObserver = null; watch.SkipLine = false; start = i + 1;
                }
                watch.RecentActivity = lastDesktopRecentActivityAtMs;
            } finally { automaticCodexObserver = null; pendingDesktopInputCalls = previousInputs; lastDesktopRecentActivityAtMs = previousActivity; }
        }

        private static void ObserveAutomaticCodex(CodexWatch watch, string eventName, string evidence, long timestamp)
        {
            string state = SimpleCodexState(eventName);
            Dictionary<string, object> proof = new JavaScriptSerializer().DeserializeObject(evidence) as Dictionary<string, object>;
            string turn = ReadString(proof, "turn");
            if (state == null || timestamp < watch.SignalAt) return;
            if (state == "running" && (watch.State == "finished" || watch.State == "paused") && watch.Turn == turn) return;
            if (state != "started" && watch.Turn != null && watch.Turn != turn &&
                (watch.State == "started" || watch.State == "running" || watch.State == "needs-user")) return;
            // A tool completion belonging to the input-request call is not an answer.
            if (watch.State == "needs-user" && state == "running" && watch.Turn == turn) return;
            watch.Turn = turn; watch.State = state; watch.SignalAt = timestamp; watch.Evidence = evidence;
            if (state == "started") watch.StartedAt = timestamp;
        }

        private static void EmitAutomaticCodex(CodexWatch watch)
        {
            if (watch == null || watch.State == null) return;
            applyingAutomaticCodex = true;
            try {
                string eventId = Guid.NewGuid().ToString("N");
                if (!ApplyAiEvent(new Dictionary<string, object> { {"version",1}, {"eventId",eventId},
                    {"observedAtMs",CurrentUnixMilliseconds()}, {"tool","codex"}, {"session",watch.Hash}, {"state",watch.State} })) return;
                watch.EmittedAt = watch.SignalAt;
                lastCodexActionAtMs = CurrentUnixMilliseconds(); lastCodexActionEventId = eventId; lastCodexActionSession = watch.Hash;
                lastCodexActionEvidence = watch.Evidence == null ? null : new JavaScriptSerializer().DeserializeObject(watch.Evidence);
                lastCodexActionSource = watch.Evidence == null ? "agent-reported" : "desktop-auto"; lastCodexRequestedSlot = aiBindings[watch.State];
                lastCodexPlayedSlot = lastAiOutcome == "played" ? aiBindings[watch.State] : null; lastCodexActionOutcome = lastAiOutcome;
            } finally { applyingAutomaticCodex = false; }
        }

        private static void PollAutomaticCodex(long now)
        {
            if (codexFollowMode != "auto") return;
            try { DiscoverAutomaticCodex(now); } catch (Exception) { /* Keep existing watches if enumeration fails. */ }
            CodexWatch current = null;
            foreach (CodexWatch watch in codexWatches.Values) {
                try { ReadAutomaticCodex(watch, now); } catch (Exception) { watch.State = null; }
                if (watch.Hash == connectedAiSession && connectedAiTool == "codex") current = watch;
            }
            if (current != null && (current.SignalAt != current.EmittedAt || lastAiState != current.State) && current.State != null &&
                (ActiveCodexWatch(current, now) || current.EmittedAt > 0)) {
                EmitAutomaticCodex(current);
                if (current.State == "finished" || current.State == "paused") codexReleaseAt = now + 2000;
            }
            CodexWatch chosen = ActiveCodexWatch(current, now) ? current : null;
            foreach (CodexWatch watch in codexWatches.Values) {
                if (!ActiveCodexWatch(watch, now)) continue;
                if (chosen == null || (watch.State == "needs-user" && chosen.State != "needs-user") ||
                    (watch.State == "needs-user" && chosen.State == "needs-user" && watch.SignalAt > chosen.SignalAt) ||
                    (!ActiveCodexWatch(current, now) && chosen.State != "needs-user" && watch.StartedAt == chosen.StartedAt && watch.SignalAt > chosen.SignalAt) ||
                    (chosen.State != "needs-user" && watch.StartedAt > chosen.StartedAt && watch.StartedAt > codexSwitchedAt)) chosen = watch;
            }
            if (chosen != null && chosen != current && (now >= codexReleaseAt || chosen.State == "needs-user")) {
                codexSwitchReason = chosen.State == "needs-user" ? "有会话需要你回答" : current != null && !ActiveCodexWatch(current, now)
                    ? "继续其他运行任务" : "最近开始的任务";
                selectedDesktopRolloutPath = chosen.Path; selectedCodexSession = chosen.Hash;
                SaveDesktopSelection(); SaveAiConnection("codex", chosen.Hash, true);
                selectedDesktopRolloutOffset = chosen.Offset; codexSwitchedAt = now; codexReleaseAt = 0;
                EmitAutomaticCodex(chosen); current = chosen;
            }
            if (current != null) {
                if (selectedDesktopRolloutPath != current.Path) { selectedDesktopRolloutPath = current.Path; SaveDesktopSelection(); }
                selectedDesktopRolloutOffset = current.Offset;
                if (!ActiveCodexWatch(current, now) && current.State != "finished" && current.State != "paused") {
                    ResetConnectedPlayback(); lastAiOutcome = "signal-stale";
                }
            }
        }

        private static void ObserveAutomaticAgentState(string state, long timestamp)
        {
            if (applyingAutomaticCodex || codexFollowMode != "auto" || connectedAiTool != "codex") return;
            foreach (CodexWatch watch in codexWatches.Values) if (watch.Hash == connectedAiSession && timestamp >= watch.SignalAt) {
                watch.State = state; watch.SignalAt = timestamp; watch.EmittedAt = timestamp; watch.Evidence = null;
                if (state == "started") watch.StartedAt = timestamp;
                if (state == "finished" || state == "paused") codexReleaseAt = CurrentUnixMilliseconds() + 2000;
            }
        }

        private static object AutomaticCodexStatus()
        {
            List<object> active = new List<object>(); int unknown = 0; long now = CurrentUnixMilliseconds();
            foreach (CodexWatch watch in codexWatches.Values) {
                if (ActiveCodexWatch(watch, now)) active.Add(new { session = watch.Hash, state = watch.State, lastSignalAtMs = watch.SignalAt, current = watch.Hash == connectedAiSession });
                else if ((watch.State == null && watch.Hash == connectedAiSession) || ((watch.State == "started" || watch.State == "running" || watch.State == "needs-user") && now - watch.SignalAt > CodexSignalLifetime)) unknown++;
            }
            return new { mode = codexFollowMode, currentSession = connectedAiTool == "codex" ? connectedAiSession : null, activeSessions = active, unconfirmed = unknown };
        }

        private static string AutomaticCodexLabel(CodexWatch watch, long now)
        {
            string title = CodexTitleForHash(watch.Hash) ?? "未命名会话";
            bool ambiguous = title == "未命名会话";
            foreach (CodexWatch other in codexWatches.Values) if (other.Hash != watch.Hash && ActiveCodexWatch(other, now) &&
                (CodexTitleForHash(other.Hash) ?? "未命名会话") == title) ambiguous = true;
            if (!ambiguous) return title;
            string project = Path.GetFileName(watch.Cwd.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            long at = watch.StartedAt > 0 ? watch.StartedAt : watch.SignalAt;
            return title + " · " + (String.IsNullOrEmpty(project) ? watch.Cwd : project) + " · " +
                new DateTimeOffset(621355968000000000L + Math.Max(0, at) * TimeSpan.TicksPerMillisecond, TimeSpan.Zero).ToLocalTime().ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture);
        }

        private static string AutomaticCodexSummary(long? clock = null)
        {
            List<CodexWatch> active = new List<CodexWatch>(); long now = clock ?? CurrentUnixMilliseconds();
            foreach (CodexWatch watch in codexWatches.Values) if (ActiveCodexWatch(watch, now)) active.Add(watch);
            active.Sort(delegate(CodexWatch a, CodexWatch b) { return b.StartedAt.CompareTo(a.StartedAt); });
            string text = active.Count == 0 ? "自动跟随 · 暂无明确的运行信号" : "自动跟随 · " + active.Count + " 个活动会话";
            if (connectedAiTool == "codex") {
                string currentLabel = CodexTitleForHash(connectedAiSession) ?? "未命名会话";
                foreach (CodexWatch watch in codexWatches.Values) if (watch.Hash == connectedAiSession) currentLabel = AutomaticCodexLabel(watch, now);
                text += "\n当前关联：" + currentLabel;
            }
            if (codexSwitchReason != null && active.Count > 0) text += "\n跟随原因：" + codexSwitchReason;
            int shown = 0;
            foreach (CodexWatch watch in active) if (watch.Hash != connectedAiSession && shown++ < 3)
                text += "\n同时进行：" + AutomaticCodexLabel(watch, now) + (watch.State == "needs-user" ? "（需要回答）" : "");
            if (shown > 3) text += "\n还有 " + (shown - 3) + " 个活动会话";
            foreach (CodexWatch watch in codexWatches.Values) if (watch.Hash == connectedAiSession && !ActiveCodexWatch(watch, now) &&
                watch.State != "finished" && watch.State != "paused") text += "\n当前会话状态待确认";
            return text;
        }

        private static void UpdateCodexFollowTooltip()
        {
            string title = connectedAiTool == "codex" ? CodexTitleForHash(connectedAiSession) ?? "未命名会话" : null;
            if (title == null && codexFollowMode != "auto") {
                if (window != null) window.ToolTip = null;
                if (trayIcon != null) trayIcon.Text = "AI Pet · 桌面伙伴";
                return;
            }
            int count = 0;
            foreach (CodexWatch watch in codexWatches.Values) if (ActiveCodexWatch(watch, CurrentUnixMilliseconds())) count++;
            string text = "AI Pet · " + (codexFollowMode == "auto" ? "自动(" + count + ")：" : "固定会话：") + (title ?? "等待任务");
            if (window != null) window.ToolTip = codexFollowMode == "auto" ? AutomaticCodexSummary() : text;
            if (trayIcon != null) {
                if (text.Length > 63) text = text.Substring(0, Char.IsHighSurrogate(text[61]) ? 61 : 62) + "…";
                trayIcon.Text = text;
            }
        }

        private static void TestAutomaticCodex(string output)
        {
            string home = Environment.GetEnvironmentVariable("CODEX_HOME"), data = Environment.GetEnvironmentVariable("AI_PET_DATA_DIR");
            if (String.IsNullOrEmpty(home) || String.IsNullOrEmpty(data) || !Path.GetFullPath(home).StartsWith(Path.GetFullPath(data).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase) || Directory.Exists(home) || Directory.Exists(output))
                throw new InvalidOperationException("Automatic-follow QA requires new isolated data and Codex directories.");
            Directory.CreateDirectory(output); Directory.CreateDirectory(CodexSessionsRoot());
            System.Windows.Application app = new System.Windows.Application { ShutdownMode = System.Windows.ShutdownMode.OnExplicitShutdown };
            activeTheme = CreatePublicDemoTheme(); BuildTray(); BuildWindow(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "reference-cat.jpg")); window.Show();
            JavaScriptSerializer json = new JavaScriptSerializer(); long now = CurrentUnixMilliseconds();
            string a = Guid.NewGuid().ToString(), b = Guid.NewGuid().ToString(), c = Guid.NewGuid().ToString();
            string ta = Guid.NewGuid().ToString(), tb = Guid.NewGuid().ToString(), tb2 = Guid.NewGuid().ToString(), tc = Guid.NewGuid().ToString();
            Func<string, string> path = delegate(string id) { return Path.Combine(CodexSessionsRoot(), "rollout-test-" + id + ".jsonl"); };
            Action<string, string, object> session = delegate(string id, string origin, object source) {
                File.WriteAllText(path(id), json.Serialize(new { type = "session_meta", payload = new { id = id, cwd = data, originator = origin, source = source } }) + "\n", new UTF8Encoding(false));
            };
            session(a, "Codex Desktop", "cli"); session(b, "Codex Desktop", "cli");
            string worker = Guid.NewGuid().ToString(); session(worker, "Codex Desktop", new { subagent = new { thread_spawn = new { parent_thread_id = a } } });
            string cli = Guid.NewGuid().ToString(); session(cli, "Codex CLI", "cli");
            File.WriteAllLines(Path.Combine(home, "session_index.jsonl"), new [] {
                json.Serialize(new { id = a, thread_name = "任务 A · 写代码" }), json.Serialize(new { id = b, thread_name = "任务 B · 画宠物" }),
                json.Serialize(new { id = c, thread_name = "任务 C · 新任务" }) }, new UTF8Encoding(false));
            Func<string, string, string> line = delegate(string kind, string turn) {
                return json.Serialize(new { timestamp = new DateTimeOffset(621355968000000000L + now * TimeSpan.TicksPerMillisecond, TimeSpan.Zero).ToString("o"),
                    type = "event_msg", payload = new { type = kind, turn_id = turn, reason = "interrupted", completed_at_ms = now,
                        item = new { type = "CommandExecution", output = "PRIVATE-AUTO-BODY" } } });
            };
            Action<string, string, string> emit = delegate(string id, string kind, string turn) { now += 100; File.AppendAllText(path(id), line(kind, turn) + "\n", new UTF8Encoding(false)); };
            Action poll = delegate { PollAutomaticCodex(now); };
            SaveAiConnection(null, null, true);
            bool defaultModePersisted = File.Exists(codexFollowPath) && File.ReadAllText(codexFollowPath).Contains("auto");
            SetCodexFollowMode("auto"); poll();
            bool metadataIsNotActivity = connectedAiTool == null && codexWatches.Count == 2;
            emit(worker, "task_started", Guid.NewGuid().ToString()); emit(cli, "task_started", Guid.NewGuid().ToString());
            emit(a, "task_started", ta); poll();
            bool discoveredStart = connectedAiSession == DesktopSessionHash(a) && lastAiOutcome == "played";
            File.Copy(path(a), Path.Combine(CodexSessionsRoot(), "rollout-copy-" + a + ".jsonl"));
            codexDiscoveryAt = 0; poll(); bool duplicateFilesIgnored = codexWatches.Count == 2;
            emit(b, "task_started", tb); poll();
            bool newStartSwitches = connectedAiSession == DesktopSessionHash(b);
            codexWatches[path(a)].RecentActivity = 0; emit(a, "item_completed", ta); poll();
            bool stickyActivity = connectedAiSession == DesktopSessionHash(b) && codexWatches[path(a)].State == "running";
            UpdateCodexFollowTooltip(); ShowPetManager(1);
            CaptureAppearanceContent(petManager, Path.Combine(output, "multiple-sessions.png"));
            bool visibleOwnership = FriendlyConnectionStatus().Contains("任务 B") && FriendlyConnectionStatus().Contains("同时进行：任务 A") && trayIcon.Text.Contains("任务 B");
            File.AppendAllText(Path.Combine(home, "session_index.jsonl"), json.Serialize(new { id = a, thread_name = "同名任务" }) + "\n" + json.Serialize(new { id = b, thread_name = "同名任务" }) + "\n", new UTF8Encoding(false));
            codexTitlesCheckedAt = DateTime.MinValue;
            bool duplicateTitlesClear = AutomaticCodexLabel(codexWatches[path(a)], now) != AutomaticCodexLabel(codexWatches[path(b)], now);
            string call = "call_" + Guid.NewGuid().ToString("N"); now += 100;
            string stamp = new DateTimeOffset(621355968000000000L + now * TimeSpan.TicksPerMillisecond, TimeSpan.Zero).ToString("o");
            File.AppendAllText(path(a), json.Serialize(new { timestamp = stamp, type = "response_item", payload = new { type = "function_call", name = "request_user_input_async", call_id = call,
                arguments = "PRIVATE-AUTO-QUESTION", internal_chat_message_metadata_passthrough = new { turn_id = ta } } }) + "\n" +
                json.Serialize(new { timestamp = stamp, type = "response_item", payload = new { type = "function_call_output", call_id = call, output = "{\"accepted\":true}" } }) + "\n", new UTF8Encoding(false));
            poll(); bool needsUserPriority = connectedAiSession == DesktopSessionHash(a) && lastAiState == "needs-user";
            emit(b, "task_started", tb2); poll();
            codexWatches[path(a)].RecentActivity = 0; emit(a, "item_completed", ta); poll();
            bool inputWaitHeld = connectedAiSession == DesktopSessionHash(a) && lastAiState == "needs-user";
            emit(a, "task_complete", ta); poll();
            bool finishHeld = connectedAiSession == DesktopSessionHash(a) && lastAiState == "finished";
            now += 2100; poll();
            bool handedOff = connectedAiSession == DesktopSessionHash(b);
            codexWatches[path(b)].RecentActivity = 0; emit(b, "item_completed", tb); poll();
            bool oldTurnIgnored = codexWatches[path(b)].Turn == Sha256Text(tb2);
            session(c, "Codex Desktop", "cli"); now += 100; string partial = line("task_started", tc);
            File.AppendAllText(path(c), partial, new UTF8Encoding(false)); codexDiscoveryAt = 0; poll();
            bool partialIgnored = connectedAiSession == DesktopSessionHash(b);
            File.AppendAllText(path(c), "\n", new UTF8Encoding(false)); poll();
            bool partialCompleted = connectedAiSession == DesktopSessionHash(c);
            session(c, "Codex Desktop", "cli"); poll();
            bool truncationSafe = connectedAiSession == DesktopSessionHash(b);
            emit(b, "turn_aborted", tb2); poll();
            bool paused = lastAiState == "paused" && lastAiOutcome == "played";
            ConnectSimpleCodex(a); emit(c, "task_started", Guid.NewGuid().ToString()); poll();
            bool manualPinned = codexFollowMode == "manual" && connectedAiSession == DesktopSessionHash(a);
            SetCodexFollowMode("auto"); codexFollowMode = "off"; codexFollowText = null; ReloadCodexFollow();
            bool persists = codexFollowMode == "auto";
            poll();
            now += CodexSignalLifetime + 1; poll();
            bool staleUnknown = lastAiOutcome == "signal-stale" && activeThemeAction.Slot == "idle" && AutomaticCodexSummary(now).Contains("待确认");
            object staleSnapshot = new { outcome = lastAiOutcome, slot = activeThemeAction.Slot, summary = AutomaticCodexSummary(now), connection = connectedAiSession, state = lastAiState };
            SaveAiConnection(null, null); emit(a, "task_started", Guid.NewGuid().ToString()); poll();
            bool disconnected = codexFollowMode == "off" && connectedAiTool == null;
            bool privatePayloadDiscarded = true;
            foreach (string file in Directory.GetFiles(data, "*.json")) if (File.ReadAllText(file).Contains("PRIVATE-AUTO")) privatePayloadDiscarded = false;
            bool passed = defaultModePersisted && metadataIsNotActivity && discoveredStart && duplicateFilesIgnored && newStartSwitches && stickyActivity && visibleOwnership && duplicateTitlesClear && needsUserPriority && inputWaitHeld &&
                finishHeld && handedOff && oldTurnIgnored && partialIgnored && partialCompleted && truncationSafe && paused && manualPinned && persists && staleUnknown && disconnected && privatePayloadDiscarded;
            File.WriteAllText(Path.Combine(output, "result.json"), json.Serialize(new { passed = passed, defaultModePersisted = defaultModePersisted, metadataIsNotActivity = metadataIsNotActivity, discoveredStart = discoveredStart,
                duplicateFilesIgnored = duplicateFilesIgnored, newStartSwitches = newStartSwitches, stickyActivity = stickyActivity, visibleOwnership = visibleOwnership, duplicateTitlesClear = duplicateTitlesClear, needsUserPriority = needsUserPriority, inputWaitHeld = inputWaitHeld,
                finishHeld = finishHeld, handedOff = handedOff, oldTurnIgnored = oldTurnIgnored, partialIgnored = partialIgnored, partialCompleted = partialCompleted, truncationSafe = truncationSafe,
                paused = paused, manualPinned = manualPinned, persists = persists, staleUnknown = staleUnknown, staleSnapshot = staleSnapshot, disconnected = disconnected, privatePayloadDiscarded = privatePayloadDiscarded }));
            ExitApplication(); if (!passed) throw new InvalidOperationException("Automatic Codex regression failed.");
        }
    }
}
