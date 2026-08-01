using System.Diagnostics;
using System.IO;

namespace CodeOS_setup;

public static class Background
{
    private const string ServiceName = "codeos";
    private const string ServicePath = "/etc/systemd/system/codeos.service";
    private const string InstallPath = "/opt/codeos/CodeOS.Background";

    public static void Install()
    {
        Console.WriteLine("CodeOS Background Service 설치 중...");

        CreateDirectory();
        PublishBackground();
        RegisterSudoers();
        CreateServiceFile();

        RunCommand("systemctl daemon-reload");
        RunCommand($"systemctl enable {ServiceName}");
        RunCommand($"systemctl start {ServiceName}");

        Console.WriteLine("백그라운드 서비스 설치 완료!");
    }

    private static void CreateDirectory()
    {
        Directory.CreateDirectory("/opt/codeos");
    }

    private static void PublishBackground()
    {
        string publishDir = "/opt/codeos";

        Console.WriteLine("백그라운드 바이너리 빌드 중...");
        RunCommand($"dotnet publish -o {publishDir} --self-contained -r linux-x64");

        string binaryName = Path.Combine(publishDir, "CodeOS_setup");
        string targetName = Path.Combine(publishDir, "CodeOS.Background");
        if (File.Exists(binaryName))
        {
            File.Move(binaryName, targetName, overwrite: true);
            Console.WriteLine("바이너리 설치 완료!");
        }
    }

    private static void CreateServiceFile()
    {
        string service = $"""
                          [Unit]
                          Description=CodeOS Background Service
                          After=network.target

                          [Service]
                          Type=simple
                          ExecStart={InstallPath} --service
                          Restart=always
                          RestartSec=5
                          User=root

                          [Install]
                          WantedBy=multi-user.target
                          """;

        File.WriteAllText(ServicePath, service);
    }

    private static void RegisterSudoers()
    {
        string user = Environment.GetEnvironmentVariable("SUDO_USER")
                      ?? Environment.GetEnvironmentVariable("USER")
                      ?? "root";
        string sudoersContent = $"{user} ALL=(ALL) NOPASSWD: {InstallPath}";
        File.WriteAllText("/etc/sudoers.d/codeos", sudoersContent + "\n");
        RunCommand("chmod 440 /etc/sudoers.d/codeos");
    }

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