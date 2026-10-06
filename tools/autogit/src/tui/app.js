'use strict';

/**
 * AutoGit TUI (의존성 없음).
 * 모든 Git/커밋메시지/GitHub 로직은 src/*.js 를 그대로 재사용한다.
 */

const git = require('../git');
const github = require('../github');
const { generateCommitMessage } = require('../commitMessage');
const { createScreen, pad, strWidth } = require('./screen');

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  sel: '\x1b[7m',
};

const TABS = ['diff', 'history', 'time', 'remote', 'branch'];
const TAB_LABEL = { diff: 'Diff', history: 'History', time: 'Time', remote: 'Remote', branch: 'Branch' };

function badge(label) {
  switch (label) {
    case 'added':
    case 'untracked': return `${C.green}A${C.reset}`;
    case 'modified': return `${C.yellow}M${C.reset}`;
    case 'deleted': return `${C.red}D${C.reset}`;
    case 'renamed': return `${C.magenta}R${C.reset}`;
    case 'conflicted': return `${C.red}U${C.reset}`;
    default: return `${C.gray}?${C.reset}`;
  }
}

const ESC_KEYS = [
  ['\u001b[A', 'up'], ['\u001b[B', 'down'], ['\u001b[C', 'right'], ['\u001b[D', 'left'],
  ['\u001b[5~', 'pageup'], ['\u001b[6~', 'pagedown'],
];
const CTRL_KEYS = new Map([
  ['\r', 'enter'], ['\n', 'enter'], ['\u007f', 'backspace'], ['\b', 'backspace'],
  ['\t', 'tab'], ['\u001b', 'esc'], ['\u0003', 'ctrl-c'], ['\u0015', 'ctrl-u'],
]);
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/**
 * 한 번의 입력(chunk)을 키/붙여넣기 토큰 배열로 나눈다.
 *  - 단일 문자 → 문자열 키
 *  - 브래킷 페이스트(\u001b[200~ … \u001b[201~) 또는 여러 문자가 한 번에
 *    들어온 경우 → { paste: "..." }
 */
function parseInput(data) {
  const s = data.toString('utf8');
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (s.startsWith(PASTE_START, i)) {
      const end = s.indexOf(PASTE_END, i + PASTE_START.length);
      if (end === -1) { tokens.push({ paste: s.slice(i + PASTE_START.length) }); break; }
      tokens.push({ paste: s.slice(i + PASTE_START.length, end) });
      i = end + PASTE_END.length;
      continue;
    }
    const esc = ESC_KEYS.find(([seq]) => s.startsWith(seq, i));
    if (esc) { tokens.push(esc[1]); i += esc[0].length; continue; }
    const ctrl = CTRL_KEYS.get(s[i]);
    if (ctrl) { tokens.push(ctrl); i += 1; continue; }
    if (s[i] >= ' ') {
      let j = i;
      while (j < s.length && s[j] >= ' ' && s[j] !== '\u007f') j += 1;
      const run = s.slice(i, j);
      tokens.push(run.length === 1 ? run : { paste: run });
      i = j;
      continue;
    }
    i += 1; // 알 수 없는 제어 문자는 버린다
  }
  return tokens;
}

/**
 * 붙여넣은 텍스트를 용도에 맞게 정리한다.
 *  - text   : 메시지 편집(줄바꿈 유지)
 *  - prompt : 일반 입력(줄바꿈 → 공백)
 *  - token  : 토큰(모든 공백 제거 — 토큰에는 공백이 없음)
 */
function sanitizePaste(text, kind = 'text') {
  const out = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (kind === 'token') return out.replace(/\s+/g, '');
  if (kind === 'prompt') return out.replace(/\n/g, ' ');
  return out;
}

async function start(cwd, io = {}) {
  const out = io.out || process.stdout;
  const input = io.in || process.stdin;
  const screen = createScreen(out);

  const state = {
    cwd,
    snapshot: null,
    status: null,
    upstream: null,
    history: [],
    remotes: [],
    repos: [],
    snapshots: [],
    timeIndex: 0,
    timeMode: 'mixed', // soft | mixed | hard
    branches: [],
    branchIndex: 0,
    diff: [],
    diffHeader: '',
    files: [],
    selected: 0,
    scroll: 0,
    focus: 'files', // files | message
    editing: false,
    tab: 'diff',
    message: '',
    notice: null, // { text, kind }
    prompt: null, // { label, value, onSubmit }
    busy: null,
    github: null,
    help: false,
    running: true,
  };

  const setNotice = (text, kind = 'info') => { state.notice = text ? { text, kind } : null; };

  /* ------------------------------ 데이터 ------------------------------ */

  async function refresh({ keepSelection = true } = {}) {
    const snap = await git.isRepo(cwd);
    if (!snap) {
      state.snapshot = { isRepo: false, repoPath: cwd };
      state.status = { ok: true, files: [] };
      state.files = [];
      render();
      return;
    }
    const [root, branch, remotes, status, history, upstream, branchList] = await Promise.all([
      git.getRepoRoot(cwd),
      git.getBranch(cwd),
      git.getRemotes(cwd),
      git.getStatus(cwd),
      git.getLog(cwd, 100),
      git.hasUpstream(cwd),
      git.getBranches(cwd),
    ]);
    state.snapshot = { isRepo: true, repoPath: cwd, root, branch: branch || '(커밋 없음)', remotes };
    state.upstream = upstream;
    state.status = status;
    state.history = history.ok ? history.commits : [];
    state.remotes = remotes;
    state.branches = branchList.ok ? branchList.branches : [];
    if (state.branches.length) {
      const currentIdx = state.branches.findIndex((b) => b.current);
      if (state.branchIndex >= state.branches.length || !keepSelection) {
        state.branchIndex = currentIdx >= 0 ? currentIdx : 0;
      }
    } else {
      state.branchIndex = 0;
    }
    state.github = github.getStatus();

    const staged = status.files.filter((f) => f.staged);
    const unstaged = status.files.filter((f) => f.unstaged);
    state.files = [
      ...staged.map((f) => ({ ...f, list: 'staged' })),
      ...unstaged.map((f) => ({ ...f, list: 'unstaged' })),
    ];
    if (!keepSelection) state.selected = 0;
    if (state.selected >= state.files.length) state.selected = Math.max(0, state.files.length - 1);
    await loadDiff();
    render();
  }

  async function loadDiff() {
    const file = state.files[state.selected];
    if (!file) { state.diff = []; state.diffHeader = ''; return; }
    state.diffHeader = `${file.path}  (${file.list})`;
    if (file.untracked) {
      const content = await git.readUntracked(cwd, file.path);
      if (typeof content === 'string') {
        state.diff = content.split('\n').map((l) => `+ ${l}`);
        state.diff.unshift(`${C.gray}new file (untracked)${C.reset}`, '');
      } else {
        state.diff = ['(내용을 읽을 수 없습니다 — 바이너리이거나 너무 큰 파일)'];
      }
      return;
    }
    const res = await git.getDiff(cwd, { staged: file.list === 'staged', path: file.path });
    state.diff = res.ok ? (res.diff || '(변경 내용 없음)').split('\n') : [res.error || 'diff 를 읽을 수 없습니다.'];
  }

  async function loadSnapshots() {
    const res = await git.readJournal(cwd);
    state.snapshots = res.ok ? res.entries : [];
    if (state.timeIndex >= state.snapshots.length) {
      state.timeIndex = Math.max(0, state.snapshots.length - 1);
    }
  }

  async function loadBranches() {
    const res = await git.getBranches(cwd);
    state.branches = res.ok ? res.branches : [];
    const currentIdx = state.branches.findIndex((b) => b.current);
    if (currentIdx >= 0) {
      state.branchIndex = currentIdx;
    } else if (state.branchIndex >= state.branches.length) {
      state.branchIndex = Math.max(0, state.branches.length - 1);
    }
  }

  /* ------------------------------ 렌더링 ------------------------------ */

  function rightLines(bodyHeight) {
    if (state.tab === 'diff') {
      return [state.diffHeader, ''].concat(state.diff);
    }
    if (state.tab === 'history') {
      return state.history.length
        ? state.history.map((c) => `${C.yellow}${c.short}${C.reset} ${C.dim}${c.date}${C.reset} ${c.subject}`)
        : ['(커밋 기록 없음)'];
    }
    if (state.tab === 'time') {
      const lines = [
        `${C.bold}시간 되돌리기${C.reset}  ${C.dim}rewind 모드:${C.reset} ${C.yellow}${state.timeMode}${C.reset}${C.dim} (m: 변경)${C.reset}`,
        `${C.dim}↑/↓ 선택  Enter: 복구  f: 파일만 복구  t: rewind  v: revert  z: undo  d: 정리${C.reset}`,
        '',
      ];
      if (state.snapshots.length === 0) {
        lines.push('(저장된 스냅샷이 없음 — 커밋/되돌리기를 하면 자동 저장됩니다)');
      } else {
        state.snapshots.forEach((e, i) => {
          const mark = i === state.timeIndex ? `${C.sel}>${C.reset}` : ' ';
          const id = `${C.cyan}${e.snapshot.id}${C.reset}`;
          const at = `${C.dim}${e.at.replace('T', ' ').slice(0, 19)}${C.reset}`;
          const action = `${C.magenta}${e.action.padEnd(7)}${C.reset}`;
          lines.push(`${mark} ${id} ${at} ${action} ${e.snapshot.label || ''}`);
        });
      }
      return lines;
    }
    if (state.tab === 'branch') {
      const lines = [
        `${C.bold}브랜치${C.reset}  ${C.dim}Enter: 전환  n: 새 브랜치  d: 삭제  r: 이름 변경  M: 병합${C.reset}`,
        '',
      ];
      if (state.branches.length === 0) {
        lines.push('(브랜치 없음)');
      } else {
        state.branches.forEach((b, i) => {
          const mark = i === state.branchIndex ? `${C.sel}>${C.reset}` : ' ';
          const name = b.current ? `${C.bold}${C.green}${b.name}${C.reset}` : b.name;
          lines.push(`${mark} ${name}${b.current ? `  ${C.dim}(현재)${C.reset}` : ''}`);
        });
      }
      return lines;
    }
    // remote
    const lines = [`${C.bold}Remote${C.reset}`, ''];
    if (state.remotes.length === 0) lines.push('(remote 없음)  a: 추가');
    for (const r of state.remotes) lines.push(`${C.green}${r.name}${C.reset} ${C.dim}${r.url}${C.reset}`);
    lines.push('', `${C.bold}추적${C.reset}: ${state.upstream ? `${C.green}${state.upstream}${C.reset}` : `${C.dim}(없음 — 첫 push 시 자동 설정)${C.reset}`}`);
    lines.push('', `${C.dim}p: push   P: pull   a: remote 추가${C.reset}`);
    lines.push('', `${C.bold}GitHub${C.reset}`);
    if (state.github && state.github.loggedIn) {
      lines.push(`@${state.github.user.login} (${state.github.source})  저장=${state.github.persisted ? '설정 파일' : '메모리만'}`);
      lines.push(`${C.dim}o: 내 저장소 불러오기   L: 로그아웃${C.reset}`);
      if (state.repos.length) {
        lines.push('');
        for (const r of state.repos) lines.push(`${r.private ? '🔒' : '  '} ${r.fullName}  ${C.dim}${r.cloneUrl}${C.reset}`);
      }
    } else {
      lines.push('로그인되어 있지 않습니다.  i: 토큰 붙여넣기로 로그인');
    }
    return lines;
  }

  function buildLines() {
    const { cols, rows } = screen.size();
    const lines = [];
    const snap = state.snapshot || {};

    // 헤더
    const gh = state.github && state.github.loggedIn ? `${C.green}@${state.github.user.login}${C.reset}` : `${C.gray}github 미로그인${C.reset}`;
    const remote = snap.remotes && snap.remotes.length ? snap.remotes.map((r) => r.name).join(',') : 'remote 없음';
    const branchText = snap.branch
      ? `${snap.branch}${state.upstream ? ` → ${state.upstream}` : ''}`
      : '-';
    lines.push(
      `${C.bold}${C.cyan}AutoGit${C.reset}  ${C.green}${branchText}${C.reset}  ${C.dim}${snap.root || snap.repoPath || ''}${C.reset}  ${C.dim}${remote}${C.reset}  ${gh}`,
    );

    // 탭
    lines.push(
      TABS.map((t) => (t === state.tab ? `${C.bold}${C.blue}[${TAB_LABEL[t]}]${C.reset}` : `${C.dim} ${TAB_LABEL[t]} ${C.reset}`)).join(' ')
      + `   ${C.dim}${state.busy ? `⏳ ${state.busy}` : ''}${C.reset}`,
    );

    const footer = 4;
    const bodyHeight = Math.max(3, rows - 2 - footer);
    const leftWidth = Math.min(42, Math.max(24, Math.floor(cols * 0.42)));
    const gutter = ' │ ';
    const rightWidth = Math.max(10, cols - leftWidth - strWidth(gutter));

    // 좌: 파일 목록
    const left = [];
    const stagedCount = state.files.filter((f) => f.list === 'staged').length;
    if (!snap.isRepo) {
      left.push(`${C.red}Git 저장소가 아닙니다.${C.reset}`);
      left.push(`${C.dim}${snap.repoPath}${C.reset}`);
    } else {
      left.push(`${C.bold}Staged (${stagedCount})${C.reset}`);
      if (stagedCount === 0) left.push(`${C.dim}  (없음)${C.reset}`);
      let idx = 0;
      for (const f of state.files) {
        if (f.list === 'staged') { left.push(fileRow(f, idx)); idx += 1; }
      }
      left.push('');
      left.push(`${C.bold}Changes (${state.files.length - stagedCount})${C.reset}`);
      if (state.files.length - stagedCount === 0) left.push(`${C.dim}  (없음)${C.reset}`);
      for (const f of state.files) {
        if (f.list === 'unstaged') { left.push(fileRow(f, idx)); idx += 1; }
      }
    }

    // 좌측 스크롤: 선택 항목이 보이도록
    const selLine = left.findIndex((l) => l.includes('\u0000SEL'));
    let leftOffset = 0;
    if (selLine >= bodyHeight) leftOffset = selLine - bodyHeight + 1;

    const right = rightLines(bodyHeight);
    const rightMax = Math.max(0, right.length - bodyHeight);
    state.scroll = Math.min(state.scroll, rightMax);
    const rightOffset = state.scroll;

    for (let i = 0; i < bodyHeight; i += 1) {
      const l = (left[leftOffset + i] || '').replace('\u0000SEL', '');
      const r = right[rightOffset + i] || '';
      lines.push(`${pad(l, leftWidth)}${C.gray}${gutter}${C.reset}${r}`);
    }

    // 푸터
    lines.push(`${C.gray}${'─'.repeat(cols)}${C.reset}`);
    const msgLines = state.message ? state.message.split('\n') : [];
    const label = state.editing ? `${C.bold}${C.yellow}메시지(편집중)${C.reset}` : `${C.bold}메시지${C.reset}`;
    lines.push(`${label}: ${msgLines[0] || `${C.dim}(g: 자동 생성, e: 편집)${C.reset}`}${state.editing ? `${C.sel} ${C.reset}` : ''}`);
    lines.push(`  ${C.dim}${msgLines.slice(1).join(' / ') || ''}${C.reset}`);
    lines.push(statusLine());
    return lines;
  }

  function fileRow(f, idx) {
    const selected = idx === state.selected && state.focus === 'files';
    const mark = selected ? `${C.sel}>${C.reset}` : ' ';
    const stat = f.binary ? '' : (f.additions || f.deletions) ? `${C.green}+${f.additions}${C.reset}${C.red}-${f.deletions}${C.reset}` : '';
    const label = f.list === 'staged' ? f.stagedLabel : (f.unstagedLabel || f.label);
    return `${mark}${badge(label)} ${f.path}${stat ? ` ${stat}` : ''}\u0000SEL`;
  }

  function statusLine() {
    if (state.prompt) {
      const shown = state.prompt.secret ? '•'.repeat(state.prompt.value.length) : state.prompt.value;
      const hint = state.prompt.secret ? 'Enter: 확인, Esc: 취소, 붙여넣기 가능' : 'Enter: 확인, Esc: 취소';
      return `${C.bold}${state.prompt.label}${C.reset} ${shown}${C.sel} ${C.reset}  ${C.dim}(${hint})${C.reset}`;
    }
    if (state.notice) {
      const color = state.notice.kind === 'error' ? C.red : C.green;
      return `${color}${state.notice.text}${C.reset}`;
    }
    if (state.help) {
      return `${C.dim}Tab 포커스 │ space stage/unstage │ a 전체 │ g 메시지 │ e 편집 │ c 커밋 │ 1-5 탭 │ r 새로고침 │ q 종료${C.reset}`;
    }
    if (state.tab === 'time') {
      return `${C.dim}↑/↓ 선택  Enter:복구  f:파일만  t:rewind  v:revert  m:모드  z:undo  d:정리  ?:도움말  q:종료${C.reset}`;
    }
    if (state.tab === 'branch') {
      return `${C.dim}↑/↓ 선택  Enter:전환  n:새 브랜치  d:삭제  r:이름변경  M:병합  ?:도움말  q:종료${C.reset}`;
    }
    return `${C.dim}space:stage/unstage  g:메시지  c:커밋  t:rewind  z:undo  ?:도움말  q:종료${C.reset}`;
  }

  function render() {
    const cursor = state.editing
      ? { row: screen.size().rows - 2, col: Math.min(screen.size().cols, 10 + strWidth(state.message.split('\n').pop() || '')) }
      : null;
    screen.draw(buildLines(), cursor);
  }

  /* ------------------------------ 동작 ------------------------------ */

  async function runOp(label, fn) {
    state.busy = label;
    render();
    try {
      const res = await fn();
      if (res && res.ok === false) setNotice(res.error, 'error');
      return res;
    } catch (err) {
      setNotice(String((err && err.message) || err), 'error');
      return { ok: false };
    } finally {
      state.busy = null;
      render();
    }
  }

  async function ensureCredential() {
    if (github.getStatus().loggedIn) await github.ensureCredential(cwd);
  }

  async function toggleStage() {
    const file = state.files[state.selected];
    if (!file) return;
    const res = file.list === 'staged'
      ? await git.unstage(cwd, [file.path])
      : await git.stage(cwd, [file.path]);
    if (!res.ok) setNotice(res.error, 'error');
    await refresh();
  }

  async function stageAll() {
    const res = await git.stageAll(cwd);
    if (!res.ok) setNotice(res.error, 'error');
    await refresh();
  }

  async function generate() {
    if (state.files.length === 0) { setNotice('변경 사항이 없습니다.', 'error'); return; }
    const [a, b] = await Promise.all([
      git.getDiff(cwd, { staged: true }), git.getDiff(cwd, { staged: false }),
    ]);
    const suggestion = generateCommitMessage(state.files, `${a.diff || ''}\n${b.diff || ''}`);
    if (!suggestion) { setNotice('메시지를 생성할 수 없습니다.', 'error'); return; }
    state.message = suggestion.message;
    setNotice(`메시지 생성됨 — ${suggestion.reasons.join(' · ')}`);
    render();
  }

  async function doCommit() {
    if (!state.message.trim()) { setNotice('커밋 메시지를 입력하세요 (e 또는 g).', 'error'); return; }
    const staged = state.files.filter((f) => f.list === 'staged');
    if (staged.length === 0) { setNotice('stage 된 파일이 없습니다. (space / a)', 'error'); return; }
    const res = await git.commit(cwd, state.message);
    if (!res.ok) { setNotice(res.error, 'error'); return; }
    state.message = '';
    setNotice(`커밋 완료 — ${res.summary.split('\n')[0]}`);
    await refresh({ keepSelection: false });
  }

  async function doUndo() {
    const res = await git.undoLast(cwd);
    if (!res.ok) { setNotice(res.error, 'error'); return; }
    setNotice(`취소 완료 — ${res.undone.action}${res.undone.target ? ` (${res.undone.target})` : ''}`);
    await refresh();
  }

  async function restoreSnapshotAt(index, { restoreHead = true } = {}) {
    const entry = state.snapshots[index];
    if (!entry) { setNotice('복구할 스냅샷을 선택하세요.', 'error'); return; }
    const res = await git.restoreSnapshot(cwd, entry.snapshot.id, { restoreHead });
    if (!res.ok) { setNotice(res.error, 'error'); return; }
    setNotice(restoreHead
      ? `스냅샷 ${entry.snapshot.id} 시점으로 복구했습니다.`
      : `스냅샷 ${entry.snapshot.id} 의 파일 내용만 복구했습니다 (HEAD 유지).`);
    await refresh();
    await loadSnapshots();
  }

  async function doPrune() {
    const res = await git.pruneSnapshots(cwd);
    if (!res.ok) { setNotice(res.error, 'error'); return; }
    setNotice(`사용되지 않는 스냅샷 ${res.removed.length}개를 정리했습니다.`);
    await loadSnapshots();
  }

  function openPrompt(label, initial, onSubmit, { secret = false } = {}) {
    state.prompt = { label, value: initial || '', onSubmit, secret };
    render();
  }

  /** 붙여넣은 텍스트를 현재 입력 대상(prompt/메시지 편집)에 삽입한다. */
  function insertPaste(text) {
    if (state.prompt) {
      const kind = state.prompt.secret ? 'token' : 'prompt';
      state.prompt.value += sanitizePaste(text, kind);
      render();
      return;
    }
    if (state.editing) {
      state.message += sanitizePaste(text, 'text');
      render();
    }
  }

  function closePrompt() {
    state.prompt = null;
    render();
  }

  /* ------------------------------ 키 처리 ------------------------------ */

  async function onKey(key) {
    if (!key) return;

    if (typeof key === 'object') {
      if (key.paste !== undefined) insertPaste(key.paste);
      return;
    }

    if (key === 'ctrl-c') { state.running = false; return; }

    if (state.prompt) {
      const p = state.prompt;
      if (key === 'esc') { closePrompt(); return; }
      if (key === 'enter') {
        const value = p.value;
        state.prompt = null;
        await p.onSubmit(value);
        render();
        return;
      }
      if (key === 'backspace') { p.value = p.value.slice(0, -1); render(); return; }
      if (key === 'ctrl-u') { p.value = ''; render(); return; }
      if (key.length === 1 && key >= ' ') { p.value += key; render(); }
      return;
    }

    if (state.editing) {
      if (key === 'esc' || key === 'tab') { state.editing = false; render(); return; }
      if (key === 'enter') { state.message += '\n'; render(); return; }
      if (key === 'backspace') { state.message = state.message.slice(0, -1); render(); return; }
      if (key === 'ctrl-u') { state.message = ''; render(); return; }
      if (key.length === 1 && key >= ' ') { state.message += key; render(); }
      return;
    }

    switch (key) {
      case 'q': state.running = false; return;
      case '?': state.help = !state.help; render(); return;
      case 'tab': state.focus = state.focus === 'files' ? 'message' : 'files'; render(); return;
      case 'up': case 'k':
        if (state.tab === 'time') {
          state.timeIndex = Math.max(0, state.timeIndex - 1);
        } else if (state.tab === 'branch') {
          state.branchIndex = Math.max(0, state.branchIndex - 1);
        } else {
          state.selected = Math.max(0, state.selected - 1);
          await loadDiff();
        }
        render(); return;
      case 'down': case 'j':
        if (state.tab === 'time') {
          state.timeIndex = Math.min(Math.max(0, state.snapshots.length - 1), state.timeIndex + 1);
        } else if (state.tab === 'branch') {
          state.branchIndex = Math.min(Math.max(0, state.branches.length - 1), state.branchIndex + 1);
        } else {
          state.selected = Math.min(Math.max(0, state.files.length - 1), state.selected + 1);
          await loadDiff();
        }
        render(); return;
      case 'pageup': state.scroll = Math.max(0, state.scroll - 10); render(); return;
      case 'pagedown': state.scroll += 10; render(); return;
      default: break;
    }

    if (key === '1') { state.tab = 'diff'; state.scroll = 0; render(); return; }
    if (key === '2') { state.tab = 'history'; state.scroll = 0; render(); return; }
    if (key === '3') { state.tab = 'time'; state.scroll = 0; await loadSnapshots(); render(); return; }
    if (key === '4') { state.tab = 'remote'; state.scroll = 0; render(); return; }
    if (key === '5') { state.tab = 'branch'; state.scroll = 0; await loadBranches(); render(); return; }

    if (state.tab === 'branch') {
      const selected = state.branches[state.branchIndex];
      if (key === 'enter') {
        if (!selected) { setNotice('전환할 브랜치를 선택하세요.', 'error'); return; }
        if (selected.current) { setNotice(`이미 '${selected.name}' 브랜치입니다.`); return; }
        await runOp('브랜치 전환', async () => {
          const res = await git.checkout(cwd, selected.name);
          if (res.ok) { setNotice(`'${selected.name}'(으)로 전환했습니다.`); await refresh(); }
          return res;
        });
        return;
      }
      if (key === 'n') {
        openPrompt('새 브랜치 이름:', '', async (value) => {
          const name = value.trim();
          if (!name) { setNotice('취소되었습니다.'); return; }
          const res = await runOp('브랜치 생성', () => git.createBranch(cwd, name));
          if (res && res.ok) { setNotice(`브랜치 '${name}' 생성 후 전환했습니다.`); await refresh(); }
        });
        return;
      }
      if (key === 'd') {
        if (!selected) { setNotice('삭제할 브랜치를 선택하세요.', 'error'); return; }
        if (selected.current) { setNotice('현재 브랜치는 삭제할 수 없습니다.', 'error'); return; }
        const name = selected.name;
        await runOp('브랜치 삭제', async () => {
          const res = await git.deleteBranch(cwd, name);
          if (res.ok) { setNotice(`브랜치 '${name}' 삭제 완료`); await refresh(); return res; }
          if (/병합되지|not fully merged/.test(res.error || '')) {
            openPrompt(`'${name}' 는 병합되지 않았습니다. 강제 삭제하려면 'force' 입력:`, '', async (v) => {
              if (v.trim() !== 'force') { setNotice('취소되었습니다.'); return; }
              const forced = await runOp('강제 삭제', () => git.deleteBranch(cwd, name, { force: true }));
              if (forced && forced.ok) { setNotice(`브랜치 '${name}' 강제 삭제 완료`); await refresh(); }
            });
            return {};
          }
          return res;
        });
        return;
      }
      if (key === 'r') {
        if (!selected) { setNotice('이름을 바꿀 브랜치를 선택하세요.', 'error'); return; }
        openPrompt(`'${selected.name}' 새 이름:`, selected.name, async (value) => {
          const name = value.trim();
          if (!name || name === selected.name) { setNotice('취소되었습니다.'); return; }
          const res = await runOp('브랜치 이름 변경', () => git.renameBranch(cwd, selected.name, name));
          if (res && res.ok) { setNotice(`브랜치 '${selected.name}' → '${name}'`); await refresh(); }
        });
        return;
      }
      if (key === 'M') {
        if (!selected) { setNotice('병합할 브랜치를 선택하세요.', 'error'); return; }
        if (selected.current) { setNotice('현재 브랜치는 병합 대상이 아닙니다.', 'error'); return; }
        await runOp('브랜치 병합', async () => {
          const res = await git.mergeBranch(cwd, selected.name);
          if (res.ok) setNotice(`'${selected.name}' 병합 완료`);
          else if (res.conflict) setNotice(res.error, 'error');
          await refresh();
          return res;
        });
        return;
      }
    }

    if (key === ' ') { await runOp('stage', toggleStage); return; }
    if (key === 'a') {
      if (state.tab === 'remote') {
        openPrompt('remote 이름:', 'origin', (name) => {
          if (!name.trim()) { setNotice('취소되었습니다.'); return; }
          openPrompt('remote URL (https:// 또는 git@host:path):', '', async (url) => {
            if (!url.trim()) { setNotice('취소되었습니다.'); return; }
            const res = await runOp('remote 추가', () => git.addRemote(cwd, name.trim(), url.trim()));
            if (res && res.ok) { setNotice(`remote '${name.trim()}' 추가`); await refresh(); }
          });
        });
        return;
      }
      await runOp('stage all', stageAll);
      return;
    }
    if (key === 's') {
      const f = state.files[state.selected];
      if (f && f.list !== 'staged') await runOp('stage', () => git.stage(cwd, [f.path]).then(() => refresh()));
      return;
    }
    if (key === 'u') {
      const f = state.files[state.selected];
      if (f && f.list === 'staged') await runOp('unstage', () => git.unstage(cwd, [f.path]).then(() => refresh()));
      return;
    }
    if (key === 'g') { await runOp('메시지 생성', generate); return; }
    if (key === 'e') {
      if (!state.message) state.message = '';
      state.editing = true; state.focus = 'message'; render(); return;
    }
    if (key === 'c') { await runOp('커밋', doCommit); return; }
    if (key === 'z') { await runOp('undo', doUndo); return; }
    if (key === 'r') { await runOp('새로고침', async () => { await refresh(); await loadSnapshots(); }); return; }

    if (key === 't') {
      openPrompt('되돌릴 커밋 (예: HEAD~1, <해시>):', 'HEAD~1', async (value) => {
        if (!value) { setNotice('취소되었습니다.'); return; }
        const mode = state.timeMode;
        const res = await runOp(`rewind (${mode})`, () => git.rewindTo(cwd, value, mode));
        if (res && res.ok) {
          setNotice(`되돌렸습니다 (${mode} → ${value}). 스냅샷 ${res.snapshot.id} · 취소: z`);
          await refresh();
          await loadSnapshots();
        }
      });
      return;
    }

    if (state.tab === 'time') {
      if (key === 'm') {
        const modes = ['soft', 'mixed', 'hard'];
        state.timeMode = modes[(modes.indexOf(state.timeMode) + 1) % modes.length];
        setNotice(`rewind 모드: ${state.timeMode}`);
        render();
        return;
      }
      if (key === 'f') { await runOp('파일만 복구', () => restoreSnapshotAt(state.timeIndex, { restoreHead: false })); return; }
      if (key === 'd') { await runOp('스냅샷 정리', doPrune); return; }
      if (key === 'v') {
        const entry = state.snapshots[state.timeIndex];
        const initial = entry && entry.snapshot && entry.snapshot.head ? entry.snapshot.head.slice(0, 7) : 'HEAD';
        openPrompt('revert 할 커밋 (예: HEAD, <해시>):', initial, async (value) => {
          if (!value) { setNotice('취소되었습니다.'); return; }
          const res = await runOp('revert', () => git.revertCommit(cwd, value));
          if (res && res.ok) {
            setNotice(`revert 커밋을 만들었습니다 (${value}).`);
            await refresh();
            await loadSnapshots();
          }
        });
        return;
      }
    }

    if (key === 'enter') {
      if (state.tab === 'time') {
        await runOp('복구', () => restoreSnapshotAt(state.timeIndex));
      } else if (state.tab === 'remote' && state.github && state.github.loggedIn) {
        await runOp('저장소', loadRepos);
      }
      return;
    }

    if (key === 'i') {
      openPrompt('GitHub 토큰 (붙여넣기 후 Enter):', '', async (value) => {
        if (!value || !value.trim()) { setNotice('취소되었습니다.'); return; }
        const res = await runOp('로그인', () => github.loginWithToken(value));
        if (res && res.ok) setNotice(`로그인 완료: @${res.user.login}`);
        state.github = github.getStatus();
        render();
      }, { secret: true });
      return;
    }
    if (key === 'L') {
      await runOp('로그아웃', async () => {
        const res = await github.logout(cwd);
        state.github = github.getStatus();
        if (res.ok) setNotice('로그아웃했습니다.');
        return res;
      });
      return;
    }
    if (key === 'o') { await runOp('저장소 불러오기', loadRepos); return; }
    if (key === 'N') {
      openPrompt('새 GitHub 저장소 이름:', '', async (value) => {
        if (!value) { setNotice('취소되었습니다.'); return; }
        const created = await github.createRepo({ name: value });
        if (!created.ok) { setNotice(created.error, 'error'); return; }
        const existing = await git.getRemotes(cwd);
        const linked = existing.some((r) => r.name === 'origin')
          ? await git.setRemoteUrl(cwd, 'origin', created.repo.cloneUrl)
          : await git.addRemote(cwd, 'origin', created.repo.cloneUrl);
        if (!linked.ok) { setNotice(linked.error, 'error'); return; }
        await ensureCredential();
        setNotice(`생성 완료: ${created.repo.fullName}`);
        await refresh();
      });
      return;
    }
    if (key === 'p') { await runOp('push', async () => { await ensureCredential(); const r = await git.push(cwd); if (r.ok) setNotice(`push 완료${r.upstream ? ` · upstream ${r.upstream}` : ''}`); return r; }); return; }
    if (key === 'P') { await runOp('pull', async () => { await ensureCredential(); const r = await git.pull(cwd); if (r.ok) setNotice(r.output || 'pull 완료'); return r; }); return; }
  }

  async function loadRepos() {
    const res = await github.listRepos();
    if (!res.ok) { setNotice(res.error, 'error'); return res; }
    state.repos = res.repos;
    setNotice(`${res.repos.length}개 저장소를 불러왔습니다.`);
    render();
    return res;
  }

  /* ------------------------------ 루프 ------------------------------ */

  screen.enter();
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  let done;
  const finished = new Promise((resolve) => { done = resolve; });

  const onData = (chunk) => {
    for (const key of parseInput(chunk)) {
      Promise.resolve(onKey(key)).catch(() => { /* 개별 키 오류는 무시하고 계속 */ });
    }
  };
  const onResize = () => render();
  const onSigint = () => { state.running = false; };

  input.on('data', onData);
  out.on('resize', onResize);
  process.on('SIGINT', onSigint);

  const cleanup = () => {
    input.removeListener('data', onData);
    out.removeListener('resize', onResize);
    process.removeListener('SIGINT', onSigint);
    try { input.setRawMode(false); } catch { /* ignore */ }
    input.pause();
    screen.exit();
  };

  process.on('exit', cleanup);

  github.restore();
  await refresh();
  await loadSnapshots();
  render();

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!state.running) { clearInterval(timer); resolve(); }
    }, 60);
  });

  cleanup();
  done();
  await finished;
  return 0;
}

module.exports = { start, parseInput, sanitizePaste };
