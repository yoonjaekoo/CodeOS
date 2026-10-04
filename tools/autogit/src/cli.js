'use strict';

/**
 * 헤드리스 CLI.
 * TTY 없이도 모든 기능을 스크립트로 쓸 수 있어야 한다.
 * (TUI 는 `autogit tui` 또는 인자 없이 TTY 일 때만 실행)
 */

const path = require('path');
const git = require('./git');
const github = require('./github');
const { generateCommitMessage } = require('./commitMessage');

const HELP = `AutoGit — 터미널 Git 도구 (AI 없이 규칙 기반 커밋 메시지)

사용법: autogit [명령] [옵션]

기본
  (인자 없음)            대화형 TUI 실행 (TTY 필요)
  status                 현재 변경 사항 요약
  msg                    커밋 메시지 생성 (커밋하지 않고 stdout 출력)
  stage <경로...>        파일 stage            (--all: 전체)
  unstage <경로...>      파일 unstage          (--all: 전체)
  commit -m "메시지"     커밋
  commit --auto          메시지를 자동 생성해 커밋
  log [-n 개수]          커밋 기록
  branches               브랜치 목록
  checkout <브랜치>      브랜치 전환
  branch                 브랜치 목록 (list)
  branch new <이름>      브랜치 생성 후 전환 (--no-switch: 전환 없이 생성)
  branch switch <이름>   브랜치 전환
  branch delete <이름>   브랜치 삭제 (-d; --force: 병합 안 됐어도 삭제)
  branch rename <A> <B>  브랜치 이름 변경
  branch merge <이름>    현재 브랜치로 병합

시간 되돌리기
  rewind <커밋> [--mode soft|mixed|hard]   해당 시점으로 되돌리기 (자동 스냅샷)
  undo                                     마지막 AutoGit 작업 취소
  snapshots                                스냅샷(되돌릴 지점) 목록
  restore <스냅샷id> [--files-only]        스냅샷 시점으로 복구
  revert <커밋>                            안전한 반대 커밋 생성

원격
  remote list                              remote 목록
  remote add <이름> <URL>                  remote 추가
  remote set-url <이름> <URL>              remote URL 변경
  remote remove <이름>                     remote 삭제
  pull [remote] [branch]                   원격 동기화 (upstream 자동 설정)
  push [remote] [branch] [-u]              원격 동기화 (최초 push 는 upstream 자동 설정)

GitHub
  github status                            로그인 상태
  github login --token <토큰>              토큰으로 로그인
  github login                             토큰을 stdin(붙여넣기/파이프)으로 받아 로그인
  github login --gh                        gh CLI 토큰 사용
  github logout
  github repos                             내 저장소 목록
  github create <이름> [--private]         저장소 생성 + origin 연결

전역 옵션
  -C <경로>      저장소 경로 지정 (기본: 현재 폴더)
  --json         결과를 JSON 으로 출력
  -h, --help     도움말
`;

/** 아주 단순한 인자 파서: `--flag`, `--key value`, 위치 인자 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1 && arg !== '-') {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** 표준입력을 끝까지 읽는다(붙여넣기/파이프로 토큰 전달). */
function readStream(stream) {
  return new Promise((resolve) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => { data += d; });
    stream.on('end', () => resolve(data));
    stream.on('error', () => resolve(data));
    stream.resume();
  });
}

function formatNumstat(f) {
  if (f.binary) return 'bin';
  if (!f.additions && !f.deletions) return '';
  return `+${f.additions} -${f.deletions}`;
}

function renderStatusText(snapshot, status) {
  const lines = [];
  lines.push(`저장소: ${snapshot.root || snapshot.repoPath}`);
  lines.push(`브랜치: ${snapshot.branch}${snapshot.remotes.length ? `  remote: ${snapshot.remotes.map((r) => r.name).join(', ')}` : '  (remote 없음)'}`);
  const staged = status.files.filter((f) => f.staged);
  const unstaged = status.files.filter((f) => f.unstaged);
  lines.push('');
  lines.push(`Staged (${staged.length})`);
  if (staged.length === 0) lines.push('  (없음)');
  for (const f of staged) lines.push(`  ${f.stagedLabel[0].toUpperCase()} ${f.path}  ${formatNumstat(f)}`.trimEnd());
  lines.push('');
  lines.push(`Changes (${unstaged.length})`);
  if (unstaged.length === 0) lines.push('  (없음)');
  for (const f of unstaged) lines.push(`  ${(f.unstagedLabel || 'modified')[0].toUpperCase()} ${f.path}  ${formatNumstat(f)}`.trimEnd());
  if (status.files.length === 0) {
    lines.push('');
    lines.push('변경 사항이 없습니다.');
  }
  return lines.join('\n');
}

async function gatherStatus(cwd) {
  const isRepo = await git.isRepo(cwd);
  if (!isRepo) return { ok: false, error: `'${cwd}' 는 Git 저장소가 아닙니다.` };
  const [root, branch, remotes, status] = await Promise.all([
    git.getRepoRoot(cwd), git.getBranch(cwd), git.getRemotes(cwd), git.getStatus(cwd),
  ]);
  if (!status.ok) return { ok: false, error: status.error };
  return { ok: true, snapshot: { repoPath: cwd, root, branch: branch || '(커밋 없음)', remotes, hasRemote: remotes.length > 0 }, status };
}

function renderBranchList(branches) {
  return branches.map((b) => `${b.current ? '*' : ' '} ${b.name}`).join('\n');
}

/**
 * @returns {Promise<number>} exit code
 */
async function run(argv, io = {}) {
  const { out = process.stdout, err = process.stderr, in: input = process.stdin, cwd: initialCwd = process.cwd() } = io;
  const write = (s) => out.write(`${s}\n`);
  const writeErr = (s) => err.write(`${s}\n`);

  const { positional, flags } = parseArgs(argv);
  const json = Boolean(flags.json);
  const repoPath = flags.C ? path.resolve(initialCwd, String(flags.C)) : initialCwd;

  const command = positional[0] || (process.stdout.isTTY ? 'tui' : 'status');
  const args = positional.slice(1);

  const fail = (message) => {
    if (json) write(JSON.stringify({ ok: false, error: message }, null, 2));
    else writeErr(`오류: ${message}`);
    return 1;
  };
  const ok = (payload, text) => {
    if (json) write(JSON.stringify(payload, null, 2));
    else if (text) write(text);
    return 0;
  };

  if (flags.h || flags.help || command === 'help') {
    write(HELP.trimEnd());
    return 0;
  }

  if (command === 'version' || flags.version) {
    write(require('../package.json').version);
    return 0;
  }

  if (command === 'tui') {
    if (!process.stdout.isTTY) return fail('TUI 는 터미널(TTY)에서만 실행할 수 있습니다. 헤드리스에서는 다른 명령을 사용하세요.');
    const { start } = require('./tui/app');
    return start(repoPath, io);
  }

  switch (command) {
    case 'status': {
      const res = await gatherStatus(repoPath);
      if (!res.ok) return fail(res.error);
      if (json) {
        return ok({
          ok: true,
          repo: res.snapshot.root,
          branch: res.snapshot.branch,
          remotes: res.snapshot.remotes,
          files: res.status.files.map((f) => ({
            path: f.path, staged: f.staged, unstaged: f.unstaged,
            label: f.label, additions: f.additions, deletions: f.deletions, binary: f.binary,
          })),
          stagedCount: res.status.files.filter((f) => f.staged).length,
          unstagedCount: res.status.files.filter((f) => f.unstaged).length,
        });
      }
      return ok({}, renderStatusText(res.snapshot, res.status));
    }

    case 'msg': {
      const res = await gatherStatus(repoPath);
      if (!res.ok) return fail(res.error);
      if (res.status.files.length === 0) return fail('변경 사항이 없어 메시지를 생성할 수 없습니다.');
      const [a, b] = await Promise.all([
        git.getDiff(repoPath, { staged: true }), git.getDiff(repoPath, { staged: false }),
      ]);
      const suggestion = generateCommitMessage(res.status.files, `${a.diff || ''}\n${b.diff || ''}`);
      if (!suggestion) return fail('메시지를 생성할 수 없습니다.');
      if (json) return ok({ ok: true, ...suggestion });
      return ok({}, suggestion.message);
    }

    case 'stage': {
      const res = flags.all ? await git.stageAll(repoPath) : await git.stage(repoPath, args);
      if (!res.ok) return fail(res.error || 'stage 할 파일을 지정하세요.');
      return ok({ ok: true }, 'stage 완료');
    }

    case 'unstage': {
      if (args.length === 0) return fail('unstage 할 파일을 지정하세요. (--all 미지원)');
      const res = await git.unstage(repoPath, args);
      if (!res.ok) return fail(res.error);
      return ok({ ok: true }, 'unstage 완료');
    }

    case 'commit': {
      let message = flags.m ? String(flags.m) : (flags.message ? String(flags.message) : '');
      if (flags.auto) {
        const res = await gatherStatus(repoPath);
        if (!res.ok) return fail(res.error);
        const [a, b] = await Promise.all([
          git.getDiff(repoPath, { staged: true }), git.getDiff(repoPath, { staged: false }),
        ]);
        const suggestion = generateCommitMessage(res.status.files, `${a.diff || ''}\n${b.diff || ''}`);
        if (!suggestion) return fail('변경 사항이 없어 메시지를 생성할 수 없습니다.');
        message = suggestion.message;
        if (!json) writeErr(`생성된 메시지:\n${message}\n`);
      }
      if (!message.trim()) return fail('커밋 메시지가 필요합니다. (-m "메시지" 또는 --auto)');
      const res = await git.commit(repoPath, message);
      if (!res.ok) return fail(res.error);
      return ok({ ok: true, summary: res.summary, message }, res.summary);
    }

    case 'log': {
      const limit = Number(flags.n || flags.limit || 20);
      const res = await git.getLog(repoPath, limit);
      if (!res.ok) return fail(res.error);
      if (json) return ok({ ok: true, commits: res.commits });
      return ok({}, res.commits.map((c) => `${c.short}  ${c.date}  ${c.author}  ${c.subject}`).join('\n'));
    }

    case 'branches': {
      const res = await git.getBranches(repoPath);
      if (!res.ok) return fail(res.error);
      if (json) return ok({ ok: true, ...res });
      return ok({}, renderBranchList(res.branches));
    }

    case 'branch': {
      const sub = args[0] || 'list';
      const rest = args.slice(1);
      if (sub === 'list' || sub === 'ls') {
        const res = await git.getBranches(repoPath);
        if (!res.ok) return fail(res.error);
        if (json) return ok({ ok: true, ...res });
        return ok({}, renderBranchList(res.branches));
      }
      if (sub === 'new' || sub === 'create' || sub === 'add') {
        if (!rest[0]) return fail('사용법: autogit branch new <이름> [--no-switch]');
        const checkout = !(flags['no-switch'] || flags.n);
        const res = await git.createBranch(repoPath, rest[0], { checkout });
        if (!res.ok) return fail(res.error);
        return ok({ ok: true, branch: rest[0], checkout }, checkout
          ? `브랜치 '${rest[0]}' 생성 후 전환했습니다.`
          : `브랜치 '${rest[0]}' 를 생성했습니다.`);
      }
      if (sub === 'switch' || sub === 'checkout' || sub === 'co') {
        if (!rest[0]) return fail('사용법: autogit branch switch <이름>');
        const res = await git.checkout(repoPath, rest[0]);
        if (!res.ok) return fail(res.error);
        return ok({ ok: true, branch: rest[0] }, res.output || `'${rest[0]}'(으)로 전환했습니다.`);
      }
      if (sub === 'delete' || sub === 'remove' || sub === 'rm' || sub === 'del') {
        if (!rest[0]) return fail('사용법: autogit branch delete <이름> [--force]');
        const force = Boolean(flags.force || flags.f || flags.D);
        const res = await git.deleteBranch(repoPath, rest[0], { force });
        if (!res.ok) return fail(res.error);
        return ok({ ok: true, branch: rest[0], force }, `브랜치 '${rest[0]}' 삭제 완료`);
      }
      if (sub === 'rename' || sub === 'move' || sub === 'mv') {
        if (!rest[0] || !rest[1]) return fail('사용법: autogit branch rename <기존이름> <새이름>');
        const res = await git.renameBranch(repoPath, rest[0], rest[1]);
        if (!res.ok) return fail(res.error);
        return ok({ ok: true, from: rest[0], to: rest[1] }, `브랜치 '${rest[0]}' → '${rest[1]}' 이름 변경 완료`);
      }
      if (sub === 'merge') {
        if (!rest[0]) return fail('사용법: autogit branch merge <이름>');
        const res = await git.mergeBranch(repoPath, rest[0]);
        if (!res.ok) {
          if (res.conflict) writeErr(res.output || '');
          return fail(res.error);
        }
        return ok({ ok: true, branch: rest[0], output: res.output },
          res.output || `'${rest[0]}' 병합 완료`);
      }
      return fail(`알 수 없는 branch 하위 명령: ${sub}\n  list · new · switch · delete · rename · merge`);
    }

    case 'checkout': {
      if (!args[0]) return fail('전환할 브랜치를 지정하세요.');
      const res = await git.checkout(repoPath, args[0]);
      if (!res.ok) return fail(res.error);
      return ok({ ok: true }, res.output);
    }

    case 'rewind': {
      if (!args[0]) return fail('되돌릴 커밋을 지정하세요. (예: autogit rewind HEAD~1 --mode soft)');
      const mode = String(flags.mode || 'mixed');
      const res = await git.rewindTo(repoPath, args[0], mode);
      if (!res.ok) return fail(res.error);
      return ok({ ok: true, snapshot: res.snapshot.id, mode, target: args[0] },
        `되돌렸습니다 (${mode} → ${args[0]}).\n스냅샷 ${res.snapshot.id} 을(를) 남겼습니다. 실행 취소: autogit undo`);
    }

    case 'undo': {
      const res = await git.undoLast(repoPath);
      if (!res.ok) return fail(res.error);
      return ok({ ok: true, ...res }, `취소했습니다: ${res.undone.action}${res.undone.target ? ` (${res.undone.target})` : ''}`);
    }

    case 'snapshots': {
      if (flags.prune) {
        const res = await git.pruneSnapshots(repoPath);
        if (!res.ok) return fail(res.error);
        return ok({ ok: true, removed: res.removed }, `${res.removed.length}개 스냅샷 정리`);
      }
      const res = await git.readJournal(repoPath);
      if (!res.ok) return fail(res.error);
      if (json) return ok({ ok: true, snapshots: res.entries });
      if (res.entries.length === 0) return ok({}, '스냅샷이 없습니다.');
      return ok({}, res.entries.map((e) => `${e.snapshot.id}  ${e.at}  ${e.action.padEnd(7)}  ${e.snapshot.label}`).join('\n'));
    }

    case 'restore': {
      if (!args[0]) return fail('복구할 스냅샷 id 를 지정하세요. (autogit snapshots)');
      const res = await git.restoreSnapshot(repoPath, args[0], { restoreHead: !flags['files-only'] });
      if (!res.ok) return fail(res.error);
      return ok({ ok: true, restored: args[0] }, `스냅샷 ${args[0]} 시점으로 복구했습니다.`);
    }

    case 'revert': {
      if (!args[0]) return fail('되돌릴 커밋을 지정하세요.');
      const res = await git.revertCommit(repoPath, args[0]);
      if (!res.ok) return fail(res.error);
      return ok({ ok: true, output: res.output }, res.output);
    }

    case 'remote': {
      const sub = args[0];
      if (sub === 'list' || !sub) {
        const remotes = await git.getRemotes(repoPath);
        if (json) return ok({ ok: true, remotes });
        if (remotes.length === 0) return ok({}, 'remote 가 없습니다.');
        return ok({}, remotes.map((r) => `${r.name}\t${r.url}`).join('\n'));
      }
      if (sub === 'add') {
        if (!args[1] || !args[2]) return fail('사용법: autogit remote add <이름> <URL>');
        const res = await git.addRemote(repoPath, args[1], args[2]);
        if (!res.ok) return fail(res.error);
        return ok({ ok: true }, `remote '${args[1]}' 추가`);
      }
      if (sub === 'set-url') {
        if (!args[1] || !args[2]) return fail('사용법: autogit remote set-url <이름> <URL>');
        const res = await git.setRemoteUrl(repoPath, args[1], args[2]);
        if (!res.ok) return fail(res.error);
        return ok({ ok: true }, `remote '${args[1]}' URL 변경`);
      }
      if (sub === 'remove' || sub === 'rm') {
        if (!args[1]) return fail('사용법: autogit remote remove <이름>');
        const res = await git.removeRemote(repoPath, args[1]);
        if (!res.ok) return fail(res.error);
        return ok({ ok: true }, `remote '${args[1]}' 삭제`);
      }
      return fail(`알 수 없는 remote 하위 명령: ${sub}`);
    }

    case 'pull':
    case 'push': {
      if (github.getStatus().loggedIn) await github.ensureCredential(repoPath);
      const target = { remote: args[0] || null, branch: args[1] || null };
      const res = command === 'pull'
        ? await git.pull(repoPath, target)
        : await git.push(repoPath, { ...target, setUpstream: Boolean(flags.u || flags['set-upstream']) });
      if (!res.ok) return fail(res.error);
      const tail = res.upstream ? `  ·  upstream ${res.upstream}` : '';
      return ok({ ok: true, upstream: res.upstream || null, output: res.output }, `${res.output}${tail}`);
    }

    case 'github': {
      const sub = args[0];
      if (!sub || sub === 'status') {
        const st = github.getStatus();
        if (json) return ok({ ok: true, ...st });
        if (!st.loggedIn) {
          const gh = await github.ghCliStatus();
          const hints = [`로그인되어 있지 않습니다.`, `  autogit github login --token <토큰>`];
          if (gh.available && gh.loggedIn) hints.push('  autogit github login --gh   (gh CLI 토큰 재사용)');
          return ok({}, hints.join('\n'));
        }
        return ok({}, `@${st.user.login} (${st.user.name})  source=${st.source}  저장=${st.persisted ? st.configPath : '메모리만'}`);
      }
      if (sub === 'login') {
        if (flags.gh) {
          const res = await github.loginFromGhCli();
          if (!res.ok) return fail(res.error);
          return ok({ ok: true, user: res.user }, `로그인 완료: @${res.user.login}`);
        }
        let token = flags.token ? String(flags.token) : (args[1] || '');
        // TTY 가 아니면 stdin(붙여넣기/파이프)에서 토큰을 읽는다.
        if (!token && input && !input.isTTY) {
          token = (await readStream(input)).trim();
        }
        if (!token) {
          return fail('토큰이 필요합니다.\n  autogit github login --token <토큰>\n  printf %s "$TOKEN" | autogit github login\n  autogit github login --gh');
        }
        const res = await github.loginWithToken(token);
        if (!res.ok) return fail(res.error);
        const warn = res.warning ? `\n${res.warning}` : '';
        return ok({ ok: true, user: res.user, scopes: res.scopes }, `로그인 완료: @${res.user.login}${warn}`);
      }
      if (sub === 'logout') {
        const res = await github.logout(repoPath);
        if (!res.ok) return fail(res.error);
        return ok({ ok: true }, '로그아웃 완료');
      }
      if (sub === 'repos') {
        const res = await github.listRepos();
        if (!res.ok) return fail(res.error);
        if (json) return ok({ ok: true, repos: res.repos });
        return ok({}, res.repos.map((r) => `${r.private ? '🔒' : '  '} ${r.fullName}`).join('\n'));
      }
      if (sub === 'create') {
        if (!args[1]) return fail('사용법: autogit github create <이름> [--private]');
        const created = await github.createRepo({ name: args[1], isPrivate: Boolean(flags.private) });
        if (!created.ok) return fail(created.error);
        const existing = await git.getRemotes(repoPath);
        const url = created.repo.cloneUrl;
        const linked = existing.some((r) => r.name === 'origin')
          ? await git.setRemoteUrl(repoPath, 'origin', url)
          : await git.addRemote(repoPath, 'origin', url);
        if (!linked.ok) return fail(`저장소는 생성됐지만 remote 연결 실패: ${linked.error}`);
        await github.ensureCredential(repoPath);
        return ok({ ok: true, repo: created.repo }, `생성 완료: ${created.repo.fullName}\norigin → ${url}`);
      }
      return fail(`알 수 없는 github 하위 명령: ${sub}`);
    }

    default:
      writeErr(`알 수 없는 명령: ${command}\n`);
      write(HELP.trimEnd());
      return 2;
  }
}

module.exports = { run, parseArgs, HELP };
