using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace CodeOS_setup;

// 설치된 CodeOS의 두 가지 실행 모드를 담당한다.
//
// - 서비스 모드(--service): root로 실행되며 화이트리스트 방화벽과 HTTP API를 제공한다.
// - CLI 모드(--cli 또는 일반 명령): 사용자의 명령을 검증하고 서비스에 전달한다.
//
// 실제 사용자가 호출할 수 있는 명령은 help, status, version, whitelist, password뿐이다.
// 서비스 동작에 필요한 --service와 --cli는 사용자 기능이 아니라 내부 진입점이므로 남긴다.
public static class BackgroundProgram
{
    private const string Version = "1.1";
    private const string ConfigDirectory = "/etc/codeos";
    private const string DataDirectory = "/var/lib/codeos";
    private const string ServiceTokenPath = ConfigDirectory + "/service.token";
    private const string WhitelistPath = DataDirectory + "/whitelist.txt";
    private const string WhitelistModePath = DataDirectory + "/whitelist-mode";
    private const string ServiceUrl = "http://127.0.0.1:5890/";

    // HashSet은 중복 도메인을 자동으로 제거하고, 비교는 대소문자를 구분하지 않는다.
    private static readonly HashSet<string> Whitelist = new(StringComparer.OrdinalIgnoreCase);
    private static readonly object PolicyLock = new();
    private static bool _whitelistEnabled;
    private static string _firewallStatus = "비활성화됨";

    // file-based 실행과 게시된 실행 파일 모두에서 사용할 수 있는 내부 진입점이다.
    public static async Task Main(string[] args)
    {
        if (args.Length > 0 && args[0].Equals("--service", StringComparison.Ordinal))
        {
            await RunService();
            return;
        }

        if (args.Length > 0 && args[0].Equals("--cli", StringComparison.Ordinal))
            args = args[1..];

        await HandleCli(args);
    }

    // root 서비스는 시작할 때 저장된 화이트리스트를 읽고 즉시 방화벽에 적용한다.
    // 설치되지 않은 개발 환경에서는 토큰 파일이 없으므로 로컬 요청을 허용한다.
    public static async Task RunService()
    {
        string configuredToken = Secrets.Read(ServiceTokenPath);
        string environmentToken = Environment.GetEnvironmentVariable("CODEOS_SERVICE_TOKEN") ?? "";
        if (!string.IsNullOrEmpty(configuredToken) && !Secrets.FixedEquals(environmentToken, configuredToken))
            throw new InvalidOperationException("CodeOS 서비스 토큰이 없습니다.");

        Storage.Directory(ConfigDirectory);
        Storage.Directory(DataDirectory);
        LoadWhitelist();
        await ApplyWhitelistPolicyAsync();

        using var listener = new HttpListener();
        listener.Prefixes.Add(ServiceUrl);
        listener.Start();
        Console.WriteLine("CodeOS 화이트리스트 서비스가 127.0.0.1:5890에서 실행 중입니다.");

        // DNS 주소가 바뀔 수 있으므로 화이트리스트가 켜져 있을 때 주기적으로 갱신한다.
        _ = RefreshFirewallAsync();
        while (true)
            _ = HandleRequestAsync(await listener.GetContextAsync());
    }

    // API는 localhost에서만 받고, 설치된 서비스에서는 별도의 비밀 토큰도 요구한다.
    private static async Task HandleRequestAsync(HttpListenerContext context)
    {
        bool isLocal = context.Request.RemoteEndPoint is { } remote
            && IPAddress.IsLoopback(remote.Address);
        string token = Secrets.Read(ServiceTokenPath);
        bool hasValidToken = string.IsNullOrEmpty(token)
            || Secrets.FixedEquals(context.Request.Headers["X-CodeOS-Service-Token"], token);

        if (!isLocal || !hasValidToken)
        {
            context.Response.StatusCode = 403;
            await WriteResponseAsync(context, "허용되지 않은 요청입니다.");
            return;
        }

        string[] parts = context.Request.Url!.AbsolutePath.Trim('/')
            .Split('/', StringSplitOptions.RemoveEmptyEntries);
        string result;
        try
        {
            result = await ExecuteServiceCommandAsync(parts);
        }
        catch (Exception exception)
        {
            result = "처리 중 오류가 발생했습니다: " + exception.Message;
        }

        await WriteResponseAsync(context, result);
    }

    // 서비스가 처리하는 명령은 상태 조회와 화이트리스트 조작만 남긴다.
    private static Task<string> ExecuteServiceCommandAsync(string[] parts)
    {
        if (parts.Length == 1 && parts[0].Equals("status", StringComparison.OrdinalIgnoreCase))
            return Task.FromResult(BuildStatus());

        if (parts.Length > 0 && parts[0].Equals("whitelist", StringComparison.OrdinalIgnoreCase))
            return WhitelistCommandAsync(parts);

        return Task.FromResult("알 수 없는 명령입니다.\n" + Usage());
    }

    // CLI는 비밀번호 인증을 통과한 뒤 허용된 명령만 서비스에 전달한다.
    public static async Task HandleCli(string[] args)
    {
        if (!IsRootProcess())
        {
            Console.Error.WriteLine("CodeOS CLI는 설치된 codeos 명령으로 실행해야 합니다.");
            return;
        }

        if (!AdministratorPassword.AuthenticateIfEnabled())
            return;

        if (args.Length == 0 || IsHelp(args[0]))
        {
            Console.WriteLine(Usage());
            return;
        }

        if (args[0].Equals("version", StringComparison.OrdinalIgnoreCase))
        {
            Console.WriteLine("CodeOS " + Version);
            return;
        }

        if (args[0].Equals("password", StringComparison.OrdinalIgnoreCase))
        {
            PasswordCommand(args);
            return;
        }

        string[] route = Route(args, out string? error);
        if (error != null)
        {
            Console.WriteLine(error);
            return;
        }

        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            string token = Secrets.Read(ServiceTokenPath);
            if (!string.IsNullOrEmpty(token))
                http.DefaultRequestHeaders.Add("X-CodeOS-Service-Token", token);

            using HttpResponseMessage response = await http.GetAsync(ServiceUrl + string.Join('/', route));
            Console.WriteLine(await response.Content.ReadAsStringAsync());
        }
        catch (HttpRequestException)
        {
            Console.WriteLine("CodeOS 백그라운드 서비스가 실행 중이지 않습니다.");
            Console.WriteLine("sudo systemctl start codeos 명령으로 서비스를 시작할 수 있습니다.");
        }
    }

    private static bool IsHelp(string command) => command is "help" or "--help" or "-h";

    // 외부로 전달하기 전 명령 구조를 고정한다. 도메인은 URL 경로에 들어가므로 이스케이프한다.
    private static string[] Route(string[] args, out string? error)
    {
        error = null;
        string command = args[0].ToLowerInvariant();
        bool valid = command switch
        {
            "status" when args.Length == 1 => true,
            "whitelist" when args.Length == 2
                && args[1].ToLowerInvariant() is "on" or "off" or "status" or "list" => true,
            "whitelist" when args.Length == 3
                && args[1].ToLowerInvariant() is "add" or "remove" => true,
            _ => false
        };

        if (!valid)
        {
            error = "알 수 없는 명령입니다.\n" + Usage();
            return [];
        }

        return args.Select(Uri.EscapeDataString).ToArray();
    }

    // password는 서비스가 없어도 변경할 수 있어 CLI에서 직접 처리한다.
    private static void PasswordCommand(string[] args)
    {
        if (args.Length != 2)
        {
            Console.WriteLine("사용법: codeos password {enable|disable|change}");
            return;
        }

        switch (args[1].ToLowerInvariant())
        {
            case "enable":
                if (AdministratorPassword.IsEnabled)
                    Console.WriteLine("CodeOS 관리자 비밀번호가 이미 활성화되어 있습니다.");
                else if (AdministratorPassword.SetFromPrompt())
                    Console.WriteLine("CodeOS 관리자 비밀번호를 활성화했습니다.");
                break;

            case "disable":
                if (!AdministratorPassword.IsEnabled)
                    Console.WriteLine("CodeOS 관리자 비밀번호가 이미 비활성화되어 있습니다.");
                else
                {
                    AdministratorPassword.Disable();
                    Console.WriteLine("CodeOS 관리자 비밀번호를 비활성화했습니다.");
                }
                break;

            case "change":
                if (!AdministratorPassword.IsEnabled)
                    Console.WriteLine("먼저 codeos password enable로 비밀번호를 활성화하세요.");
                else if (AdministratorPassword.SetFromPrompt())
                    Console.WriteLine("CodeOS 관리자 비밀번호를 변경했습니다.");
                break;

            default:
                Console.WriteLine("사용법: codeos password {enable|disable|change}");
                break;
        }
    }

    // whitelist의 on/off는 방화벽 사용 여부이고, add/remove/list는 저장 목록을 관리한다.
    private static async Task<string> WhitelistCommandAsync(string[] parts)
    {
        if (parts.Length < 2)
            return "사용법: codeos whitelist {on|off|status|add|remove|list} [도메인]";

        string action = parts[1].ToLowerInvariant();
        if (action == "status" && parts.Length == 2)
        {
            lock (PolicyLock)
                return "화이트리스트 모드: " + (_whitelistEnabled ? "ON" : "OFF")
                    + "\n허용 도메인 수: " + Whitelist.Count;
        }

        if (action == "list" && parts.Length == 2)
        {
            lock (PolicyLock)
                return FormatDomainList(Whitelist, "허용 목록");
        }

        if (action is "on" or "off")
        {
            if (parts.Length != 2)
                return "사용법: codeos whitelist {on|off|status|add|remove|list} [도메인]";

            bool previous;
            lock (PolicyLock)
            {
                previous = _whitelistEnabled;
                _whitelistEnabled = action == "on";
                Storage.Write(WhitelistModePath, _whitelistEnabled ? "on\n" : "off\n");
            }

            try
            {
                await ApplyWhitelistPolicyAsync();
                return _whitelistEnabled ? "화이트리스트 모드를 켰습니다." : "화이트리스트 모드를 껐습니다.";
            }
            catch
            {
                // 방화벽 적용에 실패하면 메모리와 디스크의 모드도 이전 값으로 되돌린다.
                lock (PolicyLock)
                {
                    _whitelistEnabled = previous;
                    Storage.Write(WhitelistModePath, previous ? "on\n" : "off\n");
                }
                throw;
            }
        }

        if (parts.Length != 3 || action is not ("add" or "remove")
            || !DomainRules.TryNormalize(Uri.UnescapeDataString(parts[2]), out string domain))
        {
            return "사용법: codeos whitelist {on|off|status|add|remove|list} [도메인]";
        }

        bool add = action == "add";
        lock (PolicyLock)
        {
            if (add && !Whitelist.Add(domain))
                return "'" + domain + "'은(는) 이미 허용 목록에 있습니다.";
            if (!add && !Whitelist.Remove(domain))
                return "'" + domain + "'은(는) 허용 목록에 없습니다.";
            SaveDomains(WhitelistPath, Whitelist);
        }

        try
        {
            bool enabled;
            lock (PolicyLock) enabled = _whitelistEnabled;
            if (enabled)
                await ApplyWhitelistPolicyAsync();
        }
        catch
        {
            // 목록 변경 뒤 방화벽 적용이 실패하면 목록도 원상 복구한다.
            lock (PolicyLock)
            {
                if (add) Whitelist.Remove(domain);
                else Whitelist.Add(domain);
                SaveDomains(WhitelistPath, Whitelist);
            }
            throw;
        }

        return add
            ? "'" + domain + "'을(를) 허용 목록에 추가했습니다."
            : "'" + domain + "'을(를) 허용 목록에서 제거했습니다.";
    }

    private static string BuildStatus()
    {
        lock (PolicyLock)
        {
            return "CodeOS 상태"
                + "\n  화이트리스트 모드: " + (_whitelistEnabled ? "ON" : "OFF")
                + "\n  허용 도메인 수: " + Whitelist.Count
                + "\n  방화벽 상태: " + _firewallStatus;
        }
    }

    private static string FormatDomainList(IEnumerable<string> domains, string title)
    {
        string[] ordered = domains.Order(StringComparer.OrdinalIgnoreCase).ToArray();
        return ordered.Length == 0
            ? title + "이(가) 비어 있습니다."
            : title + ":\n" + string.Join("\n", ordered.Select(domain => "  - " + domain));
    }

    // 서비스가 재시작되어도 화이트리스트와 모드가 유지되도록 파일에서 읽는다.
    private static void LoadWhitelist()
    {
        lock (PolicyLock)
        {
            Whitelist.Clear();
            if (File.Exists(WhitelistPath))
            {
                foreach (string line in File.ReadLines(WhitelistPath))
                {
                    if (DomainRules.TryNormalize(line, out string domain))
                        Whitelist.Add(domain);
                }
            }

            _whitelistEnabled = File.Exists(WhitelistModePath)
                && File.ReadAllText(WhitelistModePath).Trim().Equals("on", StringComparison.OrdinalIgnoreCase);
        }
    }

    private static void SaveDomains(string path, IEnumerable<string> domains)
    {
        Storage.Write(path, string.Join("\n", domains.Order(StringComparer.OrdinalIgnoreCase)) + "\n");
    }

    // 화이트리스트가 켜져 있으면 허용 IP만 통과시키고, 꺼져 있으면 CodeOS 방화벽 테이블을 제거한다.
    private static async Task ApplyWhitelistPolicyAsync()
    {
        string[] domains;
        bool enabled;
        lock (PolicyLock)
        {
            enabled = _whitelistEnabled;
            domains = Whitelist.ToArray();
        }

        if (!enabled)
        {
            NetworkFirewall.Disable();
            lock (PolicyLock) _firewallStatus = "비활성화됨";
            return;
        }

        FirewallApplyResult result = await NetworkFirewall.ApplyAsync(domains);
        lock (PolicyLock)
        {
            _firewallStatus = result.UnresolvedDomains.Count == 0
                ? "화이트리스트 적용됨 (허용 IP " + result.AddressCount + "개)"
                : "화이트리스트 적용됨 (DNS 확인 실패: "
                    + string.Join(", ", result.UnresolvedDomains) + ")";
        }
    }

    // DNS 결과가 바뀌는 환경을 위해 1분마다 현재 목록을 다시 적용한다.
    private static async Task RefreshFirewallAsync()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        while (await timer.WaitForNextTickAsync())
        {
            bool enabled;
            lock (PolicyLock) enabled = _whitelistEnabled;
            if (!enabled)
                continue;

            try
            {
                await ApplyWhitelistPolicyAsync();
            }
            catch (Exception exception)
            {
                lock (PolicyLock) _firewallStatus = "방화벽 갱신 실패: " + exception.Message;
                Console.WriteLine(_firewallStatus);
            }
        }
    }

    private static string Usage() =>
        "사용법:\n"
        + "  codeos help\n"
        + "  codeos status\n"
        + "  codeos version\n"
        + "  codeos whitelist {on|off|status|add|remove|list} [도메인]\n"
        + "  codeos password {enable|disable|change}";

    // 설치기는 서비스 토큰과 저장 디렉터리를 먼저 준비한 뒤 서비스 바이너리를 게시한다.
    internal static void InitializeInstallation()
    {
        Storage.Directory(ConfigDirectory);
        Storage.Directory(DataDirectory);
        if (!File.Exists(ServiceTokenPath))
            Storage.Write(ServiceTokenPath, Convert.ToHexString(RandomNumberGenerator.GetBytes(32)) + "\n");
        Storage.Write(ConfigDirectory + "/service.env",
            "CODEOS_SERVICE_TOKEN=" + Secrets.Read(ServiceTokenPath) + "\n");
    }

    // 이전 버전의 화이트리스트만 새 저장 위치로 옮긴다. 제거된 기능의 상태는 더 이상 읽지 않는다.
    internal static void MigrateLegacyState()
    {
        const string legacyPath = "/opt/codeos/whitelist.txt";
        if (!File.Exists(WhitelistPath) && File.Exists(legacyPath))
            Storage.Write(WhitelistPath, File.ReadAllText(legacyPath));
    }

    private static async Task WriteResponseAsync(HttpListenerContext context, string text)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(text);
        context.Response.ContentType = "text/plain; charset=utf-8";
        context.Response.ContentLength64 = bytes.Length;
        await context.Response.OutputStream.WriteAsync(bytes);
        context.Response.Close();
    }

    private static bool IsRootProcess()
    {
        // 설치된 CLI wrapper가 sudo로 root 프로세스를 만들지만, 직접 실행한 경우도 명확히 거부한다.
        using Process? process = Process.Start(new ProcessStartInfo("id", "-u")
        {
            RedirectStandardOutput = true,
            UseShellExecute = false
        });
        if (process == null)
            return false;

        string uid = process.StandardOutput.ReadToEnd().Trim();
        process.WaitForExit();
        return uid == "0";
    }
}

// 비밀번호는 평문으로 저장하지 않고 PBKDF2-HMAC-SHA512 결과만 저장한다.
internal static class AdministratorPassword
{
    private const string PasswordPath = "/etc/codeos/auth";
    private const int Iterations = 600_000;

    public static bool IsEnabled => File.Exists(PasswordPath) && new FileInfo(PasswordPath).Length > 0;

    public static bool AuthenticateIfEnabled()
    {
        if (!IsEnabled)
            return true;

        string? password = Read("CodeOS 관리자 비밀번호: ");
        if (password == null || !Verify(password))
        {
            Console.WriteLine("CodeOS 관리자 비밀번호가 올바르지 않습니다.");
            return false;
        }

        return true;
    }

    public static bool SetFromPrompt()
    {
        string? first = Read("새 CodeOS 관리자 비밀번호: ");
        string? second = Read("새 비밀번호 확인: ");
        if (string.IsNullOrEmpty(first))
        {
            Console.WriteLine("비밀번호는 비어 있을 수 없습니다.");
            return false;
        }

        if (!string.Equals(first, second, StringComparison.Ordinal))
        {
            Console.WriteLine("비밀번호가 일치하지 않습니다.");
            return false;
        }

        byte[] salt = RandomNumberGenerator.GetBytes(16);
        byte[] hash = Rfc2898DeriveBytes.Pbkdf2(first, salt, Iterations, HashAlgorithmName.SHA512, 32);
        Storage.Directory("/etc/codeos");
        Storage.Write(PasswordPath,
            "v1$pbkdf2-sha512$" + Iterations + "$"
            + Convert.ToBase64String(salt) + "$" + Convert.ToBase64String(hash) + "\n");
        CryptographicOperations.ZeroMemory(salt);
        CryptographicOperations.ZeroMemory(hash);
        return true;
    }

    public static void Disable()
    {
        if (File.Exists(PasswordPath))
            File.Delete(PasswordPath);
    }

    private static bool Verify(string password)
    {
        try
        {
            string[] fields = File.ReadAllText(PasswordPath).Trim().Split('$');
            if (fields.Length != 5 || fields[0] != "v1" || fields[1] != "pbkdf2-sha512"
                || !int.TryParse(fields[2], out int iterations))
                return false;

            byte[] salt = Convert.FromBase64String(fields[3]);
            byte[] expected = Convert.FromBase64String(fields[4]);
            byte[] actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations,
                HashAlgorithmName.SHA512, expected.Length);
            bool valid = CryptographicOperations.FixedTimeEquals(actual, expected);
            CryptographicOperations.ZeroMemory(salt);
            CryptographicOperations.ZeroMemory(expected);
            CryptographicOperations.ZeroMemory(actual);
            return valid;
        }
        catch
        {
            // 손상된 인증 파일은 인증 실패로 처리하고 서비스가 중단되지 않게 한다.
            return false;
        }
    }

    private static string? Read(string prompt)
    {
        if (Console.IsInputRedirected)
        {
            Console.WriteLine("대화형 터미널에서 비밀번호를 입력하세요.");
            return null;
        }

        Console.Write(prompt);
        var password = new StringBuilder();
        ConsoleKeyInfo key;
        while ((key = Console.ReadKey(intercept: true)).Key != ConsoleKey.Enter)
        {
            if (key.Key == ConsoleKey.Backspace)
            {
                if (password.Length > 0)
                    password.Length--;
            }
            else if (!char.IsControl(key.KeyChar))
            {
                password.Append(key.KeyChar);
            }
        }

        Console.WriteLine();
        return password.ToString();
    }
}

// 서비스 토큰을 비교할 때 일반 문자열 비교 대신 일정 시간 비교를 사용한다.
internal static class Secrets
{
    public static string Read(string path)
    {
        try
        {
            return File.Exists(path) ? File.ReadAllText(path).Trim() : "";
        }
        catch
        {
            return "";
        }
    }

    public static bool FixedEquals(string? left, string? right) =>
        !string.IsNullOrEmpty(left)
        && !string.IsNullOrEmpty(right)
        && CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(left), Encoding.UTF8.GetBytes(right));
}

// 설정 파일은 임시 파일에 쓴 뒤 교체해 서비스 중간에 잘린 파일이 남지 않게 한다.
internal static class Storage
{
    private const UnixFileMode Private = UnixFileMode.UserRead | UnixFileMode.UserWrite;

    public static void Directory(string path)
    {
        System.IO.Directory.CreateDirectory(path);
        Mode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    public static void Write(string path, string content, UnixFileMode mode = Private)
    {
        System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        string temporaryPath = path + ".tmp." + Environment.ProcessId + "." + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(temporaryPath, content, new UTF8Encoding(false));
            Mode(temporaryPath, mode);
            File.Move(temporaryPath, path, true);
            Mode(path, mode);
        }
        finally
        {
            if (File.Exists(temporaryPath))
                File.Delete(temporaryPath);
        }
    }

    public static void Mode(string path, UnixFileMode mode)
    {
        if (!OperatingSystem.IsLinux())
            return;

        try
        {
            File.SetUnixFileMode(path, mode);
        }
        catch (PlatformNotSupportedException)
        {
            // Unix 권한을 지원하지 않는 개발 환경에서는 기본 파일 권한을 사용한다.
        }
    }
}

// URL, 포트, 경로가 섞인 입력을 방화벽에 넣기 전에 안전한 DNS 도메인으로 정규화한다.
internal static class DomainRules
{
    public static bool TryNormalize(string? input, out string domain)
    {
        domain = "";
        if (string.IsNullOrWhiteSpace(input))
            return false;

        string value = input.Trim();
        if (value.Contains('\0') || value.Any(char.IsWhiteSpace))
            return false;

        if (Uri.TryCreate(value, UriKind.Absolute, out Uri? uri) && !string.IsNullOrEmpty(uri.Host))
        {
            value = uri.Host;
        }
        else
        {
            value = value.TrimEnd('/');
            int separator = value.IndexOfAny(['/', '?', '#']);
            if (separator >= 0)
                value = value[..separator];

            int colon = value.LastIndexOf(':');
            if (colon > 0 && value[(colon + 1)..].All(char.IsAsciiDigit))
                value = value[..colon];
        }

        value = value.TrimEnd('.').ToLowerInvariant();
        while (value.StartsWith("www.", StringComparison.Ordinal))
            value = value[4..];

        if (value.Length == 0 || value is "localhost" or "127.0.0.1" or "::1"
            || IPAddress.TryParse(value, out _))
            return false;

        try
        {
            value = new IdnMapping().GetAscii(value).ToLowerInvariant();
        }
        catch (ArgumentException)
        {
            return false;
        }

        if (value.Length > 253 || !value.Contains('.'))
            return false;

        string[] labels = value.Split('.');
        if (labels.Any(label => label.Length is < 1 or > 63
            || label[0] == '-' || label[^1] == '-'
            || label.Any(character => !(char.IsAsciiLetterOrDigit(character) || character == '-'))))
            return false;

        domain = value;
        return true;
    }
}

internal sealed record FirewallApplyResult(int AddressCount, IReadOnlyList<string> UnresolvedDomains);

// nftables에는 화이트리스트 IP만 등록한다. 도메인은 IP로 해석되므로 DNS가 바뀌면 주기적으로 재적용한다.
internal static class NetworkFirewall
{
    private const string NftablesPath = "/usr/sbin/nft";
    private static readonly SemaphoreSlim ApplyLock = new(1, 1);
    private static readonly Dictionary<string, HashSet<IPAddress>> AddressCache = new(StringComparer.OrdinalIgnoreCase);

    public static async Task<FirewallApplyResult> ApplyAsync(IReadOnlyCollection<string> domains)
    {
        await ApplyLock.WaitAsync();
        try
        {
            var unresolved = new List<string>();
            var activeDomains = new HashSet<string>(domains, StringComparer.OrdinalIgnoreCase);
            var nextCache = AddressCache
                .Where(entry => activeDomains.Contains(entry.Key))
                .ToDictionary(entry => entry.Key, entry => new HashSet<IPAddress>(entry.Value), StringComparer.OrdinalIgnoreCase);

            foreach (string domain in activeDomains)
            {
                HashSet<IPAddress> addresses = await ResolveAsync(domain);
                if (addresses.Count == 0)
                    unresolved.Add(domain);
                else
                    nextCache[domain] = addresses;
            }

            List<IPAddress> allAddresses = nextCache.Values.SelectMany(addresses => addresses).Distinct().ToList();
            Apply(allAddresses);

            // nftables 적용이 성공한 뒤에만 새 DNS 캐시를 확정한다.
            AddressCache.Clear();
            foreach ((string domain, HashSet<IPAddress> addresses) in nextCache)
                AddressCache[domain] = addresses;

            return new FirewallApplyResult(allAddresses.Count, unresolved);
        }
        finally
        {
            ApplyLock.Release();
        }
    }

    // 하나의 화이트리스트 도메인에서 대표적인 호스트 이름도 함께 허용한다.
    private static async Task<HashSet<IPAddress>> ResolveAsync(string domain)
    {
        var addresses = new HashSet<IPAddress>();
        string[] candidates = [domain, "www." + domain, "accounts." + domain];
        foreach (string candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            try
            {
                foreach (IPAddress address in await Dns.GetHostAddressesAsync(candidate, timeout.Token))
                    addresses.Add(address);
            }
            catch (SocketException) { }
            catch (OperationCanceledException) { }
        }

        return addresses;
    }

    public static void Disable()
    {
        if (File.Exists(NftablesPath))
            Run(NftablesPath, ["delete", "table", "inet", "codeos"], null);
        AddressCache.Clear();
    }

    private static void Apply(IReadOnlyCollection<IPAddress> addresses)
    {
        if (!File.Exists(NftablesPath))
            throw new InvalidOperationException("nftables 실행 파일(/usr/sbin/nft)을 찾을 수 없습니다.");

        bool tableExists = Run(NftablesPath, ["list", "table", "inet", "codeos"], null).ExitCode == 0;
        string transaction = BuildTransaction(addresses, tableExists);

        // 먼저 같은 배치를 검사해 문법 오류가 기존 테이블을 훼손하지 않게 한다.
        ProcessResult check = Run(NftablesPath, ["-c", "-f", "-"], transaction);
        if (check.ExitCode != 0)
            throw new InvalidOperationException("nftables 정책 문법 검증 실패: " + check.Error.Trim());

        // nftables의 파일 적용은 하나의 트랜잭션이므로 실패 시 기존 정책이 유지된다.
        ProcessResult result = Run(NftablesPath, ["-f", "-"], transaction);
        if (result.ExitCode != 0)
            throw new InvalidOperationException("nftables 정책 적용 실패: " + result.Error.Trim());
    }

    private static string BuildTransaction(IReadOnlyCollection<IPAddress> addresses, bool tableExists)
    {
        IEnumerable<string> ipv4 = addresses
            .Where(address => address.AddressFamily == AddressFamily.InterNetwork)
            .Select(address => address.ToString()).Order();
        IEnumerable<string> ipv6 = addresses
            .Where(address => address.AddressFamily == AddressFamily.InterNetworkV6)
            .Select(address => address.ToString()).Order();

        var transaction = new StringBuilder();
        if (tableExists)
            transaction.AppendLine("flush table inet codeos");
        else
            transaction.AppendLine("add table inet codeos");

        transaction.Append(BuildSet("allowed_ipv4", "ipv4_addr", ipv4));
        transaction.Append(BuildSet("allowed_ipv6", "ipv6_addr", ipv6));
        transaction.AppendLine("add chain inet codeos output {");
        transaction.AppendLine("  type filter hook output priority -150; policy accept;");
        transaction.AppendLine("  oifname \"lo\" accept");
        transaction.AppendLine("  udp dport 53 accept");
        transaction.AppendLine("  tcp dport 53 accept");
        transaction.AppendLine("  ip daddr @allowed_ipv4 accept");
        transaction.AppendLine("  ip6 daddr @allowed_ipv6 accept");
        transaction.AppendLine("  ip protocol { tcp, udp } drop");
        transaction.AppendLine("  ip6 nexthdr { tcp, udp } drop");
        transaction.AppendLine("}");
        return transaction.ToString();
    }

    private static string BuildSet(string name, string type, IEnumerable<string> addresses)
    {
        string values = string.Join(", ", addresses);
        return "add set inet codeos " + name + " { type " + type + "; flags interval;"
            + (values.Length == 0 ? "" : " elements = { " + values + " };") + " }\n";
    }

    private static ProcessResult Run(string file, IReadOnlyCollection<string> arguments, string? input)
    {
        using var process = new Process
        {
            StartInfo =
            {
                FileName = file,
                UseShellExecute = false,
                RedirectStandardInput = input != null,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
        };
        foreach (string argument in arguments)
            process.StartInfo.ArgumentList.Add(argument);

        process.Start();
        if (input != null)
        {
            process.StandardInput.Write(input);
            process.StandardInput.Close();
        }

        Task<string> outputTask = process.StandardOutput.ReadToEndAsync();
        Task<string> errorTask = process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        Task.WaitAll(outputTask, errorTask);
        return new ProcessResult(process.ExitCode, errorTask.Result);
    }

    private sealed record ProcessResult(int ExitCode, string Error);
}
