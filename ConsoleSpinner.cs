namespace CodeOS_setup;

// 설치 중 긴 작업이 도는 동안 콘솔 한 줄에서 점자를 돌려
// 사용자에게 진행 중임을 보여준다. 캐리지 리턴(\r)으로 줄을 덮어써
// 화면이 흐르지 않고 제자리에서 갱신된다.
// 출력이 파일 등으로 리다이렉트되면 아무것도 출력하지 않는다(로그 오염 방지).
internal sealed class Spinner
{
    private static readonly string[] Frames = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" };
    private const int IntervalMs = 80;

    private readonly object _gate = new();
    private readonly CancellationTokenSource _cancellation = new();
    private readonly bool _active;
    private readonly Task? _loop;
    private int _width;
    private bool _stopped;

    private Spinner(string label, bool active)
    {
        _active = active;
        if (active)
            _loop = Task.Run(() => AnimateAsync(label, _cancellation.Token));
    }

    public static Spinner Start(string label) => new(label, !Console.IsOutputRedirected);

    // 긴 작업 하나를 감싸는 편의 메서드. 작업이 끝나면 스피너를 지운다.
    public static void Run(string label, Action action)
    {
        Spinner spinner = Start(label);
        try
        {
            action();
        }
        finally
        {
            spinner.Stop();
        }
    }

    private async Task AnimateAsync(string label, CancellationToken token)
    {
        int frame = 0;
        try
        {
            while (!token.IsCancellationRequested)
            {
                Write(Frames[frame++ % Frames.Length] + " " + label);
                await Task.Delay(IntervalMs, token);
            }
        }
        catch (OperationCanceledException)
        {
            // 정상 종료
        }
    }

    private void Write(string line)
    {
        lock (_gate)
        {
            int padding = _width - line.Length;
            Console.Write('\r');
            Console.Write(line);
            if (padding > 0)
                Console.Write(new string(' ', padding));
            _width = line.Length;
        }
    }

    // 스피너를 멈추고 줄을 비운다. 여러 번 호출해도 안전하다.
    public void Stop()
    {
        if (_stopped)
            return;
        _stopped = true;

        if (_active)
        {
            _cancellation.Cancel();
            try
            {
                _loop?.Wait();
            }
            catch (AggregateException)
            {
                // 취소로 인한 예외는 무시
            }

            lock (_gate)
            {
                Console.Write('\r');
                if (_width > 0)
                    Console.Write(new string(' ', _width));
                Console.Write('\r');
                _width = 0;
            }
        }

        _cancellation.Dispose();
    }
}
