'use strict';

/**
 * AI/LLM/외부 API 없이, 순수 규칙 기반으로 커밋 메시지를 생성한다.
 *
 * 입력:
 *   changes  - git.getStatus() 가 만든 파일 변경 목록
 *   diffText - getDiff() 로 얻은 통합 diff (선택)
 *
 * 판단 근거:
 *   - 파일 경로/확장자 (docs / test / style / config / code)
 *   - 변경 종류 (added / modified / deleted / renamed / untracked)
 *   - diff 의 추가/삭제 라인 (새 선언 추가 여부, 순수 이동/정리 여부)
 *   - 여러 파일이 같은 디렉터리/모듈에 속하는지
 */

const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc']);
const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.stylus', '.html', '.htm']);
const CONFIG_EXT = new Set([
  '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.properties', '.lock',
]);

const CONFIG_NAMES = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'tsconfig.json', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc',
  'dockerfile', 'makefile', '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.prettierrc',
  '.prettierrc.json', 'vite.config.js', 'vite.config.ts', 'webpack.config.js', 'rollup.config.js',
  'babel.config.js', 'jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'license',
]);

const TEST_PATTERNS = [
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)spec\//,
  /\.test\.[^.]+$/,
  /\.spec\.[^.]+$/,
  /(^|\/)test_[^/]+$/,
  /_test\.[^.]+$/,
];

const STOP_TOKENS = new Set([
  'index', 'main', 'app', 'src', 'lib', 'dist', 'build', 'out', 'test', 'tests', 'spec', 'specs',
  'util', 'utils', 'helper', 'helpers', 'style', 'styles', 'config', 'configs', 'core', 'common',
  'types', 'type', 'constants', 'const', 'mod', 'module', 'modules', 'js', 'ts', 'jsx', 'tsx',
  'css', 'scss', 'html', 'json', 'md', 'py', 'java', 'go', 'rs', 'and', 'the',
]);

const DECLARATION_RE = [
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+[A-Za-z_$]/,
  /^\s*(export\s+)?(abstract\s+)?class\s+[A-Za-z_$]/,
  /^\s*(export\s+)?(interface|type|enum)\s+[A-Za-z_$]/,
  /^\s*(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*\s*=/,
  /^\s*(public|private|protected|static|async)\s+[\w$]*\s*\(/,
  /^\s*def\s+[A-Za-z_]/,
  /^\s*func\s+[A-Za-z_]/,
];

const LOGIC_HINT_RE = [
  /\bif\s*\(/, /\belse\b/, /\bfor\s*\(/, /\bwhile\s*\(/, /\btry\b/, /\bcatch\b/,
  /\breturn\b/, /\bthrow\b/, /=>/, /\bawait\b/, /\bswitch\b/,
];

function extOf(filePath) {
  const base = filePath.split('/').pop();
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx).toLowerCase() : '';
}

function baseName(filePath) {
  return filePath.split('/').pop();
}

/** 파일을 docs / test / style / config / code 로 분류 */
function classifyFile(filePath) {
  const base = baseName(filePath).toLowerCase();
  const ext = extOf(filePath);

  if (TEST_PATTERNS.some((re) => re.test(filePath))) return 'test';
  if (DOC_EXT.has(ext)) return 'docs';
  if (CONFIG_NAMES.has(base) || CONFIG_EXT.has(ext)) return 'config';
  if (STYLE_EXT.has(ext)) return 'style';
  return 'code';
}

function actionOf(file) {
  if (file.untracked || file.label === 'added') return 'add';
  if (file.label === 'deleted') return 'remove';
  if (file.label === 'renamed') return 'rename';
  return 'update';
}

function churnOf(file) {
  return (file.additions || 0) + (file.deletions || 0);
}

function humanize(token) {
  return token.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 변경 파일들의 공통 디렉터리 (없으면 '') */
function commonDir(paths) {
  if (paths.length === 0) return '';
  const split = paths.map((p) => p.split('/').slice(0, -1));
  const first = split[0];
  let len = first.length;
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < len && i < parts.length && parts[i] === first[i]) i += 1;
    len = i;
  }
  return first.slice(0, len).join('/');
}

/** 파일명에서 반복 등장하는 의미 토큰 추출 */
function dominantToken(files) {
  const tally = new Map();
  for (const f of files) {
    const base = baseName(f.path).replace(/\.[^.]+$/, '');
    for (const raw of base.split(/[-_.\s]+/)) {
      const t = raw.toLowerCase();
      if (t.length < 3 || STOP_TOKENS.has(t)) continue;
      tally.set(t, (tally.get(t) || 0) + 1);
    }
  }
  if (tally.size === 0) return null;
  const threshold = Math.max(1, Math.ceil(files.length * 0.4));
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] >= threshold) return ranked[0][0];
  return null;
}

const SYMBOL_RES = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:interface|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*def\s+([A-Za-z_][\w]*)/,
  /^\s*func\s+([A-Za-z_][\w]*)/,
];

/** diff 에 새로 추가된 함수/클래스/타입 이름을 뽑는다 (const/let 은 노이즈라 제외) */
function namesFrom(lines) {
  const names = [];
  for (const line of lines) {
    for (const re of SYMBOL_RES) {
      const m = line.match(re);
      if (m && m[1]) { names.push(m[1]); break; }
    }
  }
  return names;
}

/**
 * 진짜 "새로 생긴" 심볼만 반환한다.
 * 기존 선언이 수정되면 diff 에 -/+ 로 함께 나타나므로, 삭제된 쪽 이름은 제외한다.
 */
function extractSymbols(addedLines, removedLines = []) {
  const removed = new Set(namesFrom(removedLines));
  return [...new Set(namesFrom(addedLines))].filter((n) => !removed.has(n));
}

/** diff 에서 추가/삭제 라인만 뽑는다 */
function diffSignals(diffText) {
  const added = [];
  const removed = [];
  if (!diffText) return { added, removed, addedDeclarations: false, touchedLogic: false };

  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }

  const addedDeclarations = added.some((l) => DECLARATION_RE.some((re) => re.test(l)));
  const touchedLogic = [...added, ...removed].some((l) => LOGIC_HINT_RE.some((re) => re.test(l)));
  return { added, removed, addedDeclarations, touchedLogic };
}

/**
 * code 카테고리의 modified 파일에 대해 feat / fix / refactor 를 판정한다.
 */
function classifyCodeUpdate(files, signals) {
  const hasAddedFile = files.some((f) => actionOf(f) === 'add');
  if (hasAddedFile) return 'feat';

  const added = signals.added.length;
  const removed = signals.removed.length;
  const total = added + removed;

  // 추가/삭제가 비슷하게 많은 구조 변경 → refactor (선언 추가보다 우선)
  if (added > 0 && removed > 0 && total >= 6 && Math.abs(added - removed) <= Math.max(2, total * 0.25)) {
    return 'refactor';
  }
  if (signals.addedDeclarations) return 'feat';
  if (total === 0) return 'fix';
  // 순수 삭제 위주(죽은 코드 정리) → refactor
  if (added === 0 && removed > 0) return 'refactor';
  // 새 선언 없이 동작을 고치는 경우 → fix
  return 'fix';
}

const KIND_TO_TYPE = {
  docs: 'docs',
  test: 'test',
  style: 'style',
  config: 'chore',
};

/** 카테고리별 가중 점수 (파일 수 + churn) */
function scoreKinds(files) {
  const scores = { code: 0, docs: 0, test: 0, style: 0, config: 0 };
  for (const f of files) {
    const kind = classifyFile(f.path);
    scores[kind] += 1 + Math.min(churnOf(f), 40) / 10;
  }
  return scores;
}

function pickPrimaryKind(scores) {
  let best = 'code';
  let bestScore = -1;
  // 동점 시 코드 > test > docs > style > config 순으로 우선 (기능 변경 우선)
  const order = ['code', 'test', 'docs', 'style', 'config'];
  for (const kind of order) {
    if (scores[kind] > bestScore) {
      bestScore = scores[kind];
      best = kind;
    }
  }
  return best;
}

/**
 * scope 는 "공통 디렉터리" 에서만 유도한다.
 * 파일명 토큰을 scope 로 쓰면 `docs(readme): update readme` 처럼 중복되므로 사용하지 않는다.
 * 단일 파일 변경 역시 scope 없이 type + subject 만 쓴다.
 */
function buildScope(files) {
  if (files.length < 2) return null;
  const dir = commonDir(files.map((f) => f.path));
  if (!dir) return null;
  const seg = dir.split('/').filter(Boolean).pop();
  if (!seg || STOP_TOKENS.has(seg.toLowerCase())) return null;
  return humanize(seg);
}

function stripExt(filePath) {
  const base = baseName(filePath);
  const idx = base.lastIndexOf('.');
  // 선행 점은 확장자가 아니라 숨김 파일 표시다 (.gitignore 등)
  const name = idx > 0 ? base.slice(0, idx) : base;
  return humanize(name);
}

function buildObject(files, scope) {
  const token = dominantToken(files);
  if (token) return humanize(token);
  if (scope) return scope;
  // 삭제된 파일 이름을 대표로 쓰면 오해를 부르므로, 추가 → 유지 순으로 우선한다.
  const added = files.find((f) => actionOf(f) === 'add');
  const kept = files.find((f) => actionOf(f) !== 'remove');
  const pick = added || kept || files[0];
  if (!pick) return 'changes';

  // 여러 최상위 디렉터리에 흩어진 변경은 파일 하나로 대표할 수 없다.
  const tops = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '(root)')));
  if (files.length >= 5 && tops.size > 1) return 'project files';

  return stripExt(pick.path);
}

function summarize(type, action, object) {
  const has = (w) => object.toLowerCase().includes(w);

  switch (type) {
    case 'feat':
      if (action === 'remove') return `remove ${object}`;
      if (action === 'rename') return `rename ${object}`;
      return `add ${object}`;
    case 'fix':
      if (action === 'add') return `add ${object}`;
      if (action === 'remove') return `remove ${object}`;
      return `fix ${object}`;
    case 'refactor':
      if (action === 'rename') return `rename ${object}`;
      return `refactor ${object}`;
    case 'style':
      return has('style') || has('layout') ? `update ${object}` : `update ${object} styles`;
    case 'docs':
      return has('doc') || has('readme') ? `update ${object}` : `update ${object} docs`;
    case 'test':
      return has('test') ? `update ${object}` : `update ${object} tests`;
    case 'chore':
      return action === 'add' ? `add ${object} config` : `update ${object} config`;
    case 'remove':
      return `remove ${object}`;
    default:
      return `update ${object}`;
  }
}

function truncateSubject(text, max = 68) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).replace(/[\s,;:]+$/, '') + '…';
}

function dirOf(filePath) {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? '' : filePath.slice(0, idx);
}

/** 파일명 목록을 "a.js, b.js, c.js 외 3개" 형태로 압축 */
function joinNames(group, max = 4) {
  const names = group.map((f) => baseName(f.path)).sort((a, b) => a.localeCompare(b));
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`;
}

const KIND_LABEL = { docs: 'docs', test: 'tests', style: 'styles', config: 'config' };
const MAX_BODY_LINES = 12;

/**
 * 커밋 본문.
 * subject 는 짧게 유지하고, "무엇이 얼마나 바뀌었는지"는 본문에 담는다.
 *  - rename 은 경로 변화이므로 명시
 *  - 코드 파일은 디렉터리별로 묶어 구조를 드러냄
 *  - docs/tests/styles/config 는 카테고리별로 묶음
 *  - 마지막에 파일 수와 증감 라인 요약
 */
function buildBody(files) {
  const lines = [];

  const renamed = files.filter((f) => f.origPath && actionOf(f) === 'rename');
  for (const f of renamed.slice(0, 5)) {
    lines.push(`- rename ${f.origPath} -> ${f.path}`);
  }

  const codeFiles = [];
  const kindGroups = { docs: [], test: [], style: [], config: [] };
  for (const f of files) {
    const kind = classifyFile(f.path);
    if (kind === 'code') codeFiles.push(f);
    else kindGroups[kind].push(f);
  }

  const byDir = new Map();
  for (const f of codeFiles) {
    const dir = dirOf(f.path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }
  const dirs = [...byDir.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  for (const [dir, group] of dirs.slice(0, 6)) {
    lines.push(dir ? `- ${dir}/: ${joinNames(group)}` : `- ${joinNames(group)}`);
  }
  if (dirs.length > 6) {
    lines.push(`- ... and ${dirs.length - 6} more directories`);
  }

  for (const kind of ['docs', 'test', 'style', 'config']) {
    const group = kindGroups[kind];
    if (group.length === 0) continue;
    lines.push(`- ${KIND_LABEL[kind]}: ${joinNames(group)}`);
  }

  const additions = files.reduce((n, f) => n + (f.additions || 0), 0);
  const deletions = files.reduce((n, f) => n + (f.deletions || 0), 0);
  const churn = additions || deletions ? ` (+${additions} -${deletions})` : '';
  lines.push(`- ${files.length} files changed${churn}`);

  if (lines.length > MAX_BODY_LINES) {
    const kept = lines.slice(0, MAX_BODY_LINES - 1);
    kept.push(`- ... and ${lines.length - (MAX_BODY_LINES - 1)} more lines`);
    return kept;
  }
  return lines;
}

/**
 * 커밋 메시지 생성.
 * @returns {{message:string, type:string, scope:string|null, subject:string, reasons:string[]}|null}
 */
function generateCommitMessage(changes, diffText = '') {
  const files = Array.isArray(changes) ? changes.filter(Boolean) : [];
  if (files.length === 0) {
    return null;
  }

  const signals = diffSignals(diffText);
  const scores = scoreKinds(files);
  const primaryKind = pickPrimaryKind(scores);

  let type;
  if (primaryKind === 'code') {
    const onlyAdds = files.every((f) => actionOf(f) === 'add');
    const onlyRemoves = files.every((f) => actionOf(f) === 'remove');
    if (onlyRemoves) type = 'remove';
    else if (onlyAdds) type = 'feat';
    else type = classifyCodeUpdate(files, signals);
  } else {
    type = KIND_TO_TYPE[primaryKind];
  }

  const scope = buildScope(files);
  let object = buildObject(files, scope);

  // 새 파일 추가가 아니라 "기존 파일에 새 함수/클래스를 추가" 한 경우,
  // 파일명보다 심볼 이름이 훨씬 구체적이다. 예: feat: add closePanel
  const symbols = extractSymbols(signals.added, signals.removed);
  const hasAddedFile = files.some((f) => actionOf(f) === 'add');
  if (type === 'feat' && !hasAddedFile && symbols.length > 0) {
    object = humanize(symbols[0]);
  }

  // 대표 action: 가장 많은 파일이 가진 action
  const actionTally = new Map();
  for (const f of files) {
    const a = actionOf(f);
    actionTally.set(a, (actionTally.get(a) || 0) + 1);
  }
  const action = [...actionTally.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const subject = truncateSubject(summarize(type, action, object));

  // 본문: 파일이 3개 이상이거나 rename 이 있을 때만 상세를 붙인다(1~2개는 subject 로 충분).
  const hasRename = files.some((f) => f.origPath && actionOf(f) === 'rename');
  const bodyLines = files.length >= 3 || hasRename ? buildBody(files) : [];

  const header = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;
  const message = bodyLines.length > 0 ? `${header}\n\n${bodyLines.join('\n')}` : header;

  const reasons = [];
  reasons.push(`주요 분류: ${primaryKind} → type=${type}`);
  if (scope) reasons.push(`범위(scope): ${scope}`);
  reasons.push(`변경 파일 ${files.length}개 (action=${action})`);
  if (signals.addedDeclarations) reasons.push('새 선언(함수/클래스/export) 추가 감지');
  if (hasRename) {
    const renameCount = files.filter((f) => f.origPath && actionOf(f) === 'rename').length;
    reasons.push(`rename ${renameCount}건`);
  }
  if (bodyLines.length > 0) reasons.push(`본문 ${bodyLines.length}줄 요약`);

  return { message, type, scope, subject, reasons };
}

module.exports = {
  generateCommitMessage,
  classifyFile,
  actionOf,
  diffSignals,
  extractSymbols,
  commonDir,
  dominantToken,
  classifyCodeUpdate,
};
