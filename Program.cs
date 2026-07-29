using System.Diagnostics;
using CodeOS_setup;

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

Console.WriteLine("먼저 백그라운드 프로그램 설치기를 실행하시겠습니까?(Y/n): "); // 물어보기(그냥 엔터 -> 진행)
var input = Console.ReadLine()?.Trim().ToLower();
if (string.IsNullOrEmpty(input) || input == "y")
{
    Console.WriteLine("설치기를 실행하겠습니다.");
    await Task.Delay(1200);
    Background.Install();
}
else
{
    Console.WriteLine("프로그램을 종료하겠습니다.");
    await Task.Delay(1200);
    Environment.Exit(0);
}
