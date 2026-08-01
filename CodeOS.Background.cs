using System.Net;
using System.Text;

namespace CodeOS_setup;

// CodeOS 백그라운드
public static class BackgroundProgram
{
    // 차단목록 파일 경로
    private static readonly string BlockListPath = "/opt/codeos/blocklist.txt";

    // 차단 목록 / 집중 모드 상태
    private static readonly List<string> BlockedSites = [];
    private static bool _focusMode;

    // 인자가 있으면 CLI 모드, 없으면 서비스 모드
    public static async Task Main(string[] args)
    {
        if (args.Length > 0)
            await HandleCli(args);
        else
            await RunService(args);
    }

    // 서비스 모드: HTTP API 서버 시작
    public static async Task RunService(string[] args)
    {
        LoadBlockList();

        // 저장된 차단 목록이 있으면 /etc/hosts에 즉시 적용
        if (BlockedSites.Count > 0)
        {
            ApplyHostsBlock(true);
        }

        // localhost:5890에서 HTTP 요청 대기
        var http = new HttpListener();
        http.Prefixes.Add("http://localhost:5890/");
        http.Start();

        while (true)
        {
            var ctx = await http.GetContextAsync();
            _ = HandleRequest(ctx);
        }
    }

    // -------------------요청 처리-------------
    private static async Task HandleRequest(HttpListenerContext ctx)
    {
        var method = ctx.Request.HttpMethod;
        var path = ctx.Request.Url!.AbsolutePath.Trim('/');
        var parts = path.Split('/');

        string response;

        try
        {
            response = parts[0] switch
            {
                "status" => GetStatus(),
                "block" when parts.Length >= 2 => parts[1] switch
                {
                    "add" when parts.Length >= 3 => BlockAdd(parts[2]),
                    "remove" when parts.Length >= 3 => BlockRemove(parts[2]),
                    "list" => GetBlockList(),
                    _ => "Usage: /block/{add|remove|list} [domain]"
                },
                "focus" when parts.Length >= 2 => parts[1] switch
                {
                    "on" => FocusOn(),
                    "off" => FocusOff(),
                    _ => "Usage: /focus/{on|off}"
                },
                _ => "Commands: status, block/{add|remove|list}, focus/{on|off}"
            };
        }
        catch (Exception ex)
        {
            response = $"Error: {ex.Message}";
        }

        var buf = Encoding.UTF8.GetBytes(response);
        ctx.Response.ContentType = "text/plain";
        ctx.Response.ContentLength64 = buf.Length;
        await ctx.Response.OutputStream.WriteAsync(buf);
        ctx.Response.Close();
    }

    // -------------CLI-------------
    private static async Task HandleCli(string[] args)
    {
        using var client = new HttpClient();
        var baseUrl = "http://localhost:5890";

        try
        {
            // 인자를 HTTP 경로로 변환하여 서비스에 GET 요청
            string path = args[0] switch
            {
                "status" => "/status",
                "block" when args.Length >= 2 => args[1] switch
                {
                    "add" when args.Length >= 3 => $"/block/add/{args[2]}",
                    "remove" when args.Length >= 3 => $"/block/remove/{args[2]}",
                    "list" => "/block/list",
                    _ => throw new Exception("Usage: codeos block {add|remove|list} [domain]")
                },
                "focus" when args.Length >= 2 => args[1] switch
                {
                    "on" => "/focus/on",
                    "off" => "/focus/off",
                    _ => throw new Exception("Usage: codeos focus {on|off}")
                },
                _ => throw new Exception("Commands: status, block {add|remove|list}, focus {on|off}")
            };
            var res = await client.GetAsync(baseUrl + path);
            Console.WriteLine(await res.Content.ReadAsStringAsync());
        }
        catch (HttpRequestException)
        {
            Console.WriteLine("CodeOS Background Service is not running.");
            Console.WriteLine("Start it with: sudo systemctl start codeos");
        }
    }

    // ----------상태 조회----------
    private static string GetStatus()
    {
        var sb = new StringBuilder();
        sb.AppendLine("CodeOS Status");
        sb.AppendLine($"  Focus Mode: {(_focusMode ? "ON" : "OFF")}");
        sb.AppendLine($"  Blocked Sites: {BlockedSites.Count}");
        foreach (var site in BlockedSites)
            sb.AppendLine($"    - {site}");
        return sb.ToString();
    }

    // ----------사이트 차단 추가----------
    private static string BlockAdd(string domain)
    {
        domain = domain.Trim().ToLower();
        if (string.IsNullOrEmpty(domain))
            return "Invalid domain";

        if (BlockedSites.Contains(domain))
            return $"'{domain}' is already blocked";

        BlockedSites.Add(domain);
        SaveBlockList();           // 영구 저장
        ApplyHostsBlock(true);     // /etc/hosts 즉시 반영
        return $"Blocked '{domain}'";
    }

    // ----------사이트 차단 해제----------
    private static string BlockRemove(string domain)
    {
        domain = domain.Trim().ToLower();
        if (!BlockedSites.Remove(domain))
            return $"'{domain}' is not in block list";

        SaveBlockList();
        ApplyHostsBlock(false);    // /etc/hosts에서 제거
        return $"Unblocked '{domain}'";
    }

    // ----------차단 목록 출력----------
    private static string GetBlockList()
    {
        if (BlockedSites.Count == 0)
            return "No sites blocked";

        return $"Blocked sites:\n{string.Join("\n", BlockedSites.Select(s => $"  - {s}"))}";
    }

    // ----------집중 모드 ON / OFF----------
    private static string FocusOn()
    {
        _focusMode = true;
        return "Focus mode ON";
    }

    private static string FocusOff()
    {
        _focusMode = false;
        return "Focus mode OFF";
    }

    // ----------차단 목록 파일→메모리 로드----------
    private static void LoadBlockList()
    {
        if (!File.Exists(BlockListPath)) return;
        BlockedSites.Clear();
        foreach (var line in File.ReadAllLines(BlockListPath))
        {
            var s = line.Trim().ToLower();
            if (!string.IsNullOrEmpty(s) && !s.StartsWith('#'))  // 주석 줄 무시
                BlockedSites.Add(s);
        }
    }

    // ----------메모리→파일 저장----------
    private static void SaveBlockList()
    {
        File.WriteAllLines(BlockListPath, BlockedSites);
    }

    // ----------/etc/hosts 조작----------
    private static void ApplyHostsBlock(bool @lock)
    {
        var hostsPath = "/etc/hosts";
        var markerStart = "# CodeOS BLOCK START";
        var markerEnd = "# CodeOS BLOCK END";
        var lines = File.ReadAllLines(hostsPath).ToList();

        // 기존 CodeOS 블록 제거
        var startIdx = lines.FindIndex(l => l == markerStart);
        var endIdx = lines.FindIndex(l => l == markerEnd);

        if (startIdx != -1 && endIdx != -1)
            lines.RemoveRange(startIdx, endIdx - startIdx + 1);

        // @lock=true 이고 차단 목록이 있으면 새 블록 삽입
        if (@lock && BlockedSites.Count > 0)
        {
            var blockLines = new List<string> { markerStart };
            blockLines.AddRange(BlockedSites.Select(s => $"0.0.0.0 {s}"));
            blockLines.AddRange(BlockedSites.Select(s => $"0.0.0.0 www.{s}"));
            blockLines.Add(markerEnd);

            // localhost 줄 다음에 삽입
            var insertIdx = lines.FindIndex(l => l.StartsWith("127.0.0.1\tlocalhost"));
            if (insertIdx == -1) insertIdx = lines.Count - 1;
            lines.InsertRange(insertIdx + 1, blockLines);
        }

        File.WriteAllLines(hostsPath, lines);
    }
}
