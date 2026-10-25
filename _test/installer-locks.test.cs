using System;
using System.IO;
using System.Reflection;
using System.Threading;
using DolaModSetup;

internal static class InstallerRegression
{
    private static int checks;

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

    public static int Main(string[] args)
    {
        string root = Path.Combine(Path.GetTempPath(), "dm_installer_regression_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            Type current = typeof(Program);
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
