using System.Diagnostics;
using CodeOS_setup;

// ================================================================
// CodeOS_setup — CodeOS 설치 프로그램
//
// 실행 진입점은 두 가지로 나뉜다.
//   1) CLI 클라이언트 모드 : 이미 설치된 백그라운드 서비스에 HTTP 요청을 보내는 역할
//   2) 설치 모드           : 루트 권한으로 개발 프로그램 + 백그라운드 서비스를 설치
//
// ※ 주의: Program.cs(설치 프로그램)와 CodeOS.Background.cs(백그라운드 서비스)는
//   같은 프로젝트지만 실행 경로가 다르므로 혼동하지 않도록 한다.
//   - dotnet run          → 이 파일(설치 프로그램)
//   - dotnet run --file CodeOS.Background.cs 또는 systemd codeos 서비스
//                        → 백그라운드 서비스
// ================================================================

// ---------- 1. CLI 클라이언트 모드 ----------
// 첫 번째 인자가 "--service" 이면 백그라운드 서비스 본체(RunService)를 실행한다.
// (systemd 의 ExecStart 에서 사용되는 경로)
if (args.Length > 0 && args[0] == "--service")
{
    await BackgroundProgram.RunService(args);
    return;
}

// 첫 번째 인자가 서비스 제어 명령이면 설치 메뉴 대신
// 로컬 HTTP API(http://localhost:5890) 로 요청을 전달한다.
if (args.Length > 0 && args[0] is "status" or "block" or "focus" or "game" or "help" or "--help")
{
    // 사용법 안내
    if (args[0] is "help" or "--help")
    {
        Console.WriteLine("Usage: codeos status | block {add|remove|list} [domain] | focus {on|off|cache clear} | game <domain>");
        return;
    }

    // 나머지 명령은 백그라운드 서비스의 HandleCli() 에서 처리된다.
    await BackgroundProgram.HandleCli(args);
    return;
}

// ---------- 2. 설치 모드 ----------
// 설치 모드는 /etc/hosts, /opt/codeos 등 시스템 파일을 수정하므로 루트 권한이 필수다.
if (!IsRoot())
{
    Console.WriteLine("관리자 권한이 필요합니다. sudo로 실행해주세요.");
    Console.WriteLine("sudo ./CodeOS_setup");
    Environment.Exit(1);
}

// ASCII 아트 로고 출력 (시작 화면)
string LOGO = " ██████╗ ██████╗ ██████╗ ███████╗ ██████╗ ███████╗\n" +
             "██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔═══██╗██╔════╝\n" +
             "██║     ██║   ██║██║  ██║█████╗  ██║   ██║███████╗\n" +
             "██║     ██║   ██║██║  ██║██╔══╝  ██║   ██║╚════██║\n" +
             "╚██████╗╚██████╔╝██████╔╝███████╗╚██████╔╝███████║\n" +
             " ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝ ╚═════╝ ╚══════╝";
Console.WriteLine(LOGO);

await Task.Delay(1200); // 로고가 잠시 보이도록 대기

Console.WriteLine("Made By 구윤재"); // 크레딧

await Task.Delay(1200); // 크레딧이 잠시 보이도록 대기

Console.Clear(); // 설치 메뉴를 보여주기 전 화면을 정리

// ---------- 설치 대상 프로그램 선택 메뉴 ----------
Console.WriteLine("다음 중 어떤 프로그램을 설치하시겠습니까?\n" +
                  "1. Visual Studio Code(VSCode!)\n" +
                  "2. Python3(파이썬!)\n" +
                  "3. G++(C++ 컴파일러!)\n" +
                  "4. Node.js\n" +
                  "5. npm\n" +
                  "6. Docker(프로젝트를 상자에 담아버림!)\n" +
                  "7. Vim\n" +
                  "설치하고 싶은 프로그램들을 공백(오름차순)으로 구분해서 입력해주세요.\n" +
                  "ex: 1 3 4 5\n");

// 번호 → 프로그램 이름 / 설치 명령어 매핑
// Command 배열의 첫 요소가 실행 파일명, 나머지는 인자로 사용된다.
var programs = new Dictionary<string, (string Name, string[] Command)>
{
    ["1"] = ("Visual Studio Code", new[] { "snap", "install", "code", "--classic" }),
    ["2"] = ("Python3", new[] { "apt-get", "install", "-y", "python3", "python3-pip" }),
    ["3"] = ("G++", new[] { "apt-get", "install", "-y", "g++" }),
    ["4"] = ("Node.js", new[] { "apt-get", "install", "-y", "nodejs" }),
    ["5"] = ("npm", new[] { "apt-get", "install", "-y", "npm" }),
    ["6"] = ("Docker", new[] { "bash", "-c", "curl -fsSL https://get.docker.com | sh" }),
    ["7"] = ("Vim", new[] { "apt-get", "install", "-y", "vim" })
};

// ---------- 입력 검증 ----------
// 모든 입력이 유효해질 때까지 반복해서 입력을 받는다.
string[] selections;
while (true)
{
    Console.Write("> ");
    string? input = Console.ReadLine();
    // 공백으로 분리하여 번호 목록을 만든다. (ex: "1 3 4" → ["1","3","4"])
    selections = (input ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries);

    // 아무것도 입력하지 않은 경우
    if (selections.Length == 0)
    {
        Console.WriteLine("아무것도 입력되지 않았습니다. 다시 입력해주세요.");
        continue;
    }

    // 메뉴에 없는 번호를 고른 경우
    var invalid = selections.Where(s => !programs.ContainsKey(s)).ToList();
    if (invalid.Count > 0)
    {
        Console.WriteLine($"[{string.Join(", ", invalid)}] 은(는) 유효하지 않은 번호입니다. 다시 입력해주세요.");
        continue;
    }

    break; // 모든 입력이 유효하면 루프 탈출
}

Console.WriteLine("프로그램 설치를 백그라운드에서 시작합니다...\n");

// ---------- 병렬 설치 태스크 생성 ----------
// 각 선택마다 설치를 백그라운드 태스크로 만들어 동시에 진행한다.
var installTasks = new List<Task>();
foreach (var sel in selections)
    installTasks.Add(InstallProgramAsync(sel, programs[sel].Name, programs[sel].Command));

// 백그라운드 프로그램 설치기(차단 서비스)도 동시에 설치한다.
installTasks.Add(Task.Run(Background.Install));

Console.WriteLine("백그라운드 설치가 진행 중입니다...");
await Task.WhenAll(installTasks); // 모든 설치 태스크가 끝날 때까지 대기

Console.WriteLine("\n모든 작업이 완료되었습니다.");

// ---------- 프로그램 설치 헬퍼 ----------
// 주어진 명령어로 프로그램을 설치하고, 실행 로그를 /tmp/codeos-install-{key}.log 에 저장한다.
static Task InstallProgramAsync(string key, string name, string[] command)
{
    return Task.Run(() =>
    {
        var logPath = $"/tmp/codeos-install-{key}.log";
        try
        {
            Console.WriteLine($"[{name}] 설치 시작...");
            using var process = new Process();
            process.StartInfo.FileName = command[0];         // 실행할 프로그램(apt-get, snap 등)
            foreach (var arg in command.Skip(1))
                process.StartInfo.ArgumentList.Add(arg);     // 나머지 인자 추가
            process.StartInfo.UseShellExecute = false;       // 셸 경유 없이 직접 실행
            process.StartInfo.RedirectStandardOutput = true; // 표준 출력 수집
            process.StartInfo.RedirectStandardError = true;  // 표준 에러 수집
            process.Start();

            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            process.WaitForExit();

            // 실행 결과(출력 + 에러)를 로그 파일에 저장
            File.WriteAllText(logPath, output + error);
            Console.WriteLine($"[{name}] 설치 {(process.ExitCode == 0 ? "완료" : "실패")} (exit: {process.ExitCode}) 로그: {logPath}");
        }
        catch (Exception ex)
        {
            // 예외가 발생해도 로그 파일에 기록해 원인을 확인할 수 있게 한다.
            File.WriteAllText(logPath, ex.ToString());
            Console.WriteLine($"[{name}] 오류: {ex.Message} 로그: {logPath}");
        }
    });
}

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
