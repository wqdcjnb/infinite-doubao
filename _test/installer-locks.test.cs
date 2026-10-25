using System;
using System.IO;
using System.Reflection;
using System.Threading;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using DolaModSetup;

internal static class InstallerRegression
{
    private static int checks;

    private sealed class SeekCounter : MemoryStream
    {
        internal int Seeks;
        internal SeekCounter(byte[] bytes) : base(bytes) { }
        public override long Seek(long offset, SeekOrigin origin) { Seeks++; return base.Seek(offset, origin); }
    }

    private static object Call(Type type, string method, params object[] args)
    {
        try { return type.GetMethod(method, BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, args); }
        catch (TargetInvocationException ex) { throw ex.InnerException; }
    }

    private static void Check(bool ok, string message)
    {
        if (!ok) throw new Exception(message);
        checks++;
        Console.WriteLine("PASS " + message);
    }

    private static MemoryStream Payload(bool manifest)
    {
        MemoryStream stream = new MemoryStream();
        using (ZipArchive zip = new ZipArchive(stream, ZipArchiveMode.Create, true))
        {
            StringBuilder hashes = new StringBuilder();
            string[] names = { Program.AppExeName, "resources/app.asar", "changed.txt", "new.txt" };
            foreach (string name in names)
            {
                byte[] bytes = Encoding.UTF8.GetBytes("new-" + name);
                using (Stream entry = zip.CreateEntry(name).Open()) entry.Write(bytes, 0, bytes.Length);
                using (SHA256 hash = SHA256.Create()) hashes.Append(BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "")).Append(' ').Append(name).Append('\n');
            }
            if (manifest)
                using (StreamWriter writer = new StreamWriter(zip.CreateEntry(".doubao-files.sha256").Open(), new UTF8Encoding(false))) writer.Write(hashes);
        }
        stream.Position = 0;
        return stream;
    }

    public static int Main(string[] args)
    {
        string root = Path.Combine(Path.GetTempPath(), "dm_installer_regression_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            Type current = typeof(Program);
            Options update = (Options)Call(current, "Parse", (object)new string[] { "/UPDATE", "/WAITPID=12345", "/D=" + root });
            Check(update.Update && update.WaitPid == 12345 && update.Dir == root && update.Run && !update.Silent, "in-app update waits for the old process and restarts after visible installation");
            Check(Program.AppName == "豆包工坊" && Program.AppExeName == "豆包工坊.exe", "installer and executable use the new brand");
            Check(Path.GetFileName(Program.DataDir()) == "无限豆包", "renamed application retains its existing data directory");
            string legacyInstall = Path.Combine(root, "legacy-install");
            Directory.CreateDirectory(legacyInstall);
            File.WriteAllText(Path.Combine(legacyInstall, "无限豆包.exe"), "legacy executable");
            Check((bool)Call(current, "LooksLikeInstall", legacyInstall), "upgrade recognizes the previous executable name");
            string stage = Path.Combine(root, "stage");
            string target = Path.Combine(root, "target");
            Directory.CreateDirectory(stage);
            Directory.CreateDirectory(target);
            File.WriteAllText(Path.Combine(stage, "first.txt"), "new-first");
            File.WriteAllText(Path.Combine(stage, "added.txt"), "new-file");
            File.WriteAllText(Path.Combine(stage, Program.AppExeName), "new-exe");
            File.WriteAllText(Path.Combine(target, "first.txt"), "old-first");
            string targetExe = Path.Combine(target, Program.AppExeName);
            File.WriteAllText(targetExe, "old-exe");

            Check((bool)Call(current, "IsInInstallDirectory", targetExe, target), "target process path is included");
            Check((bool)Call(current, "IsInInstallDirectory", targetExe.ToUpperInvariant(), target), "path comparison is case insensitive");
            Check(!(bool)Call(current, "IsInInstallDirectory", Path.Combine(target + "-other", Program.AppExeName), target), "sibling install process is excluded");
            Check(!(bool)Call(current, "IsInInstallDirectory", Path.Combine(root, Program.AppExeName), target), "same process name outside target is excluded");

            bool lockedFailed = false;
            using (FileStream held = new FileStream(targetExe, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                try { Call(current, "CopyStagedFiles", stage, target); }
                catch (IOException ex) { lockedFailed = ex.Message.Contains(targetExe); }
                Check(lockedFailed, "occupied executable is reported before replacing files");
                Check(File.ReadAllText(Path.Combine(target, "first.txt")) == "old-first", "earlier existing files remain unchanged on lock failure");
                Check(File.ReadAllText(targetExe) == "old-exe", "occupied executable remains unchanged");
                Check(!File.Exists(Path.Combine(target, "added.txt")), "failed acquisition leaves no new placeholder file");
            }

            string uninstaller = Path.Combine(target, "Uninstall.exe");
            File.WriteAllText(Path.Combine(stage, "Uninstall.exe"), "new-uninstaller");
            File.WriteAllText(uninstaller, "old-uninstaller");
            using (FileStream held = new FileStream(uninstaller, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                bool failed = false;
                try { Call(current, "CopyStagedFiles", stage, target); }
                catch (IOException ex) { failed = ex.Message.Contains(uninstaller); }
                Check(failed, "occupied uninstaller is checked before any replacement");
                Check(File.ReadAllText(Path.Combine(target, "first.txt")) == "old-first", "uninstaller lock also preserves earlier existing files");
            }

            FileStream transient = new FileStream(targetExe, FileMode.Open, FileAccess.Read, FileShare.Read);
            Thread releaser = new Thread(delegate() { Thread.Sleep(500); transient.Dispose(); });
            releaser.Start();
            Call(current, "CopyStagedFiles", stage, target);
            releaser.Join();
            Check(File.ReadAllText(targetExe) == "new-exe" && File.ReadAllText(Path.Combine(target, "first.txt")) == "new-first", "temporary lock release permits complete staged copy");
            Check(!File.Exists(Path.Combine(stage, Program.AppExeName)), "upgrade moves staged files without copying their contents again");

            string extra = Path.Combine(target, "user-extra.txt");
            File.WriteAllText(extra, "keep");
            File.WriteAllText(Path.Combine(stage, "first.txt"), "next-version");
            Call(current, "CopyStagedFiles", stage, target);
            Check(File.ReadAllText(extra) == "keep" && File.ReadAllText(Path.Combine(target, "first.txt")) == "next-version", "upgrade retains files outside the payload");

            string freshStage = Path.Combine(root, "fresh-stage");
            string freshTarget = Path.Combine(root, "fresh-target");
            Directory.CreateDirectory(Path.Combine(freshStage, "resources"));
            File.WriteAllText(Path.Combine(freshStage, "resources", "app.asar"), "fresh-content");
            Call(current, "CopyStagedFiles", freshStage, freshTarget);
            Check(!Directory.Exists(freshStage) && File.ReadAllText(Path.Combine(freshTarget, "resources", "app.asar")) == "fresh-content", "fresh installation moves the complete directory");

            byte[] bytes = new byte[64];
            for (int i = 0; i < bytes.Length; i++) bytes[i] = (byte)i;
            SeekCounter counter = new SeekCounter(bytes);
            using (SubStream payload = new SubStream(counter, 10, 20))
            {
                byte[] part = new byte[4];
                for (int i = 0; i < 5; i++)
                    Check(payload.Read(part, 0, part.Length) == 4 && part[0] == 10 + i * 4, "payload sequential read preserves offset " + i);
                Check(counter.Seeks == 1 && payload.Read(part, 0, part.Length) == 0, "sequential reads avoid redundant seeks and stop at payload boundary");
                payload.Seek(2, SeekOrigin.Begin);
                Check(payload.Read(part, 0, part.Length) == 4 && part[0] == 12 && counter.Seeks == 2, "ZIP backward seek still reads the requested payload bytes");
            }

            string reuseTarget = Path.Combine(root, "reuse-target");
            string reuseStage = Path.Combine(root, "reuse-stage");
            Directory.CreateDirectory(Path.Combine(reuseTarget, "resources"));
            File.WriteAllText(Path.Combine(reuseTarget, Program.AppExeName), "new-" + Program.AppExeName);
            File.WriteAllText(Path.Combine(reuseTarget, "resources", "app.asar"), "new-resources/app.asar");
            File.WriteAllText(Path.Combine(reuseTarget, "changed.txt"), "old-changed.txt");
            using (Stream payload = Payload(true)) Call(current, "ExtractPayload", payload, reuseStage, reuseTarget, null);
            Check(!File.Exists(Path.Combine(reuseStage, Program.AppExeName)) && !File.Exists(Path.Combine(reuseStage, "resources", "app.asar")), "matching installed files are not decompressed or staged");
            Check(File.ReadAllText(Path.Combine(reuseStage, "changed.txt")) == "new-changed.txt", "same-size modified file is detected by SHA256 and restored");
            Check(File.ReadAllText(Path.Combine(reuseStage, "new.txt")) == "new-new.txt", "missing file is extracted on upgrade");
            Call(current, "CopyStagedFiles", reuseStage, reuseTarget);
            Check(File.ReadAllText(Path.Combine(reuseTarget, "changed.txt")) == "new-changed.txt" && File.ReadAllText(Path.Combine(reuseTarget, Program.AppExeName)) == "new-" + Program.AppExeName, "incremental update retains verified runtime and installs changed files");

            string noManifest = Path.Combine(root, "no-manifest");
            using (Stream payload = Payload(false)) Call(current, "ExtractPayload", payload, noManifest, reuseTarget, null);
            Check(File.Exists(Path.Combine(noManifest, Program.AppExeName)), "payloads without a manifest fall back to full extraction");

            if (args.Length > 0)
            {
                // Read the delivered installer as data via reflection. Never invoke its Main,
                // Install, KillRunningIn, shortcut or registry methods.
                Assembly delivered = Assembly.LoadFile(Path.GetFullPath(args[0]));
                Type previous = delivered.GetType("DolaModSetup.Program", true);
                string oldTarget = Path.Combine(root, "old-extract");
                Directory.CreateDirectory(Path.Combine(oldTarget, "resources"));
                string oldExe = Path.Combine(oldTarget, Program.AppExeName);
                string oldAsar = Path.Combine(oldTarget, "resources", "app.asar");
                File.WriteAllText(oldExe, "locked-old-exe");
                File.WriteAllText(oldAsar, "old-asar-marker");
                using (FileStream held = new FileStream(oldExe, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (Stream payload = (Stream)Call(previous, "OpenPayload"))
                {
                    bool reproduced = false;
                    try { Call(previous, "Extract", payload, oldTarget, null); }
                    catch (IOException ex) { reproduced = ex.Message.Contains(Program.AppExeName); }
                    Check(reproduced, "delivered extraction reproduces occupied executable failure in isolated directory");
                    Check(new FileInfo(oldAsar).Length > 100, "old extraction had replaced resources before encountering locked executable");
                    Check(File.ReadAllText(oldExe) == "locked-old-exe", "reproduction does not alter held executable");
                }
            }
            Console.WriteLine("Installer regression: " + checks + " checks passed; no installation, registry or process-control methods invoked.");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
        finally
        {
            // root is the fresh GUID directory created by this test, never an install directory.
            try { Directory.Delete(root, true); } catch { }
        }
    }
}
