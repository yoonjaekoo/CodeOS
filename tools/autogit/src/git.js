'use strict';

/**
 * 안전한 Git 실행 래퍼.
 *
 * 원칙:
 *  - shell 을 절대 사용하지 않는다. 모든 인자는 배열로 spawn 에 전달한다.
 *  - 사용자 입력(브랜치명, 경로, 커밋 메시지)을 명령 문자열에 이어붙이지 않는다.
 *  - 실패 시 { ok:false, code, stdout, stderr } 를 반환하고, 사람이 읽을 수 있는
 *    메시지는 analyzeError() 로 변환한다.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const GIT_TIMEOUT_MS = 30_000;

function runGit(cwd, args, { timeout = GIT_TIMEOUT_MS, input = null, env = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        shell: false,
        windowsHide: true,
        env: env || process.env,
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err && err.message), spawnError: err });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({ ok: false, code: -1, stdout, stderr: stderr + '\n[timeout] git 명령이 시간 내에 끝나지 않았습니다.' });
      }
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    // stdin 은 자격 증명 전달에만 쓴다(토큰을 argv 로 노출하지 않기 위함).
    child.stdin.on('error', () => { /* 프로세스가 먼저 닫은 경우 무시 */ });
    child.stdin.end(input != null ? input : '');

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const notFound = err && err.code === 'ENOENT';
      resolve({
        ok: false,
        code: -1,
        stdout,
        stderr: notFound ? 'git 을(를) 찾을 수 없습니다.' : String(err && err.message),
        spawnError: err,
        gitMissing: notFound,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/** git 설치 여부 및 버전 */
async function getGitVersion() {
  const res = await runGit(process.cwd(), ['--version']);
  if (res.gitMissing || !res.ok) {
    return { installed: false, version: null };
  }
  return { installed: true, version: res.stdout.trim() };
}

/** cwd 가 git 저장소인지 (상위 디렉터리 포함) */
async function isRepo(cwd) {
  const res = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.stdout.trim() === 'true';
}

/** 저장소 루트 경로 */
async function getRepoRoot(cwd) {
  const res = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  return res.ok ? res.stdout.trim() : null;
}

/** 현재 브랜치 (detached 이면 짧은 SHA) */
async function getBranch(cwd) {
  const res = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (res.ok) return res.stdout.trim();
  // 커밋이 하나도 없는 저장소
  const symbolic = await runGit(cwd, ['symbolic-ref', '--short', 'HEAD']);
  if (symbolic.ok) return symbolic.stdout.trim();
  return null;
}

/** remote 목록 (push 용 URL 포함) */
async function getRemotes(cwd) {
  const res = await runGit(cwd, ['remote', '-v']);
  if (!res.ok) return [];
  const seen = new Map();
  for (const line of res.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const [name, url] = parts;
    if (!seen.has(name)) seen.set(name, { name, url });
  }
  return [...seen.values()];
}

function parseNumstat(raw) {
  const map = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [add, del, ...rest] = parts;
    const file = rest.join('\t');
    map.set(file, {
      additions: add === '-' ? 0 : parseInt(add, 10) || 0,
      deletions: del === '-' ? 0 : parseInt(del, 10) || 0,
      binary: add === '-' || del === '-',
    });
  }
  return map;
}

/**
 * git status --porcelain=v1 -z 파싱.
 * XY 코드로 staged/unstaged 를 구분한다.
 */
function parseStatus(raw) {
  const parts = raw.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry) continue;
    const index = entry[0];
    const worktree = entry[1];
    const filePath = entry.slice(3);
    let origPath = null;
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      origPath = parts[i + 1] || null;
      i += 1;
    }
    files.push({ index, worktree, path: filePath, origPath });
  }
  return files;
}

function statusLabel(code) {
  switch (code) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'typechange';
    case 'U': return 'conflicted';
    case '?': return 'untracked';
    case '!': return 'ignored';
    default: return 'modified';
  }
}

function countFileLines(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    const content = fs.readFileSync(absPath, 'utf8');
    if (content.indexOf('\u0000') !== -1) return null; // binary
    if (content.length === 0) return 0;
    return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  } catch {
    return null;
  }
}

/**
 * 변경 사항 전체 분석.
 * 각 파일에 staged/unstaged 여부, 상태 라벨, 증감 라인 수를 붙여 반환한다.
 */
async function getStatus(cwd) {
  const res = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!res.ok) {
    return { ok: false, files: [], error: analyzeError(res, '상태를 읽을 수 없습니다.') };
  }

  const parsed = parseStatus(res.stdout);

  const [stagedNumstat, unstagedNumstat] = await Promise.all([
    runGit(cwd, ['diff', '--cached', '--numstat']),
    runGit(cwd, ['diff', '--numstat']),
  ]);
  const stagedStats = stagedNumstat.ok ? parseNumstat(stagedNumstat.stdout) : new Map();
  const unstagedStats = unstagedNumstat.ok ? parseNumstat(unstagedNumstat.stdout) : new Map();

  const root = await getRepoRoot(cwd);

  const files = parsed.map((f) => {
    const untracked = f.index === '?' && f.worktree === '?';
    const staged = !untracked && f.index !== ' ' && f.index !== '?';
    const unstaged = untracked || (f.worktree !== ' ' && f.worktree !== '?');

    const stagedStat = stagedStats.get(f.path) || null;
    const unstagedStat = unstagedStats.get(f.path) || null;

    let additions = (stagedStat?.additions || 0) + (unstagedStat?.additions || 0);
    let deletions = (stagedStat?.deletions || 0) + (unstagedStat?.deletions || 0);
    let binary = Boolean(stagedStat?.binary || unstagedStat?.binary);
    let lineCount = null;

    if (untracked && root) {
      const n = countFileLines(path.join(root, f.path));
      if (n !== null) {
        additions = n;
        lineCount = n;
      } else {
        binary = true;
      }
    }

    // staged / unstaged 양쪽 상태 라벨
    const stagedLabel = staged ? statusLabel(f.index) : null;
    const unstagedLabel = unstaged ? statusLabel(untracked ? '?' : f.worktree) : null;

    return {
      path: f.path,
      origPath: f.origPath,
      staged,
      unstaged,
      untracked,
      conflicted: f.index === 'U' || f.worktree === 'U',
      stagedLabel,
      unstagedLabel,
      label: stagedLabel || unstagedLabel || 'modified',
      additions,
      deletions,
      binary,
      lineCount,
    };
  });

  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    ok: true,
    files,
    staged: files.filter((f) => f.staged),
    unstaged: files.filter((f) => f.unstaged),
    conflicted: files.filter((f) => f.conflicted),
  };
}

/** 통합 diff 텍스트 (커밋 메시지 생성 및 diff 뷰어용) */
async function getDiff(cwd, { staged = false, path: filePath = null } = {}) {
  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  if (filePath) args.push('--', filePath);
  const res = await runGit(cwd, args);
  return { ok: res.ok, diff: res.stdout, error: res.ok ? null : analyzeError(res, 'diff 를 읽을 수 없습니다.') };
}

/** untracked 파일 내용 (diff 뷰어 대체) */
async function readUntracked(cwd, filePath) {
  const root = await getRepoRoot(cwd);
  if (!root) return null;
  try {
    const abs = path.join(root, filePath);
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

async function stage(cwd, paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  if (list.length === 0) return { ok: false, error: 'stage 할 파일이 없습니다.' };
  const res = await runGit(cwd, ['add', '--', ...list]);
  return { ok: res.ok, error: res.ok ? null : analyzeError(res, 'stage 에 실패했습니다.') };
}

async function unstage(cwd, paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  if (list.length === 0) return { ok: false, error: 'unstage 할 파일이 없습니다.' };
  // HEAD 가 없는 저장소에서는 reset 대신 rm --cached 를 사용한다.
  let res = await runGit(cwd, ['reset', 'HEAD', '--', ...list]);
  if (!res.ok && /HEAD/.test(res.stderr)) {
    res = await runGit(cwd, ['rm', '--cached', '-r', '--', ...list]);
  }
  return { ok: res.ok, error: res.ok ? null : analyzeError(res, 'unstage 에 실패했습니다.') };
}

async function stageAll(cwd) {
  const res = await runGit(cwd, ['add', '-A']);
  return { ok: res.ok, error: res.ok ? null : analyzeError(res, '전체 stage 에 실패했습니다.') };
}

async function commit(cwd, message) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: '커밋 메시지가 비어 있습니다.' };

  // 커밋 직전 상태를 남겨두면 undo 로 커밋을 되돌릴 수 있다.
  const snap = await createSnapshot(cwd, `commit: ${msg.split('\n')[0]}`);

  const res = await runGit(cwd, ['commit', '-m', msg]);
  if (!res.ok) {
    return { ok: false, error: analyzeError(res, '커밋에 실패했습니다.'), raw: res.stderr };
  }
  if (snap.ok) {
    await journalPush(cwd, {
      id: snap.snapshot.id,
      action: 'commit',
      at: new Date().toISOString(),
      target: msg.split('\n')[0],
      snapshot: snap.snapshot,
    });
  }
  return { ok: true, summary: res.stdout.trim(), error: null, snapshot: snap.ok ? snap.snapshot : null };
}

async function getBranches(cwd) {
  const res = await runGit(cwd, ['branch', '--format=%(refname:short)']);
  if (!res.ok) return { ok: false, branches: [], error: analyzeError(res, '브랜치 목록을 읽을 수 없습니다.') };
  const current = await getBranch(cwd);
  const branches = res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name, current: name === current }));
  return { ok: true, branches, current };
}

async function checkout(cwd, branchName) {
  if (!branchName || typeof branchName !== 'string') {
    return { ok: false, error: '전환할 브랜치가 지정되지 않았습니다.' };
  }
  const res = await runGit(cwd, ['checkout', branchName]);
  if (!res.ok) {
    return { ok: false, error: analyzeError(res, `'${branchName}' 브랜치로 전환하지 못했습니다.`), raw: res.stderr };
  }
  return { ok: true, output: (res.stdout + res.stderr).trim() };
}

async function createBranch(cwd, branchName, { checkout = true } = {}) {
  if (!branchName || typeof branchName !== 'string') {
    return { ok: false, error: '생성할 브랜치 이름이 필요합니다.' };
  }
  const args = checkout ? ['checkout', '-b', branchName] : ['branch', branchName];
  const res = await runGit(cwd, args);
  if (!res.ok) return { ok: false, error: analyzeError(res, `브랜치 '${branchName}' 생성에 실패했습니다.`) };
  return { ok: true, output: (res.stdout + res.stderr).trim() };
}

async function deleteBranch(cwd, branchName, { force = false } = {}) {
  if (!branchName || typeof branchName !== 'string') {
    return { ok: false, error: '삭제할 브랜치 이름이 필요합니다.' };
  }
  const current = await getBranch(cwd);
  if (branchName === current) {
    return { ok: false, error: '현재 브랜치는 삭제할 수 없습니다. 다른 브랜치로 전환한 뒤 삭제하세요.' };
  }
  const res = await runGit(cwd, ['branch', force ? '-D' : '-d', branchName]);
  if (!res.ok) {
    const merged = /not fully merged|병합되지/.test(res.stderr);
    const hint = merged && !force ? `\n강제로 삭제하려면: autogit branch delete ${branchName} --force` : '';
    return { ok: false, error: `${analyzeError(res, `브랜치 '${branchName}' 삭제에 실패했습니다.`)}${hint}` };
  }
  return { ok: true, output: (res.stdout + res.stderr).trim(), branch: branchName };
}

async function renameBranch(cwd, from, to) {
  if (!from || !to || typeof from !== 'string' || typeof to !== 'string') {
    return { ok: false, error: '사용법: autogit branch rename <기존이름> <새이름>' };
  }
  const res = await runGit(cwd, ['branch', '-m', from, to]);
  if (!res.ok) return { ok: false, error: analyzeError(res, `브랜치 이름을 '${to}'(으)로 바꾸지 못했습니다.`) };
  return { ok: true, output: (res.stdout + res.stderr).trim(), from, to };
}

/**
 * 다른 브랜치를 현재 브랜치로 병합한다.
 * 충돌이 나면 conflict=true 를 반환하되, 워킹트리는 충돌 해결을 위해 그대로 둔다.
 */
async function mergeBranch(cwd, branchName) {
  if (!branchName || typeof branchName !== 'string') {
    return { ok: false, error: '병합할 브랜치 이름이 필요합니다.' };
  }
  const current = await getBranch(cwd);
  if (branchName === current) {
    return { ok: false, error: `현재 브랜치('${branchName}')는 자기 자신과 병합할 수 없습니다.` };
  }
  const res = await runGit(cwd, ['merge', '--no-edit', branchName]);
  const output = `${res.stdout}${res.stderr}`.trim();
  if (!res.ok) {
    if (/CONFLICT|Automatic merge failed|충돌/.test(output)) {
      return {
        ok: false,
        conflict: true,
        error: `'${branchName}' 병합 중 충돌이 발생했습니다. 충돌을 해결하고 커밋하세요.`,
        output,
      };
    }
    return { ok: false, error: analyzeError(res, `'${branchName}' 병합에 실패했습니다.`), output };
  }
  return { ok: true, output, branch: branchName };
}

async function getLog(cwd, limit = 50) {
  const sep = '\u001f';
  const rec = '\u001e';
  const format = ['%H', '%h', '%an', '%ar', '%s'].join(sep) + rec;
  const res = await runGit(cwd, ['log', `--max-count=${Number(limit) || 50}`, `--pretty=format:${format}`]);
  if (!res.ok) {
    // 커밋이 없는 저장소
    if (/does not have any commits|unknown revision/.test(res.stderr)) {
      return { ok: true, commits: [] };
    }
    return { ok: false, commits: [], error: analyzeError(res, '커밋 기록을 읽을 수 없습니다.') };
  }
  const commits = res.stdout
    .split(rec)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, short, author, date, subject] = entry.split(sep);
      return { hash, short, author, date, subject };
    });
  return { ok: true, commits };
}

async function getCommitDiff(cwd, hash) {
  const meta = await runGit(cwd, ['show', '--no-color', '--stat', '--format=%H%n%an%n%ar%n%s%n%n%b', hash]);
  const patch = await runGit(cwd, ['show', '--no-color', '--format=', hash]);
  if (!meta.ok) return { ok: false, error: analyzeError(meta, '커밋을 읽을 수 없습니다.') };
  return { ok: true, meta: meta.stdout, patch: patch.stdout };
}

async function getDefaultBranch(cwd) {
  const res = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (res.ok) return res.stdout.trim().replace(/^origin\//, '');
  return null;
}

async function hasUpstream(cwd) {
  const res = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  return res.ok ? res.stdout.trim() : null;
}

/** push/pull 대상 remote 선택: 명시값 > origin > 첫 번째 */
function pickRemoteName(remotes, wanted) {
  if (wanted) return remotes.some((r) => r.name === wanted) ? wanted : null;
  if (remotes.some((r) => r.name === 'origin')) return 'origin';
  return remotes[0].name;
}

async function pull(cwd, { remote = null, branch = null } = {}) {
  const remotes = await getRemotes(cwd);
  if (remotes.length === 0) {
    return { ok: false, error: '연결된 remote 가 없습니다. 먼저 remote 를 추가하세요. (git remote add origin <url>)' };
  }
  const current = await getBranch(cwd);
  if (!current || current === 'HEAD') {
    return { ok: false, error: 'detached HEAD 상태에서는 pull 할 수 없습니다. 브랜치로 전환하세요.' };
  }
  const remoteName = pickRemoteName(remotes, remote);
  if (!remoteName) return { ok: false, error: `remote '${remote}' 를 찾을 수 없습니다.` };
  const branchName = branch || current;

  // upstream 이 없거나 대상이 명시되면 --set-upstream 으로 맞춘다.
  const opts = [];
  if (!(await hasUpstream(cwd)) || remote || branch) opts.push('--set-upstream', remoteName, branchName);

  let res = await runGit(cwd, ['pull', ...opts], { timeout: 120_000 });
  // README 만 있는 새 원격처럼 히스토리가 무관하면 git 이 거부한다 → 허용하고 재시도.
  if (!res.ok && /unrelated histories/i.test(res.stderr)) {
    res = await runGit(cwd, ['pull', ...opts, '--allow-unrelated-histories'], { timeout: 120_000 });
  }
  if (!res.ok) return { ok: false, error: analyzeError(res, 'pull 에 실패했습니다.'), raw: res.stderr };
  return { ok: true, output: (res.stdout + res.stderr).trim(), upstream: await hasUpstream(cwd) };
}

async function push(cwd, { remote = null, branch = null, setUpstream = false } = {}) {
  const remotes = await getRemotes(cwd);
  if (remotes.length === 0) {
    return { ok: false, error: '연결된 remote 가 없습니다. 먼저 remote 를 추가하세요. (git remote add origin <url>)' };
  }
  if (!(await headSha(cwd))) {
    return { ok: false, error: '아직 커밋이 없습니다. 먼저 커밋한 뒤 push 하세요.' };
  }
  const current = await getBranch(cwd);
  if (!current || current === 'HEAD') {
    return { ok: false, error: 'detached HEAD 상태에서는 push 할 수 없습니다. 브랜치로 전환하세요.' };
  }
  const remoteName = pickRemoteName(remotes, remote);
  if (!remoteName) return { ok: false, error: `remote '${remote}' 를 찾을 수 없습니다.` };
  const branchName = branch || current;

  const has = await hasUpstream(cwd);
  const explicit = Boolean(remote || branch || setUpstream);
  const args = (!has || explicit) ? ['push', '--set-upstream', remoteName, branchName] : ['push'];

  const res = await runGit(cwd, args, { timeout: 120_000 });
  if (res.ok) {
    return {
      ok: true,
      output: (res.stdout + res.stderr).trim(),
      upstream: await hasUpstream(cwd),
      setUpstreamed: !has || explicit,
    };
  }

  // 최초 push 인데 원격에 이미 커밋이 있는 경우: upstream 을 맞춰 두고 pull 로 이어가게 안내한다.
  if (/non-fast-forward|fetch first|\[rejected\]|Updates were rejected/i.test(res.stderr)) {
    await runGit(cwd, ['fetch', remoteName, branchName], { timeout: 120_000 });
    const track = await runGit(cwd, ['branch', `--set-upstream-to=${remoteName}/${branchName}`, branchName]);
    const set = track.ok;
    const trackText = set ? `upstream 을 ${remoteName}/${branchName} 로 맞췄습니다. ` : '';
    return {
      ok: false,
      error: `원격에 이미 커밋이 있어 push 가 거부되었습니다.\n${trackText}먼저 \`autogit pull\` 로 병합한 뒤 다시 push 하세요.\n\n${res.stderr.trim()}`,
      raw: res.stderr,
      upstream: set ? `${remoteName}/${branchName}` : has,
      setUpstream: set,
    };
  }

  return { ok: false, error: analyzeError(res, 'push 에 실패했습니다.'), raw: res.stderr };
}

/* ------------------------------------------------------------------ *
 *  remote 관리
 * ------------------------------------------------------------------ */

/**
 * remote URL 검증.
 * `ext::`, `fd::` 같은 remote helper 는 fetch 시 임의 명령을 실행할 수 있으므로 차단한다.
 */
const SAFE_REMOTE_PATTERNS = [
  /^https:\/\/[^\s]+$/i,
  /^http:\/\/[^\s]+$/i,
  /^ssh:\/\/[^\s]+$/i,
  /^git:\/\/[^\s]+$/i,
  /^file:\/\/[^\s]+$/i,
  /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/, // scp 형식: git@github.com:user/repo.git
];

function validateRemoteUrl(url) {
  const value = String(url || '').trim();
  if (!value) return { ok: false, error: 'remote URL 이 비어 있습니다.' };
  if (value.includes('::')) {
    return { ok: false, error: '보안상 지원하지 않는 URL 형식입니다. https:// 또는 git@host:path 형식을 사용하세요.' };
  }
  if (!SAFE_REMOTE_PATTERNS.some((re) => re.test(value))) {
    return {
      ok: false,
      error: '지원하지 않는 URL 형식입니다.\n예: https://github.com/user/repo.git 또는 git@github.com:user/repo.git',
    };
  }
  return { ok: true, url: value };
}

function validateRemoteName(name) {
  const value = String(name || '').trim();
  if (!value) return { ok: false, error: 'remote 이름이 비어 있습니다.' };
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    return { ok: false, error: 'remote 이름은 영문/숫자/마침표/밑줄/하이픈만 사용할 수 있습니다.' };
  }
  return { ok: true, name: value };
}

/** remote URL 에서 호스트 추출 (자격 증명 저장 대상 결정용) */
function parseRemoteHost(url) {
  const value = String(url || '').trim();
  const scp = value.match(/^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):/);
  if (scp) return scp[1];
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

async function addRemote(cwd, name, url) {
  const n = validateRemoteName(name);
  if (!n.ok) return n;
  const u = validateRemoteUrl(url);
  if (!u.ok) return u;
  const res = await runGit(cwd, ['remote', 'add', n.name, u.url]);
  if (!res.ok) {
    if (/already exists/i.test(res.stderr)) {
      return { ok: false, error: `'${n.name}' remote 가 이미 있습니다. URL 을 바꾸려면 수정을 사용하세요.` };
    }
    return { ok: false, error: analyzeError(res, 'remote 추가에 실패했습니다.') };
  }
  return { ok: true };
}

async function setRemoteUrl(cwd, name, url) {
  const n = validateRemoteName(name);
  if (!n.ok) return n;
  const u = validateRemoteUrl(url);
  if (!u.ok) return u;
  const res = await runGit(cwd, ['remote', 'set-url', n.name, u.url]);
  if (!res.ok) return { ok: false, error: analyzeError(res, 'remote URL 변경에 실패했습니다.') };
  return { ok: true };
}

async function removeRemote(cwd, name) {
  const n = validateRemoteName(name);
  if (!n.ok) return n;
  const res = await runGit(cwd, ['remote', 'remove', n.name]);
  if (!res.ok) return { ok: false, error: analyzeError(res, 'remote 삭제에 실패했습니다.') };
  return { ok: true };
}

async function renameRemote(cwd, from, to) {
  const a = validateRemoteName(from);
  if (!a.ok) return a;
  const b = validateRemoteName(to);
  if (!b.ok) return b;
  const res = await runGit(cwd, ['remote', 'rename', a.name, b.name]);
  if (!res.ok) return { ok: false, error: analyzeError(res, 'remote 이름 변경에 실패했습니다.') };
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 *  자격 증명 (토큰은 절대 argv 로 넘기지 않고 stdin 으로만 전달)
 * ------------------------------------------------------------------ */

function credentialPayload({ protocol = 'https', host, username, password }) {
  const lines = [`protocol=${protocol}`, `host=${host}`];
  if (username) lines.push(`username=${username}`);
  lines.push(`password=${password}`, '');
  return `${lines.join('\n')}\n`;
}

async function credentialApprove(cwd, creds) {
  const res = await runGit(cwd, ['credential', 'approve'], { input: credentialPayload(creds) });
  return { ok: res.ok, error: res.ok ? null : analyzeError(res, '자격 증명 저장에 실패했습니다.') };
}

async function credentialReject(cwd, creds) {
  const res = await runGit(cwd, ['credential', 'reject'], { input: credentialPayload(creds) });
  return { ok: res.ok, error: res.ok ? null : analyzeError(res, '자격 증명 삭제에 실패했습니다.') };
}

/**
 * 자격 증명이 실제로 저장/조회되는지 확인하는 테스트용 헬퍼.
 * (자격 증명을 프롬프트 없이 조회한다)
 */
async function credentialFill(cwd, { protocol = 'https', host }) {
  const res = await runGit(cwd, ['credential', 'fill'], {
    input: credentialPayload({ protocol, host, password: undefined }).replace('password=undefined\n', ''),
  });
  return res;
}

async function getCredentialHelpers(cwd) {
  const res = await runGit(cwd, ['config', '--get-all', 'credential.helper']);
  if (!res.ok) return [];
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 *  시간 되돌리기 (스냅샷 / rewind / undo)
 *
 *  설계:
 *   - 모든 변경 작업 전에 "직전 상태"를 스냅샷으로 남긴다.
 *   - 스냅샷은 HEAD + index tree + 워킹트리 tree(untracked/삭제 포함)를 담는다.
 *   - untracked 까지 담기 위해 임시 index 로 `git add -A` 후 write-tree 한다
 *     (`git stash create -u` 는 -u 를 메시지로 해석해 untracked 를 담지 못한다).
 *   - 스냅샷 객체는 refs/autogit/** 에 ref 로 걸어 GC 로부터 보호한다.
 *   - 저널(.git/autogit/journal.json)에 기록해 undo 로 직전 상태로 돌아간다.
 * ------------------------------------------------------------------ */

const JOURNAL_LIMIT = 50;

async function getGitDir(cwd) {
  const res = await runGit(cwd, ['rev-parse', '--absolute-git-dir']);
  if (res.ok && res.stdout.trim()) return res.stdout.trim();
  const root = await getRepoRoot(cwd);
  return root ? path.join(root, '.git') : null;
}

function journalPath(gitDir) {
  return path.join(gitDir, 'autogit', 'journal.json');
}

function readJournalSync(gitDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath(gitDir), 'utf8'));
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch { /* ignore */ }
  return { version: 1, entries: [] };
}

function writeJournalSync(gitDir, journal) {
  const dir = path.join(gitDir, 'autogit');
  fs.mkdirSync(dir, { recursive: true });
  const trimmed = { version: 1, entries: journal.entries.slice(0, JOURNAL_LIMIT) };
  fs.writeFileSync(journalPath(gitDir), JSON.stringify(trimmed, null, 2));
  return trimmed;
}

async function readJournal(cwd) {
  const gitDir = await getGitDir(cwd);
  if (!gitDir) return { ok: false, entries: [], error: 'Git 저장소가 아닙니다.' };
  return { ok: true, entries: readJournalSync(gitDir).entries };
}

async function headSha(cwd) {
  const res = await runGit(cwd, ['rev-parse', 'HEAD']);
  if (res.ok && res.stdout.trim()) return res.stdout.trim();
  return null;
}

/** 현재 index 내용을 tree 로 (staged 상태 보존용) */
async function writeIndexTree(cwd) {
  const res = await runGit(cwd, ['write-tree']);
  return res.ok ? res.stdout.trim() : null;
}

/** 워킹트리 전체(tracked + untracked + 삭제)를 tree 로 */
async function writeWorktreeTree(cwd) {
  const gitDir = await getGitDir(cwd);
  if (!gitDir) return { ok: false, error: 'Git 저장소가 아닙니다.' };
  const tmpIndex = path.join(gitDir, `autogit-tmp-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    const added = await runGit(cwd, ['add', '-A'], { env });
    if (!added.ok) return { ok: false, error: analyzeError(added, '워킹트리 스냅샷에 실패했습니다.') };
    const tree = await runGit(cwd, ['write-tree'], { env });
    if (!tree.ok) return { ok: false, error: analyzeError(tree, '워킹트리 스냅샷에 실패했습니다.') };
    return { ok: true, tree: tree.stdout.trim() };
  } finally {
    try { fs.rmSync(tmpIndex, { force: true }); } catch { /* ignore */ }
  }
}

async function commitTree(cwd, tree, parents, message) {
  const args = ['commit-tree', tree];
  for (const p of parents) if (p) args.push('-p', p);
  args.push('-m', message);
  const res = await runGit(cwd, args, { input: '' });
  return res.ok ? res.stdout.trim() : null;
}

async function updateRef(cwd, ref, sha) {
  const res = await runGit(cwd, ['update-ref', ref, sha]);
  return { ok: res.ok, error: res.ok ? null : analyzeError(res, 'ref 생성에 실패했습니다.') };
}

async function deleteRef(cwd, ref) {
  const res = await runGit(cwd, ['update-ref', '-d', ref]);
  return { ok: res.ok };
}

/**
 * 현재 상태(HEAD + index + 워킹트리)를 스냅샷으로 저장한다.
 * @returns {{id, createdAt, label, head, branch, wipTree, indexTree, ref}}
 */
async function createSnapshot(cwd, label = 'snapshot') {
  const gitDir = await getGitDir(cwd);
  if (!gitDir) return { ok: false, error: 'Git 저장소가 아닙니다.' };

  const head = await headSha(cwd);
  const branch = await getBranch(cwd);
  const wip = await writeWorktreeTree(cwd);
  if (!wip.ok) return wip;
  const indexTree = (await writeIndexTree(cwd)) || wip.tree;

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const parents = head ? [head] : [];
  const wipCommit = await commitTree(cwd, wip.tree, parents, `autogit snapshot ${id}`);
  const indexCommit = await commitTree(cwd, indexTree, parents, `autogit index ${id}`);
  if (!wipCommit || !indexCommit) return { ok: false, error: '스냅샷 객체를 만들지 못했습니다.' };

  const ref = `refs/autogit/snapshots/${id}`;
  const indexRef = `refs/autogit/index/${id}`;
  const r1 = await updateRef(cwd, ref, wipCommit);
  if (!r1.ok) return r1;
  await updateRef(cwd, indexRef, indexCommit);

  const snapshot = {
    id,
    createdAt: new Date().toISOString(),
    label,
    head,
    branch,
    wipTree: wip.tree,
    indexTree,
    ref,
    indexRef,
  };
  return { ok: true, snapshot };
}

/** 스냅샷의 워킹트리/스테이징 상태를 그대로 복원한다(HEAD 는 건드리지 않음) */
async function applySnapshotState(cwd, snapshot) {
  if (!snapshot || !snapshot.wipTree) return { ok: false, error: '스냅샷 정보가 올바르지 않습니다.' };
  const restoreTree = await runGit(cwd, ['read-tree', '--reset', '-u', snapshot.wipTree]);
  if (!restoreTree.ok) return { ok: false, error: analyzeError(restoreTree, '워킹트리 복원에 실패했습니다.') };
  // index 를 원래 staged 상태로 되돌린다
  await runGit(cwd, ['read-tree', snapshot.indexTree || snapshot.wipTree]);
  return { ok: true };
}

/** HEAD 를 스냅샷 시점으로 되돌리고 워킹트리/스테이징도 복원 */
async function returnToSnapshot(cwd, snapshot) {
  const gitDir = await getGitDir(cwd);
  if (!gitDir) return { ok: false, error: 'Git 저장소가 아닙니다.' };

  if (snapshot.head) {
    const res = await runGit(cwd, ['reset', '--hard', snapshot.head]);
    if (!res.ok) return { ok: false, error: analyzeError(res, 'HEAD 복원에 실패했습니다.') };
  } else {
    // 커밋이 없던 상태로 되돌린다
    await runGit(cwd, ['rm', '-r', '--cached', '--ignore-unmatch', '.']);
    await runGit(cwd, ['update-ref', '-d', 'HEAD']);
  }
  return applySnapshotState(cwd, snapshot);
}

async function journalPush(cwd, entry) {
  const gitDir = await getGitDir(cwd);
  if (!gitDir) return { ok: false };
  const journal = readJournalSync(gitDir);
  journal.entries.unshift(entry);
  writeJournalSync(gitDir, journal);
  return { ok: true };
}

async function journalPop(cwd) {
  const gitDir = await getGitDir(cwd);
  if (!gitDir) return null;
  const journal = readJournalSync(gitDir);
  const [first, ...rest] = journal.entries;
  writeJournalSync(gitDir, { version: 1, entries: rest });
  return first || null;
}

const REWIND_MODES = new Set(['soft', 'mixed', 'hard']);

/**
 * 지정한 시점으로 되돌린다. 항상 되돌리기 전 상태를 스냅샷으로 남긴다.
 *  - soft : 변경 내용은 그대로 두고 staged 로
 *  - mixed: 변경 내용은 그대로 두고 unstaged 로 (기본)
 *  - hard : 워킹트리까지 해당 시점으로 (되돌릴 수 있음 — 스냅샷이 있으므로)
 */
async function rewindTo(cwd, ref, mode = 'mixed') {
  if (!ref) return { ok: false, error: '되돌릴 대상(커밋/ref)을 지정하세요.' };
  if (!REWIND_MODES.has(mode)) {
    return { ok: false, error: `mode 는 soft, mixed, hard 중 하나여야 합니다. (받은 값: ${mode})` };
  }
  const target = await runGit(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!target.ok) return { ok: false, error: `'${ref}' 를 찾을 수 없습니다. 커밋 해시나 브랜치 이름을 확인하세요.` };

  const snap = await createSnapshot(cwd, `rewind → ${ref} (${mode})`);
  if (!snap.ok) return snap;

  const res = await runGit(cwd, ['reset', `--${mode}`, target.stdout.trim()]);
  if (!res.ok) return { ok: false, error: analyzeError(res, '되돌리기에 실패했습니다.'), snapshot: snap.snapshot };

  await journalPush(cwd, {
    id: snap.snapshot.id,
    action: 'rewind',
    at: new Date().toISOString(),
    target: ref,
    mode,
    snapshot: snap.snapshot,
  });

  return { ok: true, snapshot: snap.snapshot, output: (res.stdout + res.stderr).trim() };
}

/** 안전한 반대 커밋 생성(이미 push 한 기록에 사용) */
async function revertCommit(cwd, ref) {
  const target = await runGit(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!target.ok) return { ok: false, error: `'${ref}' 를 찾을 수 없습니다.` };

  const snap = await createSnapshot(cwd, `revert ${ref}`);
  if (!snap.ok) return snap;

  const res = await runGit(cwd, ['revert', '--no-edit', target.stdout.trim()]);
  if (!res.ok) {
    await runGit(cwd, ['revert', '--abort']);
    return { ok: false, error: analyzeError(res, '되돌리기 커밋 생성에 실패했습니다.'), snapshot: snap.snapshot };
  }
  await journalPush(cwd, {
    id: snap.snapshot.id, action: 'revert', at: new Date().toISOString(), target: ref, snapshot: snap.snapshot,
  });
  return { ok: true, snapshot: snap.snapshot, output: (res.stdout + res.stderr).trim() };
}

/**
 * 마지막 AutoGit 작업(커밋/되돌리기 등)을 취소한다.
 * = 그 작업 직전에 찍어둔 스냅샷으로 돌아간다.
 */
async function undoLast(cwd) {
  const journal = await readJournal(cwd);
  if (!journal.ok) return { ok: false, error: journal.error };
  const last = journal.entries[0];
  if (!last) return { ok: false, error: '되돌릴 작업이 없습니다. (기록된 AutoGit 작업이 없음)' };

  const res = await returnToSnapshot(cwd, last.snapshot);
  if (!res.ok) return res;
  await journalPop(cwd);
  return { ok: true, undone: { action: last.action, at: last.at, target: last.target, mode: last.mode } };
}

/**
 * 스냅샷 시점으로 되돌린다.
 *  - restoreHead=true  : HEAD 까지 그 시점으로 (hard)
 *  - restoreHead=false : 파일 내용만 복원(현재 HEAD 유지)
 */
async function restoreSnapshot(cwd, id, { restoreHead = true } = {}) {
  const journal = await readJournal(cwd);
  if (!journal.ok) return { ok: false, error: journal.error };
  const entry = journal.entries.find((e) => e.snapshot && e.snapshot.id === id);
  if (!entry) return { ok: false, error: `스냅샷 '${id}' 을 찾을 수 없습니다.` };

  const snap = await createSnapshot(cwd, `restore ${id} 이전 상태`);
  if (!snap.ok) return snap;

  let result;
  if (restoreHead) result = await returnToSnapshot(cwd, entry.snapshot);
  else result = await applySnapshotState(cwd, entry.snapshot);
  if (!result.ok) return result;

  await journalPush(cwd, {
    id: snap.snapshot.id, action: 'restore', at: new Date().toISOString(), target: id, snapshot: snap.snapshot,
  });
  return { ok: true, snapshot: snap.snapshot, restored: entry.snapshot };
}

/** 저널이 참조하지 않는 스냅샷 ref 정리 */
async function pruneSnapshots(cwd) {
  const gitDir = await getGitDir(cwd);
  if (!gitDir) return { ok: false, error: 'Git 저장소가 아닙니다.' };
  const journal = readJournalSync(gitDir);
  const keep = new Set();
  for (const e of journal.entries) {
    if (e.snapshot) {
      keep.add(e.snapshot.id);
    }
    if (e.id) keep.add(e.id);
  }
  const res = await runGit(cwd, ['for-each-ref', '--format=%(refname)', 'refs/autogit/']);
  if (!res.ok) return { ok: false, error: analyzeError(res, '스냅샷 목록을 읽을 수 없습니다.') };
  const removed = [];
  for (const ref of res.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const id = ref.split('/').pop();
    if (!keep.has(id)) {
      await deleteRef(cwd, ref);
      removed.push(ref);
    }
  }
  return { ok: true, removed };
}

/**
 * git stderr 를 사용자가 다음 행동을 알 수 있는 메시지로 변환한다.
 */
function analyzeError(res, fallback) {
  const raw = ((res && (res.stderr || res.stdout)) || '').trim();
  if (!raw) return fallback;

  if (/not a git repository/i.test(raw)) {
    return '현재 폴더는 Git 저장소가 아닙니다. Git 저장소 안에서 실행하거나 -C <경로> 로 저장소를 지정하세요.';
  }
  if (/git: command not found|git 을\(를\) 찾을 수 없습니다|not recognized as an internal/i.test(raw)) {
    return 'Git 이 설치되어 있지 않거나 PATH 에 없습니다. https://git-scm.com 에서 설치하세요.';
  }
  if (/CONFLICT|Automatic merge failed|fix conflicts|unmerged files|unresolved conflict|Committing is not possible/i.test(raw)) {
    return '병합 충돌(merge conflict)이 발생했습니다. 충돌 파일을 열어 충돌 표시(<<<<<<<)를 해결하고 다시 stage 한 뒤 커밋하세요.\n\n' + raw;
  }
  if (/Please tell me who you are|unable to auto-detect email|empty ident name/i.test(raw)) {
    return 'Git 사용자 정보가 없습니다. 다음을 실행하세요:\n  git config --global user.name "이름"\n  git config --global user.email "you@example.com"';
  }
  if (/nothing to commit|no changes added to commit/i.test(raw)) {
    return '커밋할 변경 사항이 없습니다. 파일을 stage 했는지 확인하세요.';
  }
  if (/pathspec .* did not match/i.test(raw)) {
    return '해당 브랜치/경로를 찾을 수 없습니다. 이름을 확인하세요.\n\n' + raw;
  }
  if (/couldn't find remote ref|no such remote|does not appear to be a git repository/i.test(raw)) {
    return 'remote 브랜치를 찾을 수 없습니다. remote 설정과 브랜치 이름을 확인하세요.\n\n' + raw;
  }
  if (/Permission denied|Authentication failed|could not read Username|Invalid username or password|Support for password authentication was removed/i.test(raw)) {
    return 'GitHub 인증에 실패했습니다. 상단의 "GitHub 로그인"으로 토큰을 등록하거나, 원격 저장소 접근 권한을 확인하세요.\n\n' + raw;
  }
  if (/remote: Repository not found|Repository .* not found/i.test(raw)) {
    return '원격 저장소를 찾을 수 없거나 접근 권한이 없습니다. 저장소 이름과 토큰 권한(repo scope)을 확인하세요.\n\n' + raw;
  }
  if (/You have divergent branches|non-fast-forward|rejected|fetch first/i.test(raw)) {
    return '원격과 로컬 브랜치가 갈라졌습니다. 먼저 pull 을 실행한 뒤 다시 시도하세요.\n\n' + raw;
  }
  if (/local changes.*would be overwritten|Your local changes/i.test(raw)) {
    return '로컬 변경 사항이 덮어써질 수 있어 전환할 수 없습니다. 변경을 커밋하거나 stash 한 뒤 다시 시도하세요.\n\n' + raw;
  }
  return raw;
}

module.exports = {
  runGit,
  getGitVersion,
  isRepo,
  getRepoRoot,
  getBranch,
  getRemotes,
  getStatus,
  getDiff,
  readUntracked,
  stage,
  unstage,
  stageAll,
  commit,
  getBranches,
  checkout,
  createBranch,
  deleteBranch,
  renameBranch,
  mergeBranch,
  getLog,
  getCommitDiff,
  getDefaultBranch,
  hasUpstream,
  pull,
  push,
  // remote 관리
  addRemote,
  setRemoteUrl,
  removeRemote,
  renameRemote,
  validateRemoteUrl,
  validateRemoteName,
  parseRemoteHost,
  // 자격 증명
  credentialApprove,
  credentialReject,
  credentialFill,
  getCredentialHelpers,
  // 시간 되돌리기
  createSnapshot,
  rewindTo,
  undoLast,
  restoreSnapshot,
  revertCommit,
  readJournal,
  pruneSnapshots,
  getGitDir,
  analyzeError,
  // 테스트용 export
  parseStatus,
  parseNumstat,
};
