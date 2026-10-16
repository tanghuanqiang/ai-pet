using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Forms = System.Windows.Forms;
using WpfApplication = System.Windows.Application;

namespace AIPet.Desktop
{
    // Product controls and the small, tool-independent Agent interface.
    internal static partial class DesktopPet
    {
        private static readonly string[] AiStates = { "started", "running", "finished", "paused", "needs-user" };
        private static readonly string[] AiStateLabels = { "任务开始", "任务进行中", "任务结束", "任务暂停", "需要回答或确认" };
        private static readonly string[] DefaultAiSlots = { "recent-activity", "recent-activity", "stop-unknown", "interrupt", "needs-user" };
        private static readonly Dictionary<string, string> aiBindings = new Dictionary<string, string>();
        private static readonly HashSet<string> seenAiEvents = new HashSet<string>();
        private static readonly Queue<string> seenAiEventOrder = new Queue<string>();
        private static string experienceRoot, aiConfigurationPath, aiEventsPath;
        private static readonly List<string> creationPhotos = new List<string>();
        private static string latestCreationRequest;
        private static string creationDraftPrompt;
        private static string connectedAiTool, connectedAiSession, lastAiState, lastAiOutcome;
        private static long aiConnectedAt;
        private static string aiConfigurationText;
        private static Window petManager;
        private static TabControl petManagerTabs;
        private static Forms.ToolStripMenuItem actionsMenu;
        private static readonly List<Forms.ToolStripItem> advancedPetItems = new List<Forms.ToolStripItem>();

        private static void InitializeSimpleExperience(string root)
        {
            experienceRoot = root;
            aiConfigurationPath = Path.Combine(root, "ai-connection.json");
            aiEventsPath = Path.Combine(root, "ai-events");
            for (int i = 0; i < AiStates.Length; i++) aiBindings[AiStates[i]] = DefaultAiSlots[i];
            try { ReloadAiConnection(); }
            catch (Exception) { connectedAiTool = connectedAiSession = null; }
        }

        private static bool ValidAiId(string value)
        {
            return value != null && Regex.IsMatch(value, @"\A[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\z");
        }

        private static void SaveAiConnection(string tool, string session)
        {
            if (tool != null && (!ValidAiId(tool) || !ValidAiId(session)))
                throw new InvalidDataException("工具和会话标识只允许字母、数字、点、下划线与连字符（最多96字符）。");
            Dictionary<string, object> config = new Dictionary<string, object>();
            config["version"] = 1;
            config["tool"] = tool;
            config["session"] = tool == null ? null : session;
            config["connectedAtMs"] = CurrentUnixMilliseconds();
            config["bindings"] = new Dictionary<string, string>(aiBindings);
            Directory.CreateDirectory(experienceRoot);
            if (tool != "codex") ClearDesktopSelection();
            WriteCodexEventAtomically(aiConfigurationPath, new JavaScriptSerializer().Serialize(config));
            ReloadAiConnection();
        }

        private static void ReloadAiConnection()
        {
            if (!File.Exists(aiConfigurationPath))
            {
                bool wasConnected = connectedAiTool != null;
                connectedAiTool = connectedAiSession = aiConfigurationText = null;
                if (wasConnected) ResetConnectedPlayback();
                return;
            }
            string text = ReadBoundedJson(aiConfigurationPath);
            if (text == aiConfigurationText) return;
            Dictionary<string, object> config = new JavaScriptSerializer().DeserializeObject(text) as Dictionary<string, object>;
            if (config == null || Convert.ToInt32(config["version"], CultureInfo.InvariantCulture) != 1)
                throw new InvalidDataException("连接配置版本不支持。");
            string tool = config["tool"] as string, session = config["session"] as string;
            if (tool != null && (!ValidAiId(tool) || !ValidAiId(session))) throw new InvalidDataException("连接标识无效。");
            Dictionary<string, object> bindings = config["bindings"] as Dictionary<string, object>;
            if (bindings == null || bindings.Count != AiStates.Length) throw new InvalidDataException("需要五项状态映射。");
            foreach (string state in AiStates)
                if (!bindings.ContainsKey(state) || Array.IndexOf(SupportedThemeSlots, bindings[state] as string) < 0)
                    throw new InvalidDataException("动作映射无效。");
            long connected = Convert.ToInt64(config["connectedAtMs"], CultureInfo.InvariantCulture);
            bool changed = tool != connectedAiTool || session != connectedAiSession || connected != aiConnectedAt;
            foreach (string state in AiStates) aiBindings[state] = (string)bindings[state];
            connectedAiTool = tool; connectedAiSession = session; aiConnectedAt = connected; aiConfigurationText = text;
            if (changed) {
                seenAiEvents.Clear(); seenAiEventOrder.Clear(); lastAiState = lastAiOutcome = null;
                selectedCodexSession = null; selectedDesktopRolloutPath = null;
                if (tool == "codex") RestoreDesktopSelection();
                if (selectedCodexSession != session) { selectedCodexSession = null; selectedDesktopRolloutPath = null; }
                if (window != null && activeTheme != null) { activeThemeOneShot = false; SetThemeAction("idle", false); }
            }
        }

        private static object AiCapabilities()
        {
            List<object> actions = new List<object>();
            if (activeTheme != null) foreach (ThemeAction action in activeTheme.Actions)
                actions.Add(new { slot = action.Slot, label = SimpleActionLabel(action.Slot) });
            object generator = null;
            try {
                string generatorPath = Path.Combine(experienceRoot, "generator.json");
                if (File.Exists(generatorPath)) {
                    Dictionary<string, object> configured = ReadGenerator(generatorPath);
                    generator = new { name = configured["name"], maxReferences = configured["maxReferences"], dataHandling = configured["dataHandling"] };
                }
            } catch (Exception) { }
            return new { version = 1, states = AiStates, tool = connectedAiTool, session = connectedAiSession,
                generationProtocolVersion = 1, generator = generator, defaultCreationMode = generator == null ? "agent-handoff" : "configured-generator",
                codexDesktop = new { displayedInputRequests = true, permissionPrompts = false, proseQuestions = false, agentReportedStates = true },
                bindings = aiBindings, actions = actions, lastState = lastAiState, lastOutcome = lastAiOutcome,
                activeSlot = activeThemeAction == null ? null : activeThemeAction.Slot,
                dataDirectory = experienceRoot, runtimeRunning = window != null && !exiting, checkedAtMs = CurrentUnixMilliseconds(),
                pid = System.Diagnostics.Process.GetCurrentProcess().Id };
        }

        private static bool HandleAgentCommand(string[] args)
        {
            if (args.Length == 0) return false;
            if (args[0] == "--test-simple-experience" && args.Length == 2)
            {
                try { TestSimpleExperience(Path.GetFullPath(args[1])); }
                catch (Exception error) {
                    Directory.CreateDirectory(args[1]); File.WriteAllText(Path.Combine(args[1], "error.txt"), error.ToString());
                    Environment.ExitCode = 2;
                    if (trayIcon != null) ExitApplication();
                }
                return true;
            }
            if (!args[0].StartsWith("--ai-", StringComparison.Ordinal)) return false;
            try
            {
                if (args[0] == "--ai-codex-hook" && args.Length == 1) RecordSimpleCodexHook();
                else if (args[0] == "--ai-test-appearance" && args.Length == 2) TestModernAppearance(Path.GetFullPath(args[1]));
                else if (args[0] == "--ai-test-session-titles" && args.Length == 2) TestCodexSessionTitles(Path.GetFullPath(args[1]));
                else if (args[0] == "--ai-test-live-desktop" && args.Length == 4)
                    ObserveLiveDesktopForTest(args[1], Int32.Parse(args[2], CultureInfo.InvariantCulture), Path.GetFullPath(args[3]));
                else if (args[0] == "--ai-test-generation-review" && args.Length == 3) TestGenerationReview(args[1], Path.GetFullPath(args[2]));
                else if (args[0] == "--ai-test-generate-click" && args.Length == 3) TestGenerateClick(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]));
                else if (args[0] == "--ai-codex-connect" && args.Length == 2) ConnectSimpleCodex(args[1]);
                else if (args[0] == "--ai-codex-event" && args.Length == 3) {
                    if (!ValidAiId(args[1])) throw new InvalidDataException("Invalid Codex session.");
                    RecordAiStateEvent("codex", DesktopSessionHash(args[1]), args[2]);
                }
                else if (args[0] == "--ai-create-request" && args.Length == 3) {
                    Dictionary<string, object> spec = new JavaScriptSerializer().DeserializeObject(ReadBoundedJson(Path.GetFullPath(args[1]))) as Dictionary<string, object>;
                    List<string> photos = new List<string>();
                    foreach (object photo in (object[])spec["photos"]) photos.Add((string)photo);
                    string id = SaveCreationRequest(photos, ReadString(spec, "prompt"));
                    File.WriteAllText(Path.GetFullPath(args[2]), new JavaScriptSerializer().Serialize(new { id = id }), new UTF8Encoding(false));
                }
                else if (args[0] == "--ai-generator-config" && args.Length == 2) {
                    Dictionary<string, object> generator = ReadGenerator(Path.GetFullPath(args[1]));
                    Directory.CreateDirectory(experienceRoot);
                    WriteCodexEventAtomically(Path.Combine(experienceRoot, "generator.json"), new JavaScriptSerializer().Serialize(generator));
                }
                else if (args[0] == "--ai-start-generation" && args.Length == 2) StartGeneration(args[1]);
                else if (args[0] == "--ai-generate" && args.Length == 2) RunGeneration(args[1]);
                else if (args[0] == "--ai-cancel-generation" && args.Length == 2)
                    File.WriteAllText(Path.Combine(CreationFolder(args[1]), "cancel-generation"), "cancel");
                else if (args[0] == "--ai-generation-status" && args.Length == 3)
                    File.WriteAllText(Path.GetFullPath(args[2]), new JavaScriptSerializer().Serialize(GenerationStatus(args[1])), new UTF8Encoding(false));
                else if (args[0] == "--ai-connect" && args.Length == 3) SaveAiConnection(args[1], args[2]);
                else if (args[0] == "--ai-disconnect" && args.Length == 1) SaveAiConnection(null, null);
                else if (args[0] == "--ai-bind" && args.Length == 3)
                {
                    if (Array.IndexOf(AiStates, args[1]) < 0 || Array.IndexOf(SupportedThemeSlots, args[2]) < 0)
                        throw new InvalidDataException("未知状态或动作。");
                    aiBindings[args[1]] = args[2]; SaveAiConnection(connectedAiTool, connectedAiSession);
                }
                else if (args[0] == "--ai-event" && args.Length == 4)
                {
                    RecordAiStateEvent(args[1], args[2], args[3]);
                }
                else if (args[0] == "--ai-status" && args.Length == 2)
                {
                    if (File.Exists(activeThemeFilePath))
                    {
                        EnsureThemeNotRejected(activeThemeFilePath);
                        activeTheme = ParseThemePackage(activeThemeFilePath);
                    }
                    object report = AiCapabilities();
                    string livePath = Path.Combine(experienceRoot, "ai-status.json");
                    try {
                        Dictionary<string, object> live = new JavaScriptSerializer().DeserializeObject(ReadBoundedJson(livePath)) as Dictionary<string, object>;
                        long checkedAt = Convert.ToInt64(live["checkedAtMs"], CultureInfo.InvariantCulture);
                        System.Diagnostics.Process owner = System.Diagnostics.Process.GetProcessById(Convert.ToInt32(live["pid"], CultureInfo.InvariantCulture));
                        if (CurrentUnixMilliseconds() - checkedAt < 3000 && checkedAt <= CurrentUnixMilliseconds() &&
                            String.Equals(owner.MainModule.FileName, System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName, StringComparison.OrdinalIgnoreCase) &&
                            owner.Id != System.Diagnostics.Process.GetCurrentProcess().Id && ReadString(live, "tool") == (connectedAiTool ?? String.Empty) &&
                            ReadString(live, "session") == (connectedAiSession ?? String.Empty)) report = live;
                    } catch (Exception) { }
                    File.WriteAllText(Path.GetFullPath(args[1]), new JavaScriptSerializer().Serialize(report), new UTF8Encoding(false));
                }
                else if (args[0] == "--ai-requests" && args.Length == 2)
                {
                    List<object> requests = new List<object>(); string root = Path.Combine(experienceRoot, "creation-requests");
                    if (Directory.Exists(root)) foreach (string folder in Directory.GetDirectories(root))
                    {
                        if (!Regex.IsMatch(Path.GetFileName(folder), @"\A[a-f0-9]{32}\z")) continue;
                        string request = Path.Combine(folder, "request.json");
                        if (File.Exists(request)) requests.Add(new { id = Path.GetFileName(folder), request = request,
                            instructions = Path.Combine(folder, "agent-instructions.txt"),
                            status = File.Exists(Path.Combine(folder, "candidate.lotheme")) ? "ready" : "pending",
                            generation = GenerationStatus(Path.GetFileName(folder)) });
                    }
                    File.WriteAllText(Path.GetFullPath(args[1]), new JavaScriptSerializer().Serialize(requests), new UTF8Encoding(false));
                }
                else if (args[0] == "--ai-result" && args.Length == 3)
                {
                    if (!Regex.IsMatch(args[1], @"\A[a-f0-9]{32}\z")) throw new InvalidDataException("创作编号无效。");
                    string folder = Path.Combine(experienceRoot, "creation-requests", args[1]);
                    if (!File.Exists(Path.Combine(folder, "request.json"))) throw new InvalidDataException("未找到创作请求。");
                    string source = Path.GetFullPath(args[2]); EnsureThemeNotRejected(source); ParseThemePackage(source);
                    string destination = Path.Combine(folder, "candidate.lotheme");
                    if (File.Exists(destination)) throw new InvalidDataException("本请求已有候选，请新建请求或保留旧版本后再提交。");
                    File.Copy(source, destination);
                }
                else throw new InvalidDataException("不支持的 Agent 命令或参数。");
                Environment.ExitCode = 0;
            }
            catch (Exception error) {
                try {
                    Directory.CreateDirectory(experienceRoot);
                    WriteCodexEventAtomically(Path.Combine(experienceRoot, "agent-error.json"), new JavaScriptSerializer().Serialize(new {
                        command = args[0], message = error.Message, atMs = CurrentUnixMilliseconds() }));
                } catch (Exception) { }
                Environment.ExitCode = 2;
            }
            return true;
        }

        private static void RecordAiStateEvent(string tool, string session, string state)
        {
            if (!ValidAiId(tool) || !ValidAiId(session) || Array.IndexOf(AiStates, state) < 0)
                throw new InvalidDataException("事件需要工具、会话和五个合法状态之一。");
            Directory.CreateDirectory(aiEventsPath);
            string id = Guid.NewGuid().ToString("N");
            object record = new { version = 1, eventId = id, observedAtMs = CurrentUnixMilliseconds(),
                tool = tool, session = session, state = state };
            WriteCodexEventAtomically(Path.Combine(aiEventsPath, CurrentUnixMilliseconds().ToString("D13") + "." + id + ".json"),
                new JavaScriptSerializer().Serialize(record));
            PruneAiEvents();
        }

        private static void PruneAiEvents()
        {
            string[] files = Directory.GetFiles(aiEventsPath, "*.json");
            Array.Sort(files, StringComparer.Ordinal);
            for (int i = 0; i < files.Length; i++)
                if (i < files.Length - 256 || File.GetLastWriteTimeUtc(files[i]) < DateTime.UtcNow.AddMinutes(-10))
                    TryDeleteCodexEvent(files[i]);
        }

        private static bool ApplyAiEvent(Dictionary<string, object> record)
        {
            if (connectedAiTool == null || record == null || !HasExactKeys(record,
                new string[] { "version", "eventId", "observedAtMs", "tool", "session", "state" })) return false;
            if (!(record["version"] is int) || (int)record["version"] != 1 ||
                ReadString(record, "tool") != connectedAiTool || ReadString(record, "session") != connectedAiSession) return false;
            string state = ReadString(record, "state"), id = ReadString(record, "eventId");
            if (Array.IndexOf(AiStates, state) < 0 || id == null || !Regex.IsMatch(id, @"\A[a-f0-9]{32}\z")) return false;
            if (!(record["observedAtMs"] is long) && !(record["observedAtMs"] is int)) return false;
            long timestamp = Convert.ToInt64(record["observedAtMs"], CultureInfo.InvariantCulture);
            long now = CurrentUnixMilliseconds();
            if (timestamp < aiConnectedAt || timestamp > now + 1000 || now - timestamp > 10000 || !seenAiEvents.Add(id)) return false;
            seenAiEventOrder.Enqueue(id);
            if (seenAiEventOrder.Count > 512) seenAiEvents.Remove(seenAiEventOrder.Dequeue());
            lastAiState = state;
            string slot = aiBindings[state];
            if (window == null || !window.IsVisible) lastAiOutcome = "hidden";
            else if (IsWithinQuietHours(preferences, DateTime.Now.TimeOfDay)) lastAiOutcome = "quiet-hours";
            else if (activeTheme == null || activeTheme.FindAction(slot) == null) lastAiOutcome = "action-unavailable";
            else {
                activeThemeOneShot = false;
                lastAiOutcome = SetThemeAction(slot, slot != "idle" && state != "running") ? "played" : "action-unavailable";
            }
            return true;
        }

        private static void PollAiConnection()
        {
            try
            {
                ReloadAiConnection();
                if (connectedAiTool == null) {
                    Directory.CreateDirectory(experienceRoot);
                    WriteCodexEventAtomically(Path.Combine(experienceRoot, "ai-status.json"), new JavaScriptSerializer().Serialize(AiCapabilities()));
                    return;
                }
                if (connectedAiTool == "codex" && selectedCodexSession == connectedAiSession) {
                    PollSelectedDesktopRollout(); ConsumeSelectedCodexEvent();
                }
                if (lastAiState != null && window != null && (!window.IsVisible || IsWithinQuietHours(preferences, DateTime.Now.TimeOfDay))) {
                    lastAiOutcome = window.IsVisible ? "quiet-hours" : "hidden";
                    ResetConnectedPlayback();
                }
                string[] files = Directory.Exists(aiEventsPath) ? Directory.GetFiles(aiEventsPath, "*.json") : new string[0];
                Array.Sort(files, StringComparer.Ordinal);
                foreach (string file in files)
                {
                    try { ApplyAiEvent(new JavaScriptSerializer().DeserializeObject(ReadBoundedJson(file)) as Dictionary<string, object>); }
                    catch (Exception) { }
                }
                Directory.CreateDirectory(experienceRoot);
                WriteCodexEventAtomically(Path.Combine(experienceRoot, "ai-status.json"), new JavaScriptSerializer().Serialize(AiCapabilities()));
            }
            catch (Exception) {
                bool wasConnected = connectedAiTool != null;
                connectedAiTool = connectedAiSession = aiConfigurationText = null; lastAiOutcome = "invalid-config";
                if (wasConnected) ResetConnectedPlayback();
            }
        }

        private static void ResetConnectedPlayback()
        {
            if (window != null && activeTheme != null && activeThemeAction != null && activeThemeAction.Slot != "idle") {
                activeThemeOneShot = false; SetThemeAction("idle", false);
            }
        }

        private static string SimpleActionLabel(string slot)
        {
            if (slot == "idle") return "休息";
            if (slot == "ambient") return "自由活动";
            if (slot == "recent-activity") return "专注工作";
            if (slot == "needs-user") return "招呼你";
            if (slot == "stop-unknown") return "收工";
            if (slot == "interrupt") return "停一停";
            if (slot == "hover") return "好奇看看";
            if (slot == "click") return "打个招呼";
            return slot;
        }

        private static void SimplifyTrayMenu(Forms.ToolStripMenuItem exitItem)
        {
            advancedPetItems.Clear();
            foreach (Forms.ToolStripItem item in trayMenu.Items)
                if (!(item is Forms.ToolStripSeparator) && item != visibilityItem && item != exitItem && item != codexSessionItem)
                    advancedPetItems.Add(item);
            trayMenu.Items.Clear();
            trayMenu.Items.Add(visibilityItem);
            actionsMenu = new Forms.ToolStripMenuItem("宠物动作");
            actionsMenu.DropDownOpening += delegate { PopulatePetActions(); };
            trayMenu.Items.Add(actionsMenu);
            Forms.ToolStripMenuItem custom = new Forms.ToolStripMenuItem("自定义宠物和动作…");
            custom.Click += delegate { ShowPetManager(0); }; trayMenu.Items.Add(custom);
            Forms.ToolStripMenuItem connections = new Forms.ToolStripMenuItem("连接 AI 工具…");
            connections.Click += delegate { ShowPetManager(1); }; trayMenu.Items.Add(connections);
            Forms.ToolStripMenuItem settings = new Forms.ToolStripMenuItem("设置…");
            settings.Click += delegate { ShowPetManager(2); }; trayMenu.Items.Add(settings);
            trayMenu.Items.Add(new Forms.ToolStripSeparator()); trayMenu.Items.Add(exitItem);
        }

        private static void PopulatePetActions()
        {
            actionsMenu.DropDownItems.Clear();
            if (activeTheme != null) foreach (ThemeAction action in activeTheme.Actions)
            {
                string slot = action.Slot;
                Forms.ToolStripMenuItem item = new Forms.ToolStripMenuItem(SimpleActionLabel(slot));
                item.Click += delegate { ShowWindow(); activeThemeOneShot = false; SetThemeAction(slot, slot != "idle"); };
                actionsMenu.DropDownItems.Add(item);
            }
            if (actionsMenu.DropDownItems.Count == 0)
                actionsMenu.DropDownItems.Add(new Forms.ToolStripMenuItem("先添加一只宠物") { Enabled = false });
        }

        private static TextBlock ManagerText(string text, bool heading)
        {
            TextBlock block = new TextBlock { Text = text, FontSize = heading ? 26 : 14,
                FontWeight = heading ? FontWeights.SemiBold : FontWeights.Normal,
                TextWrapping = TextWrapping.Wrap, LineHeight = heading ? 34 : 22, Margin = new Thickness(0, 0, 0, heading ? 12 : 18) };
            block.SetResourceReference(TextBlock.ForegroundProperty, heading ? "PetText" : "PetMuted");
            return block;
        }

        private static Button ManagerButton(string label, Action action)
        {
            Button button = new Button { Content = label, Padding = new Thickness(14, 8, 14, 8),
                HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 0, 10, 12) };
            button.Click += delegate {
                try { action(); }
                catch (Exception error) { MessageBox.Show(petManager, error.Message, "未完成操作", MessageBoxButton.OK, MessageBoxImage.Information); }
            };
            return button;
        }

        private static StackPanel ManagerPage(string title, string description)
        {
            StackPanel page = new StackPanel { Margin = new Thickness(28) };
            page.Children.Add(ManagerText(title, true)); page.Children.Add(ManagerText(description, false)); return page;
        }

        private static void ShowPetManager(int tab)
        {
            if (petManager != null)
            { petManagerTabs.SelectedIndex = tab; petManager.Show(); petManager.Activate(); return; }
            petManager = new Window { Title = "AI Pet · 你的桌面伙伴", Width = 860, Height = 740,
                MinWidth = 720, MinHeight = 540, WindowStartupLocation = WindowStartupLocation.CenterScreen };
            AttachModernAppearance(petManager);
            AttachDisplayRecovery(petManager);
            petManager.Closed += delegate { petManager = null; petManagerTabs = null; };
            petManagerTabs = new TabControl { FontSize = 14 };
            string savedCreationPrompt = creationDraftPrompt ?? "";
            if (latestCreationRequest == null) latestCreationRequest = LatestCreationId();
            if (latestCreationRequest != null) {
                try {
                    string folder = CreationFolder(latestCreationRequest);
                    Dictionary<string, object> saved = new JavaScriptSerializer().DeserializeObject(ReadBoundedJson(Path.Combine(folder, "request.json"))) as Dictionary<string, object>;
                    savedCreationPrompt = creationDraftPrompt ?? ReadString(saved, "prompt");
                    if (creationPhotos.Count == 0) foreach (Dictionary<string, object> photo in (object[])saved["references"]) {
                        string name = ReadString(photo, "path");
                        if (Regex.IsMatch(name, @"\Areference-[1-4]\.(png|jpg|jpeg)\z")) creationPhotos.Add(Path.Combine(folder, name));
                    }
                } catch (Exception) { }
            }
            StackPanel custom = ManagerPage("自定义宠物和动作", "添加照片，写下想让它做的动作。预览满意后，再换到桌面上。");
            TextBlock photoCount = ManagerText(creationPhotos.Count == 0 ? "选择 1–4 张参考图片" : "已选择 " + creationPhotos.Count + " 张图片", false);
            custom.Children.Add(ManagerButton("添加参考图片…", delegate {
                using (Forms.OpenFileDialog picker = new Forms.OpenFileDialog()) {
                    picker.Filter = "宠物图片|*.png;*.jpg;*.jpeg"; picker.Multiselect = true;
                    if (picker.ShowDialog() != Forms.DialogResult.OK) return;
                    if (picker.FileNames.Length > 4) throw new InvalidDataException("最多选择四张参考图片。");
                    if (File.Exists(Path.Combine(experienceRoot, "generator.json"))) {
                        int maximum = Convert.ToInt32(ReadGenerator(Path.Combine(experienceRoot, "generator.json"))["maxReferences"], CultureInfo.InvariantCulture);
                        if (picker.FileNames.Length > maximum) throw new InvalidDataException("当前生成器最多支持 " + maximum + " 张图片；也可以让 Agent 配置支持更多参考图的生成器。");
                    }
                    foreach (string photo in picker.FileNames) ValidateCreationPhoto(photo);
                    creationPhotos.Clear(); creationPhotos.AddRange(picker.FileNames);
                    photoCount.Text = "已选择 " + creationPhotos.Count + " 张图片";
                }
            }));
            custom.Children.Add(photoCount);
            TextBox creationPrompt = new TextBox { Text = savedCreationPrompt, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, Height = 90,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MaxLength = 2000, Margin = new Thickness(0, 0, 0, 12) };
            custom.Children.Add(ManagerText("描述想要的宠物和动作", false)); custom.Children.Add(creationPrompt);
            petManager.Closed += delegate { creationDraftPrompt = creationPrompt.Text; };
            TextBlock generatorDescription = ManagerText("", false); custom.Children.Add(generatorDescription);
            TextBlock creationStatus = ManagerText("添加图片和描述后，交给自己的 Agent 制作。", false);
            Button generate = null;
            generate = ManagerButton("生成动作", delegate {
                try {
                    bool configured = File.Exists(Path.Combine(experienceRoot, "generator.json"));
                    if (configured) ReadGenerator(Path.Combine(experienceRoot, "generator.json"));
                    latestCreationRequest = SaveCreationRequest(creationPhotos, creationPrompt.Text);
                    if (configured) {
                        StartGeneration(latestCreationRequest); generate.IsEnabled = false; creationStatus.Text = "正在启动生成…";
                    } else {
                        CopyCreationHandoff(latestCreationRequest);
                        creationStatus.Text = "制作说明已复制，粘贴给你的 Agent 即可；完成后回到这里预览。";
                    }
                } catch (Exception error) { creationStatus.Text = error.Message; }
            });
            custom.Children.Add(generate);
            generate.SetResourceReference(FrameworkElement.StyleProperty, "PetPrimary");
            custom.Children.Add(creationStatus);
            WrapPanel generationControls = new WrapPanel();
            Button retry = ManagerButton("重试生成", delegate {
                try { StartGeneration(latestCreationRequest); creationStatus.Text = "正在重新生成…"; }
                catch (Exception error) { creationStatus.Text = error.Message; }
            });
            Button cancel = ManagerButton("取消生成", delegate {
                try { File.WriteAllText(Path.Combine(CreationFolder(latestCreationRequest), "cancel-generation"), "cancel"); creationStatus.Text = "正在取消…"; }
                catch (Exception error) { creationStatus.Text = error.Message; }
            });
            Button creationResult = ManagerButton("预览生成的动作…", delegate {
                string request = LatestCreationCandidate();
                if (request == null) throw new InvalidOperationException("还没有可预览的生成结果。");
                ImportCreationCandidate(request);
            });
            creationResult.IsEnabled = LatestCreationCandidate() != null;
            retry.Visibility = cancel.Visibility = Visibility.Collapsed;
            generationControls.Children.Add(creationResult); generationControls.Children.Add(cancel); generationControls.Children.Add(retry);
            custom.Children.Add(generationControls);
            StackPanel agentGeneration = new StackPanel();
            agentGeneration.Children.Add(ManagerButton("复制制作说明", delegate {
                try {
                    if (latestCreationRequest == null) latestCreationRequest = SaveCreationRequest(creationPhotos, creationPrompt.Text);
                    CopyCreationHandoff(latestCreationRequest);
                    creationStatus.Text = "制作说明已复制，粘贴给你的 Agent 即可。";
                } catch (Exception error) { creationStatus.Text = error.Message; }
            }));
            Expander agentInstructions = new Expander { Header = "制作说明", Content = agentGeneration, Margin = new Thickness(0, 0, 0, 12) };
            custom.Children.Add(agentInstructions);
            System.Windows.Threading.DispatcherTimer creationRefresh = new System.Windows.Threading.DispatcherTimer();
            creationRefresh.Interval = TimeSpan.FromSeconds(2);
            Action refreshCreation = delegate {
                try {
                    bool configured = File.Exists(Path.Combine(experienceRoot, "generator.json"));
                    if (configured) {
                        Dictionary<string, object> backend = ReadGenerator(Path.Combine(experienceRoot, "generator.json"));
                        generatorDescription.Text = "生成器：" + ReadString(backend, "name") + "（最多 " + backend["maxReferences"] + " 张参考图）· " + ReadString(backend, "dataHandling");
                    } else generatorDescription.Text = "默认交给自己的 Agent：复制制作说明，粘贴到它的会话。无需安装本机模型。";
                    generate.Content = configured ? "生成动作" : "交给我的 Agent 制作";
                    if (latestCreationRequest == null) latestCreationRequest = LatestCreationId();
                    bool running = false;
                    if (latestCreationRequest != null) {
                        JavaScriptSerializer serializer = new JavaScriptSerializer();
                        Dictionary<string, object> state = serializer.DeserializeObject(serializer.Serialize(GenerationStatus(latestCreationRequest))) as Dictionary<string, object>;
                        running = state.ContainsKey("running") && (bool)state["running"];
                        string status = ReadString(state, "status");
                        if (configured) generate.Content = status == "ready" ? "重新生成" : "生成动作";
                        else generate.Content = status == "ready" ? "制作新的动作" : "交给我的 Agent 制作";
                        creationStatus.Text = !configured && status == "pending" ? "等待 Agent 制作；把制作说明粘贴给它，完成后回来预览。" : ReadString(state, "message");
                        creationResult.IsEnabled = status == "ready";
                        cancel.Visibility = running ? Visibility.Visible : Visibility.Collapsed;
                        retry.Content = status == "pending" ? "生成这个请求" : "重试生成";
                        retry.Visibility = configured && !running && status != "ready" ? Visibility.Visible : Visibility.Collapsed;
                    }
                    generate.IsEnabled = !running;
                    agentInstructions.Visibility = latestCreationRequest != null || configured ? Visibility.Visible : Visibility.Collapsed;
                } catch (Exception error) { creationResult.IsEnabled = false; creationStatus.Text = error.Message; }
            };
            creationRefresh.Tick += delegate { refreshCreation(); }; refreshCreation();
            creationRefresh.Start(); petManager.Closed += delegate { creationRefresh.Stop(); };
            Expander localCreator = new Expander { Header = "使用本机眨眼、歪头模板", Content = ManagerButton("打开创作空间", OpenSimpleCreator), Margin = new Thickness(0, 0, 0, 12) };
            custom.Children.Add(localCreator);
            custom.Children.Add(ManagerButton("使用已有宠物主题…", ImportThemePackage));
            custom.Children.Add(ManagerText("当前动作", true));
            WrapPanel actionButtons = new WrapPanel();
            if (activeTheme != null) foreach (ThemeAction action in activeTheme.Actions)
            {
                string slot = action.Slot;
                actionButtons.Children.Add(ManagerButton(SimpleActionLabel(slot), delegate { ShowWindow(); activeThemeOneShot = false; SetThemeAction(slot, slot != "idle"); }));
            }
            else custom.Children.Add(ManagerText("还没有安装动作。可以先创作，或导入已有主题。", false));
            custom.Children.Add(actionButtons);
            AddManagerTab("自定义", custom);

            StackPanel connection = ManagerPage("连接 AI 工具", "选好会话，宠物就会跟着任务动起来。");
            TextBlock connectionStatus = ManagerText("", false);
            connectionStatus.Margin = new Thickness(0);
            Border connectionCard = new Border { CornerRadius = new CornerRadius(8), Padding = new Thickness(16), Margin = new Thickness(0, 0, 0, 20), Child = connectionStatus };
            connectionCard.SetResourceReference(Border.BackgroundProperty, "PetSelected");
            connection.Children.Add(connectionCard);
            System.Windows.Threading.DispatcherTimer connectionRefresh = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            Action refreshConnection = delegate { connectionStatus.Text = FriendlyConnectionStatus(); };
            connectionRefresh.Tick += delegate { refreshConnection(); }; refreshConnection(); connectionRefresh.Start();
            petManager.Closed += delegate { connectionRefresh.Stop(); };
            Expander agentSetup = new Expander { Header = "其他工具：让 Agent 连接，或手动填写", Margin = new Thickness(0, 0, 0, 12) };
            StackPanel agentFields = new StackPanel();
            TextBox toolInput = new TextBox { Text = connectedAiTool ?? "my-agent", Margin = new Thickness(0, 0, 0, 10) };
            TextBox sessionInput = new TextBox { Text = connectedAiSession ?? "my-task", Margin = new Thickness(0, 0, 0, 12) };
            agentFields.Children.Add(ManagerText("工具标识", false)); agentFields.Children.Add(toolInput);
            agentFields.Children.Add(ManagerText("任务 / 会话标识", false)); agentFields.Children.Add(sessionInput);
            agentFields.Children.Add(ManagerButton("连接", delegate {
                SaveAiConnection(toolInput.Text.Trim(), sessionInput.Text.Trim());
                selectedCodexSession = null; selectedDesktopRolloutPath = null; ClearDesktopSelection();
                connectionStatus.Text = "已连接：" + connectedAiTool + " / " + connectedAiSession;
            }));
            agentSetup.Content = agentFields;
            Expander codexSetup = new Expander { Header = "可连接的本机会话", Visibility = Visibility.Collapsed, Margin = new Thickness(0, 0, 0, 12) };
            connection.Children.Add(ManagerButton("连接 Codex：选择任务", delegate {
                PopulateCodexSessionMenu();
                StackPanel sessions = new StackPanel();
                AddCodexConnectionButtons(sessions, codexSessionItem.DropDownItems, connectionStatus);
                codexSetup.Content = sessions; codexSetup.Visibility = Visibility.Visible; codexSetup.IsExpanded = true;
            }));
            connection.Children.Add(codexSetup);
            connection.Children.Add(ManagerButton("断开连接", delegate {
                SaveAiConnection(null, null); selectedCodexSession = null; selectedDesktopRolloutPath = null; ClearDesktopSelection();
                SetThemeAction("idle", false); connectionStatus.Text = "已断开连接";
            }));
            for (int i = 0; i < AiStates.Length; i++)
            {
                string state = AiStates[i];
                StackPanel row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 12) };
                row.Children.Add(new TextBlock { Text = AiStateLabels[i], Width = 160, VerticalAlignment = VerticalAlignment.Center });
                ComboBox choice = new ComboBox { Width = 210, Tag = state };
                if (activeTheme != null) foreach (ThemeAction action in activeTheme.Actions)
                {
                    ComboBoxItem item = new ComboBoxItem { Content = SimpleActionLabel(action.Slot), Tag = action.Slot };
                    choice.Items.Add(item); if (action.Slot == aiBindings[state]) choice.SelectedItem = item;
                }
                if (choice.SelectedItem == null)
                {
                    ComboBoxItem unavailable = new ComboBoxItem { Content = SimpleActionLabel(aiBindings[state]) + "（尚未添加）", Tag = aiBindings[state] };
                    choice.Items.Add(unavailable); choice.SelectedItem = unavailable;
                }
                choice.SelectionChanged += delegate {
                    ComboBoxItem selected = choice.SelectedItem as ComboBoxItem;
                    if (selected != null) { aiBindings[state] = (string)selected.Tag; SaveAiConnection(connectedAiTool, connectedAiSession); }
                };
                row.Children.Add(choice); connection.Children.Add(row);
            }
            connection.Children.Add(agentSetup);
            connection.Children.Add(new Expander { Header = "连接说明", Margin = new Thickness(0, 0, 0, 12), Content = ManagerText("每次跟随一个 Codex 会话；切换会话时，请重新选择。可观察开始、工具活动、结束和中断；已显示的输入请求可触发提醒，普通文字追问需要 Agent 主动报告。连接状态不会自动发送制作请求。", false) });
            connection.Children.Add(ManagerText("连接其他工具需要对应适配器发送状态。任务结束不代表成功；工具未提供的状态不自动猜测。", false));
            AddManagerTab("连接 AI 工具", connection);

            StackPanel settings = ManagerPage("设置", "日常只需调整陪伴偏好。备份和恢复放在下方，需要时再打开。");
            settings.Children.Add(ManagerButton("陪伴偏好", ShowPreferences));
            Expander advanced = new Expander { Header = "高级：备份、恢复与显示器", Margin = new Thickness(0, 10, 0, 0) };
            StackPanel utilities = new StackPanel();
            foreach (Forms.ToolStripItem item in advancedPetItems)
            {
                Forms.ToolStripMenuItem menu = item as Forms.ToolStripMenuItem;
                if (menu == null || menu == moveScreenItem || menu.Text == "陪伴偏好…") continue;
                Button button = ManagerButton(menu.Text, delegate { menu.PerformClick(); }); button.IsEnabled = menu.Enabled;
                utilities.Children.Add(button);
            }
            foreach (Forms.Screen screen in Forms.Screen.AllScreens)
            {
                string name = screen.DeviceName;
                utilities.Children.Add(ManagerButton("移动到显示器 " + name, delegate {
                    MovePetToScreen(FindScreen(name));
                }));
            }
            advanced.Content = utilities; settings.Children.Add(advanced); AddManagerTab("设置", settings);
            DockPanel managerShell = new DockPanel();
            StackPanel brand = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(24, 14, 20, 10) };
            brand.Children.Add(new TextBlock { Text = "AI Pet", FontSize = 20, FontWeight = FontWeights.SemiBold });
            TextBlock tagline = new TextBlock { Text = "你的桌面伙伴", Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            tagline.SetResourceReference(TextBlock.ForegroundProperty, "PetMuted"); brand.Children.Add(tagline);
            DockPanel.SetDock(brand, Dock.Top); managerShell.Children.Add(brand); managerShell.Children.Add(petManagerTabs);
            petManager.Content = managerShell; petManagerTabs.SelectedIndex = tab; petManager.Show();
        }

        private static string FriendlyConnectionStatus()
        {
            if (connectedAiTool == null) return "尚未连接\n选择 Codex 会话，或连接自己的 Agent。";
            string title = connectedAiTool == "codex" ? "已连接 Codex" : "已连接 " + connectedAiTool;
            if (connectedAiTool == "codex") title += "\n会话：" + (CodexTitleForHash(connectedAiSession) ?? "未命名会话");
            int state = Array.IndexOf(AiStates, lastAiState);
            string detail = state < 0 ? "等待这个会话的新任务状态…" : AiStateLabels[state];
            if (lastAiOutcome == "hidden") detail += " · 桌宠已隐藏";
            else if (lastAiOutcome == "quiet-hours") detail += " · 安静时段，暂停播放";
            else if (lastAiOutcome == "action-unavailable") detail += " · 请为此状态选择可用动作";
            else if (lastAiOutcome == "played" && activeThemeAction != null) detail += " · 动作：" + SimpleActionLabel(activeThemeAction.Slot);
            if (connectedAiTool == "codex" && lastCodexActionAtMs > 0) {
                long seconds = Math.Max(0, (CurrentUnixMilliseconds() - lastCodexActionAtMs) / 1000);
                detail += "\n最近收到状态：" + (seconds < 60 ? seconds + " 秒前" : seconds / 60 + " 分钟前");
            }
            return title + "\n" + detail;
        }

        private static void AddManagerTab(string label, StackPanel content)
        {
            petManagerTabs.Items.Add(new TabItem { Header = label, Padding = new Thickness(18, 8, 18, 8),
                Content = new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto } });
        }

        private static void AddCodexConnectionButtons(StackPanel panel, Forms.ToolStripItemCollection items, TextBlock status)
        {
            foreach (Forms.ToolStripItem item in items)
            {
                Forms.ToolStripMenuItem menu = item as Forms.ToolStripMenuItem;
                if (menu == null) continue;
                if (menu.DropDownItems.Count > 0) { AddCodexConnectionButtons(panel, menu.DropDownItems, status); continue; }
                Button button = ManagerButton(menu.Text, delegate {
                    SaveAiConnection(null, null); menu.PerformClick();
                    string session = selectedCodexSession;
                    if (session != null) SaveAiConnection("codex", session);
                    status.Text = FriendlyConnectionStatus();
                });
                CodexSessionDisplay display = menu.Tag as CodexSessionDisplay;
                if (display != null) {
                    StackPanel label = new StackPanel();
                    label.Children.Add(new TextBlock { Text = display.Title, TextWrapping = TextWrapping.Wrap, MaxWidth = 370 });
                    TextBlock context = new TextBlock { Text = display.Context, FontSize = 12, Margin = new Thickness(0, 4, 0, 0) };
                    context.SetResourceReference(TextBlock.ForegroundProperty, "PetMuted"); label.Children.Add(context);
                    button.Content = label; button.ToolTip = menu.ToolTipText;
                    button.HorizontalContentAlignment = HorizontalAlignment.Left;
                    button.HorizontalAlignment = HorizontalAlignment.Stretch;
                }
                button.IsEnabled = menu.Enabled; panel.Children.Add(button);
            }
        }

        private static void OpenSimpleCreator()
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "AI Pet Creator", "AIPetCreator.exe");
            string adjacent = Path.Combine(root, "AIPetCreator.exe");
            string executable = File.Exists(adjacent) ? adjacent : installed;
            if (File.Exists(executable))
            { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(executable) { UseShellExecute = true }); return; }
            string sourceRoot = Path.GetFullPath(Path.Combine(root, "..", ".."));
            if (File.Exists(Path.Combine(root, "tools", "creator_launcher.py"))) sourceRoot = root;
            string script = Path.Combine(sourceRoot, "tools", "creator_launcher.py");
            if (!File.Exists(script)) throw new InvalidOperationException("尚未安装创作空间。请让 Agent 按仓库 Skill 安装 AI Pet Creator。");
            string localPython = Path.Combine(sourceRoot, ".venv-matting", "Scripts", "python.exe");
            System.Diagnostics.ProcessStartInfo start = new System.Diagnostics.ProcessStartInfo {
                FileName = File.Exists(localPython) ? localPython : "python", Arguments = "\"" + script + "\"",
                WorkingDirectory = sourceRoot, UseShellExecute = false, CreateNoWindow = true };
            System.Diagnostics.Process.Start(start);
        }

        private static void ValidateCreationPhoto(string path)
        {
            FileInfo file = new FileInfo(path);
            if (!file.Exists || file.Length < 1 || file.Length > 10 * 1024 * 1024) throw new InvalidDataException("每张图片需小于 10 MB。");
            using (FileStream stream = File.OpenRead(path)) {
                BitmapDecoder image = BitmapDecoder.Create(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.None);
                if (image.Frames.Count != 1 || image.Frames[0].PixelWidth > 8192 || image.Frames[0].PixelHeight > 8192)
                    throw new InvalidDataException("请使用单帧、边长不超过 8192 像素的图片。");
            }
        }

        private static string SaveCreationRequest(IList<string> photos, string prompt)
        {
            if (photos.Count < 1 || photos.Count > 4 || String.IsNullOrWhiteSpace(prompt) || prompt.Length > 2000)
                throw new InvalidDataException("请添加 1–4 张图片，并描述想要的动作。");
            foreach (string photo in photos) ValidateCreationPhoto(photo);
            string id = Guid.NewGuid().ToString("N");
            string folder = Path.Combine(experienceRoot, "creation-requests", id);
            Directory.CreateDirectory(folder);
            List<object> references = new List<object>();
            for (int i = 0; i < photos.Count; i++) {
                string name = "reference-" + (i + 1) + Path.GetExtension(photos[i]).ToLowerInvariant();
                string destination = Path.Combine(folder, name); File.Copy(photos[i], destination);
                references.Add(new { path = name, sha256 = FileSha256Hex(destination) });
            }
            WriteCodexEventAtomically(Path.Combine(folder, "request.json"), new JavaScriptSerializer().Serialize(new {
                version = 1, id = id, prompt = prompt.Trim(), references = references, createdAtMs = CurrentUnixMilliseconds(),
                target = "transparent-desktop-pet", review = "required" }));
            WriteCodexEventAtomically(Path.Combine(folder, "agent-instructions.txt"), CreationHandoff(id));
            return id;
        }

        private static string CreationHandoff(string id)
        {
            string folder = CreationFolder(id);
            return "请使用 $ai-pet Skill 制作这份桌宠动作请求。\r\n"
                + "Skill 来源：https://github.com/tanghuanqiang/ai-pet/tree/main/skills/ai-pet\r\n"
                + "创作编号：" + id + "\r\n"
                + "请求文件：" + Path.Combine(folder, "request.json") + "\r\n"
                + "桌宠程序：" + System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName + "\r\n"
                + "数据目录：" + experienceRoot + "\r\n"
                + "读取请求中的全部参考图并校验 SHA-256，按其中的 Prompt 使用你已有的图像/动画生成工具制作透明动作。"
                + "若工具不可用，请明确告诉我缺少什么。将候选主题通过 ai-pet result 提交到上述编号，使用相同桌宠程序和数据目录。"
                + "完成后我会在桌宠中预览并选择使用。";
        }

        private static void CopyCreationHandoff(string id)
        {
            string instructions = CreationHandoff(id);
            WriteCodexEventAtomically(Path.Combine(CreationFolder(id), "agent-instructions.txt"), instructions);
            try { System.Windows.Clipboard.SetText(instructions); }
            catch (Exception) { throw new InvalidOperationException("请求已保存，剪贴板暂时不可用，请稍后点击“复制制作说明”。"); }
        }

        private static string LatestCreationCandidate()
        {
            string id = LatestCreationId();
            if (id == null) return null;
            string result = Path.Combine(experienceRoot, "creation-requests", id, "candidate.lotheme");
            return File.Exists(result) ? result : null;
        }

        private static string LatestCreationId()
        {
            if (latestCreationRequest != null) return File.Exists(Path.Combine(experienceRoot, "creation-requests", latestCreationRequest, "request.json")) ? latestCreationRequest : null;
            string root = Path.Combine(experienceRoot, "creation-requests");
            if (!Directory.Exists(root)) return null;
            string[] folders = Directory.GetDirectories(root);
            Array.Sort(folders, delegate(string a, string b) { return Directory.GetCreationTimeUtc(b).CompareTo(Directory.GetCreationTimeUtc(a)); });
            foreach (string folder in folders) {
                if (latestCreationRequest != null && Path.GetFileName(folder) != latestCreationRequest) continue;
                if (!File.Exists(Path.Combine(folder, "request.json"))) continue;
                return Path.GetFileName(folder);
            }
            return null;
        }

        private static void ImportCreationCandidate(string candidate)
        {
            string folder = Path.GetDirectoryName(candidate);
            Dictionary<string, object> request = new JavaScriptSerializer().DeserializeObject(ReadBoundedJson(Path.Combine(folder, "request.json"))) as Dictionary<string, object>;
            System.Collections.IList references = request["references"] as System.Collections.IList;
            Dictionary<string, object> first = references[0] as Dictionary<string, object>;
            string relative = ReadString(first, "path");
            if (Path.GetFileName(relative) != relative) throw new InvalidDataException("参考图片路径无效。");
            string photo = Path.Combine(folder, relative);
            if (FileSha256Hex(photo) != ReadString(first, "sha256")) throw new InvalidDataException("参考图片已变化，请重新制作。");
            ValidateCreationPhoto(photo);
            BitmapImage source = LoadReferenceBitmap(photo);
            JpegBitmapEncoder image = new JpegBitmapEncoder(); image.QualityLevel = 90; image.Frames.Add(BitmapFrame.Create(source));
            string photoData;
            using (MemoryStream stream = new MemoryStream()) { image.Save(stream); photoData = "data:image/jpeg;base64," + Convert.ToBase64String(stream.ToArray()); }
            string prompt = ReadString(request, "prompt"); if (prompt.Length > 1200) prompt = prompt.Substring(0, 1200);
            object card = new { kind = "little-orbit.character-card", version = 1, status = "draft", character = new {
                name = "我的宠物", mode = "real", photo = photoData, photoName = relative,
                action = "打个招呼", prompt = prompt, traits = new string[0] } };
            string previousJson = File.Exists(pendingRoleFilePath) ? ReadBoundedJson(pendingRoleFilePath) : null;
            RoleCard previous = pendingRole;
            try {
                string json = new JavaScriptSerializer().Serialize(card);
                PersistRoleCardAt(pendingRoleFilePath, json); pendingRole = ParseRoleCard(json);
                ImportThemePackage(candidate);
            }
            finally {
                if (previousJson != null) PersistRoleCardAt(pendingRoleFilePath, previousJson);
                else if (File.Exists(pendingRoleFilePath)) File.Delete(pendingRoleFilePath);
                pendingRole = previous; UpdatePendingRoleMenu();
            }
        }

        private static void TestSimpleExperience(string output)
        {
            Directory.CreateDirectory(output);
            WpfApplication app = new WpfApplication(); app.ShutdownMode = ShutdownMode.OnExplicitShutdown;
            string referenceTheme = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "reviewed-reference-cat.lotheme");
            activeTheme = File.Exists(referenceTheme) ? ParseThemePackage(referenceTheme) : CreatePublicDemoTheme();
            BuildTray(); BuildWindow(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "reference-cat.jpg"));
            window.Show();
            PopulatePetActions(); ShowPetManager(0);
            Window first = petManager; ShowPetManager(1);
            bool reused = first == petManager && petManagerTabs.SelectedIndex == 1;
            List<string> menu = new List<string>();
            foreach (Forms.ToolStripItem item in trayMenu.Items) if (!(item is Forms.ToolStripSeparator)) menu.Add(item.Text);
            bool simple = menu.Count == 6 && actionsMenu.DropDownItems.Count == activeTheme.Actions.Count;
            trayMenu.Size = trayMenu.GetPreferredSize(System.Drawing.Size.Empty);
            using (System.Drawing.Bitmap menuBitmap = new System.Drawing.Bitmap(trayMenu.Width, trayMenu.Height)) {
                trayMenu.DrawToBitmap(menuBitmap, new System.Drawing.Rectangle(0, 0, trayMenu.Width, trayMenu.Height));
                menuBitmap.Save(Path.Combine(output, "menu.png"), System.Drawing.Imaging.ImageFormat.Png);
            }
            for (int i = 0; i < 3; i++)
            {
                petManagerTabs.SelectedIndex = i; petManager.UpdateLayout();
                RenderTargetBitmap bitmap = new RenderTargetBitmap((int)petManager.ActualWidth, (int)petManager.ActualHeight, 96, 96, PixelFormats.Pbgra32);
                bitmap.Render(petManager); PngBitmapEncoder encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
                using (FileStream stream = File.Create(Path.Combine(output, "manager-" + i + ".png"))) encoder.Save(stream);
            }
            SaveAiConnection("test-agent", "task-1");
            bool states = true; List<object> outcomes = new List<object>();
            foreach (string state in AiStates)
            {
                Dictionary<string, object> record = new Dictionary<string, object> {
                    {"version",1}, {"eventId",Guid.NewGuid().ToString("N")}, {"observedAtMs",CurrentUnixMilliseconds()},
                    {"tool","test-agent"}, {"session","task-1"}, {"state",state} };
                bool accepted = ApplyAiEvent(record), duplicate = !ApplyAiEvent(record);
                record["eventId"] = Guid.NewGuid().ToString("N"); record["session"] = "another-task";
                bool isolated = !ApplyAiEvent(record);
                record["session"] = "task-1"; record["observedAtMs"] = CurrentUnixMilliseconds() - 20000;
                bool stale = !ApplyAiEvent(record);
                bool played = lastAiOutcome == "played" && activeThemeAction.Slot == aiBindings[state];
                states &= accepted && duplicate && isolated && stale && played;
                outcomes.Add(new { state = state, accepted = accepted, played = played, duplicateRejected = duplicate, otherSessionRejected = isolated, staleRejected = stale });
            }
            SaveAiConnection(null, null);
            SetThemeAction("click", true); PollAiConnection(); PollAiConnection();
            bool manualWithoutConnection = activeThemeAction.Slot == "click";
            SaveAiConnection("test-agent", "task-1");
            Dictionary<string, object> runningEvent = new Dictionary<string, object> {
                {"version",1}, {"eventId",Guid.NewGuid().ToString("N")}, {"observedAtMs",CurrentUnixMilliseconds()},
                {"tool","test-agent"}, {"session","task-1"}, {"state","running"} };
            ApplyAiEvent(runningEvent); window.Hide(); PollAiConnection();
            bool hiddenStopsRunning = activeThemeAction.Slot == "idle" && lastAiOutcome == "hidden";
            window.Show(); PollAiConnection();
            bool showDoesNotReplay = activeThemeAction.Slot == "idle";
            runningEvent["eventId"] = Guid.NewGuid().ToString("N"); runningEvent["observedAtMs"] = CurrentUnixMilliseconds();
            ApplyAiEvent(runningEvent); File.Delete(aiConfigurationPath); PollAiConnection();
            bool removedConnectionStopsRunning = activeThemeAction.Slot == "idle" && connectedAiTool == null;
            SaveAiConnection(null, null);
            RenderPreview(Path.Combine(output, "pet.png"));
            string creation = SaveCreationRequest(new string[] {
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "reference-cat.jpg"),
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "reference-cat.jpg") }, "保留参考形象，抬起爪子打招呼。");
            string candidate = Path.Combine(experienceRoot, "creation-requests", creation, "candidate.lotheme");
            ExportPublicDemoTheme(candidate);
            bool themeExisted = File.Exists(activeThemeFilePath);
            themeReviewRenderPath = Path.Combine(output, "candidate-review.png");
            themeReviewRenderSlot = "idle"; themeReviewRenderFrame = 0;
            ImportCreationCandidate(candidate);
            bool previewOnly = File.Exists(Path.Combine(output, "candidate-review.png")) &&
                File.Exists(activeThemeFilePath) == themeExisted && pendingRole == null && !File.Exists(pendingRoleFilePath);
            File.WriteAllText(Path.Combine(output, "result.json"), new JavaScriptSerializer().Serialize(new {
                menu = menu, simpleMenu = simple, reusedWindow = reused, fiveStateIsolation = states,
                actions = actionsMenu.DropDownItems.Count, outcomes = outcomes, disconnected = connectedAiTool == null,
                manualWithoutConnection = manualWithoutConnection, hiddenStopsRunning = hiddenStopsRunning,
                showDoesNotReplay = showDoesNotReplay, removedConnectionStopsRunning = removedConnectionStopsRunning,
                twoPhotoCreationRequest = creation, creationPreviewRequiresConfirmation = previewOnly }));
            ExitApplication();
            if (!simple || !reused || !states || !previewOnly || !manualWithoutConnection || !hiddenStopsRunning ||
                !showDoesNotReplay || !removedConnectionStopsRunning) throw new InvalidOperationException("Simple experience regression failed.");
        }

        // This original illustration is generated from code; no private photo or model is distributed.
        private static BitmapSource DrawPublicDemoFrame(string slot, int index)
        {
            double phase = Math.Sin(index * Math.PI * 2 / 24.0);
            double blink = slot == "interrupt" ? 0.10 : slot == "stop-unknown" ? 0.4 :
                slot == "idle" && index > 16 && index < 21 ? 0.14 : 1;
            double look = slot == "hover" ? phase * 4 : 0;
            SolidColorBrush fur = new SolidColorBrush(Color.FromRgb(230, 173, 112));
            SolidColorBrush cream = new SolidColorBrush(Color.FromRgb(255, 239, 209));
            SolidColorBrush ink = new SolidColorBrush(Color.FromRgb(75, 61, 54));
            Pen outline = new Pen(ink, 2.5);
            DrawingVisual visual = new DrawingVisual();
            using (DrawingContext dc = visual.RenderOpen())
            {
                dc.DrawEllipse(fur, outline, new Point(153, 188), 23, 15);
                dc.DrawEllipse(fur, outline, new Point(94, 176), 56, 57);
                dc.DrawEllipse(cream, null, new Point(94, 181), 34, 43);
                dc.DrawEllipse(fur, outline, new Point(63, 222), 23, 10);
                dc.DrawEllipse(fur, outline, new Point(123, 222), 23, 10);
                StreamGeometry leftEar = new StreamGeometry();
                using (StreamGeometryContext g = leftEar.Open()) {
                    g.BeginFigure(new Point(42, 91), true, true); g.LineTo(new Point(42, 40), true, false); g.LineTo(new Point(80, 63), true, false);
                }
                StreamGeometry rightEar = new StreamGeometry();
                using (StreamGeometryContext g = rightEar.Open()) {
                    g.BeginFigure(new Point(112, 63), true, true); g.LineTo(new Point(149, 40), true, false); g.LineTo(new Point(148, 91), true, false);
                }
                dc.DrawGeometry(fur, outline, leftEar); dc.DrawGeometry(fur, outline, rightEar);
                dc.DrawEllipse(fur, outline, new Point(95 + look, 103), 61, 48);
                dc.DrawEllipse(cream, null, new Point(95 + look, 118), 35, 26);
                double eyeHeight = 6 * blink;
                dc.DrawEllipse(ink, null, new Point(71 + look, 101), 4, eyeHeight);
                dc.DrawEllipse(ink, null, new Point(118 + look, 101), 4, eyeHeight);
                dc.DrawEllipse(new SolidColorBrush(Color.FromRgb(194, 114, 107)), null, new Point(95 + look, 115), 5, 3);
                dc.DrawLine(new Pen(ink, 2), new Point(95 + look, 119), new Point(95 + look, 124));
                dc.DrawEllipse(fur, outline, new Point(46, 177), 12, 23);
                double paw = slot == "click" || slot == "needs-user" ? 133 + phase * 12 : 177;
                dc.DrawEllipse(fur, outline, new Point(143, paw), 12, 23);
                if (slot == "recent-activity") {
                    dc.DrawRoundedRectangle(new SolidColorBrush(Color.FromRgb(129, 160, 160)), outline,
                        new Rect(49, 181, 93, 32), 5, 5);
                    dc.DrawEllipse(fur, outline, new Point(71 + phase * 3, 183), 10, 7);
                    dc.DrawEllipse(fur, outline, new Point(121 - phase * 3, 183), 10, 7);
                }
                if (slot == "ambient") {
                    dc.DrawEllipse(cream, null, new Point(163, 154 + phase * 8), 6, 6);
                }
            }
            RenderTargetBitmap result = new RenderTargetBitmap(190, 254, 96, 96, PixelFormats.Pbgra32);
            result.Render(visual); result.Freeze(); return result;
        }

        private static ThemePackage CreatePublicDemoTheme()
        {
            ThemePackage theme = new ThemePackage { Name = "小麦 · 内置插画宠物", Actions = new List<ThemeAction>() };
            foreach (string slot in SupportedThemeSlots)
            {
                ThemeAction action = new ThemeAction { Slot = slot, FramesPerSecond = 12,
                    Loop = slot == "idle" || slot == "ambient" || slot == "recent-activity", Frames = new List<BitmapSource>(),
                    CanvasWidth = 190, CanvasHeight = 254 };
                for (int i = 0; i < 24; i++) action.Frames.Add(DrawPublicDemoFrame(slot, i));
                theme.Actions.Add(action);
            }
            return theme;
        }

        private static void ExportPublicDemoPhoto(string path)
        {
            JpegBitmapEncoder encoder = new JpegBitmapEncoder(); encoder.QualityLevel = 90;
            encoder.Frames.Add(BitmapFrame.Create(DrawPublicDemoFrame("idle", 0)));
            using (FileStream stream = File.Create(path)) encoder.Save(stream);
        }

        private static void ExportPublicDemoAssets(string root)
        {
            Directory.CreateDirectory(root);
            string photo = Path.Combine(root, "reference-cat.jpg");
            if (!File.Exists(photo)) ExportPublicDemoPhoto(photo);
            string assets = Path.Combine(root, "assets"); Directory.CreateDirectory(assets);
            foreach (string name in new string[] { "reviewed-reference-cat.png", "pending-model-reference-cat.png" })
            {
                string path = Path.Combine(assets, name);
                if (File.Exists(path)) continue;
                PngBitmapEncoder encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(DrawPublicDemoFrame("idle", 0)));
                using (FileStream stream = File.Create(path)) encoder.Save(stream);
            }
        }

        private static void ExportPublicDemoTheme(string path)
        {
            ThemePackage theme = CreatePublicDemoTheme(); List<object> actions = new List<object>();
            using (FileStream stream = File.Create(path))
            using (System.IO.Compression.ZipArchive zip = new System.IO.Compression.ZipArchive(stream, System.IO.Compression.ZipArchiveMode.Create))
            {
                foreach (ThemeAction action in theme.Actions) {
                    List<string> names = new List<string>();
                    for (int i = 0; i < action.Frames.Count; i++) {
                        string name = "frames/" + action.Slot + "/" + (i + 1).ToString("D4") + ".png"; names.Add(name);
                        System.IO.Compression.ZipArchiveEntry entry = zip.CreateEntry(name);
                        entry.LastWriteTime = new DateTimeOffset(2026, 10, 16, 0, 0, 0, TimeSpan.Zero);
                        PngBitmapEncoder encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(action.Frames[i]));
                        using (MemoryStream png = new MemoryStream()) {
                            encoder.Save(png); png.Position = 0;
                            using (Stream output = entry.Open()) png.CopyTo(output);
                        }
                    }
                    actions.Add(new { slot = action.Slot, fps = action.FramesPerSecond, loop = action.Loop, frames = names });
                }
                System.IO.Compression.ZipArchiveEntry manifest = zip.CreateEntry("manifest.json");
                manifest.LastWriteTime = new DateTimeOffset(2026, 10, 16, 0, 0, 0, TimeSpan.Zero);
                using (StreamWriter writer = new StreamWriter(manifest.Open(), new UTF8Encoding(false)))
                    writer.Write(new JavaScriptSerializer().Serialize(new { format = "little-orbit.theme", version = 1, name = theme.Name, review = "required", actions = actions }));
            }
        }
    }
}
