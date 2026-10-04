'use strict';

/**
 * GitHub 계정 로그인 + API.
 *
 * 헤드리스(TUI/CLI) 도구이므로 별도 GUI 런타임에 의존하지 않는다.
 *
 * 보안 원칙:
 *  - 토큰은 절대 명령줄 인자/로그/출력으로 내보내지 않는다.
 *  - 설정 파일은 0600 권한으로 저장한다(gh CLI 와 같은 방식).
 *  - git 에는 `git credential approve` 의 stdin 으로만 전달한다.
 *  - 토큰을 원격 URL 에 박지 않는다.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const git = require('./git');

const API_BASE_DEFAULT = 'https://api.github.com';
const USER_AGENT = 'AutoGit';
const TOKEN_USERNAME = 'x-access-token';

/** 메모리 세션. 디스크보다 이 값을 우선한다. */
let session = { token: null, user: null, source: null, persisted: false };

/* ----------------------------- 설정 경로 ----------------------------- */

function configDir() {
  if (process.env.AUTOGIT_CONFIG_DIR) return process.env.AUTOGIT_CONFIG_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'autogit');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autogit');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function apiBase() {
  return process.env.AUTOGIT_GITHUB_API_BASE || API_BASE_DEFAULT;
}

/* ----------------------------- 저장/복원 ----------------------------- */

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(config) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath();
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  // Windows 에서는 mode 가 무시될 수 있어 가능한 경우 다시 시도한다.
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
  return file;
}

function persist() {
  try {
    const config = readConfig();
    config.github = {
      token: session.token,
      user: session.user,
      source: session.source,
      savedAt: new Date().toISOString(),
    };
    writeConfig(config);
    session.persisted = true;
    return { ok: true, path: configPath() };
  } catch (err) {
    session.persisted = false;
    return { ok: false, error: String(err && err.message) };
  }
}

/** 앱 시작 시 저장된 로그인 복원 */
function restore() {
  const cfg = readConfig();
  const gh = cfg.github;
  if (!gh || !gh.token) return { ok: false, reason: 'empty' };
  session = { token: gh.token, user: gh.user || null, source: gh.source || 'token', persisted: true };
  return { ok: true };
}

function clearPersisted() {
  try {
    const config = readConfig();
    delete config.github;
    if (Object.keys(config).length === 0) {
      fs.rmSync(configPath(), { force: true });
    } else {
      writeConfig(config);
    }
  } catch { /* ignore */ }
  session.persisted = false;
}

/* ------------------------------- HTTP ------------------------------- */

function mapApiError(status, data) {
  const detail = data && typeof data === 'object' && data.message ? ` (${data.message})` : '';
  switch (status) {
    case 401:
      return `토큰이 유효하지 않거나 만료되었습니다. 새 토큰을 발급받아 다시 로그인하세요.${detail}`;
    case 403:
      return `접근이 거부되었습니다. 토큰 권한(scope) 또는 API 호출 한도를 확인하세요.${detail}`;
    case 404:
      return `대상을 찾을 수 없습니다. 저장소 이름과 접근 권한을 확인하세요.${detail}`;
    case 422:
      return `요청이 거부되었습니다. 입력 값을 확인하세요.${detail}`;
    default:
      return `GitHub API 오류 (HTTP ${status})${detail}`;
  }
}

async function apiRequest(pathname, { method = 'GET', token, body } = {}) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const useToken = token || session.token;
  if (useToken) headers.Authorization = `Bearer ${useToken}`;

  let res;
  try {
    res = await fetch(`${apiBase()}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, error: 'GitHub 에 연결할 수 없습니다. 인터넷 연결을 확인하세요.' };
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) return { ok: false, status: res.status, error: mapApiError(res.status, data), data };
  return { ok: true, status: res.status, data, headers: res.headers };
}

/* --------------------------- 데이터 정규화 --------------------------- */

function normalizeUser(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    login: u.login,
    name: u.name || u.login,
    avatarUrl: u.avatar_url,
    htmlUrl: u.html_url,
    publicRepos: u.public_repos ?? null,
    privateRepos: u.total_private_repos ?? null,
  };
}

function normalizeRepo(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    fullName: r.full_name,
    name: r.name,
    owner: r.owner ? r.owner.login : null,
    private: Boolean(r.private),
    description: r.description || '',
    cloneUrl: r.clone_url,
    sshUrl: r.ssh_url,
    htmlUrl: r.html_url,
    defaultBranch: r.default_branch || 'main',
    updatedAt: r.updated_at,
  };
}

function parseScopes(headersObj) {
  try {
    const raw = headersObj && headersObj.get ? headersObj.get('x-oauth-scopes') : null;
    if (!raw) return [];
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/* ------------------------------ 로그인 ------------------------------ */

async function loginWithToken(rawToken, { source = 'token', persist: shouldPersist = true } = {}) {
  const token = String(rawToken || '').trim();
  if (!token) return { ok: false, error: '토큰을 입력하세요.' };
  if (/\s/.test(token)) return { ok: false, error: '토큰에는 공백이 포함될 수 없습니다. 복사한 값을 확인하세요.' };

  const me = await apiRequest('/user', { token });
  if (!me.ok) return { ok: false, error: me.error, status: me.status };

  session = {
    token,
    user: normalizeUser(me.data),
    source,
    scopes: parseScopes(me.headers),
    persisted: false,
  };

  let storageWarning = null;
  let storagePath = null;
  if (shouldPersist) {
    const saved = persist();
    if (saved.ok) storagePath = saved.path;
    else storageWarning = '토큰을 설정 파일에 저장하지 못했습니다. 이번 실행에서만 유지됩니다.';
  }

  return { ok: true, user: session.user, scopes: session.scopes, warning: storageWarning, persisted: session.persisted, configPath: storagePath };
}

function runCommand(cmd, args, { cwd = process.cwd(), timeout = 20_000, input = null, env = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, shell: false, windowsHide: true, env: env || process.env });
    } catch (err) {
      resolve({ ok: false, missing: true, stdout: '', stderr: String(err && err.message) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ok: false, stdout, stderr: 'timeout' });
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.stdin.on('error', () => { /* ignore */ });
    child.stdin.end(input != null ? input : '');
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, missing: err && err.code === 'ENOENT', stdout, stderr: String(err && err.message) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function ghCliStatus() {
  const version = await runCommand('gh', ['--version'], { timeout: 8000 });
  if (version.missing || !version.ok) return { available: false, loggedIn: false };
  const status = await runCommand('gh', ['auth', 'status'], { timeout: 8000 });
  return { available: true, loggedIn: status.ok, detail: (status.stdout + status.stderr).trim() };
}

/** 이미 `gh auth login` 된 계정의 토큰을 재사용한다. */
async function loginFromGhCli() {
  const status = await ghCliStatus();
  if (!status.available) {
    return { ok: false, error: 'gh CLI 가 설치되어 있지 않습니다. 토큰으로 로그인하거나 https://cli.github.com 에서 설치하세요.' };
  }
  if (!status.loggedIn) {
    return { ok: false, error: 'gh CLI 에 로그인되어 있지 않습니다. 터미널에서 `gh auth login` 을 먼저 실행하세요.' };
  }
  const tokenRes = await runCommand('gh', ['auth', 'token'], { timeout: 8000 });
  if (!tokenRes.ok || !tokenRes.stdout.trim()) {
    return { ok: false, error: 'gh CLI 에서 토큰을 가져오지 못했습니다. `gh auth login` 을 다시 실행하세요.' };
  }
  return loginWithToken(tokenRes.stdout.trim(), { source: 'gh-cli' });
}

async function logout(cwd) {
  const token = session.token;
  if (token && cwd) {
    await git.credentialReject(cwd, { protocol: 'https', host: 'github.com', username: TOKEN_USERNAME, password: token });
  }
  session = { token: null, user: null, source: null, persisted: false };
  clearPersisted();
  return { ok: true, configPath: configPath() };
}

function getStatus() {
  return {
    loggedIn: Boolean(session.token),
    user: session.user,
    source: session.source,
    scopes: session.scopes || [],
    persisted: session.persisted,
    configPath: configPath(),
  };
}

/* ------------------------------ 저장소 ------------------------------ */

async function listRepos() {
  const res = await apiRequest('/user/repos?per_page=100&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member');
  if (!res.ok) return res;
  const repos = Array.isArray(res.data) ? res.data.map(normalizeRepo).filter(Boolean) : [];
  return { ok: true, repos };
}

async function createRepo({ name, description = '', isPrivate = false } = {}) {
  const repoName = String(name || '').trim();
  if (!repoName) return { ok: false, error: '저장소 이름을 입력하세요.' };
  if (!/^[A-Za-z0-9._-]+$/.test(repoName)) {
    return { ok: false, error: '저장소 이름은 영문/숫자/마침표/밑줄/하이픈만 사용할 수 있습니다.' };
  }
  const res = await apiRequest('/user/repos', {
    method: 'POST',
    body: { name: repoName, description, private: Boolean(isPrivate), auto_init: false },
  });
  if (!res.ok) return res;
  return { ok: true, repo: normalizeRepo(res.data) };
}

/**
 * 현재 저장소의 https remote 들에 대해 자격 증명을 OS 저장소에 등록한다.
 * 그래야 이후 `git push` / `git pull` 이 프롬프트 없이 동작한다.
 */
async function ensureCredential(cwd) {
  if (!session.token) return { ok: false, error: 'GitHub 로그인이 필요합니다.' };
  const remotes = await git.getRemotes(cwd);
  const hosts = [...new Set(
    remotes
      .filter((r) => /^https:\/\//i.test(r.url || ''))
      .map((r) => git.parseRemoteHost(r.url))
      .filter(Boolean),
  )];
  if (hosts.length === 0) return { ok: true, hosts: [], note: 'https remote 가 없어 자격 증명 등록을 건너뛰었습니다.' };

  for (const host of hosts) {
    await git.credentialApprove(cwd, { protocol: 'https', host, username: TOKEN_USERNAME, password: session.token });
  }
  return { ok: true, hosts };
}

/** 토큰이 원격 URL 에 박히지 않았는지 확인하기 위한 헬퍼 */
function isTokenInUrl(url) {
  return /:\/\/[^/@\s]*:[^/@\s]*@/.test(String(url || ''));
}

module.exports = {
  getStatus,
  restore,
  loginWithToken,
  loginFromGhCli,
  ghCliStatus,
  logout,
  listRepos,
  createRepo,
  ensureCredential,
  configDir,
  configPath,
  // 테스트용 순수 함수
  mapApiError,
  normalizeUser,
  normalizeRepo,
  isTokenInUrl,
  parseScopes,
  TOKEN_USERNAME,
};
