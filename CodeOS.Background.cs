// Groq API(OpenAI 호환)는 외부 패키지 없이 HttpClient 로 직접 호출하므로
// 파일 기반 실행(./execute) 에 필요한 패키지 지시문(#:package)은 없다.

using System.Globalization;
using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodeOS_setup;

// ================================================================
// CodeOS 백그라운드 서비스
//
// 화이트리스트에 등록된 도메인만 Chromium 확장을 통해 허용한다.
// 허용 목록에 없는 도메인은 로컬 API가 차단 결과를 반환하고 확장이
// 차단 안내 페이지로 이동시킨다. 비-Chromium 브라우저는 우회 방지를
// 위해 프로세스 가드가 종료한다.
// ================================================================
public static class BackgroundProgram
{
    private const string DataDirectory = "/opt/codeos";
    private static readonly string WhitelistPath = Path.Combine(DataDirectory, "whitelist.txt");

    // 화이트리스트에 없는 사이트를 안내하는 페이지 경로 / 접속 주소
    private static readonly string BlockedHtmlPath = Path.Combine(DataDirectory, "blocked.html");

    private static readonly HashSet<string> WhitelistedSites = new(StringComparer.OrdinalIgnoreCase);
    private static readonly object WhitelistLock = new();

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
        LoadWhitelist();
        RemoveLegacyHostsEntries();
        BrowserPolicyInstaller.Install();

        var http = new HttpListener();
        // HttpListener/Linux에서 IPv6 loopback prefix가 거부될 수 있으므로
        // 확장 프로그램과 CLI가 함께 사용하는 IPv4 loopback만 등록한다.
        http.Prefixes.Add("http://127.0.0.1:5890/");
        http.Prefixes.Add("http://127.0.0.1:1234/");
        http.Start();
        Console.WriteLine("CodeOS 백그라운드 서비스가 127.0.0.1:5890 및 127.0.0.1:1234에서 실행 중입니다.");

        // Firefox 등 확장을 적용할 수 없는 브라우저는 항상 종료해 우회를 막는다.
        _ = BrowserGuard.RunAsync();

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
        if (ctx.Request.RemoteEndPoint is { } remote && !IPAddress.IsLoopback(remote.Address))
        {
            ctx.Response.StatusCode = 403;
            await WriteText(ctx, "Forbidden");
            return;
        }

        var url = ctx.Request.Url!;
        var path = url.AbsolutePath.Trim('/');
        var parts = path.Split('/');

        if (ctx.Request.HttpMethod.Equals("OPTIONS", StringComparison.OrdinalIgnoreCase)
            && path.Equals("api/access-status", StringComparison.OrdinalIgnoreCase))
        {
            // 확장 프로그램의 preflight 요청만 허용한다.
            if (!IsBrowserExtensionOrigin(ctx.Request.Headers["Origin"]))
            {
                ctx.Response.StatusCode = 403;
                ctx.Response.Close();
                return;
            }

            AddCorsHeaders(ctx.Response, ctx.Request.Headers["Origin"]);
            ctx.Response.StatusCode = 204;
            ctx.Response.Close();
            return;
        }

        if (path.Equals("api/access-status", StringComparison.OrdinalIgnoreCase))
        {
            await AccessStatusAsync(ctx);
            return;
        }

        // 1234 포트에서는 화이트리스트 안내 페이지만 정적 제공한다.
        if (url.Port == 1234 && path.Equals("blocked.html", StringComparison.OrdinalIgnoreCase))
        {
            await ServeBlockedHtml(ctx);
            return;
        }

        // 나머지는 CLI/API 명령이다.
        string response;
        try
        {
            response = parts[0] switch
            {
                    "status" => GetStatus(),
                    "whitelist" when parts.Length >= 2 => parts[1] switch
                    {
                    "add" when parts.Length >= 3 => WhitelistAdd(Uri.UnescapeDataString(parts[2])),
                    "remove" when parts.Length >= 3 => WhitelistRemove(Uri.UnescapeDataString(parts[2])),
                    "list" => GetWhitelist(),
                    "clear" => WhitelistClear(),
                    _ => "Usage: /whitelist/{add|remove|list|clear} [domain]"
                },
                "browser" when parts.Length >= 2 && parts[1] == "remove" => RemoveBrowserPolicies(),
                _ => "Commands: status, whitelist/{add|remove|list|clear}, browser/remove"
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
            : "<html><body style=\"font-family:sans-serif;text-align:center;padding-top:3rem\"><h1>허용 목록에 없는 사이트입니다.</h1></body></html>";

        var buf = Encoding.UTF8.GetBytes(html);
        ctx.Response.ContentType = "text/html; charset=utf-8";
        ctx.Response.ContentLength64 = buf.Length;
        await ctx.Response.OutputStream.WriteAsync(buf);
        ctx.Response.Close();
    }

    private static async Task AccessStatusAsync(HttpListenerContext ctx)
    {
        // 이 API는 브라우저 확장 프로그램만 호출할 수 있다.
        // Origin이 없거나 일반 웹 페이지의 Origin이면 도메인 처리/AI 호출을 하지 않는다.
        string? origin = ctx.Request.Headers["Origin"];
        if (!IsBrowserExtensionOrigin(origin))
        {
            await WriteJson(ctx, new { error = "browser extension required" }, 403);
            return;
        }

        AddCorsHeaders(ctx.Response, origin);
        string rawDomain = ctx.Request.QueryString["domain"] ?? "";
        if (!DomainRules.TryNormalize(rawDomain, out var domain))
        {
            await WriteJson(ctx, new { allowed = false, blocked = true, domain = "", error = "invalid domain" }, 400);
            return;
        }

        bool allowed = IsWhitelisted(domain);
        await WriteJson(ctx, new
        {
            allowed,
            blocked = !allowed,
            domain,
            reason = allowed ? "whitelist" : "not-whitelisted"
        });
    }

    private static bool IsBrowserExtensionOrigin(string? origin)
        => !string.IsNullOrWhiteSpace(origin)
           && (origin.StartsWith("chrome-extension://", StringComparison.OrdinalIgnoreCase)
               || origin.StartsWith("moz-extension://", StringComparison.OrdinalIgnoreCase));

    private static void AddCorsHeaders(HttpListenerResponse response, string? origin)
    {
        // WebExtension의 chrome-extension:// / moz-extension:// origin만 허용한다.
        if (IsBrowserExtensionOrigin(origin))
        {
            response.Headers["Access-Control-Allow-Origin"] = origin;
            response.Headers["Vary"] = "Origin";
        }
    }

    private static async Task WriteJson(HttpListenerContext ctx, object value, int statusCode = 200)
    {
        var buf = JsonSerializer.SerializeToUtf8Bytes(value);
        ctx.Response.StatusCode = statusCode;
        ctx.Response.ContentType = "application/json; charset=utf-8";
        ctx.Response.ContentLength64 = buf.Length;
        await ctx.Response.OutputStream.WriteAsync(buf);
        ctx.Response.Close();
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
        var baseUrl = "http://127.0.0.1:5890";

        try
        {
            // 인자를 HTTP 경로로 변환하는 switch 문
            string path = args[0] switch
            {
                "status" => "/status",
                "whitelist" when args.Length >= 2 => args[1] switch
                {
                    "add" when args.Length >= 3 => $"/whitelist/add/{Uri.EscapeDataString(args[2])}",
                    "remove" when args.Length >= 3 => $"/whitelist/remove/{Uri.EscapeDataString(args[2])}",
                    "list" => "/whitelist/list",
                    "clear" => "/whitelist/clear",
                    _ => throw new Exception("Usage: codeos whitelist {add|remove|list|clear} [domain]")
                },
                "browser" when args.Length >= 2 && args[1] == "remove" => "/browser/remove",
                _ => throw new Exception("Commands: status, whitelist {add|remove|list|clear}, browser remove")
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
    // 화이트리스트와 브라우저 정책 상태를 텍스트로 정리해 반환한다.
    private static string GetStatus()
    {
        var sb = new StringBuilder();
        sb.AppendLine("CodeOS Status");
        sb.AppendLine("  Policy: 화이트리스트 모드");
        sb.AppendLine("  Browser Policy: Chromium 브라우저만 허용");
        var sites = GetWhitelistSites();
        sb.AppendLine($"  Whitelisted Sites: {sites.Count}");
        foreach (var site in sites)
            sb.AppendLine($"    - {site}");
        return sb.ToString();
    }

    private static string WhitelistAdd(string domain)
    {
        if (!DomainRules.TryNormalize(domain, out domain))
            return "올바르지 않은 도메인입니다.";

        lock (WhitelistLock)
        {
            if (!WhitelistedSites.Add(domain))
                return $"'{domain}'은(는) 이미 허용 목록에 있습니다.";
            SaveWhitelistUnsafe();
        }
        return $"'{domain}'을(를) 허용 목록에 추가했습니다.";
    }

    private static string WhitelistRemove(string domain)
    {
        if (!DomainRules.TryNormalize(domain, out domain))
            return "올바르지 않은 도메인입니다.";

        lock (WhitelistLock)
        {
            if (!WhitelistedSites.Remove(domain))
                return $"'{domain}'은(는) 허용 목록에 없습니다.";
            SaveWhitelistUnsafe();
        }
        return $"'{domain}'을(를) 허용 목록에서 제거했습니다.";
    }

    private static string WhitelistClear()
    {
        lock (WhitelistLock)
        {
            WhitelistedSites.Clear();
            SaveWhitelistUnsafe();
        }
        return "허용 목록을 비웠습니다. 이제 로컬 주소를 제외한 모든 사이트가 차단됩니다.";
    }

    private static string GetWhitelist()
    {
        var sites = GetWhitelistSites();
        if (sites.Count == 0)
            return "허용 목록이 비어 있습니다. 로컬 주소를 제외한 모든 사이트가 차단됩니다.";

        return $"허용 사이트:\n{string.Join("\n", sites.Select(s => $"  - {s}"))}";
    }

    private static List<string> GetWhitelistSites()
    {
        lock (WhitelistLock)
            return WhitelistedSites.Order(StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static bool IsWhitelisted(string domain)
    {
        lock (WhitelistLock)
        {
            return WhitelistedSites.Any(allowed =>
                domain.Equals(allowed, StringComparison.OrdinalIgnoreCase)
                || domain.EndsWith("." + allowed, StringComparison.OrdinalIgnoreCase));
        }
    }

    private static void LoadWhitelist()
    {
        lock (WhitelistLock)
        {
            WhitelistedSites.Clear();
            if (File.Exists(WhitelistPath))
                LoadDomainsInto(WhitelistPath, WhitelistedSites);
        }
    }

    private static void LoadDomainsInto(string path, HashSet<string> destination)
    {
        foreach (var line in File.ReadAllLines(path))
        {
            if (DomainRules.TryNormalize(line, out var domain))
                destination.Add(domain);
        }
    }

    private static void SaveWhitelistUnsafe()
        => AtomicWriteLines(WhitelistPath, WhitelistedSites.Order(StringComparer.OrdinalIgnoreCase));

    // 이전 버전이 /etc/hosts에 남긴 CodeOS 차단 마커만 제거한다.
    private static void RemoveLegacyHostsEntries()
    {
        var hostsPath = "/etc/hosts";
        var markerStart = "# CodeOS BLOCK START";
        var markerEnd = "# CodeOS BLOCK END";
        var lines = File.ReadAllLines(hostsPath).ToList();
        bool changed = false;

        while (true)
        {
            var startIdx = lines.FindIndex(l => l.Trim() == markerStart);
            var endIdx = startIdx >= 0
                ? lines.FindIndex(startIdx + 1, l => l.Trim() == markerEnd)
                : -1;
            if (startIdx < 0 || endIdx < 0)
                break;
            lines.RemoveRange(startIdx, endIdx - startIdx + 1);
            changed = true;
        }
        if (changed)
            AtomicWriteLines(hostsPath, lines);
    }

    private static void AtomicWriteLines(string path, IEnumerable<string> lines)
        => AtomicWriteText(path, string.Join(Environment.NewLine, lines) + Environment.NewLine);

    private static void AtomicWriteText(string path, string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temp = $"{path}.tmp.{Environment.ProcessId}.{Guid.NewGuid():N}";
        try
        {
            File.WriteAllText(temp, content, new UTF8Encoding(false));
            if (File.Exists(path) && OperatingSystem.IsLinux())
                File.SetUnixFileMode(temp, File.GetUnixFileMode(path));
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp))
                File.Delete(temp);
        }
    }

    private static string RemoveBrowserPolicies()
    {
        BrowserPolicyInstaller.Remove();
        return "CodeOS가 추가한 브라우저 정책을 제거했습니다.";
    }
}
// 프로세스 가드. 브라우저별 확장 설치 여부와 무관하게 동작하므로 Firefox
// Stable처럼 unsigned XPI를 거부하는 브라우저도 동일하게 차단된다.
internal static class BrowserGuard
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(500);

    // Chromium 계열은 이 목록에 있는 실행 파일만 허용한다. 이 목록은
    // 사이트 목록이 아니라 브라우저 엔진/배포판 목록이므로 새 브라우저를
    // 추가해도 차단 로직 자체를 바꿀 필요가 없다.
    private static readonly HashSet<string> ChromiumBrowserNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "chrome", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"
    };

    // Linux 패키지/배포판별로 실제 프로세스 이름이 조금씩 다르므로
    // 대표적인 비-Chromium 브라우저와 그 변형을 함께 식별한다.
    private static readonly HashSet<string> NonChromiumBrowserNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "firefox", "firefox-bin", "firefox.real", "firefox-esr", "librewolf", "waterfox",
        "palemoon", "icecat", "seamonkey", "floorp", "zen", "tor-browser", "torbrowser",
        "epiphany", "epiphany-browser", "gnome-web", "midori", "falkon", "konqueror",
        "qutebrowser", "dillo", "netsurf", "surf"
    };

    public static async Task RunAsync()
    {
        while (true)
        {
            try
            {
                EnforceNow();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"비-Chromium 브라우저 감시 오류: {ex.Message}");
            }

            await Task.Delay(PollInterval);
        }
    }

    public static void EnforceNow()
    {
        foreach (var process in Process.GetProcesses())
        {
            try
            {
                if (process.Id == Environment.ProcessId || process.HasExited)
                    continue;

                string name = process.ProcessName;
                if (!IsNonChromiumBrowser(name))
                    continue;

                try
                {
                    process.Kill(entireProcessTree: true);
                    Console.WriteLine($"비-Chromium 브라우저를 종료했습니다: {name} (PID {process.Id})");
                }
                catch (InvalidOperationException)
                {
                    // 검사와 종료 사이에 이미 종료된 경우다.
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"브라우저 종료 실패 ({name}, PID {process.Id}): {ex.Message}");
                }
            }
            catch (InvalidOperationException)
            {
                // 프로세스가 검사 도중 종료된 경우다.
            }
            catch (ArgumentException)
            {
                // 프로세스 정보가 이미 사라진 경우다.
            }
            finally
            {
                process.Dispose();
            }
        }
    }

    private static bool IsNonChromiumBrowser(string processName)
    {
        if (ChromiumBrowserNames.Contains(processName))
            return false;

        if (NonChromiumBrowserNames.Contains(processName))
            return true;

        // Firefox 실행 파일의 패키지별 변형(예: snap-firefox)을 허용하지
        // 않는다. Chromium 이름은 위 허용 목록에 먼저 걸러진다.
        return processName.StartsWith("firefox", StringComparison.OrdinalIgnoreCase)
               || processName.StartsWith("librewolf", StringComparison.OrdinalIgnoreCase)
               || processName.StartsWith("waterfox", StringComparison.OrdinalIgnoreCase);
    }
}

internal static class DomainRules
{
    private static readonly IdnMapping Idn = new();

    public static bool TryNormalize(string? input, out string domain)
    {
        domain = "";
        if (string.IsNullOrWhiteSpace(input))
            return false;

        string value = input.Trim();
        if (value.Contains('\0') || value.Any(char.IsWhiteSpace))
            return false;

        if (Uri.TryCreate(value, UriKind.Absolute, out var absolute)
            && !string.IsNullOrEmpty(absolute.Host))
        {
            value = absolute.Host;
        }
        else
        {
            value = value.TrimEnd('/');
            int slash = value.IndexOf('/');
            if (slash >= 0)
                value = value[..slash];
            int colon = value.LastIndexOf(':');
            if (colon > 0 && value[(colon + 1)..].All(char.IsDigit))
                value = value[..colon];
        }

        value = value.Trim().TrimEnd('.').ToLowerInvariant();
        while (value.StartsWith("www.", StringComparison.Ordinal))
            value = value[4..];

        if (value is "localhost" or "127.0.0.1" or "::1" || value.Length == 0)
            return false;

        if (IPAddress.TryParse(value, out _))
            return false;

        try
        {
            value = Idn.GetAscii(value).ToLowerInvariant();
        }
        catch (ArgumentException)
        {
            return false;
        }

        if (value.Length > 253 || value.StartsWith('.') || value.EndsWith('.') || !value.Contains('.'))
            return false;

        var labels = value.Split('.');
        if (labels.Any(label => label.Length is < 1 or > 63
                               || label[0] == '-'
                               || label[^1] == '-'
                               || label.Any(c => !(char.IsAsciiLetterOrDigit(c) || c == '-'))))
            return false;

        domain = value;
        return true;
    }
}

internal static class BrowserPolicyInstaller
{
    private const string InstallRoot = "/opt/codeos/browser-extension";
    private const string CrxVersion = "2.0.0";
    private const string FirefoxExtensionId = "codeos@codeos.local";
    private const string ChromiumSnapArtifactsMarker = "chromium-snap-artifacts.path";
    private const string ChromiumSnapPolicyPath = "/var/snap/chromium/current/policies/managed/codeos.json";
    private const string BraveSnapArtifactsMarker = "brave-snap-artifacts.path";
    private const string FirefoxSnapArtifactsMarker = "firefox-snap-artifacts.path";
    private const string FirefoxSnapPolicyDirectory = "/etc/firefox/policies";

    public static bool Install()
    {
        try
        {
            string source = PrepareSourceDirectory();
            string zipPath = Path.Combine(InstallRoot, "codeos-extension.zip");
            string crxPath = Path.Combine(InstallRoot, "codeos-extension.crx");
            string xpiPath = Path.Combine(InstallRoot, "codeos-extension.xpi");
            string keyPath = Path.Combine(InstallRoot, "codeos-extension-key.pem");

            using var rsa = LoadOrCreateKey(keyPath);
            string extensionId = GetChromeExtensionId(rsa.ExportSubjectPublicKeyInfo());
            CreateZip(source, zipPath);
            CreateCrx3(rsa, zipPath, crxPath);
            File.Copy(zipPath, xpiPath, overwrite: true);
            CreateChromeUpdateManifest(extensionId, crxPath);

            if (CommandExists("google-chrome") || CommandExists("google-chrome-stable"))
                InstallChromiumPolicy(extensionId, "chrome", "/etc/opt/chrome/policies/managed/codeos.json",
                    ["/opt/google/chrome/extensions", "/usr/share/google-chrome/extensions"]);

            if (CommandExists("chromium") || CommandExists("chromium-browser"))
            {
                string chromiumCommand = CommandExists("chromium") ? "chromium" : "chromium-browser";
                if (IsSnapCommand(chromiumCommand))
                    InstallChromiumSnapPolicy(extensionId, crxPath);
                else
                    InstallChromiumPolicy(extensionId, "chromium", "/etc/chromium/policies/managed/codeos.json",
                        ["/usr/share/chromium/extensions", "/opt/chromium/extensions"]);
            }

            if (CommandExists("microsoft-edge"))
                InstallChromiumPolicy(extensionId, "edge", "/etc/opt/edge/policies/managed/codeos.json",
                    ["/opt/microsoft/microsoft-edge/extensions", "/usr/share/microsoft-edge/extensions"]);

            if (CommandExists("brave") || CommandExists("brave-browser"))
            {
                string braveCommand = CommandExists("brave") ? "brave" : "brave-browser";
                if (IsSnapCommand(braveCommand))
                    InstallBraveSnapPolicy(extensionId, crxPath);
                else
                    InstallChromiumPolicy(extensionId, "brave", "/etc/brave/policies/managed/codeos.json",
                        ["/opt/brave.com/brave/extensions", "/usr/share/brave/extensions"]);
            }

            // 일반 Firefox는 Mozilla 서명 없는 XPI를 거부하므로 확장을
            // 강제 설치하지 않는다. 기존 CodeOS Firefox 정책이 있다면
            // 제거하고, BrowserGuard가 Firefox 프로세스 자체를 종료해
            // 화이트리스트 정책 우회를 막는다.
            RemoveFirefoxSnapArtifacts();
            RemoveFirefoxPolicy(FirefoxExtensionId);

            Console.WriteLine("Chromium 브라우저 확장 및 정책 설치를 확인했습니다.");
            return true;
        }
        catch (Exception ex)
        {
            // 브라우저가 없거나 정책 디렉터리가 지원되지 않아도 hosts fallback은 계속 사용할 수 있다.
            Console.WriteLine($"브라우저 확장 설치를 건너뜁니다: {ex.Message}");
            return false;
        }
    }

    public static void Remove()
    {
        try
        {
            string? extensionId = FindChromeExtensionId();
            if (extensionId != null)
            {
                foreach (var path in new[]
                {
                    "/etc/opt/chrome/policies/managed/codeos.json",
                    "/etc/chromium/policies/managed/codeos.json",
                    ChromiumSnapPolicyPath,
                    "/etc/opt/edge/policies/managed/codeos.json",
                    "/etc/brave/policies/managed/codeos.json"
                })
                {
                    RemovePolicyEntry(path, "ExtensionSettings", extensionId);
                    RemovePolicyListEntry(path, "ExtensionInstallForcelist", extensionId);
                }

                foreach (var directory in new[]
                {
                    "/opt/google/chrome/extensions", "/usr/share/google-chrome/extensions",
                    "/usr/share/chromium/extensions", "/opt/chromium/extensions",
                    "/opt/microsoft/microsoft-edge/extensions", "/usr/share/microsoft-edge/extensions",
                    "/opt/brave.com/brave/extensions", "/usr/share/brave/extensions"
                })
                    RemoveOwnedExternalExtension(directory, extensionId);
            }

            RemoveChromiumSnapArtifacts();
            RemoveBraveSnapArtifacts();
            RemoveFirefoxSnapArtifacts();
            RemoveFirefoxPolicy(FirefoxExtensionId);
            Console.WriteLine("CodeOS가 추가한 브라우저 정책만 제거했습니다.");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"브라우저 정책 제거 실패: {ex.Message}");
        }
    }

    private static string PrepareSourceDirectory()
    {
        string? source = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "browser-extension"),
            Path.Combine(Directory.GetCurrentDirectory(), "browser-extension"),
            Path.Combine(InstallRoot, "source")
        }.FirstOrDefault(path => File.Exists(Path.Combine(path, "manifest.json"))
                                && File.Exists(Path.Combine(path, "background.js"))
                                && File.Exists(Path.Combine(path, "guard.js")));
        if (source == null)
            throw new FileNotFoundException("browser-extension/manifest.json을 찾을 수 없습니다.");

        string target = Path.Combine(InstallRoot, "source");
        Directory.CreateDirectory(target);
        if (!Path.GetFullPath(source).Equals(Path.GetFullPath(target), StringComparison.Ordinal))
        {
            File.Copy(Path.Combine(source, "manifest.json"), Path.Combine(target, "manifest.json"), true);
            File.Copy(Path.Combine(source, "background.js"), Path.Combine(target, "background.js"), true);
            File.Copy(Path.Combine(source, "guard.js"), Path.Combine(target, "guard.js"), true);
        }
        return target;
    }

    private static RSA LoadOrCreateKey(string path)
    {
        var rsa = RSA.Create(2048);
        if (File.Exists(path))
        {
            rsa.ImportFromPem(File.ReadAllText(path));
            return rsa;
        }

        string pem = rsa.ExportRSAPrivateKeyPem();
        AtomicWrite(path, pem);
        if (OperatingSystem.IsLinux())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        return rsa;
    }

    private static string GetChromeExtensionId(byte[] publicKey)
    {
        byte[] hash = SHA256.HashData(publicKey);
        var id = new StringBuilder(32);
        foreach (byte b in hash[..16])
        {
            id.Append((char)('a' + (b >> 4)));
            id.Append((char)('a' + (b & 0x0f)));
        }
        return id.ToString();
    }

    private static void CreateZip(string source, string zipPath)
    {
        string temp = $"{zipPath}.tmp.{Guid.NewGuid():N}";
        ZipFile.CreateFromDirectory(source, temp, CompressionLevel.Optimal, includeBaseDirectory: false);
        File.Move(temp, zipPath, true);
    }

    private static void CreateCrx3(RSA rsa, string zipPath, string crxPath)
    {
        byte[] archive = File.ReadAllBytes(zipPath);
        byte[] publicKey = rsa.ExportSubjectPublicKeyInfo();
        byte[] crxId = SHA256.HashData(publicKey)[..16];
        byte[] signedHeaderData = ProtoBytes(1, crxId);
        byte[] signedMessage = Encoding.ASCII.GetBytes("CRX3 SignedData\0")
            .Concat(BitConverter.GetBytes(signedHeaderData.Length))
            .Concat(signedHeaderData)
            .Concat(archive)
            .ToArray();
        byte[] signature = rsa.SignData(signedMessage, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
        byte[] proof = ProtoBytes(1, publicKey).Concat(ProtoBytes(2, signature)).ToArray();
        byte[] header = ProtoBytes(2, proof).Concat(ProtoBytes(10000, signedHeaderData)).ToArray();

        string temp = $"{crxPath}.tmp.{Guid.NewGuid():N}";
        using (var stream = File.Create(temp))
        using (var writer = new BinaryWriter(stream))
        {
            writer.Write(Encoding.ASCII.GetBytes("Cr24"));
            writer.Write(3);
            writer.Write(header.Length);
            writer.Write(header);
            writer.Write(archive);
        }
        File.Move(temp, crxPath, true);
    }

    private static byte[] ProtoBytes(int field, byte[] value)
    {
        using var stream = new MemoryStream();
        WriteVarint(stream, (ulong)((field << 3) | 2));
        WriteVarint(stream, (ulong)value.Length);
        stream.Write(value);
        return stream.ToArray();
    }

    private static void WriteVarint(Stream stream, ulong value)
    {
        while (value >= 0x80)
        {
            stream.WriteByte((byte)((value & 0x7f) | 0x80));
            value >>= 7;
        }
        stream.WriteByte((byte)value);
    }

    private static void CreateChromeUpdateManifest(string extensionId, string crxPath, string? manifestPath = null)
    {
        string path = manifestPath ?? Path.Combine(InstallRoot, "updates.xml");
        string xml = $"<?xml version=\"1.0\" encoding=\"UTF-8\"?><gupdate xmlns=\"http://www.google.com/update2/response\" protocol=\"2.0\"><app appid=\"{extensionId}\"><updatecheck codebase=\"file://{crxPath}\" version=\"{CrxVersion}\" /></app></gupdate>\n";
        AtomicWrite(path, xml);
    }

    private static void InstallChromiumPolicy(
        string extensionId,
        string browser,
        string policyPath,
        string[] externalDirectories,
        string? updateManifestPath = null)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(policyPath)!);
        string updateUrl = $"file://{updateManifestPath ?? Path.Combine(InstallRoot, "updates.xml")}";
        MergePolicyEntry(policyPath, "ExtensionSettings", extensionId, new JsonObject
        {
            ["installation_mode"] = "force_installed",
            ["update_url"] = updateUrl,
            ["override_update_url"] = true
        });
        MarkPolicy(policyPath, extensionId);
        // Chromium Snap/최신 Chromium에서 ExtensionSettings의 로컬 CRX
        // 설치가 누락되는 경우를 대비해 공식 레거시 강제 설치 정책도
        // 함께 기록한다. 두 정책은 같은 확장 ID를 가리킨다.
        MergePolicyListEntry(policyPath, "ExtensionInstallForcelist", extensionId, updateUrl);
        MarkPolicy(policyPath, $"ExtensionInstallForcelist|{extensionId}");

        string externalJson = Path.Combine(InstallRoot, $"{browser}-{extensionId}.json");
        AtomicWrite(externalJson, JsonSerializer.Serialize(new
        {
            external_crx = Path.Combine(InstallRoot, "codeos-extension.crx"),
            external_version = CrxVersion
        }) + "\n");

        foreach (string directory in externalDirectories)
        {
            try
            {
                Directory.CreateDirectory(directory);
                string destination = Path.Combine(directory, extensionId + ".json");
                if (!File.Exists(destination))
                {
                    AtomicWrite(destination, File.ReadAllText(externalJson));
                    AtomicWrite(Path.Combine(InstallRoot, $"owned-{MarkerKey(directory)}.marker"), destination);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"{browser} 확장 경로 {directory}는 사용할 수 없습니다: {ex.Message}");
            }
        }
    }

    private static void InstallBraveSnapPolicy(string extensionId, string crxPath)
    {
        string? artifacts = GetMarkedSnapArtifacts(BraveSnapArtifactsMarker);
        if (artifacts == null
            || !artifacts.Contains("/snap/brave/common/", StringComparison.Ordinal))
        {
            // 이전 버전의 ~/.local/share 경로는 Brave Snap의 AppArmor에
            // 의해 차단될 수 있으므로 기존 산출물을 정리한다.
            RemoveBraveSnapArtifacts();
            string? home = GetInteractiveUserHome();
            if (home == null)
                throw new InvalidOperationException("Brave Snap 확장을 설치할 사용자 홈 디렉터리를 찾을 수 없습니다.");
            artifacts = Path.Combine(home, "snap", "brave", "common", "codeos-extension");
        }

        // Snap은 /opt/codeos를 볼 수 없을 수 있으므로 홈 디렉터리 아래에
        // Brave가 읽을 수 있는 CRX와 업데이트 manifest를 별도로 둔다.
        Directory.CreateDirectory(artifacts);
        string snapCrxPath = Path.Combine(artifacts, "codeos-extension.crx");
        string snapManifestPath = Path.Combine(artifacts, "updates.xml");
        File.Copy(crxPath, snapCrxPath, overwrite: true);
        CreateChromeUpdateManifest(extensionId, snapCrxPath, snapManifestPath);
        SetSnapArtifactOwner(artifacts, snapCrxPath, snapManifestPath);
        AtomicWrite(Path.Combine(InstallRoot, BraveSnapArtifactsMarker), artifacts + "\n");

        InstallChromiumPolicy(extensionId, "brave", "/etc/brave/policies/managed/codeos.json",
            [], snapManifestPath);
    }

    private static void InstallChromiumSnapPolicy(string extensionId, string crxPath)
    {
        // Snap Chromium은 호스트의 /etc/chromium/policies를 읽지 않는다.
        // 이전 버전이 남긴 정책은 제거해 두 정책이 서로 충돌하지 않게 한다.
        const string legacyPolicyPath = "/etc/chromium/policies/managed/codeos.json";
        RemovePolicyEntry(legacyPolicyPath, "ExtensionSettings", extensionId);
        RemovePolicyListEntry(legacyPolicyPath, "ExtensionInstallForcelist", extensionId);

        string? artifacts = GetMarkedSnapArtifacts(ChromiumSnapArtifactsMarker);
        if (artifacts == null
            || !artifacts.Contains("/snap/chromium/common/chromium/", StringComparison.Ordinal))
        {
            // Chromium Snap은 common 아래에서도 실제 Chromium 프로필 데이터
            // 경로만 허용한다. 그 밖의 common 하위 경로는 AppArmor에 막힐 수
            // 있으므로 기존 산출물을 제거하고 프로필 데이터 아래를 사용한다.
            RemoveChromiumSnapArtifacts();
            string? home = GetInteractiveUserHome();
            if (home == null)
                throw new InvalidOperationException("Chromium Snap 확장을 설치할 사용자 홈 디렉터리를 찾을 수 없습니다.");
            artifacts = Path.Combine(home, "snap", "chromium", "common", "chromium", "CodeOS");
        }

        // Snap Chromium은 /opt/codeos를 확장 업데이트 경로로 읽지 못할 수
        // 있으므로 Snap이 접근 가능한 사용자 홈에 CRX와 manifest를 둔다.
        Directory.CreateDirectory(artifacts);
        string snapCrxPath = Path.Combine(artifacts, "codeos-extension.crx");
        string snapManifestPath = Path.Combine(artifacts, "updates.xml");
        File.Copy(crxPath, snapCrxPath, overwrite: true);
        CreateChromeUpdateManifest(extensionId, snapCrxPath, snapManifestPath);
        SetSnapArtifactOwner(artifacts, snapCrxPath, snapManifestPath);
        AtomicWrite(Path.Combine(InstallRoot, ChromiumSnapArtifactsMarker), artifacts + "\n");

        InstallChromiumPolicy(extensionId, "chromium", ChromiumSnapPolicyPath,
            [], snapManifestPath);
    }

    private static void RemoveChromiumSnapArtifacts()
    {
        string marker = Path.Combine(InstallRoot, ChromiumSnapArtifactsMarker);
        if (!File.Exists(marker))
            return;

        string artifacts = File.ReadAllText(marker).Trim();
        if (!string.IsNullOrWhiteSpace(artifacts))
        {
            foreach (string name in new[] { "codeos-extension.crx", "updates.xml" })
            {
                string path = Path.Combine(artifacts, name);
                if (File.Exists(path)) File.Delete(path);
            }
        }

        File.Delete(marker);
    }

    private static void RemoveBraveSnapArtifacts()
    {
        string marker = Path.Combine(InstallRoot, BraveSnapArtifactsMarker);
        if (!File.Exists(marker))
            return;

        string artifacts = File.ReadAllText(marker).Trim();
        if (!string.IsNullOrWhiteSpace(artifacts))
        {
            foreach (string name in new[] { "codeos-extension.crx", "updates.xml" })
            {
                string path = Path.Combine(artifacts, name);
                if (File.Exists(path)) File.Delete(path);
            }
        }

        File.Delete(marker);
    }

    private static string? GetInteractiveUserHome()
    {
        string? user = GetInteractiveUserName();
        if (user == null)
            return null;

        try
        {
            var startInfo = new ProcessStartInfo("getent")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            startInfo.ArgumentList.Add("passwd");
            startInfo.ArgumentList.Add(user);
            using var process = Process.Start(startInfo);
            if (process == null) return null;
            string line = process.StandardOutput.ReadToEnd();
            process.WaitForExit();
            var fields = line.Trim().Split(':');
            return fields.Length > 5 && Directory.Exists(fields[5]) ? fields[5] : null;
        }
        catch
        {
            return null;
        }
    }

    private static string? GetInteractiveUserName()
    {
        string user = Environment.GetEnvironmentVariable("SUDO_USER")
                      ?? Environment.GetEnvironmentVariable("USER")
                      ?? "";
        return !string.IsNullOrWhiteSpace(user)
               && user.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.')
            ? user
            : null;
    }

    private static void SetSnapArtifactOwner(string artifacts, params string[] paths)
    {
        // systemd 서비스는 root로 실행되므로, Chromium Snap의 owner 기반
        // AppArmor 규칙을 통과하려면 산출물을 실제 데스크톱 사용자 소유로
        // 바꿔야 한다. 기존 marker 경로에서 사용자를 복원할 수도 있다.
        string? user = GetInteractiveUserName();
        if (user == null || user == "root")
        {
            string[] parts = artifacts.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length >= 2
                && parts[0].Equals("home", StringComparison.Ordinal)
                && parts[1].All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.'))
                user = parts[1];
        }

        if (string.IsNullOrWhiteSpace(user) || user == "root")
            throw new InvalidOperationException("Snap 확장 파일의 소유자로 지정할 일반 사용자를 찾을 수 없습니다.");

        Chown(user, artifacts);
        foreach (string path in paths)
            Chown(user, path);
    }

    private static void Chown(string user, string path)
    {
        using var process = new Process();
        process.StartInfo.FileName = "chown";
        process.StartInfo.ArgumentList.Add(user);
        process.StartInfo.ArgumentList.Add(path);
        process.StartInfo.UseShellExecute = false;
        process.StartInfo.RedirectStandardError = true;
        process.Start();
        string error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"Snap 확장 파일 소유권 변경 실패: {error.Trim()}");
    }

    private static void InstallFirefoxPolicy(string xpiPath)
    {
        string path = "/etc/firefox/policies/policies.json";
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        MergeFirefoxPolicyEntry(path, FirefoxExtensionId, new JsonObject
        {
            ["installation_mode"] = "force_installed",
            ["install_url"] = $"file://{xpiPath}"
        });
        MarkPolicy(path, FirefoxExtensionId);
    }

    private static void InstallFirefoxSnapPolicy(string xpiPath)
    {
        // Firefox Snap은 최신 버전에서 홈/opt 아래의 XPI를 정책 설치 대상으로
        // 읽지 못할 수 있다. 정책 파일을 읽는 동일한 디렉터리를 사용한다.
        RemoveFirefoxSnapArtifacts();
        string artifacts = FirefoxSnapPolicyDirectory;

        Directory.CreateDirectory(artifacts);
        string snapXpiPath = Path.Combine(artifacts, "codeos-extension.xpi");
        File.Copy(xpiPath, snapXpiPath, overwrite: true);
        AtomicWrite(Path.Combine(InstallRoot, FirefoxSnapArtifactsMarker), artifacts + "\n");

        InstallFirefoxPolicy(snapXpiPath);
    }

    private static string? GetMarkedSnapArtifacts(string markerName)
    {
        string marker = Path.Combine(InstallRoot, markerName);
        if (!File.Exists(marker))
            return null;

        string path = File.ReadAllText(marker).Trim();
        return path.StartsWith("/home/", StringComparison.Ordinal)
               && Directory.Exists(path)
            ? path
            : null;
    }

    private static void RemoveFirefoxSnapArtifacts()
    {
        string marker = Path.Combine(InstallRoot, FirefoxSnapArtifactsMarker);
        if (!File.Exists(marker))
            return;

        string artifacts = File.ReadAllText(marker).Trim();
        if (!string.IsNullOrWhiteSpace(artifacts))
        {
            string path = Path.Combine(artifacts, "codeos-extension.xpi");
            if (File.Exists(path)) File.Delete(path);
        }

        File.Delete(marker);
    }

    private static void MergePolicyEntry(string path, string section, string key, JsonObject value)
    {
        JsonObject root;
        if (File.Exists(path))
        {
            try { root = JsonNode.Parse(File.ReadAllText(path))?.AsObject() ?? new JsonObject(); }
            catch (JsonException) { throw new InvalidDataException($"정책 JSON이 손상되어 덮어쓰지 않았습니다: {path}"); }
        }
        else
            root = new JsonObject();

        if (root[section] is JsonNode existingSection && existingSection is not JsonObject)
            throw new InvalidDataException($"정책의 {section} 항목이 객체가 아니어서 덮어쓰지 않았습니다: {path}");
        var sectionNode = root[section] as JsonObject ?? new JsonObject();
        if (sectionNode[key] is JsonNode existingValue
            && existingValue.ToJsonString() != value.ToJsonString()
            && !IsPolicyOwned(path, key))
            throw new InvalidDataException($"정책에 같은 확장 ID가 있어 덮어쓰지 않았습니다: {path}");
        sectionNode[key] = value;
        root[section] = sectionNode;
        AtomicWrite(path, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
    }

    private static void RemovePolicyEntry(string path, string section, string key)
    {
        if (!File.Exists(path) || !IsPolicyOwned(path, key))
            return;
        JsonObject root;
        try { root = JsonNode.Parse(File.ReadAllText(path))?.AsObject() ?? new JsonObject(); }
        catch (JsonException) { return; }
        if (root[section] is not JsonObject settings || settings.Remove(key) == false)
            return;
        if (settings.Count == 0) root.Remove(section);
        AtomicWrite(path, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
        RemovePolicyMarker(path, key);
    }

    private static void MergePolicyListEntry(string path, string section, string extensionId, string updateUrl)
    {
        string value = $"{extensionId};{updateUrl}";
        JsonObject root;
        if (File.Exists(path))
        {
            try { root = JsonNode.Parse(File.ReadAllText(path))?.AsObject() ?? new JsonObject(); }
            catch (JsonException) { throw new InvalidDataException($"정책 JSON이 손상되어 덮어쓰지 않았습니다: {path}"); }
        }
        else
            root = new JsonObject();

        if (root[section] is JsonNode existingSection && existingSection is not JsonArray)
            throw new InvalidDataException($"정책의 {section} 항목이 배열이 아니어서 덮어쓰지 않았습니다: {path}");

        var entries = root[section] as JsonArray ?? new JsonArray();
        bool found = false;
        for (int i = 0; i < entries.Count; i++)
        {
            if (entries[i] is not JsonValue jsonValue
                || !jsonValue.TryGetValue<string>(out string? existing)
                || !TryGetExtensionId(existing, out string existingId)
                || !existingId.Equals(extensionId, StringComparison.OrdinalIgnoreCase))
                continue;

            if (existing != value && !IsPolicyOwned(path, $"{section}|{extensionId}"))
                throw new InvalidDataException($"정책에 같은 확장 ID가 있어 덮어쓰지 않았습니다: {path}");

            entries[i] = value;
            found = true;
            break;
        }

        if (!found)
            entries.Add(value);

        root[section] = entries;
        AtomicWrite(path, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
    }

    private static void RemovePolicyListEntry(string path, string section, string extensionId)
    {
        string markerKey = $"{section}|{extensionId}";
        if (!File.Exists(path) || !IsPolicyOwned(path, markerKey))
            return;

        JsonObject root;
        try { root = JsonNode.Parse(File.ReadAllText(path))?.AsObject() ?? new JsonObject(); }
        catch (JsonException) { return; }
        if (root[section] is not JsonArray entries)
            return;

        for (int i = entries.Count - 1; i >= 0; i--)
        {
            if (entries[i] is JsonValue jsonValue
                && jsonValue.TryGetValue<string>(out string? existing)
                && TryGetExtensionId(existing, out string existingId)
                && existingId.Equals(extensionId, StringComparison.OrdinalIgnoreCase))
                entries.RemoveAt(i);
        }

        if (entries.Count == 0)
            root.Remove(section);
        AtomicWrite(path, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
        RemovePolicyMarker(path, markerKey);
    }

    private static bool TryGetExtensionId(string value, out string extensionId)
    {
        int separator = value.IndexOf(';');
        extensionId = (separator >= 0 ? value[..separator] : value).Trim();
        return extensionId.Length > 0;
    }

    private static void RemoveFirefoxPolicy(string extensionId)
    {
        const string path = "/etc/firefox/policies/policies.json";
        if (!File.Exists(path)) return;
        JsonObject root;
        try { root = JsonNode.Parse(File.ReadAllText(path))?.AsObject() ?? new JsonObject(); }
        catch (JsonException) { return; }
        if (!IsPolicyOwned(path, extensionId)) return;
        if (root["policies"] is not JsonObject policies
            || policies["ExtensionSettings"] is not JsonObject settings
            || !settings.Remove(extensionId))
            return;
        if (settings.Count == 0) policies.Remove("ExtensionSettings");
        AtomicWrite(path, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
        RemovePolicyMarker(path, extensionId);
    }

    private static void MergeFirefoxPolicyEntry(string path, string key, JsonObject value)
    {
        JsonObject root;
        if (File.Exists(path))
        {
            try { root = JsonNode.Parse(File.ReadAllText(path))?.AsObject() ?? new JsonObject(); }
            catch (JsonException) { throw new InvalidDataException($"정책 JSON이 손상되어 덮어쓰지 않았습니다: {path}"); }
        }
        else
            root = new JsonObject();

        if (root["policies"] is JsonNode existingPolicies && existingPolicies is not JsonObject)
            throw new InvalidDataException($"Firefox 정책의 policies 항목이 객체가 아니어서 덮어쓰지 않았습니다: {path}");
        var policies = root["policies"] as JsonObject ?? new JsonObject();
        if (policies["ExtensionSettings"] is JsonNode existingSettings
            && existingSettings is not JsonObject)
            throw new InvalidDataException($"Firefox 정책의 ExtensionSettings 항목이 객체가 아니어서 덮어쓰지 않았습니다: {path}");
        var settings = policies["ExtensionSettings"] as JsonObject ?? new JsonObject();
        if (settings[key] is JsonNode existingValue
            && existingValue.ToJsonString() != value.ToJsonString()
            && !IsPolicyOwned(path, key))
            throw new InvalidDataException($"Firefox 정책에 같은 확장 ID가 있어 덮어쓰지 않았습니다: {path}");
        settings[key] = value;
        policies["ExtensionSettings"] = settings;
        root["policies"] = policies;
        AtomicWrite(path, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
    }

    private static string? FindChromeExtensionId()
    {
        try
        {
            string source = PrepareSourceDirectory();
            using var rsa = LoadOrCreateKey(Path.Combine(InstallRoot, "codeos-extension-key.pem"));
            return GetChromeExtensionId(rsa.ExportSubjectPublicKeyInfo());
        }
        catch { return null; }
    }

    private static string PolicyMarker(string path, string key)
        => Path.Combine(InstallRoot, $"policy-{MarkerKey(path + "|" + key)}.marker");

    private static void MarkPolicy(string path, string key)
        => AtomicWrite(PolicyMarker(path, key), path);

    private static bool IsPolicyOwned(string path, string key)
        => File.Exists(PolicyMarker(path, key));

    private static void RemovePolicyMarker(string path, string key)
    {
        string marker = PolicyMarker(path, key);
        if (File.Exists(marker)) File.Delete(marker);
    }

    private static void RemoveOwnedExternalExtension(string directory, string extensionId)
    {
        string path = Path.Combine(directory, extensionId + ".json");
        if (!File.Exists(path)) return;
        // 외부 확장 JSON은 CodeOS가 새로 만든 경우에만 제거한다.
        if (File.Exists(Path.Combine(InstallRoot, $"owned-{MarkerKey(directory)}.marker")))
            File.Delete(path);
    }

    private static string MarkerKey(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..16];

    private static bool CommandExists(string command)
        => FindCommandPath(command) != null;

    private static bool IsSnapCommand(string command)
    {
        string? path = FindCommandPath(command);
        if (path?.StartsWith("/snap/bin/", StringComparison.Ordinal) == true)
            return true;

        // Ubuntu의 /usr/bin/firefox는 /snap/bin/firefox를 실행하는 wrapper일 수 있다.
        return command.Equals("firefox", StringComparison.Ordinal)
               && path != null
               && File.Exists("/snap/bin/firefox")
               && File.ReadAllText(path).Contains("/snap/bin/firefox", StringComparison.Ordinal);
    }

    private static string? FindCommandPath(string command)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo("which", command)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            });
            if (process == null) return null;
            string path = process.StandardOutput.ReadToEnd().Trim();
            process.WaitForExit();
            return process.ExitCode == 0 && path.Length > 0 ? path : null;
        }
        catch { return null; }
    }

    private static void AtomicWrite(string path, string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temp = $"{path}.tmp.{Environment.ProcessId}.{Guid.NewGuid():N}";
        try
        {
            File.WriteAllText(temp, content, new UTF8Encoding(false));
            File.Move(temp, path, true);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
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
        "armorgames.com",
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

    public readonly record struct DetectionResult(
        bool IsGameSite,
        double Confidence,
        bool Succeeded,
        string? Error);

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
    public static async Task<DetectionResult> IsGameSiteAsync(string domain, string? title = null, string? description = null)
    {
        domain = NormalizeDomain(domain);

        // 대표 웹게임 포털은 캐시나 모델 판단보다 먼저 확정 처리한다.
        // 특히 예전에 false 로 저장된 캐시가 있어도 Poki 같은 사이트는 놓치지 않게 한다.
        if (IsKnownGamePortal(domain))
            return new DetectionResult(true, 1.0, true, null);

        // 이미 캐시에 저장된 도메인은 로컬 데이터를 우선 사용한다.
        if (TryGetCached(domain, out var cached))
            return new DetectionResult(cached.IsGameSite, cached.Confidence, true, null);

        bool isGameSite = false;
        double confidence = 0;
        try
        {
            (isGameSite, confidence) = await AskGroqAsync(domain, title, description);
        }
        catch (Exception ex)
        {
            // API 실패를 게임 사이트 아님(false)으로 위장하지 않는다.
            // 실패 결과도 캐시에 저장하지 않아 다음 요청에서 재시도한다.
            Console.WriteLine($"[GameDetector] Groq API 호출 실패 ({domain}): {ex.Message}");
            return new DetectionResult(false, 0, false, ex.Message);
        }

        SaveCache(domain, isGameSite, confidence);
        return new DetectionResult(isGameSite, confidence, true, null);
    }

    // ---------- Groq API 호출 (OpenAI 호환 /chat/completions) ----------
    // 모델에 프롬프트를 보내고, 반환된 JSON 응답을 파싱한다.
    private static async Task<(bool IsGameSite, double Confidence)> AskGroqAsync(string domain, string? title, string? description)
    {
        string apiKey = GetApiKey();
        if (string.IsNullOrEmpty(apiKey))
            throw new InvalidOperationException("GROQ_API_KEY가 설정되지 않았습니다.");

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
            max_completion_tokens = 128,
            reasoning_effort = "low",
            reasoning_format = "hidden",
            response_format = new { type = "json_object" }
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.groq.com/openai/v1/chat/completions");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        using var response = await Http.SendAsync(request);
        string responseBody = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            string detail = responseBody.Length > 600 ? responseBody[..600] : responseBody;
            throw new HttpRequestException($"Groq HTTP {(int)response.StatusCode}: {detail}");
        }

        // 응답에서 choices[0].message.content 만 추출해 파싱한다.
        using var doc = JsonDocument.Parse(responseBody);
        var content = doc.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString();
        return ParseResult(content);
    }

    // ---------- Groq 응답에서 JSON 파싱 ----------
    // 모델이 반환한 텍스트에서 is_game_site / confidence 값을 추출한다.
    // markdown 코드 블록 등이 붙어 있어도 첫 '{' ~ 마지막 '}' 만 추출해 파싱한다.
    private static (bool IsGameSite, double Confidence) ParseResult(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
            throw new InvalidDataException("Groq 응답이 비어 있습니다.");

        int start = text.IndexOf('{');
        int end = text.LastIndexOf('}');
        if (start < 0 || end <= start)
            throw new InvalidDataException("Groq 응답에 JSON 결과가 없습니다.");

        try
        {
            using var doc = JsonDocument.Parse(text.Substring(start, end - start + 1));
            if (!doc.RootElement.TryGetProperty("is_game_site", out var gameProp)
                || (gameProp.ValueKind != JsonValueKind.True && gameProp.ValueKind != JsonValueKind.False))
                throw new InvalidDataException("Groq 응답의 is_game_site 값이 올바르지 않습니다.");
            if (!doc.RootElement.TryGetProperty("confidence", out var confProp)
                || !confProp.TryGetDouble(out var conf)
                || conf is < 0 or > 1)
                throw new InvalidDataException("Groq 응답의 confidence 값이 올바르지 않습니다.");

            bool isGame = gameProp.GetBoolean();
            return (isGame, conf);
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException("Groq 응답 JSON을 파싱할 수 없습니다.", ex);
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
        return DomainRules.TryNormalize(domain, out var normalized) ? normalized : "";
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
