'use strict';

/**
 * AutoGit 코어 테스트.
 * 실행: node tests/run-tests.js
 *
 * 순수 Node 로 git 래퍼와 커밋 메시지 생성기를 검증한다.
 * 마지막에는 임시 git 저장소를 만들어 status → stage → commit → log 전체 흐름을 확인한다.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const git = require('../src/git');
const tui = require('../src/tui/app');
const { generateCommitMessage, classifyFile, classifyCodeUpdate, diffSignals } = require('../src/commitMessage');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
  }
}

function change(overrides) {
  return {
    path: 'src/a.js',
    origPath: null,
    staged: false,
    unstaged: true,
    untracked: false,
    conflicted: false,
    stagedLabel: null,
    unstagedLabel: 'modified',
    label: 'modified',
    additions: 5,
    deletions: 2,
    binary: false,
    lineCount: null,
    ...overrides,
  };
}

/* ------------------------- 1. status 파싱 ------------------------- */

console.log('\n[status 파싱]');

test('porcelain -z 를 staged/unstaged/untracked 로 분류', () => {
  // "M  a.js\0 M b.js\0?? c.js\0"
  const raw = 'M  a.js\0 M b.js\0?? c.js\0';
  const parsed = git.parseStatus(raw);
  assert.strictEqual(parsed.length, 3);
  assert.deepStrictEqual({ i: parsed[0].index, w: parsed[0].worktree, p: parsed[0].path }, { i: 'M', w: ' ', p: 'a.js' });
  assert.deepStrictEqual({ i: parsed[1].index, w: parsed[1].worktree, p: parsed[1].path }, { i: ' ', w: 'M', p: 'b.js' });
  assert.deepStrictEqual({ i: parsed[2].index, w: parsed[2].worktree, p: parsed[2].path }, { i: '?', w: '?', p: 'c.js' });
});

test('rename 항목은 원본 경로를 함께 파싱', () => {
  const raw = 'R  new.js\0old.js\0';
  const parsed = git.parseStatus(raw);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].index, 'R');
  assert.strictEqual(parsed[0].path, 'new.js');
  assert.strictEqual(parsed[0].origPath, 'old.js');
});

test('numstat 파싱 (binary 포함)', () => {
  const map = git.parseNumstat('10\t3\tsrc/a.js\n-\t-\timg.png\n');
  assert.deepStrictEqual(map.get('src/a.js'), { additions: 10, deletions: 3, binary: false });
  assert.strictEqual(map.get('img.png').binary, true);
});

/* ------------------------- 2. 커밋 메시지 규칙 ------------------------- */

console.log('\n[커밋 메시지 생성]');

test('파일 분류: docs/test/style/config/code', () => {
  assert.strictEqual(classifyFile('README.md'), 'docs');
  assert.strictEqual(classifyFile('src/a.test.js'), 'test');
  assert.strictEqual(classifyFile('tests/api.js'), 'test');
  assert.strictEqual(classifyFile('styles/main.css'), 'style');
  assert.strictEqual(classifyFile('package.json'), 'config');
  assert.strictEqual(classifyFile('.github/workflows/ci.yml'), 'config');
  assert.strictEqual(classifyFile('src/git.js'), 'code');
});

test('새 파일 추가 → feat: add', () => {
  const msg = generateCommitMessage([change({ path: 'src/status-viewer.js', label: 'added', unstagedLabel: 'added' })], '');
  assert.ok(msg.message.startsWith('feat:'), msg.message);
  assert.match(msg.message, /add/);
});

test('문서 변경 → docs', () => {
  const msg = generateCommitMessage([change({ path: 'README.md', label: 'modified' })], '');
  assert.ok(msg.message.startsWith('docs:'), msg.message);
  assert.match(msg.message, /readme/i);
});

test('CSS 변경 → style', () => {
  const msg = generateCommitMessage([change({ path: 'src/styles.css', label: 'modified' })], '');
  assert.ok(msg.message.startsWith('style:'), msg.message);
});

test('테스트 변경 → test', () => {
  const msg = generateCommitMessage([change({ path: 'tests/git.test.js', label: 'modified' })], '');
  assert.ok(msg.message.startsWith('test:'), msg.message);
});

test('설정 변경 → chore', () => {
  const msg = generateCommitMessage([change({ path: 'package.json', label: 'modified' })], '');
  assert.ok(msg.message.startsWith('chore:'), msg.message);
});

test('코드 삭제 → remove', () => {
  const msg = generateCommitMessage([change({ path: 'src/legacy.js', label: 'deleted', unstagedLabel: 'deleted' })], '');
  assert.ok(msg.message.startsWith('remove'), msg.message);
});

test('추가+삭제 균형이면 refactor', () => {
  const diff = [
    '--- a/src/a.js', '+++ b/src/a.js', '@@ -1 +1 @@',
    '-const x = 1;', '+const y = 2;',
    '-if (x) { run(); }', '+if (y) { run(); }',
    '-for (const i of a) { go(i); }', '+for (const j of a) { go(j); }',
  ].join('\n');
  const type = classifyCodeUpdate([change({})], diffSignals(diff));
  assert.strictEqual(type, 'refactor');
});

test('새 선언 추가 감지 → feat', () => {
  const diff = ['--- a/a.js', '+++ b/a.js', '+export function newFeature() {', '+  return 1;', '+}'].join('\n');
  const type = classifyCodeUpdate([change({})], diffSignals(diff));
  assert.strictEqual(type, 'feat');
});

test('여러 파일이 같은 모듈이면 scope 추출', () => {
  const msg = generateCommitMessage([
    change({ path: 'src/commit/panel.js', label: 'modified' }),
    change({ path: 'src/commit/panel.css', label: 'modified' }),
    change({ path: 'src/commit/engine.js', label: 'modified' }),
  ], '');
  assert.ok(msg.scope, 'scope 가 있어야 함');
  assert.ok(msg.message.includes('('), msg.message);
});

test('기존 파일에 함수 추가 → feat: add <symbol>', () => {
  const diff = [
    '--- a/src/panel.js', '+++ b/src/panel.js', '@@ -1,1 +1,5 @@',
    '-export function renderPanel() { return 1; }',
    '+export function renderPanel() { return 1; }',
    '+',
    '+export function closePanel() {',
    '+  return null;',
    '+}',
  ].join('\n');
  const msg = generateCommitMessage([change({ path: 'src/panel.js' })], diff);
  assert.strictEqual(msg.message, 'feat: add closePanel');
});

test('변경 없음 → null', () => {
  assert.strictEqual(generateCommitMessage([], ''), null);
});

test('메시지 길이는 72자 이하 헤더', () => {
  const msg = generateCommitMessage([change({ path: 'src/some/very/deeply/nested/commit-message-generator-helper.js', label: 'modified' })], '');
  const header = msg.message.split('\n')[0];
  assert.ok(header.length <= 72, `len=${header.length}: ${header}`);
});

test('dotfile 만 추가해도 빈 object 가 되지 않는다', () => {
  const msg = generateCommitMessage([change({ path: '.gitignore', label: 'added', unstagedLabel: 'added' })], '');
  assert.ok(msg.subject.trim().length > 0, `empty subject: "${msg.message}"`);
  assert.ok(!/: add\s*$/.test(msg.message), msg.message);
});

test('여러 디렉터리에 흩어진 초기 파일들은 subject + 디렉터리별 본문으로 요약', () => {
  const paths = ['main.js', 'src/a.js', 'src/b.js', 'tests/t.js', 'README.md', '.gitignore'];
  const files = paths.map((p) => change({ path: p, label: 'added', unstagedLabel: 'added', additions: 3, deletions: 0 }));
  const msg = generateCommitMessage(files, '');
  const lines = msg.message.split('\n');
  assert.strictEqual(lines[0], 'feat: add project files');
  const body = lines.slice(2);
  assert.ok(body.some((l) => l.startsWith('- src/:')), msg.message);
  assert.ok(body.some((l) => l.startsWith('- tests:')), msg.message);
  assert.ok(body.some((l) => l.startsWith('- docs:')), msg.message);
  assert.ok(body.some((l) => l.startsWith('- config:')), msg.message);
  assert.ok(body.some((l) => /^- 6 files changed \(\+18 -0\)$/.test(l)), msg.message);
});

test('파일이 1~2개면 본문 없이 subject 만 붙는다', () => {
  const one = generateCommitMessage([change({ path: 'src/a.js' })], '');
  assert.ok(!one.message.includes('\n'), one.message);
  const two = generateCommitMessage([change({ path: 'src/a.js' }), change({ path: 'src/b.js' })], '');
  assert.ok(!two.message.includes('\n'), two.message);
});

test('본문은 최대 줄 수를 넘지 않는다', () => {
  const paths = [];
  for (let d = 0; d < 12; d += 1) {
    for (let i = 0; i < 2; i += 1) paths.push(`mod${d}/file${i}.js`);
  }
  const files = paths.map((p) => change({ path: p, label: 'added', unstagedLabel: 'added' }));
  const msg = generateCommitMessage(files, '');
  const body = msg.message.split('\n').slice(2);
  assert.ok(body.length <= 12, `body lines=${body.length}\n${msg.message}`);
  assert.ok(body[body.length - 1].startsWith('- '), msg.message);
});

test('analyzeError: 충돌/미설정 사용자/remote 오류를 안내문으로 변환', () => {
  const conflict = git.analyzeError({ stderr: 'error: Committing is not possible because you have unmerged files.' }, 'fallback');
  assert.match(conflict, /병합 충돌/);
  const noUser = git.analyzeError({ stderr: '*** Please tell me who you are.' }, 'fallback');
  assert.match(noUser, /user\.name/);
  const notRepo = git.analyzeError({ stderr: 'fatal: not a git repository (or any of the parent directories)' }, 'fallback');
  assert.match(notRepo, /Git 저장소가 아닙니다/);
  const raw = git.analyzeError({ stderr: 'fatal: something unusual happened' }, 'fallback');
  assert.strictEqual(raw, 'fatal: something unusual happened');
});

async function gitMissing() {
  console.log('\n[Git 미설치 감지]');
  await testAsync('PATH 에 git 이 없으면 installed=false 로 보고', async () => {
    const saved = process.env.PATH;
    const savedPathExt = process.env.PATHEXT;
    try {
      process.env.PATH = '';
      process.env.PATHEXT = '';
      const v = await git.getGitVersion();
      assert.strictEqual(v.installed, false);
    } finally {
      process.env.PATH = saved;
      process.env.PATHEXT = savedPathExt;
    }
    // 복구 후에는 정상 감지
    const ok = await git.getGitVersion();
    assert.strictEqual(ok.installed, true);
  });
}

test('remote URL 검증: 정상 형식 허용, remote helper 차단', () => {
  assert.strictEqual(git.validateRemoteUrl('https://github.com/u/r.git').ok, true);
  assert.strictEqual(git.validateRemoteUrl('git@github.com:u/r.git').ok, true);
  assert.strictEqual(git.validateRemoteUrl('ssh://git@github.com/u/r.git').ok, true);
  assert.strictEqual(git.validateRemoteUrl('').ok, false);
  assert.strictEqual(git.validateRemoteUrl('github.com/u/r').ok, false);
  // ext:: 같은 remote helper 는 fetch 시 임의 명령 실행 가능 → 반드시 차단
  const evil = git.validateRemoteUrl('ext::sh -c "touch /tmp/pwned"');
  assert.strictEqual(evil.ok, false);
  assert.match(evil.error, /보안|지원하지/);
  assert.strictEqual(git.validateRemoteUrl('fd::17').ok, false);
});

test('remote 이름 검증', () => {
  assert.strictEqual(git.validateRemoteName('origin').ok, true);
  assert.strictEqual(git.validateRemoteName('up-stream_2').ok, true);
  assert.strictEqual(git.validateRemoteName('').ok, false);
  assert.strictEqual(git.validateRemoteName('bad name').ok, false);
  assert.strictEqual(git.validateRemoteName('a;b').ok, false);
});

test('parseRemoteHost 로 자격 증명 대상 호스트 추출', () => {
  assert.strictEqual(git.parseRemoteHost('https://github.com/u/r.git'), 'github.com');
  assert.strictEqual(git.parseRemoteHost('git@github.com:u/r.git'), 'github.com');
  assert.strictEqual(git.parseRemoteHost('ssh://git@enterprise.example.com/u/r.git'), 'enterprise.example.com');
  assert.strictEqual(git.parseRemoteHost('nonsense'), null);
});

console.log('\n[토큰 붙여넣기 입력 파싱]');

test('여러 문자가 한 청크로 와도 붙여넣기로 인식한다', () => {
  assert.deepStrictEqual(tui.parseInput('ghp_abc123'), [{ paste: 'ghp_abc123' }]);
  assert.deepStrictEqual(tui.parseInput('a'), ['a']);
});

test('브래킷 페이스트 마커를 벗겨낸다', () => {
  assert.deepStrictEqual(tui.parseInput('\u001b[200~ghp_secret_token\u001b[201~'), [{ paste: 'ghp_secret_token' }]);
});

test('붙여넣기와 화살표 키가 섞여도 순서대로 나뉜다', () => {
  const seq = '\u001b[A\u001b[200~tok\u001b[201~\u001b[Bab';
  assert.deepStrictEqual(tui.parseInput(seq), ['up', { paste: 'tok' }, 'down', { paste: 'ab' }]);
});

test('토큰 붙여넣기는 공백/제어 문자를 제거한다', () => {
  assert.strictEqual(tui.sanitizePaste(' ghp_x\n\t ', 'token'), 'ghp_x');
  assert.strictEqual(tui.sanitizePaste('a\r\nb', 'text'), 'a\nb');
  assert.strictEqual(tui.sanitizePaste('a\nb', 'prompt'), 'a b');
});

test('GitHub 오류 메시지 매핑', () => {
  const gh = require('../src/github');
  assert.match(gh.mapApiError(401, { message: 'Bad credentials' }), /유효하지 않거나 만료/);
  assert.match(gh.mapApiError(403, {}), /권한|한도/);
  assert.match(gh.mapApiError(404, {}), /찾을 수 없습니다/);
  assert.match(gh.mapApiError(500, {}), /HTTP 500/);
});

test('GitHub 응답 정규화 및 토큰 URL 노출 검사', () => {
  const gh = require('../src/github');
  const u = gh.normalizeUser({ login: 'octocat', name: null, avatar_url: 'a', html_url: 'h' });
  assert.strictEqual(u.login, 'octocat');
  assert.strictEqual(u.name, 'octocat'); // name 없으면 login 으로 대체
  const r = gh.normalizeRepo({ full_name: 'o/r', name: 'r', owner: { login: 'o' }, private: true, clone_url: 'c', default_branch: 'main' });
  assert.strictEqual(r.fullName, 'o/r');
  assert.strictEqual(r.private, true);
  assert.strictEqual(r.defaultBranch, 'main');
  assert.strictEqual(gh.isTokenInUrl('https://x-access-token:ghp_secret@github.com/u/r.git'), true);
  assert.strictEqual(gh.isTokenInUrl('https://github.com/u/r.git'), false);
});

test('analyzeError: 인증 실패를 로그인 안내로 변환', () => {
  const auth = git.analyzeError({ stderr: 'fatal: Authentication failed for https://github.com/u/r.git' }, 'fallback');
  assert.match(auth, /GitHub 로그인/);
  const notFound = git.analyzeError({ stderr: 'remote: Repository not found.' }, 'fallback');
  assert.match(notFound, /권한|찾을 수 없/);
});

async function remoteE2E() {
  console.log('\n[E2E: remote 연결 + 자격 증명]');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autogit-remote-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  await git.runGit(repo, ['init', '-b', 'main']);
  await git.runGit(repo, ['config', 'user.email', 't@example.com']);
  await git.runGit(repo, ['config', 'user.name', 'T']);

  await testAsync('remote 추가/조회/set-url/이름변경/삭제', async () => {
    const add = await git.addRemote(repo, 'origin', 'https://github.com/octocat/hello.git');
    assert.ok(add.ok, add.error);
    let remotes = await git.getRemotes(repo);
    assert.strictEqual(remotes.length, 1);
    assert.strictEqual(remotes[0].name, 'origin');

    const dup = await git.addRemote(repo, 'origin', 'https://github.com/octocat/other.git');
    assert.strictEqual(dup.ok, false);
    assert.match(dup.error, /이미 있습니다/);

    assert.ok((await git.setRemoteUrl(repo, 'origin', 'https://github.com/octocat/changed.git')).ok);
    remotes = await git.getRemotes(repo);
    assert.match(remotes[0].url, /changed\.git$/);

    assert.ok((await git.renameRemote(repo, 'origin', 'upstream')).ok);
    remotes = await git.getRemotes(repo);
    assert.strictEqual(remotes[0].name, 'upstream');

    assert.ok((await git.removeRemote(repo, 'upstream')).ok);
    assert.strictEqual((await git.getRemotes(repo)).length, 0);
  });

  await testAsync('위험한 remote URL 은 추가되지 않는다', async () => {
    const res = await git.addRemote(repo, 'evil', 'ext::sh -c "echo pwned"');
    assert.strictEqual(res.ok, false);
    assert.strictEqual((await git.getRemotes(repo)).length, 0);
  });

  await testAsync('자격 증명 approve → fill 왕복 (토큰은 stdin 으로만 전달)', async () => {
    // 중요: 이 테스트는 사용자의 실제 자격 증명(GCM 등)에 절대 접근하면 안 된다.
    //  - 전역/시스템 git 설정을 비워 다른 credential helper 를 배제하고,
    //  - 실제로 존재하지 않는 호스트(.invalid)를 사용한다.
    const store = path.join(tmp, 'creds.txt').replace(/\\/g, '/');
    const emptyGlobal = path.join(tmp, 'empty-global');
    const emptySystem = path.join(tmp, 'empty-system');
    fs.writeFileSync(emptyGlobal, '');
    fs.writeFileSync(emptySystem, '');

    const savedEnv = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    };
    process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
    process.env.GIT_CONFIG_SYSTEM = emptySystem;
    process.env.GIT_CONFIG_NOSYSTEM = '1';

    try {
      await git.runGit(repo, ['config', 'credential.helper', `store --file=${store}`]);
      const host = 'github.invalid';
      const token = 'test-token-not-real';

      const helpers = await git.getCredentialHelpers(repo);
      assert.deepStrictEqual(helpers, [`store --file=${store}`], '테스트 helper 만 활성이어야 함');

      const approved = await git.credentialApprove(repo, {
        protocol: 'https',
        host,
        username: 'x-access-token',
        password: token,
      });
      assert.ok(approved.ok, approved.error);

      const filled = await git.credentialFill(repo, { protocol: 'https', host });
      assert.ok(filled.ok, filled.stderr);
      assert.match(filled.stdout, /username=x-access-token/);
      assert.ok(filled.stdout.includes(`password=${token}`), '저장된 토큰을 조회할 수 있어야 함');

      // 자격 증명 헬퍼 저장소에 기록됐는지 확인
      const stored = fs.readFileSync(store, 'utf8');
      assert.ok(stored.includes(token));

      const rejected = await git.credentialReject(repo, {
        protocol: 'https',
        host,
        username: 'x-access-token',
        password: token,
      });
      assert.ok(rejected.ok, rejected.error);
      const after = await git.credentialFill(repo, { protocol: 'https', host });
      assert.ok(!after.stdout.includes(token), 'reject 후에는 토큰이 조회되지 않아야 함');
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function githubFlow() {
  console.log('\n[GitHub 로그인 흐름 (mock API — 실제 계정 미사용)]');

  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(__dirname, 'mock-github-server.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('mock server 시작 실패')), 10000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/LISTENING (\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('error', reject);
  });

  const gh = require('../src/github');
  const savedBase = process.env.AUTOGIT_GITHUB_API_BASE;
  const savedConfig = process.env.AUTOGIT_CONFIG_DIR;
  // 실제 사용자 설정(%APPDATA%/autogit)을 건드리지 않도록 임시 디렉터리를 쓴다.
  process.env.AUTOGIT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'autogit-cfg-'));
  process.env.AUTOGIT_GITHUB_API_BASE = `http://127.0.0.1:${port}`;
  await gh.logout();

  try {
    await testAsync('잘못된 토큰은 401 안내 메시지로 거부된다', async () => {
      const res = await gh.loginWithToken('wrong-token');
      assert.strictEqual(res.ok, false);
      assert.match(res.error, /유효하지 않거나 만료/);
      assert.strictEqual(gh.getStatus().loggedIn, false);
    });

    await testAsync('빈 토큰/공백 포함 토큰 거부', async () => {
      assert.strictEqual((await gh.loginWithToken('   ')).ok, false);
      assert.match((await gh.loginWithToken('a b c')).error, /공백/);
    });

    await testAsync('정상 토큰 로그인 → 사용자/스코프/저장소 목록', async () => {
      const res = await gh.loginWithToken('good-token');
      assert.ok(res.ok, res.error);
      assert.strictEqual(res.user.login, 'mockuser');
      assert.deepStrictEqual(res.scopes, ['repo', 'read:user']);

      const st = gh.getStatus();
      assert.strictEqual(st.loggedIn, true);
      assert.strictEqual(st.user.login, 'mockuser');

      const repos = await gh.listRepos();
      assert.ok(repos.ok, repos.error);
      assert.strictEqual(repos.repos.length, 2);
      assert.strictEqual(repos.repos[1].private, true);
      assert.strictEqual(repos.repos[0].cloneUrl, 'https://github.com/mockuser/hello.git');
    });

    await testAsync('저장소 생성 → clone URL, 중복 이름은 422 안내', async () => {
      const ok = await gh.createRepo({ name: 'newrepo' });
      assert.ok(ok.ok, ok.error);
      assert.strictEqual(ok.repo.cloneUrl, 'https://github.com/mockuser/newrepo.git');
      const dup = await gh.createRepo({ name: 'taken' });
      assert.strictEqual(dup.ok, false);
      assert.match(dup.error, /거부|입력/);
      const bad = await gh.createRepo({ name: 'bad name!' });
      assert.strictEqual(bad.ok, false);
    });

    await testAsync('로그아웃 시 세션 정리', async () => {
      assert.ok((await gh.loginWithToken('good-token')).ok);
      assert.strictEqual(gh.getStatus().loggedIn, true);
      assert.ok((await gh.logout()).ok);
      assert.strictEqual(gh.getStatus().loggedIn, false);
      assert.strictEqual((await gh.listRepos()).ok, false);
    });
  } finally {
    if (savedBase === undefined) delete process.env.AUTOGIT_GITHUB_API_BASE;
    else process.env.AUTOGIT_GITHUB_API_BASE = savedBase;
    if (savedConfig === undefined) delete process.env.AUTOGIT_CONFIG_DIR;
    else process.env.AUTOGIT_CONFIG_DIR = savedConfig;
    child.kill();
  }
}

async function rewindE2E() {
  console.log('\n[E2E: 시간 되돌리기 (스냅샷/rewind/undo)]');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autogit-rewind-'));
  const repo = path.join(tmp, 'r');
  fs.mkdirSync(repo);
  const g = (...a) => git.runGit(repo, a);
  const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8').replace(/\r\n/g, '\n');
  const statusText = async () => (await g('status', '--porcelain', '-uall')).stdout.trim();

  await g('init', '-b', 'main');
  await g('config', 'user.email', 't@e.com');
  await g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
  await g('add', '-A');
  await git.commit(repo, 'chore: init');
  const head1 = (await g('rev-parse', 'HEAD')).stdout.trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v2\n');
  await g('add', '-A');
  await git.commit(repo, 'feat: v2');
  const head2 = (await g('rev-parse', 'HEAD')).stdout.trim();

  await testAsync('커밋하면 되돌리기용 스냅샷이 자동 기록된다', async () => {
    const journal = await git.readJournal(repo);
    assert.ok(journal.ok);
    assert.ok(journal.entries.length >= 2, '커밋 2건이 기록되어야 함');
    assert.strictEqual(journal.entries[0].action, 'commit');
    assert.ok(journal.entries[0].snapshot.ref.startsWith('refs/autogit/snapshots/'));
    // ref 가 실제로 존재해야 GC 로 사라지지 않는다
    const ref = await g('rev-parse', '--verify', journal.entries[0].snapshot.ref);
    assert.ok(ref.ok, '스냅샷 ref 가 존재해야 함');
  });

  await testAsync('hard rewind → 해당 시점 내용으로 되돌아간다', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'v3-wip\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'brand new\n');
    assert.match(await statusText(), /new\.txt/);

    const res = await git.rewindTo(repo, head1, 'hard');
    assert.ok(res.ok, res.error);
    assert.strictEqual((await g('rev-parse', 'HEAD')).stdout.trim(), head1);
    assert.strictEqual(read('a.txt'), 'v1\n');
    // hard reset 은 git 규칙상 untracked 를 지우지 않는다(안전)
    assert.strictEqual(fs.existsSync(path.join(repo, 'new.txt')), true);
  });

  await testAsync('undo → 되돌리기 직전 상태를 staged 구분까지 복원', async () => {
    const res = await git.undoLast(repo);
    assert.ok(res.ok, res.error);
    assert.strictEqual(res.undone.action, 'rewind');
    assert.strictEqual((await g('rev-parse', 'HEAD')).stdout.trim(), head2);
    assert.strictEqual(read('a.txt'), 'v3-wip\n');
    assert.strictEqual(read('new.txt'), 'brand new\n');
    assert.strictEqual(await statusText(), 'M a.txt\n?? new.txt');
  });

  await testAsync('undo → 커밋 자체를 되돌리면 변경이 staged 로 남는다', async () => {
    const res = await git.undoLast(repo);
    assert.ok(res.ok, res.error);
    assert.strictEqual(res.undone.action, 'commit');
    assert.strictEqual((await g('rev-parse', 'HEAD')).stdout.trim(), head1);
    const st = await statusText();
    assert.match(st, /^M {2}a\.txt/); // staged (index) 상태로 복원
  });

  await testAsync('soft/mixed rewind 동작과 모드 검증', async () => {
    const bad = await git.rewindTo(repo, head1, 'nonsense');
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /soft, mixed, hard/);
    const missing = await git.rewindTo(repo, 'no-such-ref', 'soft');
    assert.strictEqual(missing.ok, false);
    assert.match(missing.error, /찾을 수 없습니다/);

    await git.commit(repo, 'chore: restage');
    const soft = await git.rewindTo(repo, 'HEAD~1', 'soft');
    assert.ok(soft.ok, soft.error);
    assert.match(await statusText(), /^M {2}a\.txt/);
    assert.ok((await git.undoLast(repo)).ok);
  });

  await testAsync('revert 는 기록을 남기는 안전한 되돌리기', async () => {
    const before = (await g('rev-parse', 'HEAD')).stdout.trim();
    const res = await git.revertCommit(repo, before);
    assert.ok(res.ok, res.error);
    const after = (await g('rev-parse', 'HEAD')).stdout.trim();
    assert.notStrictEqual(after, before);
    assert.match((await g('log', '-1', '--format=%s')).stdout, /^Revert/);
  });

  await testAsync('저널에 없는 스냅샷 ref 는 prune 로 정리된다', async () => {
    const before = (await g('for-each-ref', '--format=%(refname)', 'refs/autogit/')).stdout.trim().split('\n').filter(Boolean);
    assert.ok(before.length > 0);
    // 저널을 비우면 모든 스냅샷이 고아가 된다
    const gitDir = await git.getGitDir(repo);
    fs.writeFileSync(path.join(gitDir, 'autogit', 'journal.json'), JSON.stringify({ version: 1, entries: [] }));
    const pruned = await git.pruneSnapshots(repo);
    assert.ok(pruned.ok, pruned.error);
    assert.strictEqual(pruned.removed.length, before.length);
    const after = (await g('for-each-ref', '--format=%(refname)', 'refs/autogit/')).stdout.trim();
    assert.strictEqual(after, '');
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function pushE2E() {
  console.log('\n[E2E: 최초 push upstream]');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autogit-push-'));
  const bare = path.join(tmp, 'remote.git');
  const bare2 = path.join(tmp, 'remote2.git');
  await git.runGit(tmp, ['init', '--bare', '-b', 'main', bare]);
  await git.runGit(tmp, ['init', '--bare', '-b', 'main', bare2]);

  const makeRepo = async (dir, remotePath = bare) => {
    const repo = path.join(tmp, dir);
    fs.mkdirSync(repo);
    await git.runGit(repo, ['init', '-b', 'main']);
    await git.runGit(repo, ['config', 'user.email', 't@e.com']);
    await git.runGit(repo, ['config', 'user.name', 'T']);
    await git.runGit(repo, ['remote', 'add', 'origin', remotePath]);
    return repo;
  };

  const local = await makeRepo('local');
  fs.writeFileSync(path.join(local, 'a.txt'), 'v1\n');
  await git.runGit(local, ['add', '-A']);
  await git.commit(local, 'chore: init');

  await testAsync('최초 push 가 upstream 을 자동 설정한다', async () => {
    const res = await git.push(local);
    assert.ok(res.ok, res.error);
    assert.strictEqual(res.setUpstreamed, true);
    assert.strictEqual(res.upstream, 'origin/main');
    assert.strictEqual(await git.hasUpstream(local), 'origin/main');
  });

  await testAsync('커밋 없는 저장소 push 는 명확히 거부', async () => {
    const empty = await makeRepo('empty');
    const res = await git.push(empty);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /커밋/);
  });

  await testAsync('명시한 remote/branch 로도 upstream 을 맞춘다', async () => {
    const other = await makeRepo('other', bare2);
    fs.writeFileSync(path.join(other, 'b.txt'), 'x\n');
    await git.runGit(other, ['add', '-A']);
    await git.commit(other, 'chore: other');
    const res = await git.push(other, { remote: 'origin', branch: 'main' });
    assert.ok(res.ok, res.error);
    assert.strictEqual(await git.hasUpstream(other), 'origin/main');
  });

  const local2 = await makeRepo('local2');
  fs.writeFileSync(path.join(local2, 'c.txt'), 'v1\n');
  await git.runGit(local2, ['add', '-A']);
  await git.commit(local2, 'chore: local init');

  await testAsync('원격에 커밋이 있어도 upstream 을 맞추고 pull 로 이어간다', async () => {
    const res = await git.push(local2);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.setUpstream, true);
    assert.strictEqual(await git.hasUpstream(local2), 'origin/main');

    const pulled = await git.pull(local2);
    assert.ok(pulled.ok, pulled.error);
    const pushed = await git.push(local2);
    assert.ok(pushed.ok, pushed.error);
    assert.strictEqual(await git.hasUpstream(local2), 'origin/main');
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function cliE2E() {
  console.log('\n[E2E: 헤드리스 CLI]');

  const { spawnSync } = require('child_process');
  const bin = path.join(__dirname, '..', 'bin', 'autogit.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autogit-cli-'));
  const repo = path.join(tmp, 'r');
  fs.mkdirSync(repo);
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'autogit-cli-cfg-'));
  const g = (...a) => git.runGit(repo, a);

  const cli = (args, opts = {}) => spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AUTOGIT_CONFIG_DIR: cfg },
    ...opts,
  });

  await g('init', '-b', 'main');
  await g('config', 'user.email', 't@e.com');
  await g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'app.js'), 'function main() {}\n');
  await g('add', '-A');
  await git.commit(repo, 'chore: init');

  await testAsync('--help 는 사용법을 출력하고 0 으로 종료', () => {
    const r = cli(['--help']);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /AutoGit/);
    assert.match(r.stdout, /시간 되돌리기/);
  });

  await testAsync('알 수 없는 명령은 exit code 2', () => {
    const r = cli(['nope']);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /알 수 없는 명령/);
  });

  await testAsync('status --json 이 변경 사항을 구조화해 출력', () => {
    fs.writeFileSync(path.join(repo, 'app.js'), 'function main() { return 1; }\n');
    fs.writeFileSync(path.join(repo, 'new.md'), '# new\n');
    const r = cli(['-C', repo, 'status', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.branch, 'main');
    const paths = data.files.map((f) => f.path);
    assert.ok(paths.includes('app.js'));
    assert.ok(paths.includes('new.md'));
    assert.strictEqual(data.unstagedCount, 2);
  });

  await testAsync('msg 는 커밋 메시지만 stdout 으로 출력', () => {
    const r = cli(['-C', repo, 'msg']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout.trim().split('\n')[0], /^feat: /);
  });

  await testAsync('commit --auto 는 생성한 메시지로 커밋', async () => {
    cli(['-C', repo, 'stage', '--all']);
    const r = cli(['-C', repo, 'commit', '--auto']);
    assert.strictEqual(r.status, 0, r.stderr);
    const subject = await g('log', '-1', '--format=%s');
    assert.match(subject.stdout.trim(), /^feat: /);
  });

  await testAsync('branch new/switch/rename/delete (CLI)', async () => {
    const created = cli(['-C', repo, 'branch', 'new', 'feature/cli']);
    assert.strictEqual(created.status, 0, created.stderr);
    assert.match(created.stdout, /생성 후 전환/);
    assert.strictEqual((await g('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'feature/cli');

    const listed = cli(['-C', repo, 'branch', 'list', '--json']);
    assert.strictEqual(listed.status, 0);
    const data = JSON.parse(listed.stdout);
    assert.ok(data.branches.find((b) => b.name === 'feature/cli' && b.current));

    const renamed = cli(['-C', repo, 'branch', 'rename', 'feature/cli', 'feature/renamed']);
    assert.strictEqual(renamed.status, 0, renamed.stderr);

    const switched = cli(['-C', repo, 'branch', 'switch', 'main']);
    assert.strictEqual(switched.status, 0, switched.stderr);
    assert.strictEqual((await g('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'main');

    const deleted = cli(['-C', repo, 'branch', 'delete', 'feature/renamed']);
    assert.strictEqual(deleted.status, 0, deleted.stderr);
    const after = JSON.parse(cli(['-C', repo, 'branches', '--json']).stdout);
    assert.ok(!after.branches.find((b) => b.name === 'feature/renamed'));
  });

  await testAsync('branch new --no-switch 는 전환하지 않는다', () => {
    const r = cli(['-C', repo, 'branch', 'new', 'feature/stay', '--no-switch']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /생성했습니다/);
  });

  await testAsync('현재 브랜치 삭제는 거부 (CLI)', () => {
    const r = cli(['-C', repo, 'branch', 'delete', 'main']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /현재 브랜치/);
  });

  await testAsync('rewind → undo 왕복 (CLI)', async () => {
    const head1 = (await g('rev-parse', 'HEAD')).stdout.trim();
    fs.writeFileSync(path.join(repo, 'app.js'), 'function main() { return 2; }\n');
    await g('add', '-A');
    await git.commit(repo, 'feat: two');
    const head2 = (await g('rev-parse', 'HEAD')).stdout.trim();

    const rw = cli(['-C', repo, 'rewind', head1, '--mode', 'hard']);
    assert.strictEqual(rw.status, 0, rw.stderr);
    assert.match(rw.stdout, /되돌렸습니다/);
    assert.strictEqual((await g('rev-parse', 'HEAD')).stdout.trim(), head1);

    const snaps = cli(['-C', repo, 'snapshots', '--json']);
    assert.strictEqual(snaps.status, 0);
    assert.ok(JSON.parse(snaps.stdout).snapshots.length > 0);

    const undo = cli(['-C', repo, 'undo']);
    assert.strictEqual(undo.status, 0, undo.stderr);
    assert.match(undo.stdout, /취소했습니다/);
    assert.strictEqual((await g('rev-parse', 'HEAD')).stdout.trim(), head2);
  });

  await testAsync('Git 저장소가 아니면 status 는 exit 1 + 안내', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'autogit-nonrepo-'));
    const r = cli(['-C', bare, 'status']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /Git 저장소가 아닙니다/);
    fs.rmSync(bare, { recursive: true, force: true });
  });

  await testAsync('remote add/list/remove (CLI)', () => {
    assert.strictEqual(cli(['-C', repo, 'remote', 'add', 'origin', 'https://github.com/u/r.git']).status, 0);
    const list = cli(['-C', repo, 'remote', 'list', '--json']);
    assert.strictEqual(JSON.parse(list.stdout).remotes[0].name, 'origin');
    const bad = cli(['-C', repo, 'remote', 'add', 'evil', 'ext::sh -c whoami']);
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stderr, /보안|지원하지/);
    assert.strictEqual(cli(['-C', repo, 'remote', 'remove', 'origin']).status, 0);
  });

  await testAsync('push 는 최초에 upstream 을 자동 설정한다 (CLI)', async () => {
    const bare = path.join(tmp, 'remote.git');
    await g('init', '--bare', '-b', 'main', bare);
    await g('remote', 'add', 'origin', bare);
    const r = cli(['-C', repo, 'push']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /upstream origin\/main/);
    const up = await g('rev-parse', '--abbrev-ref', '@{u}');
    assert.strictEqual(up.stdout.trim(), 'origin/main');
  });

  await testAsync('github status 는 미로그인 안내 (실제 계정 미사용)', () => {
    const r = cli(['-C', repo, 'github', 'status']);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /로그인되어 있지 않습니다/);
  });

  await testAsync('github login 은 stdin(파이프) 토큰을 읽는다', () => {
    const spaced = cli(['-C', repo, 'github', 'login'], { input: 'ghp_ with space\n' });
    assert.strictEqual(spaced.status, 1);
    assert.match(spaced.stderr, /공백/);
    const empty = cli(['-C', repo, 'github', 'login'], { input: '\n' });
    assert.strictEqual(empty.status, 1);
    assert.match(empty.stderr, /토큰이 필요합니다/);
  });

  await testAsync('tui 는 TTY 가 아니면 명확히 거부', () => {
    const r = cli(['-C', repo, 'tui']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /TTY/);
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(cfg, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ------------------------- 3. 실제 git E2E ------------------------- */

async function e2e() {
  console.log('\n[E2E: 임시 저장소 status → stage → commit]');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autogit-test-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);

  const g = (args) => git.runGit(repo, args);

  await testAsync('git init 및 사용자 설정', async () => {
    const init = await g(['init', '-b', 'main']);
    assert.ok(init.ok, init.stderr);
    await g(['config', 'user.email', 'test@example.com']);
    await g(['config', 'user.name', 'AutoGit Test']);
  });

  await testAsync('isRepo / getBranch', async () => {
    assert.strictEqual(await git.isRepo(repo), true);
    assert.strictEqual(await git.getBranch(repo), 'main');
  });

  await testAsync('빈 저장소 status 는 성공 + 0개 파일', async () => {
    const st = await git.getStatus(repo);
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.files.length, 0);
  });

  await testAsync('untracked 파일 감지 및 줄 수 계산', async () => {
    fs.writeFileSync(path.join(repo, 'app.js'), 'const a = 1;\nconst b = 2;\n');
    fs.writeFileSync(path.join(repo, 'README.md'), '# hi\n');
    const st = await git.getStatus(repo);
    assert.strictEqual(st.ok, true);
    const app = st.files.find((f) => f.path === 'app.js');
    assert.ok(app, 'app.js 가 보여야 함');
    assert.strictEqual(app.untracked, true);
    assert.strictEqual(app.additions, 2);
  });

  await testAsync('메시지 생성 → feat', async () => {
    const st = await git.getStatus(repo);
    const msg = generateCommitMessage(st.files, '');
    assert.ok(msg.message.startsWith('feat:'), msg.message);
  });

  await testAsync('stage 후 staged 로 분류', async () => {
    const res = await git.stage(repo, ['app.js']);
    assert.ok(res.ok, res.error);
    const st = await git.getStatus(repo);
    const app = st.files.find((f) => f.path === 'app.js');
    assert.strictEqual(app.staged, true);
    assert.strictEqual(app.untracked, false);
    assert.strictEqual(st.staged.length, 1);
    assert.strictEqual(st.unstaged.length, 1); // README.md
  });

  await testAsync('unstage 동작 (HEAD 없는 저장소)', async () => {
    const res = await git.unstage(repo, ['app.js']);
    assert.ok(res.ok, res.error);
    const st = await git.getStatus(repo);
    assert.strictEqual(st.staged.length, 0);
    await git.stage(repo, ['app.js', 'README.md']);
  });

  await testAsync('commit 성공 및 log 에 반영', async () => {
    const res = await git.commit(repo, 'feat: add initial app');
    assert.ok(res.ok, res.error);
    const log = await git.getLog(repo);
    assert.strictEqual(log.ok, true);
    assert.strictEqual(log.commits.length, 1);
    assert.strictEqual(log.commits[0].subject, 'feat: add initial app');
    const st = await git.getStatus(repo);
    assert.strictEqual(st.files.length, 0);
  });

  await testAsync('커밋 후 수정 → modified 표시', async () => {
    fs.writeFileSync(path.join(repo, 'app.js'), 'const a = 1;\nconst b = 3;\n');
    const st = await git.getStatus(repo);
    assert.strictEqual(st.files.length, 1);
    assert.strictEqual(st.files[0].unstaged, true);
    assert.strictEqual(st.files[0].additions, 1);
    assert.strictEqual(st.files[0].deletions, 1);
  });

  await testAsync('diff 조회', async () => {
    const res = await git.getDiff(repo, {});
    assert.ok(res.ok);
    assert.match(res.diff, /const b = 3/);
  });

  await testAsync('빈 메시지 커밋 거부', async () => {
    const res = await git.commit(repo, '   ');
    assert.strictEqual(res.ok, false);
  });

  await testAsync('브랜치 생성 및 전환', async () => {
    const created = await git.createBranch(repo, 'feature/x');
    assert.ok(created.ok, created.error);
    assert.strictEqual(await git.getBranch(repo), 'feature/x');
    const back = await git.checkout(repo, 'main');
    assert.ok(back.ok, back.error);
    assert.strictEqual(await git.getBranch(repo), 'main');
    const list = await git.getBranches(repo);
    assert.ok(list.branches.find((b) => b.name === 'feature/x'));
    assert.ok(list.branches.find((b) => b.name === 'main' && b.current));
  });

  await testAsync('없는 브랜치 전환 시 친절한 오류', async () => {
    const res = await git.checkout(repo, 'no-such-branch');
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /찾을 수 없습니다|확인/);
  });

  await testAsync('remote 없을 때 push 안내 메시지', async () => {
    const res = await git.push(repo);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /remote/);
  });

  await testAsync('커밋 diff 조회', async () => {
    const log = await git.getLog(repo);
    const res = await git.getCommitDiff(repo, log.commits[0].hash);
    assert.ok(res.ok);
    assert.match(res.patch, /initial app|app\.js/);
  });

  await testAsync('브랜치 rename/delete/merge (git)', async () => {
    await git.stageAll(repo);
    const chk = await git.commit(repo, 'chore: checkpoint');
    assert.ok(chk.ok, chk.error);

    const created = await git.createBranch(repo, 'feature/tmp');
    assert.ok(created.ok, created.error);
    const renamed = await git.renameBranch(repo, 'feature/tmp', 'feature/tmp2');
    assert.ok(renamed.ok, renamed.error);
    assert.strictEqual(await git.getBranch(repo), 'feature/tmp2');

    fs.writeFileSync(path.join(repo, 'merge.txt'), 'from feature\n');
    await git.stageAll(repo);
    assert.ok((await git.commit(repo, 'feat: merge source')).ok);

    assert.ok((await git.checkout(repo, 'main')).ok);
    const merged = await git.mergeBranch(repo, 'feature/tmp2');
    assert.ok(merged.ok, merged.error);
    assert.ok(fs.existsSync(path.join(repo, 'merge.txt')));

    const del = await git.deleteBranch(repo, 'feature/tmp2');
    assert.ok(del.ok, del.error);
    const list = await git.getBranches(repo);
    assert.ok(!list.branches.find((b) => b.name === 'feature/tmp2'));
  });

  await testAsync('현재 브랜치는 삭제할 수 없다 (git)', async () => {
    const res = await git.deleteBranch(repo, 'main');
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /현재 브랜치/);
  });

  await testAsync('병합 안 된 브랜치는 일반 삭제 거부, --force 로 삭제', async () => {
    assert.ok((await git.createBranch(repo, 'feature/unmerged')).ok);
    fs.writeFileSync(path.join(repo, 'only-here.txt'), 'x\n');
    await git.stageAll(repo);
    assert.ok((await git.commit(repo, 'feat: unmerged')).ok);
    assert.ok((await git.checkout(repo, 'main')).ok);

    const normal = await git.deleteBranch(repo, 'feature/unmerged');
    assert.strictEqual(normal.ok, false);
    assert.match(normal.error, /강제로 삭제|not fully merged|병합/);

    const forced = await git.deleteBranch(repo, 'feature/unmerged', { force: true });
    assert.ok(forced.ok, forced.error);
  });

  // cleanup
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function main() {
  await gitMissing();
  await remoteE2E();
  await githubFlow();
  await rewindE2E();
  await pushE2E();
  await cliE2E();
  await e2e();
  console.log(`\n결과: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
