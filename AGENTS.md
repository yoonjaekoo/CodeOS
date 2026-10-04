# AGENTS.md

.NET 10 console app (`net10.0`), no external packages (game-site detection uses Groq's OpenAI-compatible REST API via `HttpClient`), no tests, no CI. A background service that blocks distraction sites via `/etc/hosts`, plus a root-gated installer that deploys it. All user-facing console strings are Korean — keep new UI text in Korean.

## Two entrypoints (easy to confuse)

- `Program.cs` — top-level statements. The **service installer / CLI entry**. Runs when you `dotnet run`. `--service-install` (root) calls `Background.Install()`; `--cli <cmd>` forwards to the CLI; no args prints usage.
- `CodeOS.Background.cs` — the **background service** (`BackgroundProgram`, classic `Main` dispatching CLI vs service on args). `dotnet run` does NOT start this; it is the same project but entered via `./execute` (file-based app) or the systemd `codeos` service (`--service`).

## Commands

- `dotnet build` is the only verification available (no test/lint tooling). `sudo dotnet run -- --service-install` exercises the service installer.
- `./execute` — dev harness for the service. No args: starts HTTP server in background (idempotent, health-checks `http://localhost:5890/status` first), logs to `./execute.log`. With args: CLI client — `./execute status | block add|remove <domain> | block list | focus on|off`.
- The script auto-locates dotnet (checks `$HOME/.dotnet/dotnet`, `/usr/lib/dotnet`, etc.) and runs the file directly via `dotnet run --file CodeOS.Background.cs` (.NET 10 file-based apps). Don't break that lookup.

## Service behavior

- HTTP API on `http://localhost:5890/` (HttpListener): `/status`, `/block/add|remove|list`, `/focus/on|off`.
- Blocklist persisted at `/opt/codeos/blocklist.txt`, applied to `/etc/hosts` between `# CodeOS BLOCK START`/`# CodeOS BLOCK END` markers (`0.0.0.0` + `www.` entries). Requires root.

## Install flow (`BackGroundSetup.cs` → `Background.Install()`)

Runs from the installer: creates `/opt/codeos`, `dotnet publish -o /opt/codeos --self-contained -r linux-x64`, renames published `CodeOS_setup` → `CodeOS.Background`, writes `/etc/systemd/system/codeos.service` (root, `--service`, `Restart=always`), registers a NOPASSWD sudoers rule, then `systemctl enable --now codeos`.

## Gotchas

- `CodeOS.Background.cs` uses NO NuGet packages — Groq's OpenAI-compatible `/chat/completions` endpoint is called directly with `HttpClient`, so there's no csproj `PackageReference` and no `#:package` directive needed for the file-based `./execute` path. Don't add an SDK package.
- The Groq API key is read from env `GROQ_API_KEY` or `/opt/codeos/groq-api-key.txt` — never hardcode a key. The model is `openai/gpt-oss-120b`.
- `Background.RunCommand` shells out via `bash -c` string interpolation — keep command args hardcoded, never user input.
- Changes to `CodeOS.Background.cs` only take effect after re-running the installer (`sudo dotnet run -- --service-install`) or `./execute`; a bare `dotnet build`/`dotnet run` won't touch the running service.
