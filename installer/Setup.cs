// 豆包工坊 安装程序（单文件）
//
// 结构：[本 exe 代码] + [app 的 zip 数据] + [24 字节尾索引]
// 尾索引：int64 数据偏移 | int64 数据长度 | "DMINST01"
//
// 为什么自己写而不是用 NSIS/Inno：本机没装这两样，离线也下不了；
// 系统自带 csc.exe 能直接编出 WinForms 程序，且单文件追加数据的方式最省事，
// 卸载器只要复制本 exe 的头部（不含数据）就是一个小工具，不用再带 170MB。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace DolaModSetup
{
    internal sealed class Options
    {
        public string Dir = "";
        public string CleanupDir = "";
        public bool Silent;
        public bool Desktop = true;
        public bool Run = true;
        public bool Uninstall;
        public bool Cleanup;
        public bool PurgeData;
        public bool Update;
        public int WaitPid;
    }

    internal static class Program
    {
        internal const string AppName = "豆包工坊";
        internal const string AppExeName = "豆包工坊.exe";
        internal const string LegacyName = "无限豆包";
        internal const string AppVersion = "1.3.3";
        internal const string Publisher = "豆包工坊";
        internal const string RegKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\InfiniteDoubao";
        internal const string Magic = "DMINST01";
        internal const int TailSize = 24;

        [STAThread]
        internal static int Main(string[] args)
        {
            Options o = Parse(args);
            if (o.Cleanup) return DoCleanup(o);
            if (o.Uninstall) return DoUninstall(o);
            if (o.Silent)
            {
                try
                {
                    Install(o, null, null);
                    if (o.Run) LaunchApp(o.Dir);
                    return 0;
                }
                catch (Exception ex)
                {
                    TryLog("silent install failed: " + ex.Message);
                    return 1;
                }
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm(o));
            return 0;
        }

        /* ------------------------------------------------------------ 参数 */

        private static Options Parse(string[] args)
        {
            Options o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i] ?? "";
                if (a.Equals("/S", StringComparison.OrdinalIgnoreCase) || a.Equals("/silent", StringComparison.OrdinalIgnoreCase)
                    || a.Equals("/quiet", StringComparison.OrdinalIgnoreCase) || a.Equals("/verysilent", StringComparison.OrdinalIgnoreCase)
                    || a.Equals("--silent", StringComparison.OrdinalIgnoreCase)) o.Silent = true;
                else if (a.StartsWith("/D=", StringComparison.OrdinalIgnoreCase)) o.Dir = a.Substring(3).Trim('"');
                else if (a.Equals("/UPDATE", StringComparison.OrdinalIgnoreCase)) o.Update = true;
                else if (a.StartsWith("/WAITPID=", StringComparison.OrdinalIgnoreCase)) int.TryParse(a.Substring(9), out o.WaitPid);
                else if (a.Equals("/NODESKTOP", StringComparison.OrdinalIgnoreCase) || a.Equals("--no-desktop", StringComparison.OrdinalIgnoreCase)) o.Desktop = false;
                else if (a.Equals("/NORUN", StringComparison.OrdinalIgnoreCase) || a.Equals("--no-run", StringComparison.OrdinalIgnoreCase)) o.Run = false;
                else if (a.Equals("/uninstall", StringComparison.OrdinalIgnoreCase) || a.Equals("--uninstall", StringComparison.OrdinalIgnoreCase)) o.Uninstall = true;
                else if (a.Equals("/purge", StringComparison.OrdinalIgnoreCase) || a.Equals("--purge", StringComparison.OrdinalIgnoreCase)) o.PurgeData = true;
                else if (a.Equals("/cleanup", StringComparison.OrdinalIgnoreCase))
                {
                    o.Cleanup = true;
                    if (i + 1 < args.Length) o.CleanupDir = args[++i].Trim('"');
                }
                else if (a.Equals("/?", StringComparison.OrdinalIgnoreCase) || a.Equals("/help", StringComparison.OrdinalIgnoreCase))
                {
                    MessageBox.Show(
                        AppName + " 安装程序 v" + AppVersion + "\n\n" +
                        "  直接双击            图形界面安装\n" +
                        "  /S /D=<目录>        静默安装\n" +
                        "  /NODESKTOP          不创建桌面快捷方式\n" +
                        "  /NORUN              装完不自动启动\n" +
                        "  /uninstall          卸载\n",
                        AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    Environment.Exit(0);
                }
            }
            if (o.Dir.Length == 0) o.Dir = DefaultDir();
            return o;
        }

        internal static string DefaultDir()
        {
            string installed = RegistryInstallDir();
            if (LooksLikeInstall(installed)) return Path.GetFullPath(installed);
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                AppName);
        }

        /** Electron 的 userData 目录：%APPDATA%\无限豆包 */
        internal static string DataDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), LegacyName);
        }

        /* ------------------------------------------------------------ 安装 */

        internal static void Install(Options o, Action<int, string> progress, Action<string> status)
        {
            if (o.WaitPid > 0 && o.WaitPid != Process.GetCurrentProcess().Id)
            {
                if (status != null) status("正在等待应用保存数据并退出…");
                Process previous = null;
                try { previous = Process.GetProcessById(o.WaitPid); } catch (ArgumentException) { }
                if (previous != null)
                {
                    using (previous)
                        if (!previous.WaitForExit(30000)) throw new IOException("应用尚未退出，请关闭应用后重试更新。");
                }
            }
            string dir = Path.GetFullPath(o.Dir);
            if (dir.Length < 4) throw new InvalidOperationException("安装目录不合法。");
            // 与目标目录同卷，解压后可直接移动文件，避免再次读写整套运行时。
            string parent = Path.GetDirectoryName(dir);
            Directory.CreateDirectory(parent);
            string stage = Path.Combine(parent, ".doubao-setup-" + Guid.NewGuid().ToString("N"));
            Stopwatch timer = Stopwatch.StartNew();
            try
            {
                // 先完整解包，损坏的安装包或被占用的旧版本不能造成半覆盖。
                if (status != null) status("正在检查并释放安装文件…");
                Directory.CreateDirectory(stage);
                using (Stream payload = OpenPayload())
                    ExtractPayload(payload, stage, dir, progress == null ? null : new Action<int, string>(delegate(int p, string name) { progress(p * 85 / 100, name); }));
                TryLog("extract_ms=" + timer.ElapsedMilliseconds);
                if ((!File.Exists(Path.Combine(stage, AppExeName)) && !File.Exists(Path.Combine(dir, AppExeName))) ||
                    (!File.Exists(Path.Combine(stage, "resources", "app.asar")) && !File.Exists(Path.Combine(dir, "resources", "app.asar"))))
                    throw new InvalidOperationException("安装包缺少主程序或应用资源，请重新下载安装包。");
                WriteUninstaller(stage);

                if (status != null) status("正在关闭旧版本并检查文件占用…");
                KillRunningIn(dir);

                if (status != null) status("正在更新应用文件…");
                timer.Restart();
                CopyStagedFiles(stage, dir);
                TryLog("update_ms=" + timer.ElapsedMilliseconds);
                if (progress != null) progress(97, "");

                if (status != null) status("正在创建快捷方式…");
                string exe = Path.Combine(dir, AppExeName);
                CreateShortcut(StartMenuLnk(), exe, dir);
                if (o.Desktop) CreateShortcut(DesktopLnk(), exe, dir);

                if (status != null) status("正在登记到「应用和功能」…");
                WriteRegistry(dir, exe);
                RemoveLegacyBranding(dir);

                if (status != null) status("安装完成。");
            }
            finally
            {
                try { if (Directory.Exists(stage)) Directory.Delete(stage, true); } catch { }
            }
        }

        private static void CopyStagedFiles(string stage, string dir)
        {
            if (!Directory.Exists(dir))
            {
                Directory.Move(stage, dir);
                return;
            }
            string[] sources = Directory.GetFiles(stage, "*", SearchOption.AllDirectories);
            DateTime deadline = DateTime.UtcNow.AddSeconds(5);
            while (true)
            {
                string blocked = "";
                List<FileStream> targets = new List<FileStream>();
                List<string> created = new List<string>();
                bool writing = false;
                try
                {
                    // 保持读写独占锁直到提交完成；仅允许同卷替换操作删除旧文件名。
                    foreach (string source in sources)
                    {
                        string target = Path.Combine(dir, source.Substring(stage.Length + 1));
                        blocked = target;
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        bool exists = File.Exists(target);
                        targets.Add(new FileStream(target, exists ? FileMode.Open : FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Delete));
                        if (!exists) created.Add(target);
                    }
                    writing = true;
                    for (int i = 0; i < sources.Length; i++)
                    {
                        string target = Path.Combine(dir, sources[i].Substring(stage.Length + 1));
                        File.Replace(sources[i], target, null);
                    }
                    return;
                }
                catch (IOException) { if (writing) throw; }
                catch (UnauthorizedAccessException) { if (writing) throw; }
                finally
                {
                    foreach (FileStream target in targets) target.Dispose();
                    if (!writing)
                        foreach (string file in created) { try { File.Delete(file); } catch { } }
                }
                if (DateTime.UtcNow >= deadline)
                    throw new IOException("旧版本文件仍被占用或无法写入，尚未替换任何应用文件。请退出程序后重试：\n" + blocked);
                Thread.Sleep(200);
            }
        }

        /** 从本 exe 尾部取 zip 数据；没有数据（比如卸载器）时抛错 */
        internal static Stream OpenPayload()
        {
            string self = SelfPath();
            FileStream fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1 << 20);
            try
            {
                long size = fs.Length;
                if (size < TailSize + 64) throw new InvalidOperationException("安装包不完整：缺少内置的安装数据。");
                byte[] tail = new byte[TailSize];
                fs.Seek(size - TailSize, SeekOrigin.Begin);
                ReadFull(fs, tail, 0, TailSize);
                string magic = Encoding.ASCII.GetString(tail, 16, 8);
                if (magic != Magic) throw new InvalidOperationException("安装包不完整：末尾标记不匹配（文件可能被截断）。");
                long offset = BitConverter.ToInt64(tail, 0);
                long length = BitConverter.ToInt64(tail, 8);
                if (offset <= 0 || length <= 0 || offset + length > size - TailSize)
                    throw new InvalidOperationException("安装包不完整：数据段长度异常。");
                return new SubStream(fs, offset, length);
            }
            catch
            {
                try { fs.Dispose(); } catch { }
                throw;
            }
        }

        internal static string SelfPath()
        {
            try
            {
                string loc = Assembly.GetExecutingAssembly().Location;
                if (!string.IsNullOrEmpty(loc) && File.Exists(loc)) return loc;
            }
            catch { }
            Process p = Process.GetCurrentProcess();
            return p.MainModule.FileName;
        }

        private static void ReadFull(Stream s, byte[] buf, int offset, int count)
        {
            int done = 0;
            while (done < count)
            {
                int n = s.Read(buf, offset + done, count - done);
                if (n <= 0) throw new EndOfStreamException("读取安装包失败。");
                done += n;
            }
        }

        /** 解压 zip 到目录，逐块报进度 */
        private static void Extract(Stream payload, string dir, Action<int, string> progress)
        {
            ExtractPayload(payload, dir, null, progress);
        }

        private static bool MatchesInstalledFile(string file, long length, string expected)
        {
            try
            {
                if (!File.Exists(file) || new FileInfo(file).Length != length) return false;
                using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 20, FileOptions.SequentialScan))
                using (SHA256 sha = new SHA256Cng())
                    return string.Equals(BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", ""), expected, StringComparison.OrdinalIgnoreCase);
            }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }

        private static void ExtractPayload(Stream payload, string dir, string installed, Action<int, string> progress)
        {
            string root = Path.GetFullPath(dir);
            if (!root.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)) root += Path.DirectorySeparatorChar;

            using (ZipArchive zip = new ZipArchive(payload, ZipArchiveMode.Read, false))
            {
                if (installed != null && (zip.GetEntry(AppExeName) == null || zip.GetEntry("resources/app.asar") == null))
                    throw new InvalidOperationException("安装包缺少主程序或应用资源，请重新下载安装包。");
                const string manifestName = ".doubao-files.sha256";
                Dictionary<string, string> hashes = new Dictionary<string, string>(StringComparer.Ordinal);
                ZipArchiveEntry manifest = zip.GetEntry(manifestName);
                if (installed != null && manifest != null)
                    using (StreamReader reader = new StreamReader(manifest.Open(), Encoding.UTF8))
                    {
                        string line;
                        while ((line = reader.ReadLine()) != null)
                            if (line.Length > 65 && line[64] == ' ') hashes[line.Substring(65)] = line.Substring(0, 64);
                    }
                long total = 0;
                foreach (ZipArchiveEntry e in zip.Entries) if (e.FullName != manifestName) total += e.Length;
                if (total <= 0) total = 1;

                long done = 0;
                int reused = 0;
                byte[] buf = new byte[1 << 16];
                foreach (ZipArchiveEntry e in zip.Entries)
                {
                    if (e.FullName == manifestName) continue;
                    string rel = e.FullName.Replace('/', Path.DirectorySeparatorChar);
                    string dest = Path.GetFullPath(Path.Combine(dir, rel));
                    // 防目录穿越：只允许落在安装目录内部
                    if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase) &&
                        !string.Equals(dest.TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                        continue;

                    if (rel.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal))
                    {
                        Directory.CreateDirectory(dest);
                        continue;
                    }

                    string expected;
                    if (installed != null && hashes.TryGetValue(e.FullName, out expected) &&
                        MatchesInstalledFile(Path.Combine(installed, rel), e.Length, expected))
                    {
                        reused++;
                        done += e.Length;
                        if (progress != null) progress((int)(done * 100 / total), rel);
                        continue;
                    }

                    string parent = Path.GetDirectoryName(dest);
                    if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);

                    if (File.Exists(dest))
                    {
                        try { File.SetAttributes(dest, FileAttributes.Normal); } catch { }
                    }

                    using (Stream src = e.Open())
                    using (FileStream fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
                    {
                        int n;
                        while ((n = src.Read(buf, 0, buf.Length)) > 0)
                        {
                            fs.Write(buf, 0, n);
                            done += n;
                            if (progress != null) progress((int)(done * 100 / total), rel);
                        }
                    }
                    try { File.SetLastWriteTime(dest, e.LastWriteTime.DateTime); } catch { }
                }
                TryLog("reused_files=" + reused);
            }
        }

        /** 卸载器 = 本 exe 的头部（不含 zip 数据），只有几十 KB */
        private static void WriteUninstaller(string dir)
        {
            string self = SelfPath();
            string target = Path.Combine(dir, "Uninstall.exe");
            if (string.Equals(Path.GetFullPath(self), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) return;

            long stubLength = 0;
            if (HasPayload(self))
            {
                using (FileStream fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    long size = fs.Length;
                    byte[] tail = new byte[TailSize];
                    fs.Seek(size - TailSize, SeekOrigin.Begin);
                    ReadFull(fs, tail, 0, TailSize);
                    stubLength = BitConverter.ToInt64(tail, 0);
                }
            }

            if (File.Exists(target)) { try { File.SetAttributes(target, FileAttributes.Normal); File.Delete(target); } catch { } }

            if (stubLength > 0 && stubLength < new FileInfo(self).Length)
            {
                using (FileStream src = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (FileStream dst = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    byte[] buf = new byte[1 << 16];
                    long left = stubLength;
                    while (left > 0)
                    {
                        int want = (int)Math.Min(buf.Length, left);
                        int n = src.Read(buf, 0, want);
                        if (n <= 0) break;
                        dst.Write(buf, 0, n);
                        left -= n;
                    }
                }
            }
            else
            {
                File.Copy(self, target, true);
            }
        }

        private static bool HasPayload(string file)
        {
            try
            {
                using (FileStream fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    if (fs.Length < TailSize) return false;
                    byte[] tail = new byte[TailSize];
                    fs.Seek(fs.Length - TailSize, SeekOrigin.Begin);
                    ReadFull(fs, tail, 0, TailSize);
                    return Encoding.ASCII.GetString(tail, 16, 8) == Magic;
                }
            }
            catch { return false; }
        }

        /* ------------------------------------------------------------ 快捷方式 / 注册表 */

        private static string DesktopLnk()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk");
        }

        private static string StartMenuLnk()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName, AppName + ".lnk");
        }

        private static void RemoveLegacyBranding(string dir)
        {
            string oldMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), LegacyName);
            string[] links = {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), LegacyName + ".lnk"),
                Path.Combine(oldMenu, LegacyName + ".lnk")
            };
            foreach (string file in links)
            {
                try
                {
                    if (!File.Exists(file)) continue;
                    Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                    if (shellType == null) continue;
                    object shell = Activator.CreateInstance(shellType);
                    object link = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { file });
                    string target = Convert.ToString(link.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, link, null));
                    if (!string.IsNullOrEmpty(target) && IsInInstallDirectory(target, dir)) File.Delete(file);
                }
                catch { }
            }
            try { if (Directory.Exists(oldMenu) && Directory.GetFileSystemEntries(oldMenu).Length == 0) Directory.Delete(oldMenu); } catch { }
            try { File.Delete(Path.Combine(dir, LegacyName + ".exe")); } catch { }
        }

        private static void CreateShortcut(string lnkPath, string target, string workDir)
        {
            try
            {
                string parent = Path.GetDirectoryName(lnkPath);
                if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);

                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null) return;
                object shell = Activator.CreateInstance(shellType);
                object lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                Type lt = lnk.GetType();
                lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
                lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workDir });
                lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { target + ",0" });
                lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { AppName + " v" + AppVersion });
                lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
            }
            catch (Exception ex)
            {
                TryLog("create shortcut failed: " + ex.Message);
            }
        }

        private static void RemoveShortcuts(string dir)
        {
            try { if (File.Exists(DesktopLnk())) File.Delete(DesktopLnk()); } catch { }
            try
            {
                string sm = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName);
                if (Directory.Exists(sm)) Directory.Delete(sm, true);
            }
            catch { }
        }

        private static void WriteRegistry(string dir, string exe)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RegKey))
            {
                if (k == null) return;
                k.SetValue("DisplayName", AppName);
                k.SetValue("DisplayVersion", AppVersion);
                k.SetValue("Publisher", Publisher);
                k.SetValue("InstallLocation", dir);
                k.SetValue("DisplayIcon", exe + ",0");
                k.SetValue("UninstallString", "\"" + Path.Combine(dir, "Uninstall.exe") + "\" /uninstall");
                k.SetValue("QuietUninstallString", "\"" + Path.Combine(dir, "Uninstall.exe") + "\" /uninstall /quiet");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                long size = 0;
                try
                {
                    foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                    {
                        try { size += new FileInfo(f).Length; } catch { }
                    }
                }
                catch { }
                k.SetValue("EstimatedSize", (int)(size / 1024), RegistryValueKind.DWord);
            }
        }

        private static void RemoveRegistry()
        {
            try { Registry.CurrentUser.DeleteSubKeyTree(RegKey, false); } catch { }
        }

        /* ------------------------------------------------------------ 卸载 */

        /** 这个目录像不像我们的安装目录：有主程序或卸载器才算（防止把随便哪个文件夹删掉） */
        private static bool LooksLikeInstall(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return false;
            try
            {
                string full = Path.GetFullPath(dir).TrimEnd('\\');
                if (full.Length <= 3) return false; // 盘符根
                if (File.Exists(Path.Combine(full, AppExeName)) || File.Exists(Path.Combine(full, LegacyName + ".exe"))) return true;
                if (File.Exists(Path.Combine(full, "Uninstall.exe"))) return true;
                return false;
            }
            catch { return false; }
        }

        private static string RegistryInstallDir()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RegKey))
                {
                    if (k == null) return "";
                    object v = k.GetValue("InstallLocation");
                    return v == null ? "" : Convert.ToString(v);
                }
            }
            catch { return ""; }
        }

        /**
         * 卸载目标目录：注册表记的安装位置 → 自己所在目录（Uninstall.exe 的行为）→ 默认目录。
         * 不能只用「自己所在目录」——把安装包放在任意文件夹里执行 /uninstall，
         * 那个文件夹会被当成安装目录整个删掉。
         */
        private static string ResolveInstallDir()
        {
            string reg = RegistryInstallDir();
            if (LooksLikeInstall(reg)) return Path.GetFullPath(reg);
            string selfDir = Path.GetDirectoryName(SelfPath());
            if (LooksLikeInstall(selfDir)) return Path.GetFullPath(selfDir);
            return DefaultDir();
        }

        private static int DoUninstall(Options o)
        {
            string dir = ResolveInstallDir();
            TryLog("uninstall dir: " + dir);

            if (!o.Silent)
            {
                DialogResult r = MessageBox.Show(
                    "确定要卸载 " + AppName + " 吗？\n\n" +
                    "点「是」卸载并保留数据（账号配置、分镜稿、成片）。\n" +
                    "点「否」卸载并删除全部数据。\n" +
                    "点「取消」退出。",
                    AppName + " 卸载", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                if (r == DialogResult.Cancel) return 0;
                o.PurgeData = r == DialogResult.No;
            }

            try
            {
                KillRunningIn(dir);
            }
            catch { }

            RemoveShortcuts(dir);
            RemoveRegistry();

            // 自己建在安装目录里，删不掉自己 → 复制到 temp 再让它回来收拾
            string tmp = Path.Combine(Path.GetTempPath(), "dm_uninstall_" + Guid.NewGuid().ToString("N") + ".exe");
            try
            {
                File.Copy(SelfPath(), tmp, true);
                ProcessStartInfo psi = new ProcessStartInfo(tmp);
                psi.Arguments = "/cleanup \"" + dir + "\"" + (o.PurgeData ? " /purge" : "");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                // 复制失败就当场删（安装目录里剩一个 Uninstall.exe，下次覆盖安装会替换）
                TryLog("spawn cleanup failed: " + ex.Message);
                try { Directory.Delete(dir, true); } catch { }
            }
            return 0;
        }

        private static int DoCleanup(Options o)
        {
            string dir = o.CleanupDir;
            if (!string.IsNullOrEmpty(dir))
            {
                // 只删安装目录：这条路径由另一个进程带着参数传进来，
                // 参数传错就会变成「删掉任意文件夹」，所以先验一遍。
                bool isDefault = false;
                try { isDefault = string.Equals(Path.GetFullPath(dir).TrimEnd('\\'), Path.GetFullPath(DefaultDir()).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); } catch { }
                if (!LooksLikeInstall(dir) && !isDefault)
                {
                    TryLog("cleanup skipped (not an install dir): " + dir);
                    dir = "";
                }
            }
            if (!string.IsNullOrEmpty(dir))
            {
                for (int i = 0; i < 40; i++)
                {
                    try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
                    if (!Directory.Exists(dir)) break;
                    try
                    {
                        KillRunningIn(dir);
                    }
                    catch { }
                    Thread.Sleep(400);
                }
            }

            if (o.PurgeData)
            {
                try { if (Directory.Exists(DataDir())) Directory.Delete(DataDir(), true); } catch { }
            }

            ScheduleSelfDelete();
            return 0;
        }

        private static void ScheduleSelfDelete()
        {
            try
            {
                string self = SelfPath();
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe");
                psi.Arguments = "/c ping -n 3 127.0.0.1 > nul & del /f /q \"" + self + "\"";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
            }
            catch { }
        }

        /* ------------------------------------------------------------ 杂项 */

        private static void KillRunningIn(string dir)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(10);
            int selfId = Process.GetCurrentProcess().Id;
            int clearScans = 0;
            while (true)
            {
                bool found = false;
                foreach (Process p in Process.GetProcesses())
                {
                    using (p)
                    {
                        bool targetProcess = false;
                        try
                        {
                            if (p.Id == selfId || p.HasExited) continue;
                            if (!IsInInstallDirectory(p.MainModule.FileName, dir)) continue;
                            targetProcess = true;
                            found = true;
                            p.Kill();
                            p.WaitForExit(1000);
                        }
                        catch (Exception ex) { if (targetProcess) TryLog("close process failed: " + ex.Message); }
                    }
                }
                clearScans = found ? 0 : clearScans + 1;
                if (clearScans >= 2) return;
                if (DateTime.UtcNow >= deadline)
                    throw new IOException("无法关闭安装目录中的旧版本。请退出该程序后重新安装：\n" + dir);
                Thread.Sleep(200);
            }
        }

        private static bool IsInInstallDirectory(string executable, string dir)
        {
            string root = Path.GetFullPath(dir).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            return Path.GetFullPath(executable).StartsWith(root, StringComparison.OrdinalIgnoreCase);
        }

        internal static void LaunchApp(string dir)
        {
            try
            {
                string exe = Path.Combine(dir, AppExeName);
                if (!File.Exists(exe)) return;
                ProcessStartInfo psi = new ProcessStartInfo(exe);
                psi.WorkingDirectory = dir;
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                TryLog("launch failed: " + ex.Message);
            }
        }

        internal static void TryLog(string msg)
        {
            try
            {
                File.AppendAllText(
                    Path.Combine(Path.GetTempPath(), "dolamod-setup.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + msg + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch { }
        }
    }

    /** 从偏移处开始的只读子流：ZipArchive 要能 Seek，这个包装给它 */
    internal sealed class SubStream : Stream
    {
        private readonly Stream inner;
        private readonly long start;
        private readonly long len;
        private long pos;

        public SubStream(Stream inner, long start, long length)
        {
            this.inner = inner;
            this.start = start;
            this.len = length;
            this.pos = 0;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return len; } }

        public override long Position
        {
            get { return pos; }
            set { pos = value < 0 ? 0 : (value > len ? len : value); }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (pos >= len) return 0;
            long left = len - pos;
            if (count > left) count = (int)left;
            // 连续解压无需重复 Seek，让底层 FileStream 的顺序读取缓冲生效。
            if (inner.Position != start + pos) inner.Seek(start + pos, SeekOrigin.Begin);
            int n = inner.Read(buffer, offset, count);
            pos += n;
            return n;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long next;
            if (origin == SeekOrigin.Begin) next = offset;
            else if (origin == SeekOrigin.Current) next = pos + offset;
            else next = len + offset;
            if (next < 0) next = 0;
            if (next > len) next = len;
            pos = next;
            return pos;
        }

        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }

        protected override void Dispose(bool disposing)
        {
            if (disposing) inner.Dispose();
            base.Dispose(disposing);
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly Options opts;
        private readonly TextBox txtDir;
        private readonly CheckBox chkDesktop;
        private readonly CheckBox chkRun;
        private readonly ProgressBar bar;
        private readonly Label lblStatus;
        private readonly Button btnInstall;
        private readonly Button btnBrowse;
        private readonly Button btnClose;
        private bool busy;
        private long lastTick;

        public SetupForm(Options o)
        {
            opts = o;

            Text = Program.AppName + " v" + Program.AppVersion + " 安装程序";
            ClientSize = new Size(520, 336);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9f);
            BackColor = Color.White;

            Label title = new Label();
            title.Text = Program.AppName + "  v" + Program.AppVersion;
            title.Font = new Font("Microsoft YaHei UI", 15f, FontStyle.Bold);
            title.Location = new Point(20, 18);
            title.Size = new Size(470, 32);
            title.ForeColor = Color.FromArgb(28, 30, 38);

            Label sub = new Label();
            sub.Text = "多开环境 · 分镜编排 · 指纹隔离 · 本地接口 / MCP";
            sub.Location = new Point(22, 52);
            sub.Size = new Size(470, 20);
            sub.ForeColor = Color.FromArgb(120, 126, 140);

            Panel line = new Panel();
            line.Location = new Point(20, 82);
            line.Size = new Size(480, 1);
            line.BackColor = Color.FromArgb(228, 231, 238);

            Label lbDir = new Label();
            lbDir.Text = "安装到";
            lbDir.Location = new Point(20, 96);
            lbDir.Size = new Size(60, 22);
            lbDir.ForeColor = Color.FromArgb(70, 76, 90);

            txtDir = new TextBox();
            txtDir.Text = o.Dir;
            txtDir.Location = new Point(20, 120);
            txtDir.Size = new Size(360, 26);
            txtDir.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

            btnBrowse = new Button();
            btnBrowse.Text = "浏览…";
            btnBrowse.Location = new Point(388, 119);
            btnBrowse.Size = new Size(112, 28);
            btnBrowse.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnBrowse.Click += new EventHandler(OnBrowse);

            chkDesktop = new CheckBox();
            chkDesktop.Text = "创建桌面快捷方式";
            chkDesktop.Checked = o.Desktop;
            chkDesktop.Location = new Point(20, 160);
            chkDesktop.Size = new Size(240, 24);

            chkRun = new CheckBox();
            chkRun.Text = "安装完成后立即启动";
            chkRun.Checked = o.Run;
            chkRun.Location = new Point(20, 186);
            chkRun.Size = new Size(240, 24);

            bar = new ProgressBar();
            bar.Location = new Point(20, 226);
            bar.Size = new Size(480, 16);
            bar.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            bar.Minimum = 0;
            bar.Maximum = 100;

            lblStatus = new Label();
            lblStatus.Text = "准备就绪。安装到当前用户目录，不需要管理员权限。";
            lblStatus.Location = new Point(20, 250);
            lblStatus.Size = new Size(480, 20);
            lblStatus.ForeColor = Color.FromArgb(120, 126, 140);
            lblStatus.AutoEllipsis = true;
            lblStatus.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

            btnInstall = new Button();
            btnInstall.Text = "立即安装";
            btnInstall.Location = new Point(312, 286);
            btnInstall.Size = new Size(100, 32);
            btnInstall.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
            btnInstall.Click += new EventHandler(OnInstall);
            btnInstall.BackColor = Color.FromArgb(56, 116, 255);
            btnInstall.ForeColor = Color.White;
            btnInstall.FlatStyle = FlatStyle.Flat;
            btnInstall.FlatAppearance.BorderSize = 0;

            btnClose = new Button();
            btnClose.Text = "退出";
            btnClose.Location = new Point(420, 286);
            btnClose.Size = new Size(80, 32);
            btnClose.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
            btnClose.Click += new EventHandler(delegate(object s, EventArgs e) { Close(); });

            Controls.Add(title);
            Controls.Add(sub);
            Controls.Add(line);
            Controls.Add(lbDir);
            Controls.Add(txtDir);
            Controls.Add(btnBrowse);
            Controls.Add(chkDesktop);
            Controls.Add(chkRun);
            Controls.Add(bar);
            Controls.Add(lblStatus);
            Controls.Add(btnInstall);
            Controls.Add(btnClose);

            AcceptButton = btnInstall;
            if (opts.Update) Shown += delegate { OnInstall(this, EventArgs.Empty); };
        }

        private void OnBrowse(object sender, EventArgs e)
        {
            if (busy) return;
            using (FolderBrowserDialog dlg = new FolderBrowserDialog())
            {
                dlg.Description = "选择安装位置";
                dlg.ShowNewFolderButton = true;
                dlg.SelectedPath = txtDir.Text;
                if (dlg.ShowDialog(this) == DialogResult.OK) txtDir.Text = dlg.SelectedPath;
            }
        }

        private void OnInstall(object sender, EventArgs e)
        {
            if (busy) return;
            string dir = txtDir.Text.Trim().Trim('"');
            if (dir.Length == 0)
            {
                MessageBox.Show(this, "请先选择安装目录。", Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            try { dir = Path.GetFullPath(dir); }
            catch
            {
                MessageBox.Show(this, "安装目录不合法，请重新选择。", Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            opts.Dir = dir;
            opts.Desktop = chkDesktop.Checked;
            opts.Run = chkRun.Checked;

            busy = true;
            btnInstall.Enabled = false;
            btnBrowse.Enabled = false;
            txtDir.ReadOnly = true;
            chkDesktop.Enabled = false;
            chkRun.Enabled = false;
            btnClose.Enabled = false;
            bar.Value = 0;
            lblStatus.Text = "正在准备…";

            Thread t = new Thread(new ThreadStart(RunInstall));
            t.IsBackground = true;
            t.Start();
        }

        private void RunInstall()
        {
            try
            {
                Program.Install(opts, OnProgress, OnStatus);
                Invoke(new Action(delegate
                {
                    bar.Value = 100;
                    lblStatus.Text = "安装完成。";
                    busy = false;
                    string msg = Program.AppName + " 已安装到：\n" + opts.Dir +
                                 "\n\n快捷方式：" + (opts.Desktop ? "桌面 + 开始菜单" : "开始菜单");
                    if (!opts.Update) MessageBox.Show(this, msg, "安装完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    if (opts.Run) Program.LaunchApp(opts.Dir);
                    Close();
                }));
            }
            catch (Exception ex)
            {
                Program.TryLog("install failed: " + ex);
                Invoke(new Action(delegate
                {
                    busy = false;
                    bar.Value = 0;
                    lblStatus.Text = "安装失败：" + ex.Message;
                    btnInstall.Enabled = true;
                    btnBrowse.Enabled = true;
                    txtDir.ReadOnly = false;
                    chkDesktop.Enabled = true;
                    chkRun.Enabled = true;
                    btnClose.Enabled = true;
                    MessageBox.Show(this,
                        "安装没有完成：\n" + ex.Message +
                        "\n\n常见原因：目标目录被占用（程序正在运行）、磁盘空间不足、或安装包下载不完整。",
                        "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }));
            }
        }

        private void OnProgress(int percent, string name)
        {
            long now = Environment.TickCount;
            if (now - lastTick < 90 && percent < 100) return;
            lastTick = now;
            BeginInvoke(new Action(delegate
            {
                if (percent < 0) percent = 0;
                if (percent > 100) percent = 100;
                bar.Value = percent;
                lblStatus.Text = (percent < 85 ? "正在释放文件…  " : "正在完成安装…  ") + percent + "%";
            }));
        }

        private void OnStatus(string text)
        {
            Invoke(new Action(delegate { lblStatus.Text = text; }));
        }
    }
}
