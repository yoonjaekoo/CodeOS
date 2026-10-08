using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CodeOS_setup;

public static class Background
{
    private const string ServiceName = "codeos";
    private const string ServicePath = "/etc/systemd/system/codeos.service";
    private const string InstallDirectory = "/opt/codeos";
    private const string InstallPath = InstallDirectory + "/CodeOS.Background";
    private const string CliPath = "/usr/local/bin/codeos";

    public static void Install()
    {
        Console.WriteLine("CodeOS 시스템 전역 서비스를 설치합니다...");
        BackgroundProgram.InitializeInstallation();
        BackgroundProgram.MigrateLegacyState();
        PublishBackground();
        ProtectInstalledFiles();
        RegisterSystemCli();
        RegisterSudoers();
        CreateServiceFile();
        RunCommand("systemctl", "daemon-reload");
        // enable --now는 이미 실행 중인 구버전 서비스를 재시작하지 않는다.
        // 바이너리와 service 파일을 갱신한 뒤에는 항상 현재 프로세스도 교체한다.
        RunCommand("systemctl", "enable", ServiceName);
        RunCommand("systemctl", "restart", ServiceName);

        // CodeOS를 설치하면 번들된 AutoGit / Nodus와 코드 실행용 Docker도 시스템 전역에서 쓸 수 있게 설치한다.
        // Linux가 아니면 내부에서 건너뛰고, 실패해도 서비스 설치는 유지된다.
        Integrations.InstallAutoGit();
        Integrations.InstallDocker();
        Integrations.InstallNodus();

        Console.WriteLine("CodeOS 백그라운드 서비스 설치 완료!");
    }

    private static void PublishBackground()
    {
        string project = LocateProjectFile();
        string runtimeIdentifier = RuntimeInformation.RuntimeIdentifier;
        Console.WriteLine("백그라운드 바이너리를 빌드합니다...");
        // linux-x64는 로컬 SDK에 없는 경우 NuGet 런타임 팩을 받으려고
        // 네트워크에서 무기한 대기할 수 있다. 현재 OS의 로컬 RID를 사용하고,
        // 외부 소스가 없어도 로컬 런타임 팩으로 계속 진행한다.
        RunCommandWithSpinner("백그라운드 바이너리 복원 중...", "dotnet", "restore", project, "--runtime", runtimeIdentifier, "--ignore-failed-sources", "--disable-build-servers");
        RunCommandWithSpinner("백그라운드 바이너리 빌드 중...", "dotnet", "publish", project, "-o", InstallDirectory, "--self-contained", "-r", runtimeIdentifier,
            "--no-restore", "--disable-build-servers", "--verbosity", "minimal");
        string generated = Path.Combine(InstallDirectory, "CodeOS_setup");
        if (!File.Exists(generated)) throw new InvalidOperationException("dotnet publish가 CodeOS_setup 실행 파일을 만들지 못했습니다.");
        File.Move(generated, InstallPath, true);
    }

    private static void ProtectInstalledFiles()
    {
        RunCommand("chown", "-R", "root:root", InstallDirectory);
        RunCommand("chmod", "755", InstallDirectory);
        RunCommand("chmod", "755", InstallPath);
        // 런타임 DLL과 설정 파일은 일반 사용자가 수정할 수 없게 한다.
        RunCommand("chmod", "-R", "go-w", InstallDirectory);
        RunCommand("chown", "-R", "root:root", "/etc/codeos", "/var/lib/codeos");
        Storage.Mode("/etc/codeos", UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        Storage.Mode("/var/lib/codeos", UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    private static void RegisterSystemCli()
    {
        const string wrapper = "#!/bin/sh\nexec /usr/bin/sudo -n /opt/codeos/CodeOS.Background --cli \"$@\"\n";
        Storage.Write(CliPath, wrapper, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
            UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        RunCommand("chown", "root:root", CliPath);
    }

    private static void RegisterSudoers()
    {
        // 일반 사용자는 이 root-owned --cli 관문만 비밀번호 없이 실행할 수 있다.
        // 실제 정책 변경은 그 안의 CodeOS 관리자 비밀번호 검사와 서비스 토큰이
        // 모두 통과해야 한다. --service는 systemd의 비밀 환경변수 없이는 거부된다.
        Storage.Write("/etc/sudoers.d/codeos",
            "ALL ALL=(root) NOPASSWD: /opt/codeos/CodeOS.Background --cli *\n",
            UnixFileMode.UserRead | UnixFileMode.GroupRead);
        RunCommand("chown", "root:root", "/etc/sudoers.d/codeos");
        RunCommand("chmod", "440", "/etc/sudoers.d/codeos");
        RunCommand("visudo", "-cf", "/etc/sudoers.d/codeos");
    }

    private static void CreateServiceFile()
    {
        const string service = """
            [Unit]
            Description=CodeOS system policy service
            After=network.target

            [Service]
            Type=simple
            User=root
            WorkingDirectory=/opt/codeos
            EnvironmentFile=/etc/codeos/service.env
            ExecStart=/opt/codeos/CodeOS.Background --service
            Restart=always
            RestartSec=5
            UMask=0077
            NoNewPrivileges=true
            PrivateTmp=true
            ProtectHome=true

            [Install]
            WantedBy=multi-user.target
            """;
        Storage.Write(ServicePath, service, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead);
        RunCommand("chown", "root:root", ServicePath);
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

    private static void RunCommand(string executable, params string[] arguments) =>
        RunCommandCore(executable, arguments, null);

    // 긴 작업(빌드 등)에 콘솔 점자 스피너를 함께 돌린다.
    private static void RunCommandWithSpinner(string spinnerLabel, string executable, params string[] arguments) =>
        RunCommandCore(executable, arguments, spinnerLabel);

    private static void RunCommandCore(string executable, string[] arguments, string? spinnerLabel)
    {
        using var process = new Process();
        process.StartInfo.FileName = executable;
        foreach (string argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        process.StartInfo.UseShellExecute = false;
        process.StartInfo.RedirectStandardOutput = true;
        process.StartInfo.RedirectStandardError = true;

        int exitCode;
        string output;
        string error;
        Spinner? progress = spinnerLabel is null ? null : Spinner.Start(spinnerLabel);
        try
        {
            process.Start();
            // stdout을 전부 읽은 뒤 stderr를 읽으면 dotnet publish가 stderr
            // 파이프 버퍼를 채운 순간 교착될 수 있다. 두 스트림을 동시에 소비한다.
            Task<string> outputTask = process.StandardOutput.ReadToEndAsync();
            Task<string> errorTask = process.StandardError.ReadToEndAsync();
            process.WaitForExit();
            Task.WaitAll(outputTask, errorTask);
            output = outputTask.Result;
            error = errorTask.Result;
            exitCode = process.ExitCode;
        }
        finally
        {
            // 출력을 찍기 전에 스피너 줄을 지워 메시지가 겹치지 않게 한다.
            progress?.Stop();
        }

        if (!string.IsNullOrWhiteSpace(output)) Console.WriteLine(output);
        if (!string.IsNullOrWhiteSpace(error)) Console.WriteLine(error);
        if (exitCode != 0) throw new InvalidOperationException("명령 실패: " + executable + " (exit: " + exitCode + ")");
    }
}
