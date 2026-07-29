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

    private static void CreateServiceFile()
    {
        string service = $"""
                          [Unit]
                          Description=CodeOS Background Service
                          After=network.target

                          [Service]
                          Type=simple
                          ExecStart={InstallPath}
                          Restart=always
                          RestartSec=5
                          User=root

                          [Install]
                          WantedBy=multi-user.target
                          """;

        File.WriteAllText(ServicePath, service);
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