// Nodus E2E 검증 스크립트 — 모든 대기에는 타임아웃이 걸려 있어 무한루프가 없습니다.
// 사용법: node scripts/e2e.mjs [--quick]   (--quick: 분석까지만, 토론 생략)
//        분석 대상 폴더는 기본으로 이 저장소의 backend/ 를 쓰고, NODUS_TARGET 환경변수로 바꿀 수 있습니다.
// 종료코드: 0=통과, 1=실패, 2=전체 제한시간 초과
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.NODUS_API || "http://localhost:8000";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = process.env.NODUS_TARGET || path.join(ROOT, "backend");
const QUICK = process.argv.includes("--quick");
const GLOBAL_MS = QUICK ? 240000 : 420000;
const REQ_MS = 30000;

setTimeout(() => {
  console.error("GLOBAL TIMEOUT — 강제 종료");
  process.exit(2);
}, GLOBAL_MS).unref?.() ?? setTimeout(() => process.exit(2), GLOBAL_MS);

async function req(path, init = {}, timeout = REQ_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(BASE + path, { ...init, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`.slice(0, 200));
    return r.json();
  } finally {
    clearTimeout(t);
  }
}

async function waitForAnalysis(projectId, deadlineMs = 200000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const p = await req(`/api/projects/${projectId}`);
    if (p.context_status !== "analyzing") return p.context_status;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("분석 대기 시간 초과");
}

async function consumeSSE(branchId, deadlineMs = 150000) {
  const ctl = new AbortController();
  const killer = setTimeout(() => ctl.abort(), deadlineMs);
  try {
    const res = await fetch(BASE + `/api/discussions/${branchId}/stream`, { signal: ctl.signal });
    const rd = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("event: done")) break;
      if (buf.length > 200000) break; // 과도한 누적 방지
    }
    return buf;
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("SSE 대기 시간 초과");
    throw e;
  } finally {
    clearTimeout(killer);
  }
}

const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}`);
  if (!cond) process.exitCode = 1;
};

(async () => {
  // 1. 헬스
  const h = await req("/api/health");
  check("backend health", h.status === "ok");

  // 2. 폴더 브라우저
  const drives = await req("/api/fs/drives");
  check("드라이브 목록", Array.isArray(drives.drives) && drives.drives.length > 0);
  const root = drives.drives[0];
  const top = await req(`/api/fs/browse?path=${encodeURIComponent(root)}`);
  check("루트 탐색", top.path && Array.isArray(top.dirs));
  const me = await req(`/api/fs/browse?path=${encodeURIComponent(process.cwd())}`);
  check("작업 폴더 탐색", me.dirs.length >= 0 && typeof me.path === "string");
  const v = await req("/api/fs/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: process.cwd() }),
  });
  check("폴더 검증", v.ok === true);

  // 3. 분석 E2E (기본: 이 저장소의 backend/ 폴더, NODUS_TARGET으로 변경)
  const target = TARGET;
  const p = await req("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "스크립트E2E",
      topic: "우리 백엔드에 어떤 기능을 더 넣으면 좋을까?",
      agent_count: 2,
      graph_interval: 50,
      max_turns: 50,
      project_path: target,
    }),
  });
  check("프로젝트 생성", !!p.id && !!p.root_branch_id);
  const status = await waitForAnalysis(p.id);
  check("프로젝트 분석 완료", status === "done");
  const ctx = await req(`/api/projects/${p.id}/context`);
  const files = ctx.context?.important_files || [];
  check("중요 파일 선정", files.length > 0);
  check("민감파일 누출 없음", !files.some((f) => /\.env|\.pem|\.key/i.test(f.path)));

  if (!QUICK) {
    // 4. 컨텍스트 주입 토론 (2턴)
    await req(`/api/discussions/${p.root_branch_id}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turns: 2 }),
    });
    await consumeSSE(p.root_branch_id);
    const d = await req(`/api/discussions/${p.root_branch_id}`);
    check("2턴 토론 완료", d.ai_turn_count >= 2 && d.messages.length >= 2);
  }

  // 5. 정리
  await req(`/api/projects/${p.id}`, { method: "DELETE" });
  console.log(process.exitCode === 1 ? "E2E 실패 항목 있음" : "E2E 전부 통과");
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error("FAIL:", e.message || e);
  process.exit(1);
});
