using System.Diagnostics;

namespace CodeOS_setup;

// ================================================================
// CodeOS 번들 도구 전역 설치기
//
// tools/ 아래에 그대로 복사해 둔 Nodus 소스를 /opt/nodus 로 배포하고
// /usr/local/bin 에 전역 명령(nodus, nodus-tui)만 등록한다.
// 원본 소스는 건드리지 않고, 백엔드·TUI venv와 프론트엔드 npm 의존성은
// 없을 때만 준비한다(재설치 시에는 소스만 갱신한다).
// ================================================================
public static class Integrations
{
    private const string NodusDirectory = "/opt/nodus";
    private const string NodusCommand = "/usr/local/bin/nodus";
    private const string NodusTuiCommand = "/usr/local/bin/nodus-tui";

    // 전역 설치에서 제외할 디렉터리 이름(빌드 산출물·가상환경·메타데이터).
    private static readonly string[] ExcludedDirectories =
        { ".git", "node_modules", ".venv", "__pycache__", ".mypy_cache", ".pytest_cache" };

    private static readonly UnixFileMode ExecutableMode =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
        UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute;

    // ---------- Nodus ----------
    public static void InstallNodus()
    {
        const string name = "Nodus";
        try
        {
            Console.WriteLine($"[{name}] 전역 설치를 시작합니다...");
            if (!OperatingSystem.IsLinux())
            {
                Console.WriteLine($"[{name}] Linux가 아니므로 건너뜁니다.");
                return;
            }

            string source = Path.Combine(LocateToolsDirectory(), "nodus");
            CopyTree(source, NodusDirectory);
            CopyEnvFile(NodusDirectory + "/.env", NodusDirectory + "/.env.example");
            CopyEnvFile(NodusDirectory + "/backend/.env", NodusDirectory + "/backend/.env.example");
            CopyEnvFile(NodusDirectory + "/frontend/.env", NodusDirectory + "/frontend/.env.example");
            Execute(null, "chmod", new[] { "+x", NodusDirectory + "/run.sh" }, true, true);
            Execute(null, "chmod", new[] { "+x", NodusDirectory + "/run-tui.sh" }, true, true);

            EnsurePackage("python3", "command -v python3 >/dev/null 2>&1");
            EnsurePackage("python3-venv", "python3 -c \"import venv\" >/dev/null 2>&1");
            EnsurePackage("nodejs", "command -v node >/dev/null 2>&1");
            EnsurePackage("npm", "command -v npm >/dev/null 2>&1");

            // 백엔드 가상환경 + 의존성 (없을 때만)
            if (!Directory.Exists(NodusDirectory + "/backend/.venv"))
            {
                Execute(null, "python3", new[] { "-m", "venv", NodusDirectory + "/backend/.venv" }, true, true);
                string backendPython = NodusDirectory + "/backend/.venv/bin/python";
                Execute(NodusDirectory + "/backend", backendPython, new[] { "-m", "pip", "install", "--quiet", "--upgrade", "pip" }, true, true);
                Execute(NodusDirectory + "/backend", backendPython, new[] { "-m", "pip", "install", "--quiet", "-r", "requirements.txt" }, true, true);
            }

            // 터미널 TUI 가상환경 + 의존성 (없을 때만)
            if (!Directory.Exists(NodusDirectory + "/tui/.venv"))
            {
                Execute(null, "python3", new[] { "-m", "venv", NodusDirectory + "/tui/.venv" }, true, true);
                string tuiPython = NodusDirectory + "/tui/.venv/bin/python";
                Execute(NodusDirectory + "/tui", tuiPython, new[] { "-m", "pip", "install", "--quiet", "-r", "requirements.txt" }, true, true);
            }

            // 프론트엔드 의존성 (없을 때만)
            if (!Directory.Exists(NodusDirectory + "/frontend/node_modules"))
                Execute(NodusDirectory + "/frontend", "npm", new[] { "install", "--no-audit", "--no-fund" }, true, true);

            // 소유자에게 쓰기 권한을 남긴다(개발 서버가 캐시를 쓸 수 있어야 한다).
            Execute(null, "chmod", new[] { "-R", "go-w", NodusDirectory }, true, true);
            Execute(null, "chmod", new[] { "755", NodusDirectory }, true, true);
            string owner = ResolveOwner();
            if (owner != "root")
                Execute(null, "chown", new[] { "-R", owner + ":", NodusDirectory }, true, true);

            WriteWrapper(NodusCommand, "#!/bin/sh\nexec " + NodusDirectory + "/run.sh \"$@\"\n");
            WriteWrapper(NodusTuiCommand, "#!/bin/sh\nexec " + NodusDirectory + "/run-tui.sh \"$@\"\n");

            if (!CommandExists("docker"))
                Console.WriteLine($"[{name}] 참고: 코드 실행(샌드박스) 기능은 Docker가 필요합니다. Docker를 함께 설치하면 사용할 수 있습니다.");
            Console.WriteLine($"[{name}] 설치 완료 → /usr/local/bin/nodus, /usr/local/bin/nodus-tui");
        }
        catch (Exception exception)
        {
            Console.WriteLine($"[{name}] 설치 실패: {exception.Message}");
        }
    }

    // 전역 명령 래퍼를 root 소유 실행 파일로 등록한다.
    private static void WriteWrapper(string path, string content)
    {
        Storage.Write(path, content, ExecutableMode);
        Execute(null, "chown", new[] { "root:root", path }, true, true);
    }

    // sudo로 설치한 사용자에게 Nodus 디렉터리를 넘겨 개발 서버가 캐시를 쓸 수 있게 한다.
    private static string ResolveOwner()
    {
        foreach (string key in new[] { "SUDO_USER", "USER", "LOGNAME" })
        {
            string? value = Environment.GetEnvironmentVariable(key);
            if (!string.IsNullOrWhiteSpace(value) && value != "root")
                return value;
        }
        return "root";
    }

    // 누락된 시스템 패키지를 apt로 채운다. 이미 있으면 아무것도 하지 않는다.
    private static void EnsurePackage(string package, string probeCommand)
    {
        if (Probe(probeCommand))
            return;

        Console.WriteLine($"[CodeOS] {package} 설치가 필요합니다...");
        Execute(null, "apt-get", new[] { "update" }, true, false);
        Execute(null, "apt-get", new[] { "install", "-y", package }, true, true);
    }

    private static void CopyEnvFile(string target, string example)
    {
        if (!File.Exists(target) && File.Exists(example))
            File.Copy(example, target);
    }

    // 기존 설치를 지우지 않고 소스 파일만 덮어쓴다(.venv·node_modules는 제외 목록이라 보존된다).
    private static void CopyTree(string source, string destination)
    {
        if (!Directory.Exists(source))
            throw new DirectoryNotFoundException("번들 도구를 찾지 못했습니다: " + source);
        CopyDirectory(source, destination);
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (string file in Directory.GetFiles(source))
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), true);
        foreach (string directory in Directory.GetDirectories(source))
        {
            string name = Path.GetFileName(directory);
            if (ExcludedDirectories.Contains(name))
                continue;
            CopyDirectory(directory, Path.Combine(destination, name));
        }
    }

    // 소스 트리에서 tools/ 디렉터리를 찾는다. (csproj 위치를 기준으로 위로 탐색)
    private static string LocateToolsDirectory()
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var directory = new DirectoryInfo(start);
            while (directory != null)
            {
                if (File.Exists(Path.Combine(directory.FullName, "CodeOS_setup.csproj")))
                    return Path.Combine(directory.FullName, "tools");
                directory = directory.Parent;
            }
        }
        throw new FileNotFoundException("CodeOS_setup.csproj를 찾지 못했습니다.");
    }

    private static bool CommandExists(string name) =>
        Probe("command -v " + name + " >/dev/null 2>&1");

    private static bool Probe(string command) =>
        Execute(null, "bash", new[] { "-lc", command }, true, false) == 0;

    // stdout/stderr를 동시에 소비해 파이프 버퍼 교착을 막고, 필요하면 실패 시 예외를 던진다.
    private static int Execute(string? workingDirectory, string executable, string[] arguments, bool quiet, bool throwOnError)
    {
        using var process = new Process();
        process.StartInfo.FileName = executable;
        foreach (string argument in arguments)
            process.StartInfo.ArgumentList.Add(argument);
        if (!string.IsNullOrEmpty(workingDirectory))
            process.StartInfo.WorkingDirectory = workingDirectory;
        process.StartInfo.UseShellExecute = false;
        process.StartInfo.RedirectStandardOutput = true;
        process.StartInfo.RedirectStandardError = true;
        process.Start();

        Task<string> outputTask = process.StandardOutput.ReadToEndAsync();
        Task<string> errorTask = process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        Task.WaitAll(outputTask, errorTask);
        string output = outputTask.Result;
        string error = errorTask.Result;

        if (!quiet)
        {
            if (!string.IsNullOrWhiteSpace(output)) Console.WriteLine(output.TrimEnd());
            if (!string.IsNullOrWhiteSpace(error)) Console.WriteLine(error.TrimEnd());
        }
        else if (process.ExitCode != 0 && !string.IsNullOrWhiteSpace(error))
        {
            Console.WriteLine(error.TrimEnd());
        }

        if (throwOnError && process.ExitCode != 0)
            throw new InvalidOperationException("명령 실패: " + executable + " (exit: " + process.ExitCode + ")");
        return process.ExitCode;
    }
}
