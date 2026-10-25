using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

// All coordinates crossing this boundary are physical screen pixels. Never
// change focus, resize windows or synthesize global mouse input to move a pet.
public static class LLMPetDesktop {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint Size, Time; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
    [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
    public class Window {
        public string hwnd, name, title, className;
        public int pid, x, y, w, h, style, exStyle, dpi;
        public Mascot mascot;
    }
    public class Mascot { public int x, y, w, h; }
    static Mascot FindMascot(IntPtr handle) {
        try {
            var root = AutomationElement.FromHandle(handle);
            var condition = new AndCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Image),
                new OrCondition(new PropertyCondition(AutomationElement.NameProperty,"Codex pet"),
                    new PropertyCondition(AutomationElement.NameProperty,"ChatGPT pet")));
            var images = root.FindAll(TreeScope.Descendants, condition);
            if (images.Count != 1 || images[0].Current.IsOffscreen) return null;
            var r = images[0].Current.BoundingRectangle;
            if (r.IsEmpty || r.Width < 24 || r.Height < 24 || r.Width > 1000 || r.Height > 1000) return null;
            return new Mascot { x=(int)Math.Round(r.X), y=(int)Math.Round(r.Y), w=(int)Math.Round(r.Width), h=(int)Math.Round(r.Height) };
        } catch { return null; }
    }
    public static void Init() { try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch {} }
    public static Window Read(string handle) {
        long number;
        if (!long.TryParse(handle, out number) || number <= 0) return null;
        IntPtr h = new IntPtr(number);
        if (!IsWindow(h) || !IsWindowVisible(h) || IsIconic(h)) return null;
        int cloaked;
        if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return null;
        uint pid; GetWindowThreadProcessId(h, out pid);
        Rect r; if (!GetWindowRect(h, out r)) return null;
        string name;
        try { using (var process = Process.GetProcessById((int)pid)) name = process.ProcessName; } catch { return null; }
        var title = new StringBuilder(1024); GetWindowText(h, title, title.Capacity);
        var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
        var window = new Window { hwnd=handle, pid=(int)pid, name=name, title=title.ToString(), className=cls.ToString(),
            x=r.Left, y=r.Top, w=r.Right-r.Left, h=r.Bottom-r.Top,
            style=GetWindowLong(h,-16), exStyle=GetWindowLong(h,-20), dpi=(int)GetDpiForWindow(h) };
        // Modern Codex uses a large transparent surface. Identify its visible
        // mascot through the accessibility image, never document/text values.
        if ((name.Equals("ChatGPT",StringComparison.OrdinalIgnoreCase) || name.Equals("Codex",StringComparison.OrdinalIgnoreCase))
            && (window.style & 0x00c00000) == 0 && (window.exStyle & 0x00080000) != 0)
            window.mascot = FindMascot(h);
        return window;
    }
    public static Window[] Scan(string[] names) {
        var result = new List<Window>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint id; GetWindowThreadProcessId(h, out id);
            string name;
            try { using (var process = Process.GetProcessById((int)id)) name = process.ProcessName; } catch { return true; }
            bool matched = false;
            foreach (string pattern in names) {
                if (!String.IsNullOrWhiteSpace(pattern) && name.IndexOf(pattern, StringComparison.OrdinalIgnoreCase) >= 0) { matched=true; break; }
            }
            if (matched) { var win = Read(h.ToInt64().ToString()); if (win != null) result.Add(win); }
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
    static Window Validate(string handle, int pid, string name, string title, string cls) {
        var w = Read(handle);
        if (w == null || w.pid != pid || w.name != name || w.title != title || w.className != cls)
            throw new InvalidOperationException("target-changed");
        if (name.Equals("ChatGPT",StringComparison.OrdinalIgnoreCase) || name.Equals("Codex",StringComparison.OrdinalIgnoreCase)) {
            if ((w.style & 0x00c00000) != 0 || (w.exStyle & (0x00080000|0x00000080)) == 0
                || (w.mascot == null && !System.Text.RegularExpressions.Regex.IsMatch(w.title,
                    @"^(Codex Pet( Mascot( Effect)?)?|ChatGPT Pet|(Codex |ChatGPT )?Avatar( Overlay)?)$",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase)))
                throw new InvalidOperationException("target-is-not-a-pet");
        }
        return w;
    }
    public static Window Move(string handle, int pid, string name, string title, string cls, int x, int y) {
        Validate(handle,pid,name,title,cls);
        if (!SetWindowPos(new IntPtr(long.Parse(handle)), IntPtr.Zero, x,y,0,0, 0x0015))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return Validate(handle,pid,name,title,cls);
    }
    public static void Close(string handle, int pid, string name, string title, string cls) {
        Validate(handle,pid,name,title,cls);
        if (!PostMessage(new IntPtr(long.Parse(handle)), 0x0010, IntPtr.Zero, IntPtr.Zero))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    public static double IdleSeconds() {
        var v = new LastInput { Size=(uint)Marshal.SizeOf(typeof(LastInput)) };
        if (!GetLastInputInfo(ref v)) return 0;
        return unchecked((uint)Environment.TickCount - v.Time) / 1000.0;
    }
}
