using System.Diagnostics;

namespace CodeOS_setup;

// ================================================================
// CodeOS 번들 도구 전역 설치기
//
// tools/ 아래에 그대로 복사해 둔 AutoGit / Nodus 소스를 /opt 로 배포하고
// /usr/local/bin 에 전역 명령만 등록한다.
//
//   - AutoGit : /opt/autogit + /usr/local/bin/autogit  (Node.js >= 18)
//   - Nodus   : /opt/nodus   + /usr/local/bin/nodus, nodus-tui
//               백엔드·TUI venv와 프론트엔드 npm 의존성은 없을 때만 준비한다.
//
// 원본 소스는 건드리지 않고, 재설치 시에는 소스 파일만 갱신한다.
// ================================================================
public static class Integrations
{
    private const string AutoGitDirectory = "/opt/autogit";
    private const string NodusDirectory = "/opt/nodus";
    private const string NodusCommand = "/usr/local/bin/nodus";
    private const string NodusTuiCommand = "/usr/local/bin/nodus-tui";

    // 전역 설치에서 제외할 디렉터리 이름(빌드 산출물·가상환경·메타데이터).
    private static readonly string[] ExcludedDirectories =
        { ".git", "node_modules", ".venv", "__pycache__", ".mypy_cache", ".pytest_cache" };

    private static readonly UnixFileMode ExecutableMode =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
        UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute;

    // ---------- AutoGit ----------
    public static void InstallAutoGit()
    {
        const string name = "AutoGit";
        try
        {
            Console.WriteLine($"[{name}] 전역 설치를 시작합니다...");
            if (!OperatingSystem.IsLinux())
            {
                Console.WriteLine($"[{name}] Linux가 아니므로 건너뜁니다.");
                return;
            }

            string source = Path.Combine(LocateToolsDirectory(), "autogit");
            CopyTree(source, AutoGitDirectory);
            Execute(null, "chmod", new[] { "-R", "go-w", AutoGitDirectory }, true, true);
            foreach (string script in new[] { "bin/autogit.js", "autogit", "install.sh", "uninstall.sh" })
                Execute(null, "chmod", new[] { "+x", AutoGitDirectory + "/" + script }, true, true);
            Execute(null, "chown", new[] { "-R", "root:root", AutoGitDirectory }, true, true);

            // 원본 install.sh가 Node.js 18 이상을 요구하므로 먼저 준비·확인한다.
            EnsurePackage("nodejs", "command -v node >/dev/null 2>&1");
            EnsurePackage("npm", "command -v npm >/dev/null 2>&1");
            WarnIfNodeTooOld(name);

            // 원본 저장소가 제공하는 설치 스크립트를 그대로 사용해 PATH에 등록한다.
            Execute(null, "bash", new[] { AutoGitDirectory + "/install.sh" }, false, true);
            Console.WriteLine($"[{name}] 설치 완료 → /usr/local/bin/autogit");
        }
        catch (Exception exception)
        {
            Console.WriteLine($"[{name}] 설치 실패: {exception.Message}");
        }
    }

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
            EnsurePackage("nodejs", "command -v node >/dev/null 2>&1");
            EnsurePackage("npm", "command -v npm >/dev/null 2>&1");

            // 백엔드의 네이티브 의존성(pydantic-core, asyncpg)이 최신 Python(3.14+)을
            // 아직 지원하지 않으므로 3.9~3.13 중 사용 가능한 가장 높은 버전을 고른다.
            string python = ResolveNodusPython();
            EnsureVenvModule(python);

            // 백엔드 가상환경 + 의존성
            PrepareVenv(NodusDirectory + "/backend", python, upgradePip: true);

            // 터미널 TUI 가상환경 + 의존성
            PrepareVenv(NodusDirectory + "/tui", python, upgradePip: false);

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

    // 설치 실패를 예외로 던지지 않는 EnsurePackage. 여러 후보를 순서대로 시도할 때 쓴다.
    private static bool TryEnsurePackage(string package, string probeCommand)
    {
        if (Probe(probeCommand))
            return true;

        Console.WriteLine($"[CodeOS] {package} 설치를 시도합니다...");
        Execute(null, "apt-get", new[] { "update" }, true, false);
        Execute(null, "apt-get", new[] { "install", "-y", package }, true, false);
        return Probe(probeCommand);
    }

    private static void CopyEnvFile(string target, string example)
    {
        if (!File.Exists(target) && File.Exists(example))
            File.Copy(example, target);
    }

    // Nodus는 pydantic-core/asyncpg 같은 네이티브 휠을 쓰므로,
    // 아직 지원이 불안정한 3.14+ 대신 3.9~3.13 중 가장 높은 Python을 고른다.
    private static string ResolveNodusPython()
    {
        string[] candidates = { "python3.13", "python3.12", "python3.11", "python3.10", "python3.9", "python3" };
        foreach (string candidate in candidates)
        {
            if (CommandExists(candidate) && IsSupportedPython(candidate))
                return candidate;
        }

        // 설치돼 있지 않으면 3.13부터 낮춰 가며 apt로 설치를 시도한다.
        Console.WriteLine("[Nodus] 호환되는 Python(3.9~3.13)이 필요합니다. apt 설치를 시도합니다...");
        foreach (string version in new[] { "3.13", "3.12", "3.11", "3.10" })
        {
            string candidate = "python3." + version;
            if (TryEnsurePackage(candidate, "command -v " + candidate + " >/dev/null 2>&1")
                && IsSupportedPython(candidate))
                return candidate;
        }

        // 마지막 수단: 기본 python3 (PYO3 ABI3 플래그로 빌드를 시도한다).
        if (CommandExists("python3"))
        {
            Console.WriteLine("[Nodus] 경고: 호환 버전(3.9~3.13)을 설치하지 못해 기본 python3로 시도합니다.");
            return "python3";
        }

        throw new InvalidOperationException("Nodus에 필요한 Python 3.9~3.13을 찾거나 설치하지 못했습니다.");
    }

    private static bool IsSupportedPython(string executable)
    {
        string version = Capture(executable, "-c", "import sys;print('%d.%d'%sys.version_info[:2])").Trim();
        string[] parts = version.Split('.');
        return parts.Length == 2
            && int.TryParse(parts[0], out int major)
            && int.TryParse(parts[1], out int minor)
            && major == 3 && minor >= 9 && minor <= 13;
    }

    // 선택한 Python에 venv 모듈이 없으면 해당 버전용 패키지를 설치한다.
    private static void EnsureVenvModule(string python)
    {
        if (Probe($"{python} -c \"import venv\" >/dev/null 2>&1"))
            return;

        string package = python == "python3" ? "python3-venv" : python + "-venv";
        if (!TryEnsurePackage(package, $"{python} -c \"import venv\" >/dev/null 2>&1"))
            throw new InvalidOperationException($"{python}의 venv 모듈을 사용할 수 없습니다.");
    }

    // venv가 없거나 호환되지 않는 Python으로 만들어졌으면 새로 만들고,
    // 아직 준비되지 않았으면 의존성을 설치한다(마커 파일로 성공 여부를 추적).
    private static void PrepareVenv(string workingDirectory, string python, bool upgradePip)
    {
        string venv = workingDirectory + "/.venv";
        string marker = venv + "/.codeos-ready";
        if (!IsCompatibleVenv(venv))
        {
            // 이전 설치가 3.14+로 만들어 둔 venv는 지우고 다시 만든다.
            if (Directory.Exists(venv))
                Directory.Delete(venv, true);
            Execute(null, python, new[] { "-m", "venv", venv }, true, true);
        }

        if (File.Exists(marker))
            return;

        string venvPython = venv + "/bin/python";
        if (upgradePip)
            Execute(workingDirectory, venvPython, new[] { "-m", "pip", "install", "--quiet", "--upgrade", "pip" }, true, true);

        // 호환 버전(<=3.13)에서는 보통 불필요하지만, 최신 Python으로 폴백할 때를 대비한다.
        Execute(workingDirectory, venvPython, new[] { "-m", "pip", "install", "--quiet", "-r", "requirements.txt" },
            true, true, ("PYO3_USE_ABI3_FORWARD_COMPATIBILITY", "1"));
        File.WriteAllText(marker, "ok\n");
    }

    private static bool IsCompatibleVenv(string venvDirectory)
    {
        string venvPython = venvDirectory + "/bin/python";
        return File.Exists(venvPython) && IsSupportedPython(venvPython);
    }

    private static void WarnIfNodeTooOld(string name)
    {
        string detected = Capture("node", "-p", "process.versions.node.split('.')[0]").Trim();
        if (int.TryParse(detected, out int major) && major < 18)
            Console.WriteLine($"[{name}] 경고: Node.js {major} 감지 — AutoGit은 18 이상이 필요합니다.");
    }

    private static string Capture(string executable, params string[] arguments)
    {
        using var process = new Process();
        process.StartInfo.FileName = executable;
        foreach (string argument in arguments)
            process.StartInfo.ArgumentList.Add(argument);
        process.StartInfo.UseShellExecute = false;
        process.StartInfo.RedirectStandardOutput = true;
        process.StartInfo.RedirectStandardError = true;
        process.Start();
        string output = process.StandardOutput.ReadToEnd();
        process.StandardError.ReadToEnd();
        process.WaitForExit();
        return output;
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
    private static int Execute(string? workingDirectory, string executable, string[] arguments, bool quiet, bool throwOnError,
        (string Key, string Value)? environment = null)
    {
        using var process = new Process();
        process.StartInfo.FileName = executable;
        foreach (string argument in arguments)
            process.StartInfo.ArgumentList.Add(argument);
        if (!string.IsNullOrEmpty(workingDirectory))
            process.StartInfo.WorkingDirectory = workingDirectory;
        if (environment is { } variable)
            process.StartInfo.Environment[variable.Key] = variable.Value;
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
