'use strict';

/**
 * 터미널 화면 제어 (의존성 없음).
 *  - 대체 화면(alternate screen) 사용, 커서 숨김
 *  - ANSI 색상 코드를 제외한 "보이는 폭" 계산 (한글/이모지는 2칸)
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

/** 코드포인트 폭: 동아시아 전각 문자는 2 */
function codePointWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32) return 0;
  if (cp < 0x7f) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** ANSI 코드를 무시한 표시 폭 */
function strWidth(text) {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    width += codePointWidth(ch.codePointAt(0));
  }
  return width;
}

/** ANSI 코드를 보존하면서 표시 폭 기준으로 자른다 */
function truncate(text, max) {
  if (max <= 0) return '';
  const s = String(text);
  let out = '';
  let width = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end !== -1) {
        out += s.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const w = codePointWidth(cp);
    if (width + w > max) break;
    out += ch;
    width += w;
    i += ch.length;
  }
  return out;
}

/** 표시 폭 기준으로 공백 패딩 */
function pad(text, width) {
  const current = strWidth(text);
  if (current >= width) return truncate(text, width);
  return text + ' '.repeat(width - current);
}

function createScreen(stream = process.stdout) {
  let active = false;

  const api = {
    enter() {
      if (active) return;
      stream.write('\x1b[?1049h'); // 대체 화면
      stream.write('\x1b[?25l');   // 커서 숨김
      stream.write('\x1b[?2004h'); // 브래킷 페이스트(붙여넣기 구분) 켜기
      stream.write('\x1b[2J\x1b[H');
      active = true;
    },
    exit() {
      if (!active) return;
      stream.write('\x1b[?2004l'); // 브래킷 페이스트 끄기
      stream.write('\x1b[?25h');
      stream.write('\x1b[?1049l');
      active = false;
    },
    size() {
      return {
        cols: Math.max(40, stream.columns || 80),
        rows: Math.max(10, stream.rows || 24),
      };
    },
    /** lines: 화면에 그릴 문자열 배열. cursor: {row, col} (1-based) 또는 null */
    draw(lines, cursor = null) {
      const { rows, cols } = api.size();
      let buf = '\x1b[H';
      for (let i = 0; i < rows; i += 1) {
        buf += truncate(lines[i] || '', cols);
        buf += '\x1b[0m\x1b[K';
        if (i < rows - 1) buf += '\r\n';
      }
      if (cursor) {
        buf += `\x1b[${cursor.row};${cursor.col}H\x1b[?25h`;
      } else {
        buf += '\x1b[?25l';
      }
      stream.write(buf);
    },
  };

  return api;
}

module.exports = { createScreen, strWidth, truncate, pad, stripAnsi, codePointWidth };
