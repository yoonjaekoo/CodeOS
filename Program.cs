using System.Diagnostics;
using CodeOS_setup;

// ================================================================
// CodeOS_setup — CodeOS 진입점
//
// 실행 경로는 네 가지로 나뉜다.
//   1) 백그라운드 서비스 본체 : --service  (systemd 의 ExecStart 에서 사용)
//   2) CLI 클라이언트 모드     : --cli      (설치된 /usr/local/bin/codeos 래퍼가 사용)
//   3) 전체 설치              : 인자 없음    (서비스 + 번들 도구 AutoGit/Nodus)
//   4) 서비스 설치·재설치      : --service-install (루트 권한 필요)
//
// ※ 주의: Program.cs 와 CodeOS.Background.cs 는 같은 프로젝트지만 실행 경로가 다르다.
//   - dotnet run                              → 이 파일(설치 / CLI 진입점)
//   - dotnet run --file CodeOS.Background.cs  → 백그라운드 서비스
// ================================================================

// ---------- 1. 백그라운드 서비스 본체 ----------
// 첫 번째 인자가 "--service" 이면 백그라운드 서비스 본체(RunService)를 실행한다.
// (systemd 의 ExecStart 에서 사용되는 경로)
if (args.Length > 0 && args[0] == "--service")
{
    await BackgroundProgram.RunService();
    return;
}

// ---------- 2. CLI 클라이언트 모드 ----------
// 설치된 /usr/local/bin/codeos 래퍼가 사용하는 유일한 CLI 진입점이다.
// HandleCli 내부에서 명령 파싱 전에 중앙 인증을 수행한다.
if (args.Length > 0 && args[0] == "--cli")
{
    await BackgroundProgram.HandleCli(args[1..]);
    return;
}

// ---------- 3. 서비스 설치·재설치 ----------
// 백그라운드 서비스를 빌드·게시하고 systemd 에 등록한다.
// 소스 변경 후 시스템 정책을 다시 적용할 때 사용한다.
if (args.Length > 0 && args[0] == "--service-install")
{
    if (!IsRoot())
    {
        Console.WriteLine("관리자 권한이 필요합니다. sudo로 실행해주세요.");
        Console.WriteLine("sudo dotnet run -- --service-install");
        Environment.Exit(1);
    }

    Console.WriteLine("CodeOS 백그라운드 서비스를 설치합니다...");
    Background.Install();
    Console.WriteLine("CodeOS 백그라운드 서비스 설치가 완료되었습니다.");
    return;
}

// 인자가 있는 상태에서는 CLI로 처리한다.
// 실제로 허용할 명령은 HandleCli의 Route에서 고정하므로 제거된 명령이나
// 오타가 잘못 진입하지 않는다.
if (args.Length > 0)
{
    await BackgroundProgram.HandleCli(args);
    return;
}

// 인자가 없으면 서비스와 번들 도구(AutoGit/Nodus)를 한 번에 설치한다.
// 설치 모드는 nftables, /opt/codeos, systemd 등 시스템 파일을 수정하므로
// 루트 권한이 필수다.
if (!IsRoot())
{
    Console.WriteLine("관리자 권한이 필요합니다. sudo로 실행해주세요.");
    Console.WriteLine("sudo dotnet run");
    Environment.Exit(1);
}

Console.WriteLine("CodeOS와 번들 도구(AutoGit/Nodus)를 설치합니다...");
Background.Install();
Console.WriteLine("CodeOS 설치가 완료되었습니다.");

// ---------- 루트 권한 확인 ----------
// id -u 로 현재 프로세스의 UID 를 확인한다. (0 => 루트, 그 외 => 일반 사용자)
static bool IsRoot()
{
    using var process = Process.Start(new ProcessStartInfo("id", "-u")
    {
        RedirectStandardOutput = true,
        UseShellExecute = false
    });
    if (process == null) return false; // 프로세스 생성 실패 시 일반 사용자로 간주
    var uid = process.StandardOutput.ReadToEnd().Trim();
    process.WaitForExit();
    return uid == "0";
}
