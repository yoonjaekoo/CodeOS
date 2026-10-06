# AGENTS.md

.NET 10 console app (`net10.0`, version 1.1), **no NuGet packages, no tests, no CI** — `dotnet build` is the only verification. Linux-only system service that enforces a **whitelist** (not blocklist) via **nftables** (not `/etc/hosts`), and also installs the bundled **AutoGit** and **Nodus** tools globally. All user-facing strings are Korean — keep new UI text Korean. `README.md` describes product direction and is partly stale (no `browser-extension/`, `blocked.html`, or port `1234` exist); trust the code.

## Two entrypoints (easy to confuse)

- `Program.cs` — top-level statements, and the **real build entrypoint**. `dotnet run`/`dotnet build` always uses this file. Dispatches `--service` → `BackgroundProgram.RunService()`, `--cli <cmd>` → `HandleCli`, `--service-install` → `Background.Install()` (root-gated), and **no args** → full install `Background.Install()` (root-gated; service + AutoGit + Nodus). Any other args go to the CLI.
- `CodeOS.Background.cs` — `BackgroundProgram.Main` plus every implementation type (`AdministratorPassword`, `Secrets`, `Storage`, `DomainRules`, `NetworkFirewall`). Only runs via the file-based app (`dotnet run --file CodeOS.Background.cs`). A bare build **ignores** its `Main` and emits warning `CS7022`.

Both files compile into the same `CodeOS_setup` project/namespace, so a change to `CodeOS.Background.cs` is not exercised by `dotnet run` until reinstalled or run via `--file`.

## Commands

- `dotnet build` — only verification step.
- `sudo dotnet run` — one-shot full install (root-gated): systemd service + bundled AutoGit + Nodus, via `Background.Install()`.
- `sudo dotnet run -- --service-install` — same `Background.Install()` path, kept for explicit reinstall/upgrade.
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

`InitializeInstallation` (token/dirs) → `MigrateLegacyState` → `dotnet restore/publish` using the **local RID** (`RuntimeInformation.RuntimeIdentifier`, `--ignore-failed-sources`) → rename published `CodeOS_setup` to `CodeOS.Background` → chown/lock `/opt/codeos`, `/etc/codeos`, `/var/lib/codeos` → write CLI wrapper + sudoers → write systemd unit (`NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, `UMask=0077`, `Restart=always`) → `daemon-reload`, `enable`, `restart` (must `restart`, not `enable --now`, to replace a running old binary) → `Integrations.InstallAutoGit()` → `Integrations.InstallNodus()`.

## Bundled tools (`Integrations.cs`, `tools/`)

- `tools/autogit/` and `tools/nodus/` are **vendored copies** of the upstream sources; build artifacts, `.venv`, `node_modules`, `dist`, `__pycache__`, `*.db`, `*.log`, and real `.env` files are excluded (each tool's own `.gitignore`/`.gitattributes` enforce this). Refresh by copying the upstream tree, never by editing generated files.
- AutoGit: merges into `/opt/autogit` (root-owned), `chmod +x` its scripts, ensures Node.js/npm via apt, then runs the bundled `install.sh` which symlinks `/usr/local/bin/autogit` → `/opt/autogit/bin/autogit.js`. The root `.gitignore` has a `bin/` rule, so `!tools/autogit/bin/` is required to keep that launcher tracked.
- Nodus: merges into `/opt/nodus` (venvs/node_modules preserved), creates `backend/.venv` and `tui/.venv` + `pip install` and `frontend/node_modules` only when missing, copies each `.env.example` → `.env` when absent, and writes root-owned wrappers `/usr/local/bin/nodus` → `run.sh`, `/usr/local/bin/nodus-tui` → `run-tui.sh`. Venvs use a **compatible CPython (3.9–3.13)** picked by `ResolveNodusPython` (apt-installs `python3.13` if no supported interpreter exists) because `pydantic-core`/`asyncpg` don't build on 3.14+; an existing venv built with an unsupported Python is deleted and rebuilt, and successful dependency installs are tracked by a `.venv/.codeos-ready` marker.
- Both are Linux-only and self-contained: they no-op off-Linux and **catch their own exceptions** so a tool failure never aborts the CodeOS install. `LocateToolsDirectory` finds `tools/` by walking up to `CodeOS_setup.csproj`, so they only work when install runs from the source tree (`sudo dotnet run -- --service-install`), not from the published binary.


## Gotchas

- Do not add SDK packages or `#:package` directives; the project intentionally has none (so `--file` works without a csproj reference).
- `Storage.Mode` no-ops off-Linux, so a Windows `dotnet build` succeeds but the app is not runnable there; `NetworkFirewall` hardcodes `/usr/sbin/nft`.
- `Integrations.cs` only acts on Linux and never throws to the caller; keep it that way so tool setup can't break `--service-install`.
- `index.html` is a standalone landing page; the service does not serve it.
- `execute.log` is committed output from an old version and does not reflect current code.
