using System.Diagnostics;
using System.IO;

namespace CodeOS_setup;

// ================================================================
// CodeOS 백그라운드 서비스 설치기
//
// 설치 모드(Program.cs)에서 호출되며, 아래 작업을 순서대로 수행한다.
//   1. /opt/codeos 디렉토리 생성                    (저장 공간 준비)
//   2. dotnet publish 로 독립 실행 바이너리 생성      (런타임 불필요)
//   3. 차단 안내 페이지(blocked.html) 복사
//   4. sudo 없이 codeos CLI 를 실행할 sudoers 규칙 등록
//   5. codeos CLI 별칭을 사용자의 .bashrc 에 등록
//   6. systemd 서비스 파일(codeos.service) 생성 후 등록 및 시작
//
// ※ 백그라운드 서비스가 사이트 차단을 위해 /etc/hosts 를 수정하므로
//   서비스는 루트(root) 권한으로 실행된다.
// ================================================================
public static class Background
{
    // 시스템 서비스 이름 (systemctl 조작에 사용)
    private const string ServiceName = "codeos";

    // systemd 서비스 정의 파일 경로
    private const string ServicePath = "/etc/systemd/system/codeos.service";

    // 설치되는 백그라운드 서비스 바이너리 경로 (systemd 의 ExecStart 에서 실행)
    private const string InstallPath = "/opt/codeos/CodeOS.Background";

    // 설치 과정의 진입점. Program.cs 에서 Task.Run 으로 백그라운드 호출된다.
    public static void Install()
    {
        Console.WriteLine("CodeOS Background Service 설치 중...");

        // 각 단계가 서로 의존적이므로 순서를 지켜야 한다.
        CreateDirectory();    // 1) 저장 공간 준비
        PublishBackground();  // 2) 서비스 바이너리 빌드
        InstallBlockedPage(); // 3) 차단 안내 페이지 설치
        RegisterSudoers();    // 4) 무비밀번호 실행 권한 등록
        RegisterAlias();      // 5) codeos CLI 별칭 등록
        CreateServiceFile();  // 6) systemd 서비스 정의 생성

        // systemd 가 새 서비스 파일을 인식하도록 리로드 후 등록·시작
        RunCommand("systemctl daemon-reload");      // 서비스 파일 변경 사항 반영
        RunCommand($"systemctl enable {ServiceName}");  // 부팅 시 자동 시작 등록
        RunCommand($"systemctl restart {ServiceName}"); // 새 바이너리로 즉시 재시작

        Console.WriteLine("백그라운드 서비스 설치 완료!");
    }

    // ---------- 1) /opt/codeos 디렉토리 생성 ----------
    // 바이너리, 차단 목록, 게임 판별 캐시 등 모든 CodeOS 데이터가 저장되는 곳.
    // 이미 존재하면 아무 작업도 하지 않는다.
    private static void CreateDirectory()
    {
        Directory.CreateDirectory("/opt/codeos");
    }

    // ---------- 2) 차단 안내 페이지 설치 ----------
    // 집중 모드에서 차단된 사이트 대신 보여줄 안내 페이지(blocked.html) 를 복사한다.
    // 프로젝트 폴더에 blocked.html 이 없으면 그냥 건너뛴다.
    private static void InstallBlockedPage()
    {
        if (File.Exists("blocked.html"))
        {
            File.Copy("blocked.html", Path.Combine("/opt/codeos", "blocked.html"), overwrite: true);
            Console.WriteLine("차단 안내 페이지(blocked.html) 설치 완료!");
        }
    }

    // ---------- 3) 백그라운드 바이너리 빌드 및 설치 ----------
    // dotnet publish 로 단일 실행 파일을 만들어 /opt/codeos 에 배치한다.
    // --self-contained -r linux-x64 : .NET 런타임을 포함한 독립 실행 파일로 빌드
    //   (런타임이 설치되지 않은 시스템에서도 동작하게 하기 위함)
    private static void PublishBackground()
    {
        string publishDir = "/opt/codeos";

        Console.WriteLine("백그라운드 바이너리 빌드 중...");
        RunCommand($"dotnet publish -o {publishDir} --self-contained -r linux-x64");

        // 프로젝트 이름(CodeOS_setup)으로 출력되므로 서비스 이름으로 바꿔준다.
        string binaryName = Path.Combine(publishDir, "CodeOS_setup");
        string targetName = Path.Combine(publishDir, "CodeOS.Background");
        if (File.Exists(binaryName))
        {
            File.Move(binaryName, targetName, overwrite: true);
            Console.WriteLine("바이너리 설치 완료!");
        }
    }

    // ---------- 4) systemd 서비스 파일 생성 ----------
    // --service 인자로 백그라운드 서비스(HTTP API) 만 실행되도록 정의한다.
    // Restart=always : 서비스가 비정상 종료되어도 systemd 가 자동으로 재시작한다.
    private static void CreateServiceFile()
    {
        string service = """
                         [Unit]
                         Description=CodeOS Background Service
                         # 네트워크 준비 후 시작
                         After=network.target

                         [Service]
                         Type=simple
                         ExecStart=/opt/codeos/CodeOS.Background --service
                         Restart=always
                         # 재시작 대기 시간(초)
                         RestartSec=5
                         # /etc/hosts 수정을 위해 루트로 실행
                         User=root

                         [Install]
                         # 멀티유저 런타임에서 자동 시작
                         WantedBy=multi-user.target
                         """;

        File.WriteAllText(ServicePath, service);
    }

    // ---------- 5) sudoers 규칙 등록 ----------
    // 설치를 실행한 사용자가 sudo 비밀번호 없이 codeos CLI 를 실행할 수 있게 한다.
    // NOPASSWD 범위를 서비스 바이너리 하나로 한정해 보안을 유지한다.
    private static void RegisterSudoers()
    {
        string user = Environment.GetEnvironmentVariable("SUDO_USER") // sudo 로 실행 시 실제 사용자
                      ?? Environment.GetEnvironmentVariable("USER")   // 일반 실행 시 현재 사용자
                      ?? "root";
        string sudoersContent = $"{user} ALL=(ALL) NOPASSWD: {InstallPath}";
        File.WriteAllText("/etc/sudoers.d/codeos", sudoersContent + "\n");
        RunCommand("chmod 440 /etc/sudoers.d/codeos"); // sudoers 파일은 440 권한이 필수
    }

    // ---------- 6) codeos CLI 별칭 등록 ----------
    // 'codeos' 명령어가 sudo + 서비스 바이너리 호출로 이어지도록 .bashrc 에 별칭을 추가한다.
    // 이미 등록되어 있으면 중복 추가하지 않는다.
    private static void RegisterAlias()
    {
        string user = Environment.GetEnvironmentVariable("SUDO_USER")
                      ?? Environment.GetEnvironmentVariable("USER")
                      ?? "root";
        string? home = GetHomeDir(user);
        if (home == null) return; // 홈 디렉토리를 찾을 수 없으면 별칭 등록을 건너뜀

        string bashrc = Path.Combine(home, ".bashrc");
        if (!File.Exists(bashrc))
            File.WriteAllText(bashrc, ""); // .bashrc 가 없으면 빈 파일 생성

        string content = File.ReadAllText(bashrc);
        if (!content.Contains("alias codeos="))
            File.AppendAllText(bashrc, "\nalias codeos='sudo /opt/codeos/CodeOS.Background'\n");
    }

    // ---------- 사용자 홈 디렉토리 조회 ----------
    // getent passwd 명령으로 사용자의 홈 디렉토리를 알아낸다.
    // 반환 형식: 사용자:비밀번호:UID:GID:설명:홈디렉토리:셸  → 6번째 필드가 홈디렉토리
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
            if (parts.Length > 5)
                return parts[5];
        }
        catch
        {
            // getent 실행 실패 시 null 반환 (별칭 등록 생략)
        }
        return null;
    }

    // ---------- 셸 명령 실행 헬퍼 ----------
    // bash -c 로 명령을 실행하고 표준 출력/에러를 콘솔에 출력한다.
    // ※ 주의: command 에 사용자 입력을 직접 넣으면 명령 삽입 위험이 있으므로
    //   항상 하드코딩된 명령만 전달해야 한다.
    private static void RunCommand(string command)
    {
        using Process process = new();

        process.StartInfo.FileName = "bash";
        process.StartInfo.Arguments = $"-c \"{command}\"";
        process.StartInfo.UseShellExecute = false;
        process.StartInfo.RedirectStandardOutput = true;
        process.StartInfo.RedirectStandardError = true;

        process.Start();

        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();

        process.WaitForExit();

        if (!string.IsNullOrEmpty(output))
            Console.WriteLine(output);

        if (!string.IsNullOrEmpty(error))
            Console.WriteLine(error);
    }
}
