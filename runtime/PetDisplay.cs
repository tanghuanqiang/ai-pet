using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace AIPet.Desktop
{
    internal static partial class DesktopPet
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct DisplayRect { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out DisplayRect rect);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern IntPtr GetThreadDpiAwarenessContext();
        [DllImport("user32.dll")] private static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam);
        private static int displayRecoveryCount;
        private static bool displayRecoveryEnabled;

        // Native screen coordinates stay in physical pixels. Do not apply one monitor's
        // WPF transform to the origin of a different monitor with another scale factor.
        private static System.Drawing.Point ClampDisplayPixels(System.Drawing.Rectangle area, DisplayRect bounds)
        {
            int width = Math.Max(1, bounds.Right - bounds.Left), height = Math.Max(1, bounds.Bottom - bounds.Top);
            return new System.Drawing.Point(Math.Max(area.Left, Math.Min(Math.Max(area.Left, area.Right - width), bounds.Left)),
                Math.Max(area.Top, Math.Min(Math.Max(area.Top, area.Bottom - height), bounds.Top)));
        }

        private static void RecoverDisplayWindow(Window target)
        {
            if (target == null || !target.IsLoaded || !target.IsVisible) return;
            IntPtr hwnd = new WindowInteropHelper(target).Handle;
            DisplayRect bounds;
            if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out bounds)) return;
            System.Drawing.Rectangle area = Forms.Screen.FromHandle(hwnd).WorkingArea;
            System.Drawing.Point point = ClampDisplayPixels(area, bounds);
            if (point.X != bounds.Left || point.Y != bounds.Top) {
                // NOSIZE | NOZORDER | NOACTIVATE: recovery must never steal focus.
                SetWindowPos(hwnd, IntPtr.Zero, point.X, point.Y, 0, 0, 0x0015);
            }
            displayRecoveryCount++;
            if (target == window) TrySaveCurrentPlacement();
        }

        private static void AttachDisplayRecovery(Window target)
        {
            if (!displayRecoveryEnabled) return;
            bool queued = false;
            Action schedule = delegate {
                if (queued || target.Dispatcher.HasShutdownStarted) return;
                queued = true;
                target.Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, new Action(delegate {
                    queued = false;
                    RecoverDisplayWindow(target);
                }));
            };
            target.SourceInitialized += delegate {
                HwndSource source = HwndSource.FromHwnd(new WindowInteropHelper(target).Handle);
                if (source == null) return;
                HwndSourceHook hook = delegate(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled) {
                    if (message == 0x02E0 || message == 0x007E || message == 0x001A || message == 0x0218) schedule();
                    // WPF owns WM_DPICHANGED and its recommended rectangle.
                    return IntPtr.Zero;
                };
                source.AddHook(hook);
                target.Closed += delegate { if (!source.IsDisposed) source.RemoveHook(hook); };
            };
            target.Loaded += delegate { schedule(); };
        }

        private static void MovePetToScreen(Forms.Screen screen)
        {
            preferredScreenName = screen.DeviceName;
            ShowWindow();
            IntPtr hwnd = new WindowInteropHelper(window).Handle;
            DisplayRect bounds;
            if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out bounds)) return;
            System.Drawing.Rectangle area = screen.WorkingArea;
            bounds.Left = area.Right - Math.Max(1, bounds.Right - bounds.Left) - 22;
            bounds.Top = area.Bottom - Math.Max(1, bounds.Bottom - bounds.Top) - 28;
            SetWindowPos(hwnd, IntPtr.Zero, Math.Max(area.Left, bounds.Left), Math.Max(area.Top, bounds.Top), 0, 0, 0x0015);
            window.Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, new Action(delegate { RecoverDisplayWindow(window); }));
        }

        private static void TestDisplayCompatibility(string output, string photoPath)
        {
            if (File.Exists(output)) throw new InvalidDataException("Refusing to overwrite display evidence.");
            System.Drawing.Point negative = ClampDisplayPixels(new System.Drawing.Rectangle(-2560, -1440, 2560, 1400),
                new DisplayRect { Left = 5000, Top = -9000, Right = 5351, Bottom = -8451 });
            bool geometry = negative.X == -351 && negative.Y == -1440;
            foreach (int dpi in new int[] { 96, 144, 192 }) {
                int width = 234 * dpi / 96, height = 366 * dpi / 96;
                System.Drawing.Point p = ClampDisplayPixels(new System.Drawing.Rectangle(1920, 0, 2560, 1400),
                    new DisplayRect { Left = 9000, Top = 9000, Right = 9000 + width, Bottom = 9000 + height });
                geometry &= p.X == 4480 - width && p.Y == 1400 - height;
            }
            System.Windows.Application app = new System.Windows.Application(); app.ShutdownMode = ShutdownMode.OnExplicitShutdown;
            BuildTray(); BuildWindow(photoPath); window.Show();
            IntPtr hwnd = new WindowInteropHelper(window).Handle;
            bool pmv2 = AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4));
            uint actualDpi = GetDpiForWindow(hwnd);
            // An off-screen window exercises actual native recovery, without changing
            // the user's display configuration or simulating a physical monitor.
            SetWindowPos(hwnd, IntPtr.Zero, -30000, -30000, 0, 0, 0x0015);
            RecoverDisplayWindow(window);
            DisplayRect recovered; GetWindowRect(hwnd, out recovered);
            System.Drawing.Rectangle area = Forms.Screen.FromHandle(hwnd).WorkingArea;
            System.Drawing.Point expected = ClampDisplayPixels(area, recovered);
            bool visible = expected.X == recovered.Left && expected.Y == recovered.Top;
            // Exercise the real registered message hook and queued UI callback.
            window.Dispatcher.Invoke(DispatcherPriority.ApplicationIdle, new Action(delegate { }));
            int beforeMessage = displayRecoveryCount;
            SendMessage(hwnd, 0x001A, IntPtr.Zero, IntPtr.Zero);
            window.Dispatcher.Invoke(DispatcherPriority.ApplicationIdle, new Action(delegate { }));
            bool callbackObserved = displayRecoveryCount > beforeMessage;
            Directory.CreateDirectory(Path.GetDirectoryName(output));
            File.WriteAllText(output, new JavaScriptSerializer().Serialize(new {
                geometry = geometry, perMonitorV2 = pmv2, actualDpi = actualDpi, offscreenRecovery = visible,
                monitorCount = Forms.Screen.AllScreens.Length, recoveryCount = displayRecoveryCount,
                syntheticSettingsCallback = callbackObserved,
                hardwareHotplugTested = false, mixedDpiHardwareTested = false
            }));
            ExitApplication();
            if (!geometry || !pmv2 || actualDpi == 0 || !visible || !callbackObserved) throw new InvalidOperationException("Display compatibility check failed.");
        }
    }
}
