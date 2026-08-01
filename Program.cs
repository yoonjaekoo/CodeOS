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

await Task.Delay(1200);

Console.WriteLine("백그라운드 프로그램 설치기를 실행합니다...");
await Task.Delay(800);
Background.Install();

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
