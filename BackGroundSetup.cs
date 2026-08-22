using System.Diagnostics;

namespace CodeOS_setup;

public static class Background
{
    private const string ServiceName = "codeos";
    private const string ServicePath = "/etc/systemd/system/codeos.service";
    private const string InstallPath = "/opt/codeos/CodeOS.Background";

    public static void Install()
    {
        Console.WriteLine("CodeOS 백그라운드 서비스 설치 중...");
        CreateDirectory();
        PublishBackground();
        InstallBlockedPage();
        BrowserPolicyInstaller.Install();
        RegisterSudoers();
        RegisterAlias();
        CreateServiceFile();

        RunCommand("systemctl", "daemon-reload");
        RunCommand("systemctl", "enable", ServiceName);
        RunCommand("systemctl", "restart", ServiceName);
        Console.WriteLine("백그라운드 서비스 설치 완료!");
    }

    public static void RemoveBrowserPolicies() => BrowserPolicyInstaller.Remove();

    private static void CreateDirectory() => Directory.CreateDirectory("/opt/codeos");

    private static void InstallBlockedPage()
    {
        File.Copy(LocateAsset("blocked.html"), "/opt/codeos/blocked.html", overwrite: true);
        Console.WriteLine("차단 안내 페이지 설치 완료!");
    }

    private static void PublishBackground()
    {
        const string publishDir = "/opt/codeos";
        string projectPath = LocateProjectFile();
        Console.WriteLine("백그라운드 바이너리 빌드 중...");
        RunCommand("dotnet", "publish", projectPath, "-o", publishDir, "--self-contained", "-r", "linux-x64");

        string binaryName = Path.Combine(publishDir, "CodeOS_setup");
        if (!File.Exists(binaryName))
            throw new InvalidOperationException("dotnet publish가 CodeOS_setup 실행 파일을 만들지 못했습니다.");
        File.Move(binaryName, Path.Combine(publishDir, "CodeOS.Background"), overwrite: true);
        Console.WriteLine("백그라운드 바이너리 설치 완료!");
    }

    private static void CreateServiceFile()
    {
        string service = """
                         [Unit]
                         Description=CodeOS Background Service
                         After=network.target

                         [Service]
                         Type=simple
                         ExecStart=/opt/codeos/CodeOS.Background --service
                         WorkingDirectory=/opt/codeos
                         Restart=always
                         RestartSec=5
                         User=root

                         [Install]
                         WantedBy=multi-user.target
                         """;
        AtomicWrite(ServicePath, service);
    }

    private static void RegisterSudoers()
    {
        string user = Environment.GetEnvironmentVariable("SUDO_USER")
                      ?? Environment.GetEnvironmentVariable("USER")
                      ?? "root";
        if (!IsSafeUnixUserName(user))
            throw new InvalidOperationException("sudoers에 사용할 사용자 이름이 올바르지 않습니다.");
        AtomicWrite("/etc/sudoers.d/codeos", $"{user} ALL=(ALL) NOPASSWD: {InstallPath}\n");
        RunCommand("chmod", "440", "/etc/sudoers.d/codeos");
    }

    private static void RegisterAlias()
    {
        string user = Environment.GetEnvironmentVariable("SUDO_USER")
                      ?? Environment.GetEnvironmentVariable("USER")
                      ?? "root";
        string? home = GetHomeDir(user);
        if (home == null) return;

        string bashrc = Path.Combine(home, ".bashrc");
        string content = File.Exists(bashrc) ? File.ReadAllText(bashrc) : "";
        if (!content.Contains("alias codeos=", StringComparison.Ordinal))
            AtomicWrite(bashrc, content + "\nalias codeos='sudo /opt/codeos/CodeOS.Background'\n");
    }

    private static string? GetHomeDir(string user)
    {
        try
        {
            using var process = new Process();
            process.StartInfo.FileName = "getent";
            process.StartInfo.ArgumentList.Add("passwd");
            process.StartInfo.ArgumentList.Add(user);
            process.StartInfo.UseShellExecute = false;
            process.StartInfo.RedirectStandardOutput = true;
            process.Start();
            string line = process.StandardOutput.ReadToEnd();
            process.WaitForExit();
            var parts = line.Split(':');
            return parts.Length > 5 ? parts[5] : null;
        }
        catch
        {
            return null;
        }
    }

    private static string LocateProjectFile()
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var directory = new DirectoryInfo(start);
            while (directory != null)
            {
                string candidate = Path.Combine(directory.FullName, "CodeOS_setup.csproj");
                if (File.Exists(candidate)) return Path.GetFullPath(candidate);
                directory = directory.Parent;
            }
        }
        throw new FileNotFoundException("CodeOS_setup.csproj를 찾지 못했습니다.");
    }

    private static string LocateAsset(string name)
    {
        string? project = null;
        try { project = LocateProjectFile(); } catch { }
        var candidates = new List<string>
        {
            Path.Combine(AppContext.BaseDirectory, name),
            Path.Combine(Directory.GetCurrentDirectory(), name)
        };
        if (project != null) candidates.Add(Path.Combine(Path.GetDirectoryName(project)!, name));
        return candidates.FirstOrDefault(File.Exists)
               ?? throw new FileNotFoundException($"설치 파일을 찾지 못했습니다: {name}");
    }

    private static bool IsSafeUnixUserName(string value)
        => !string.IsNullOrWhiteSpace(value)
           && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.');

    private static void AtomicWrite(string path, string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temp = $"{path}.tmp.{Environment.ProcessId}.{Guid.NewGuid():N}";
        try
        {
            File.WriteAllText(temp, content);
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    private static void RunCommand(string executable, params string[] arguments)
    {
        using var process = new Process();
        process.StartInfo.FileName = executable;
        foreach (string argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        process.StartInfo.UseShellExecute = false;
        process.StartInfo.RedirectStandardOutput = true;
        process.StartInfo.RedirectStandardError = true;
        process.Start();
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        if (!string.IsNullOrEmpty(output)) Console.WriteLine(output);
        if (!string.IsNullOrEmpty(error)) Console.WriteLine(error);
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"명령 실패: {executable} (exit: {process.ExitCode})");
    }
}
