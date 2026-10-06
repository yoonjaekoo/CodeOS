# AGENTS.md

.NET 10 console app (`net10.0`, version 1.1), **no NuGet packages, no tests, no CI** — `dotnet build` is the only verification. Linux-only system service that enforces a **whitelist** (not blocklist) via **nftables** (not `/etc/hosts`). All user-facing strings are Korean — keep new UI text Korean. `README.md` describes product direction and is partly stale (no `browser-extension/`, `blocked.html`, or port `1234` exist); trust the code.

## Two entrypoints (easy to confuse)

- `Program.cs` — top-level statements, and the **real build entrypoint**. `dotnet run`/`dotnet build` always uses this file. Dispatches `--service` → `BackgroundProgram.RunService()`, `--cli <cmd>` → `HandleCli`, `--service-install` → `Background.Install()` (root-gated), else CLI.
- `CodeOS.Background.cs` — `BackgroundProgram.Main` plus every implementation type (`AdministratorPassword`, `Secrets`, `Storage`, `DomainRules`, `NetworkFirewall`). Only runs via the file-based app (`dotnet run --file CodeOS.Background.cs`). A bare build **ignores** its `Main` and emits warning `CS7022`.

Both files compile into the same `CodeOS_setup` project/namespace, so a change to `CodeOS.Background.cs` is not exercised by `dotnet run` until reinstalled or run via `--file`.

## Commands

- `dotnet build` — only verification step.
- `sudo dotnet run -- --service-install` — publish + install/upgrade the service.
- `sudo dotnet run --file CodeOS.Background.cs -- --service` — run the service directly (dev; falls back to allowing loopback requests when no token file exists).
- `./execute <cmd>` — dev CLI client; it `sudo`s the file-based app and forwards args. **The no-arg branch does not pass `--service`, so it no longer starts the server** (it hits the CLI usage path); use the two commands above or the systemd unit instead.
- Installed CLI wrapper `/usr/local/bin/codeos` → `sudo -n /opt/codeos/CodeOS.Background --cli`. Commands: `help`, `status`, `version`, `whitelist {on|off|status|add|remove|list} [domain]`, `password {enable|disable|change}`. Old `block`/`focus`/`browser` commands are removed. `version` and `password` are handled CLI-side; everything else is routed to the service.

## State & paths

- `/etc/codeos`: `service.token`, `service.env` (`CODEOS_SERVICE_TOKEN=...`), `auth` (PBKDF2-HMAC-SHA512, 600k iters).
- `/var/lib/codeos`: `whitelist.txt`, `whitelist-mode`.
- Legacy `/opt/codeos/whitelist.txt` is migrated once on install; nothing reads it afterward.

## Security model (don't weaken)

- Service listens on `http://127.0.0.1:5890/` only, rejects non-loopback requests, and requires header `X-CodeOS-Service-Token` (fixed-time compare) whenever a token file exists.
- The token comes from systemd `EnvironmentFile=/etc/codeos/service.env`; `--service` without the matching env token throws.
- CLI refuses to run unless the process is root (`id -u` == 0), then checks the admin password first if enabled. The NOPASSWD sudoers rule is scoped to `/opt/codeos/CodeOS.Background --cli *`.
- Domains go through `DomainRules.TryNormalize` and are URL-escaped before routing. Never shell-interpolate user input; install/commands use `ProcessStartInfo.ArgumentList`, and nft rules are piped as a transaction on stdin.

## Firewall behavior

- `nftables` table `inet codeos`, output chain: allow loopback + DNS (53) + whitelisted IPs, drop other tcp/udp. Requires `/usr/sbin/nft`.
- Domains are DNS-resolved (`domain`, `www.`, `accounts.`) and re-applied every 60s; whitelist off deletes the table. On Linux this all needs root.

## Install flow (`BackGroundSetup.cs`)

`InitializeInstallation` (token/dirs) → `MigrateLegacyState` → `dotnet restore/publish` using the **local RID** (`RuntimeInformation.RuntimeIdentifier`, `--ignore-failed-sources`) → rename published `CodeOS_setup` to `CodeOS.Background` → chown/lock `/opt/codeos`, `/etc/codeos`, `/var/lib/codeos` → write CLI wrapper + sudoers → write systemd unit (`NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, `UMask=0077`, `Restart=always`) → `daemon-reload`, `enable`, `restart` (must `restart`, not `enable --now`, to replace a running old binary).

## Gotchas

- Do not add SDK packages or `#:package` directives; the project intentionally has none (so `--file` works without a csproj reference).
- `Storage.Mode` no-ops off-Linux, so a Windows `dotnet build` succeeds but the app is not runnable there; `NetworkFirewall` hardcodes `/usr/sbin/nft`.
- `index.html` is a standalone landing page; the service does not serve it.
- `execute.log` is committed output from an old version and does not reflect current code.
