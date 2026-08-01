using System.Diagnostics;
using CodeOS_setup;

if (args.Length > 0 && args[0] == "--service")
{
    await BackgroundProgram.RunService(args);
    return;
}

if (!IsRoot()) 
{
    Console.WriteLine("관리자 권한이 필요합니다. sudo로 실행해주세요.");
    Console.WriteLine("sudo ./CodeOS_setup");
    Environment.Exit(1);
}

string LOGO=" ██████╗ ██████╗ ██████╗ ███████╗ ██████╗ ███████╗\n" +
         "██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔═══██╗██╔════╝\n" +
         "██║     ██║   ██║██║  ██║█████╗  ██║   ██║███████╗\n" +
         "██║     ██║   ██║██║  ██║██╔══╝  ██║   ██║╚════██║\n" +
         "╚██████╗╚██████╔╝██████╔╝███████╗╚██████╔╝███████║\n" +
         " ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝ ╚═════╝ ╚══════╝";
Console.WriteLine(LOGO);
 
await Task.Delay(1200);

Console.WriteLine("Made By 구윤재"); // 크레딧

await Task.Delay(1200);

Console.Clear();

Console.WriteLine("CodeOS는 사용자가 코드 작성에만 집중할 수 있도록 사전 설정된 개발 환경, \n" + // 소개
                  "다른 방해 요소들을 차단하는 기능을 가지고 있는 프로그램입니다.");

await Task.Delay(3000);

Console.WriteLine("다음 중 어떤 프로그램을 설치하시겠습니까?\n" +
                  "1. Visual Studio Code\n" +
                  "2. Python3\n" +
                  "3. G++(C++ 컴파일러)\n" +
                  "4. Node.js\n" +
                  "5. npm\n" +
                  "6. Docker\n" +
                  "설치하고 싶은 프로그램들을 공백(오름차순)으로 구분해서 입력해주세요.\n" +
                  "ex: 1 3 4 5\n");

Console.Write("> ");
string? input = Console.ReadLine();

// 입력을 공백 간격으로 분리해서 선택 번호 추출
var selections = (input ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries);

// 번호 → 프로그램 이름 / 설치 명령어
var programs = new Dictionary<string, (string Name, string[] Command)>
{
    ["1"] = ("Visual Studio Code", new[] { "snap", "install", "code", "--classic" }),
    ["2"] = ("Python3", new[] { "apt-get", "install", "-y", "python3", "python3-pip" }),
    ["3"] = ("G++", new[] { "apt-get", "install", "-y", "g++" }),
    ["4"] = ("Node.js", new[] { "apt-get", "install", "-y", "nodejs" }),
    ["5"] = ("npm", new[] { "apt-get", "install", "-y", "npm" }),
    ["6"] = ("Docker", new[] { "bash", "-c", "curl -fsSL https://get.docker.com | sh" })
};

Console.WriteLine("프로그램 설치를 백그라운드에서 시작합니다...\n");

// 각 선택마다 설치를 백그라운드 태스크로 실행
var installTasks = new List<Task>();
foreach (var sel in selections)
{
    if (programs.TryGetValue(sel, out var prog))
        installTasks.Add(InstallProgramAsync(sel, prog.Name, prog.Command));
    else
        Console.WriteLine($"[{sel}] 은(는) 유효하지 않은 번호입니다.");
}

// 백그라운드 프로그램 설치기(차단 서비스)도 동시에 설치
installTasks.Add(Task.Run(Background.Install));

Console.WriteLine("백그라운드 설치가 진행 중입니다...");
await Task.WhenAll(installTasks);

Console.WriteLine("\n모든 작업이 완료되었습니다.");

static Task InstallProgramAsync(string key, string name, string[] command)
{
    return Task.Run(() =>
    {
        var logPath = $"/tmp/codeos-install-{key}.log";
        try
        {
            Console.WriteLine($"[{name}] 설치 시작...");
            using var process = new Process();
            process.StartInfo.FileName = command[0];
            foreach (var arg in command.Skip(1))
                process.StartInfo.ArgumentList.Add(arg);
            process.StartInfo.UseShellExecute = false;
            process.StartInfo.RedirectStandardOutput = true;
            process.StartInfo.RedirectStandardError = true;
            process.Start();

            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            process.WaitForExit();

            File.WriteAllText(logPath, output + error);
            Console.WriteLine($"[{name}] 설치 {(process.ExitCode == 0 ? "완료" : "실패")} (exit: {process.ExitCode}) 로그: {logPath}");
        }
        catch (Exception ex)
        {
            File.WriteAllText(logPath, ex.ToString());
            Console.WriteLine($"[{name}] 오류: {ex.Message} 로그: {logPath}");
        }
    });
}

static bool IsRoot()
{
    // id -u => 현재 프로세스의 권환 가져옴.(0)=>루트, (1000)=>일반
    using var process = Process.Start(new ProcessStartInfo("id", "-u")
    {
        RedirectStandardOutput = true,
        UseShellExecute = false
    });
    if (process == null) return false; // 일반 사용자
    var uid = process.StandardOutput.ReadToEnd().Trim();
    process.WaitForExit();
    return uid == "0";
}
