// Groq API(OpenAI 호환)는 외부 패키지 없이 HttpClient 로 직접 호출하므로
// 파일 기반 실행(./execute) 에 필요한 패키지 지시문(#:package)은 없다.

using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace CodeOS_setup;

// ================================================================
// CodeOS 백그라운드 서비스
//
// 이 파일은 한 프로젝트 안에서 두 가지 실행 모드를 가진다.
//   1) 서비스 모드(RunService) : HttpListener로 로컬 HTTP API를 띄워
//      사이트 차단 / 집중 모드 / 게임 사이트 감지 기능을 제공한다.
//      (systemd codeos 서비스는 --service 로, 개발 중에는 ./execute 로 시작)
//   2) CLI 모드(HandleCli)     : 실행 중인 서비스에 HTTP 요청을 보내
//      상태 확인 / 차단 관리 / 집중 모드 토글을 수행한다.
//
// 주요 동작:
//   - 차단 목록은 /opt/codeos/blocklist.txt 에 영구 저장된다.
//   - 차단은 /etc/hosts 의 "# CodeOS BLOCK START"/"# CodeOS BLOCK END"
//     마커 사이에 "0.0.0.0 <도메인>" 항목을 넣는 DNS 차단 방식이다. (루트 필요)
//   - 게임 사이트 판별은 Groq API를 사용하고, 결과는 7일간 캐시해 재사용한다.
// ================================================================
public static class BackgroundProgram
{
    // 차단 목록 파일 경로 (도메인을 한 줄에 하나씩 저장)
    private static readonly string BlockListPath = "/opt/codeos/blocklist.txt";

    // 차단 안내 페이지(blocked.html) 파일 경로 / 접속 주소
    private static readonly string BlockedHtmlPath = "/opt/codeos/blocked.html";
    private const string BlockedPageUrl = "http://localhost:1234/blocked.html";

    // 메모리에 로드된 차단 도메인 목록 / 집중 모드 ON·OFF 상태
    private static readonly List<string> BlockedSites = [];
    private static bool _focusMode;

    // 진입점: 인자가 있으면 CLI 모드, 없으면 서비스 모드.
    // (dotnet run 은 Program.cs 의 --service 분기를 타므로, 이 Main 은
    //  dotnet run --file CodeOS.Background.cs 로 직접 실행할 때 사용된다)
    public static async Task Main(string[] args)
    {
        if (args.Length > 0)
            await HandleCli(args);
        else
            await RunService(args);
    }

    // ---------- 서비스 모드: HTTP API 서버 시작 ----------
    public static async Task RunService(string[] args)
    {
        // 저장된 차단 목록을 파일에서 메모리로 로드
        LoadBlockList();

        // 저장된 차단 목록이 있으면 서비스 시작 시점에 /etc/hosts 에 즉시 적용
        // (컴퓨터를 재부팅해도 차단이 유지되도록 함)
        if (BlockedSites.Count > 0)
        {
            ApplyHostsBlock(true);
        }

        // HTTP 서버 주소 설정:
        //   - 5890 포트 : 상태/차단/집중모드/게임감지 API
        //   - 1234 포트 : 차단된 사이트 접속 시 보여줄 안내 페이지
        var http = new HttpListener();
        http.Prefixes.Add("http://localhost:5890/");
        http.Prefixes.Add("http://localhost:1234/");
        http.Start();
        Console.WriteLine("CodeOS Background Service started on http://localhost:5890 (blocked page: http://localhost:1234/blocked.html)");

        // 요청 대기 루프: 요청이 들어올 때마다 별도 태스크로 처리해 병렬 응답 지원
        while (true)
        {
            var ctx = await http.GetContextAsync();
            _ = HandleRequest(ctx);
        }
    }

    // ---------- HTTP 요청 라우팅 ----------
    // 요청 URL 의 경로/포트에 따라 적절한 처리 함수로 분기한다.
    private static async Task HandleRequest(HttpListenerContext ctx)
    {
        var url = ctx.Request.Url!;
        var path = url.AbsolutePath.Trim('/');
        var parts = path.Split('/');

        // 1234 포트로 들어온 요청은 항상 차단 안내 페이지(blocked.html)를 제공한다.
        if (url.Port == 1234)
        {
            await ServeBlockedHtml(ctx);
            return;
        }

        // 게임 사이트 자동 감지: /game/check/{도메인}  (브라우저 확장 등에서 호출)
        if (parts.Length >= 3 && parts[0] == "game" && parts[1] == "check")
        {
            await GameCheckAsync(ctx, parts[2]);
            return;
        }

        // 그 외 경로는 아래 switch 문으로 텍스트 응답을 반환한다.
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
                    "cache" when parts.Length >= 3 && parts[2] == "clear" => ClearGameCache(),
                    _ => "Usage: /focus/{on|off|cache/clear}"
                },
                _ => "Commands: status, block/{add|remove|list}, focus/{on|off|cache/clear}, game/check/{domain}"
            };
        }
        catch (Exception ex)
        {
            // 처리 중 예외가 발생하면 클라이언트에 에러 메시지를 반환한다.
            response = $"Error: {ex.Message}";
        }

        await WriteText(ctx, response);
    }

    // ---------- 차단 안내 페이지(blocked.html) 제공 ----------
    // 파일이 없으면 기본 안내 문구가 담긴 간단한 HTML 을 대신 반환한다.
    private static async Task ServeBlockedHtml(HttpListenerContext ctx)
    {
        string html = File.Exists(BlockedHtmlPath)
            ? await File.ReadAllTextAsync(BlockedHtmlPath)
            : "<html><body style=\"font-family:sans-serif;text-align:center;padding-top:3rem\"><h1>집중 모드가 켜져 있습니다.</h1></body></html>";

        var buf = Encoding.UTF8.GetBytes(html);
        ctx.Response.ContentType = "text/html; charset=utf-8";
        ctx.Response.ContentLength64 = buf.Length;
        await ctx.Response.OutputStream.WriteAsync(buf);
        ctx.Response.Close();
    }

    // ---------- 게임 사이트 자동 감지 및 차단 ----------
    // Groq API로 도메인이 게임 사이트인지 판별한다.
    // 집중 모드가 켜져 있고 게임 사이트로 판단되면 자동 차단 + 안내 페이지로 리디렉션.
    private static async Task GameCheckAsync(HttpListenerContext ctx, string domain)
    {
        var query = ctx.Request.QueryString;
        // 판별 정확도를 위해 페이지 제목/설명을 쿼리 파라미터로 함께 받는다.
        var (isGameSite, confidence) = await GameDetector.IsGameSiteAsync(
            domain, query["title"], query["description"]);

        // 집중 모드 ON + 게임 사이트 → 차단 목록에 추가하고 안내 페이지로 이동
        if (_focusMode && isGameSite)
        {
            BlockAdd(domain);
            await RedirectTo(ctx, BlockedPageUrl, $"{domain} 은(는) 게임 사이트로 판단되어 차단되었습니다.");
            return;
        }

        // 집중 모드가 꺼져 있거나 게임 사이트가 아니면 판별 결과만 안내한다.
        string msg = isGameSite
            ? $"{domain} 은(는) 게임 사이트로 판단되었습니다. (집중 모드가 꺼져 있어 차단하지 않습니다) (confidence: {confidence:P0})"
            : $"{domain} 은(는) 게임 사이트로 판단되지 않았습니다.";
        await WriteText(ctx, msg);
    }

    // ---------- 302 리디렉션 응답 ----------
    // 브라우저를 다른 주소로 이동시키기 위한 HTTP 리디렉션을 보낸다.
    private static async Task RedirectTo(HttpListenerContext ctx, string location, string message)
    {
        ctx.Response.StatusCode = 302;
        ctx.Response.RedirectLocation = location;
        await WriteText(ctx, message);
    }

    // ---------- 텍스트 응답 작성 ----------
    // 일반 텍스트 응답을 UTF-8 로 인코딩해 클라이언트에 보낸다.
    private static async Task WriteText(HttpListenerContext ctx, string text)
    {
        var buf = Encoding.UTF8.GetBytes(text);
        ctx.Response.ContentType = "text/plain; charset=utf-8";
        ctx.Response.ContentLength64 = buf.Length;
        await ctx.Response.OutputStream.WriteAsync(buf);
        ctx.Response.Close();
    }

    // ---------- CLI 모드: 서비스에 HTTP 요청 전송 ----------
    // 명령줄 인자를 HTTP 경로로 변환해 http://localhost:5890 서비스에 GET 요청을 보낸다.
    // 서비스가 실행 중이지 않으면 안내 메시지를 출력한다.
    public static async Task HandleCli(string[] args)
    {
        using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
        var baseUrl = "http://localhost:5890";

        try
        {
            // 인자를 HTTP 경로로 변환하는 switch 문
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
                    "cache" when args.Length >= 3 && args[2] == "clear" => "/focus/cache/clear",
                    _ => throw new Exception("Usage: codeos focus {on|off|cache clear}")
                },
                "game" when args.Length >= 2 => $"/game/check/{args[1]}",
                _ => throw new Exception("Commands: status, block {add|remove|list}, game <domain>, focus {on|off|cache clear}")
            };
            var res = await client.GetAsync(baseUrl + path);
            Console.WriteLine(await res.Content.ReadAsStringAsync());
        }
        catch (HttpRequestException)
        {
            // 서비스가 떠 있지 않으면 연결 예외(HttpRequestException)가 발생한다.
            Console.WriteLine("CodeOS Background Service is not running.");
            Console.WriteLine("Start it with: sudo systemctl start codeos");
        }
    }

    // ---------- 상태 조회 ----------
    // 집중 모드, 게임 감지 활성화 여부, 차단 목록을 텍스트로 정리해 반환한다.
    private static string GetStatus()
    {
        var sb = new StringBuilder();
        sb.AppendLine("CodeOS Status");
        sb.AppendLine($"  Focus Mode: {(_focusMode ? "ON" : "OFF")}");
        sb.AppendLine($"  Game Detection: {(GameDetector.Enabled ? "enabled" : "disabled")}");
        sb.AppendLine($"  Blocked Sites: {BlockedSites.Count}");
        foreach (var site in BlockedSites)
            sb.AppendLine($"    - {site}");
        return sb.ToString();
    }

    // ---------- 사이트 차단 추가 ----------
    // 도메인을 메모리 목록에 추가하고, 파일에 저장한 뒤 /etc/hosts 에 반영한다.
    private static string BlockAdd(string domain)
    {
        domain = domain.Trim().ToLower(); // 대소문자 구분을 없애기 위해 소문자로 통일
        if (string.IsNullOrEmpty(domain))
            return "Invalid domain";

        if (BlockedSites.Contains(domain))
            return $"'{domain}' is already blocked";

        BlockedSites.Add(domain);
        SaveBlockList();       // 영구 저장 (/opt/codeos/blocklist.txt)
        ApplyHostsBlock(true); // /etc/hosts 즉시 반영
        return $"Blocked '{domain}'";
    }

    // ---------- 사이트 차단 해제 ----------
    private static string BlockRemove(string domain)
    {
        domain = domain.Trim().ToLower();
        if (!BlockedSites.Remove(domain))
            return $"'{domain}' is not in block list";

        SaveBlockList();
        ApplyHostsBlock(false); // /etc/hosts 에서 제거
        return $"Unblocked '{domain}'";
    }

    // ---------- 차단 목록 출력 ----------
    private static string GetBlockList()
    {
        if (BlockedSites.Count == 0)
            return "No sites blocked";

        return $"Blocked sites:\n{string.Join("\n", BlockedSites.Select(s => $"  - {s}"))}";
    }

    // ---------- 집중 모드 ON / OFF ----------
    // 집중 모드가 켜져 있으면 게임 사이트 접속 시 자동 차단이 동작한다.
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

    // ---------- AI 게임 판별 캐시 비우기 ----------
    // Groq API 판별 결과 캐시를 지워 다음 game/check 호출 때 새로 판단하게 한다.
    private static string ClearGameCache()
    {
        var removed = GameDetector.ClearCache();
        return removed > 0
            ? $"Game detection AI cache cleared ({removed} entries removed)"
            : "Game detection AI cache is already empty";
    }

    // ---------- 차단 목록 파일 → 메모리 로드 ----------
    // 서비스 시작 시 파일에서 목록을 읽어온다. '#'로 시작하는 줄은 주석으로 무시한다.
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

    // ---------- 메모리 → 파일 저장 ----------
    // 차단 목록이 바뀔 때마다 파일에 기록해 재부팅 후에도 목록이 유지되게 한다.
    private static void SaveBlockList()
    {
        File.WriteAllLines(BlockListPath, BlockedSites);
    }

    // ---------- /etc/hosts 조작 ----------
    // "# CodeOS BLOCK START" ~ "# CodeOS BLOCK END" 마커 사이에 차단 항목을 삽입/제거한다.
    // @lock = true  : 차단 목록을 마커 사이에 새로 쓴다.
    // @lock = false : 마커 블록 전체를 지운다.
    private static void ApplyHostsBlock(bool @lock)
    {
        var hostsPath = "/etc/hosts";
        var markerStart = "# CodeOS BLOCK START";
        var markerEnd = "# CodeOS BLOCK END";
        var lines = File.ReadAllLines(hostsPath).ToList();

        // 기존 CodeOS 블록 제거 (마커 두 개가 모두 있으면 그 사이를 통째로 삭제)
        var startIdx = lines.FindIndex(l => l == markerStart);
        var endIdx = lines.FindIndex(l => l == markerEnd);

        if (startIdx != -1 && endIdx != -1)
            lines.RemoveRange(startIdx, endIdx - startIdx + 1);

        // @lock=true 이고 차단 목록이 있으면 새 블록을 삽입한다.
        // 도메인 하나당 "0.0.0.0 도메인" 과 "0.0.0.0 www.도메인" 두 줄을 추가해
        // www 서브도메인까지 함께 차단한다.
        if (@lock && BlockedSites.Count > 0)
        {
            var blockLines = new List<string> { markerStart };
            blockLines.AddRange(BlockedSites.Select(s => $"0.0.0.0 {s}"));
            blockLines.AddRange(BlockedSites.Select(s => $"0.0.0.0 www.{s}"));
            blockLines.Add(markerEnd);

            // localhost 줄 다음에 삽입해 호스트 파일의 다른 내용과 분리한다.
            var insertIdx = lines.FindIndex(l => l.StartsWith("127.0.0.1\tlocalhost"));
            if (insertIdx == -1) insertIdx = lines.Count - 1;
            lines.InsertRange(insertIdx + 1, blockLines);
        }

        File.WriteAllLines(hostsPath, lines);
    }
}

// ================================================================
// 게임 사이트 자동 감지 (Groq API + 로컬 캐시)
//
// 도메인이 온라인 게임 사이트인지 Groq API 로 판별한다.
// 매번 API를 호출하면 비용·지연이 크므로 결과를 7일간 로컬 캐시에 저장해 재사용한다.
// Groq 는 OpenAI 호환 REST API 를 제공하므로 외부 SDK 없이 HttpClient 로 호출한다.
//
// ※ 사용 조건: Groq API 키가 필요하다. 키는 아래 순서로 찾는다.
//   1) 환경 변수 GROQ_API_KEY
//   2) 파일 /opt/codeos/groq-api-key.txt
//   3) 둘 다 없으면 감지 기능 비활성화 (Enabled == false)
// ================================================================
public static class GameDetector
{
    // 사용할 Groq 모델명.
    // openai/gpt-oss-120b 는 Groq 에서 제공되는 GPT-OSS 120B 모델이다.
    // (Groq 무료 티어: 분당 30요청 / 하루 1K요청 제한. 판별 결과를 7일간
    //  캐시하므로 제한 내에서 충분히 동작한다)
    private const string Model = "openai/gpt-oss-120b";

    // API 키 저장 파일 경로 (환경 변수로 전달하기 어려운 설치형 서비스용)
    private const string ApiKeyPath = "/opt/codeos/groq-api-key.txt";

    // 캐시 저장 경로 / 만료 시간 (7일)
    private static readonly string CachePath = "/opt/codeos/game-cache.txt";
    private static readonly TimeSpan CacheTtl = TimeSpan.FromDays(7);

    // 모델 호출 없이 바로 게임 사이트로 판단할 대표 웹게임 포털.
    // 과거에 false 로 캐시된 값이 있어도 이 목록이 우선한다.
    private static readonly HashSet<string> KnownGamePortalDomains = new(StringComparer.OrdinalIgnoreCase)
    {
        "poki.com",
        "crazygames.com",
        "kizi.com",
        "y8.com",
        "friv.com",
        "miniclip.com",
        "addictinggames.com",
        "kongregate.com",
        "armorgames.com"
    };

    // Groq API 호출용 HttpClient. 스레드 안전하므로 정적 필드로 한 번만 생성해 재사용한다.
    // 15초 제한으로 API 가 응답하지 않아도 오래 기다리지 않게 한다.
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };

    // 도메인별 판별 결과 인메모리 캐시 (도메인 → GameCacheEntry)
    private static readonly Dictionary<string, GameCacheEntry> Cache = [];

    // 여러 요청이 동시에 캐시에 접근할 때 동기화하기 위한 락
    private static readonly object CacheLock = new();

    // 도메인별 판별 결과를 담는 캐시 엔트리
    // (도메인, 게임 사이트 여부, 판단 신뢰도, 판단 시각)
    private sealed class GameCacheEntry
    {
        public bool IsGameSite;
        public double Confidence;
        public DateTimeOffset CheckedAt;
    }

    // 정적 생성자: 프로그램 시작 시 파일에 저장된 기존 캐시를 로드한다.
    static GameDetector()
    {
        LoadCache();
    }

    // API 키가 설정되어 있으면 감지 기능 활성화 (게임 감지 켜짐 상태 표시에 사용)
    public static bool Enabled => !string.IsNullOrEmpty(GetApiKey());

    // 도메인(및 얻을 수 있는 메타데이터)이 게임 사이트인지 판별
    // 1) 캐시에 최근 결과가 있으면 즉시 반환 (API 호출 생략)
    // 2) 없으면 Groq API 를 호출하고 결과를 캐시에 저장
    public static async Task<(bool IsGameSite, double Confidence)> IsGameSiteAsync(string domain, string? title = null, string? description = null)
    {
        domain = NormalizeDomain(domain);

        // 대표 웹게임 포털은 캐시나 모델 판단보다 먼저 확정 처리한다.
        // 특히 예전에 false 로 저장된 캐시가 있어도 Poki 같은 사이트는 놓치지 않게 한다.
        if (IsKnownGamePortal(domain))
            return (true, 1.0);

        // 이미 캐시에 저장된 도메인은 로컬 데이터를 우선 사용한다.
        if (TryGetCached(domain, out var cached))
            return cached;

        bool isGameSite = false;
        double confidence = 0;
        bool apiFailed = false;
        try
        {
            (isGameSite, confidence) = await AskGroqAsync(domain, title, description);
        }
        catch (Exception ex)
        {
            // Groq API 호출 실패 시 false 로 처리하되(서비스 전체 중단 방지),
            // 원인을 콘솔 로그에 남겨 디버깅이 가능하게 한다.
            // ※ 실패 결과는 캐시에 저장하지 않는다. 저장하면 실패한 false 가
            //   7일간 고정되어 실제 게임 사이트도 계속 차단되지 않기 때문이다.
            apiFailed = true;
            Console.WriteLine($"[GameDetector] Groq API 호출 실패 ({domain}): {ex.Message}");
        }

        // API 호출이 성공한 경우에만 캐시에 저장한다.
        if (!apiFailed)
            SaveCache(domain, isGameSite, confidence);
        return (isGameSite, confidence);
    }

    // ---------- Groq API 호출 (OpenAI 호환 /chat/completions) ----------
    // 모델에 프롬프트를 보내고, 반환된 JSON 응답을 파싱한다.
    private static async Task<(bool IsGameSite, double Confidence)> AskGroqAsync(string domain, string? title, string? description)
    {
        string apiKey = GetApiKey();
        if (string.IsNullOrEmpty(apiKey))
            return (false, 0); // 키가 없으면 게임 사이트가 아닌 것으로 처리

        // 요청 내용 구성: system 은 응답 형식, user 에 프롬프트 전체를 담는다.
        // Groq 의 JSON 모드(response_format=json_object) 는 메시지에 "json" 이라는
        // 단어가 포함돼 있어야 정상 동작하므로 프롬프트에 JSON 형식을 명시한다.
        var body = new
        {
            model = Model,
            messages = new object[]
            {
                new { role = "system", content = "웹사이트가 게임 사이트인지 판별하는 분류기. 응답은 반드시 JSON 만 반환한다." },
                new { role = "user", content = BuildPrompt(domain, title, description) }
            },
            temperature = 0.0,  // 같은 입력엔 같은 결과가 나오도록 결정적으로 만든다.
            max_tokens = 80,
            response_format = new { type = "json_object" }
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.groq.com/openai/v1/chat/completions");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        using var response = await Http.SendAsync(request);
        response.EnsureSuccessStatusCode();

        // 응답에서 choices[0].message.content 만 추출해 파싱한다.
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var content = doc.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString();
        return ParseResult(content);
    }

    // ---------- Groq 응답에서 JSON 파싱 ----------
    // 모델이 반환한 텍스트에서 is_game_site / confidence 값을 추출한다.
    // markdown 코드 블록 등이 붙어 있어도 첫 '{' ~ 마지막 '}' 만 추출해 파싱한다.
    private static (bool IsGameSite, double Confidence) ParseResult(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return (false, 0);

        int start = text.IndexOf('{');
        int end = text.LastIndexOf('}');
        if (start < 0 || end <= start)
            return (false, 0);

        try
        {
            using var doc = JsonDocument.Parse(text.Substring(start, end - start + 1));
            bool isGame = doc.RootElement.TryGetProperty("is_game_site", out var gameProp)
                          && gameProp.ValueKind == JsonValueKind.True;
            double conf = doc.RootElement.TryGetProperty("confidence", out var confProp)
                          && confProp.TryGetDouble(out var c) ? c : 0;
            return (isGame, conf);
        }
        catch
        {
            return (false, 0); // JSON 파싱 실패 시 게임 사이트가 아닌 것으로 처리
        }
    }

    // ---------- 프롬프트 작성 ----------
    // 모델에게 "이 도메인이 게임 사이트인가?" 를 판별하도록 지시하는 프롬프트를 만든다.
    // 한국어 지시 + 반환 형식(JSON) 을 명확히 지정해 파싱 오류를 줄인다.
    private static string BuildPrompt(string domain, string? title, string? description)
    {
        var sb = new StringBuilder();
        sb.AppendLine("이 웹사이트가 사용자가 직접 온라인 게임을 플레이하는 것을 주 목적으로 하는 웹사이트인지 판단해줘.");
        sb.AppendLine();
        sb.AppendLine($"도메인: {domain}");
        if (!string.IsNullOrWhiteSpace(title))
            sb.AppendLine($"페이지 제목: {title}");
        if (!string.IsNullOrWhiteSpace(description))
            sb.AppendLine($"페이지 설명: {description}");
        sb.AppendLine();
        sb.AppendLine("다음과 같은 사이트는 게임 사이트로 판단해:");
        sb.AppendLine("- Poki, CrazyGames, Kizi, Y8 및 기타 온라인 웹게임 포털");
        sb.AppendLine("- 사용자가 브라우저에서 직접 게임을 플레이할 수 있는 사이트");
        sb.AppendLine();
        sb.AppendLine("다음과 같은 사이트는 게임 사이트로 판단하지 마:");
        sb.AppendLine("- 게임 뉴스 사이트, 게임 위키, 게임 커뮤니티, 게임 개발 사이트");
        sb.AppendLine("- 게임 관련 쇼핑몰, 게임 회사 공식 홈페이지");
        sb.AppendLine("- 게임을 일부 다루지만 직접 플레이하는 것이 주 목적이 아닌 사이트");
        sb.AppendLine();
        sb.AppendLine("판단하기 어려우면 is_game_site를 false로 해줘.");
        sb.AppendLine("confidence는 0.0 이상 1.0 이하 숫자로 해줘.");
        sb.AppendLine("응답은 반드시 다음 JSON 형식으로 해줘: {\"is_game_site\": true, \"confidence\": 0.95}");
        return sb.ToString();
    }

    // ---------- 도메인 정규화 (URL/경로 제거) ----------
    // "https://example.com/path" 같은 입력을 "example.com" 으로 단순화한다.
    private static string NormalizeDomain(string domain)
    {
        domain = domain.Trim().ToLower();
        if (domain.StartsWith("http://"))
            domain = domain["http://".Length..];
        else if (domain.StartsWith("https://"))
            domain = domain["https://".Length..];

        int slash = domain.IndexOf('/');
        if (slash >= 0)
            domain = domain[..slash];

        return domain;
    }

    // ---------- API 키 조회 ----------
    // 1) 환경 변수 GROQ_API_KEY 우선 사용
    // 2) 없으면 /opt/codeos/groq-api-key.txt 파일에서 읽기
    // 3) 둘 다 없으면 빈 문자열 반환 (감지 기능 비활성)
    // ※ 보안: API 키를 소스 코드에 하드코딩하면 외부 유출 위험이 있으므로
    //   반드시 환경 변수나 파일로 관리해야 한다.
    private static string GetApiKey()
    {
        var envKey = Environment.GetEnvironmentVariable("GROQ_API_KEY");
        if (!string.IsNullOrEmpty(envKey))
            return envKey;

        try
        {
            if (File.Exists(ApiKeyPath))
            {
                var fileKey = File.ReadAllText(ApiKeyPath).Trim();
                if (!string.IsNullOrEmpty(fileKey))
                    return fileKey;
            }
        }
        catch
        {
            // 파일 읽기 실패는 무시 (마지막 단계에서 빈 문자열 반환)
        }

        return "";
    }

    // ---------- 캐시 조회 ----------
    // 캐시에 저장되어 있고 만료되지 않았으면 해당 결과를 반환한다.
    // 여러 요청이 동시에 캐시에 접근하므로 lock 으로 동기화한다.
    private static bool TryGetCached(string domain, out (bool IsGameSite, double Confidence) result)
    {
        lock (CacheLock)
        {
            if (Cache.TryGetValue(domain, out var entry) && DateTimeOffset.UtcNow - entry.CheckedAt < CacheTtl)
            {
                result = (entry.IsGameSite, entry.Confidence);
                return true;
            }
        }
        result = (false, 0);
        return false;
    }

    // ---------- 대표 게임 포털 판별 ----------
    // 루트 도메인뿐 아니라 www.poki.com, play.poki.com 같은 하위 도메인도 포함한다.
    private static bool IsKnownGamePortal(string domain)
    {
        foreach (var gameDomain in KnownGamePortalDomains)
        {
            if (domain.Equals(gameDomain, StringComparison.OrdinalIgnoreCase)
                || domain.EndsWith("." + gameDomain, StringComparison.OrdinalIgnoreCase))
                return true;
        }

        return false;
    }

    // ---------- 캐시 비우기 ----------
    // 메모리 캐시와 디스크 캐시 파일을 함께 삭제한다.
    public static int ClearCache()
    {
        lock (CacheLock)
        {
            var removed = Cache.Count;
            Cache.Clear();

            try
            {
                if (File.Exists(CachePath))
                    File.Delete(CachePath);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[GameDetector] 캐시 파일 삭제 실패: {ex.Message}");
            }

            return removed;
        }
    }

    // ---------- 캐시 저장 / 로드 ----------
    // 판별 결과를 메모리와 파일(game-cache.txt) 양쪽에 저장한다.
    // 파일 형식: 도메인|is_game_site|판단시각(Unix초)|confidence
    private static void SaveCache(string domain, bool isGameSite, double confidence)
    {
        lock (CacheLock)
        {
            Cache[domain] = new GameCacheEntry
            {
                IsGameSite = isGameSite,
                Confidence = confidence,
                CheckedAt = DateTimeOffset.UtcNow
            };

            try
            {
                Directory.CreateDirectory("/opt/codeos");
                var lines = Cache.Select(kv =>
                    $"{kv.Key}|{(kv.Value.IsGameSite ? "true" : "false")}|{kv.Value.CheckedAt.ToUnixTimeSeconds()}|{kv.Value.Confidence.ToString(CultureInfo.InvariantCulture)}");
                File.WriteAllLines(CachePath, lines);
            }
            catch
            {
                // 캐시 저장 실패는 치명적이지 않으므로 무시
            }
        }
    }

    // 서비스 시작 시 파일에서 캐시를 읽어 메모리에 적재한다.
    // 형식이 잘못된 줄은 건너뛴다.
    private static void LoadCache()
    {
        lock (CacheLock)
        {
            Cache.Clear();
            if (!File.Exists(CachePath))
                return;

            foreach (var line in File.ReadAllLines(CachePath))
            {
                var parts = line.Split('|');
                if (parts.Length < 3)
                    continue;
                if (!bool.TryParse(parts[1], out var isGame))
                    continue;
                if (!long.TryParse(parts[2], out var unix))
                    continue;
                double conf = parts.Length >= 4
                    && double.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out var c) ? c : 0;

                Cache[parts[0]] = new GameCacheEntry
                {
                    IsGameSite = isGame,
                    Confidence = conf,
                    CheckedAt = DateTimeOffset.FromUnixTimeSeconds(unix)
                };
            }
        }
    }
}
