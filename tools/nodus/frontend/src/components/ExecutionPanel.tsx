import { useEffect, useState } from "react";

import type { ExecutionConfig, ExecutionRun } from "../types";

const STATUS_CLASS: Record<string, string> = {
  ok: "ok",
  failed: "bad",
  timeout: "bad",
  error: "bad",
  unavailable: "muted",
};

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}초`;
}

export default function ExecutionPanel({
  config,
  executions,
  running,
  busy,
  onClose,
  onSave,
  onRun,
}: {
  config: ExecutionConfig | null;
  executions: ExecutionRun[];
  running: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (run: string, test: string) => Promise<void>;
  onRun: (kind: "run" | "test", command?: string) => void;
}) {
  const [runCmd, setRunCmd] = useState(config?.configured.run_command ?? "");
  const [testCmd, setTestCmd] = useState(config?.configured.test_command ?? "");
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRunCmd(config?.configured.run_command ?? "");
    setTestCmd(config?.configured.test_command ?? "");
  }, [config?.configured.run_command, config?.configured.test_command]);

  const sandbox = config?.sandbox;
  const detected = config?.detected ?? [];

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal execution-modal" onClick={(e) => e.stopPropagation()}>
        <div className="analysis-head">
          <h2 style={{ margin: 0 }}>코드 실행</h2>
          <button onClick={onClose}>닫기</button>
        </div>
        <div className="meta" style={{ margin: "6px 0 12px", fontSize: 12, color: "var(--muted)" }}>
          명령은 격리된 컨테이너에서 실행됩니다 · 네트워크 {sandbox?.network ?? "none"} ·{" "}
          {sandbox?.writable ? "폴더 쓰기 허용" : "폴더 읽기 전용"} · 제한 {sandbox?.timeout_sec ?? 0}초
          {sandbox?.image ? ` · 이미지 ${sandbox.image}` : ""}
        </div>
        <div className="meta" style={{ margin: "0 0 12px", fontSize: 12, color: "var(--muted)" }}>
          컨테이너 이미지에는 프로젝트 의존성이 미리 설치돼 있어야 합니다(네트워크는 기본 차단). 필요하면
          명령 앞에 설치 단계를 넣고 서버의 <code>SANDBOX_NETWORK</code>를 열어 두세요.
        </div>

        {sandbox && !sandbox.available && (
          <div className="alert" style={{ margin: "0 0 12px" }}>
            샌드박스를 쓸 수 없습니다: {sandbox.detail || "Docker를 확인해 주세요"}
          </div>
        )}
        {config && !config.project_path && (
          <div className="alert" style={{ margin: "0 0 12px" }}>
            연결된 프로젝트 폴더가 없습니다. 폴더를 지정해야 코드를 실행할 수 있습니다.
          </div>
        )}

        <label>실행 명령</label>
        <input
          value={runCmd}
          onChange={(e) => setRunCmd(e.target.value)}
          placeholder="비워 두면 자동 감지"
        />
        <label>테스트 명령</label>
        <input
          value={testCmd}
          onChange={(e) => setTestCmd(e.target.value)}
          placeholder="비워 두면 자동 감지"
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(runCmd.trim(), testCmd.trim());
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "저장 중…" : "저장"}
          </button>
          <button
            onClick={() => onRun("test", testCmd.trim() || undefined)}
            disabled={busy || running || !config?.can_run}
          >
            {running ? "실행 중…" : "테스트 실행"}
          </button>
          <button
            className="primary"
            onClick={() => onRun("run", runCmd.trim() || undefined)}
            disabled={busy || running || !config?.can_run}
          >
            {running ? "실행 중…" : "코드 실행"}
          </button>
        </div>

        {detected.length > 0 && (
          <>
            <h4 className="sec">자동 감지된 명령</h4>
            <div className="src-list">
              {detected.map((d) => (
                <div key={`${d.kind}-${d.command}`} className="src">
                  <b>{d.kind === "test" ? "테스트" : "실행"}</b>{" "}
                  <code>{d.command}</code>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>
                    {d.reason} · {d.image}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <h4 className="sec">실행 기록 {executions.length > 0 ? `(${executions.length})` : ""}</h4>
        {executions.length === 0 ? (
          <div className="meta">아직 실행 기록이 없습니다.</div>
        ) : (
          <div className="file-list">
            {executions.map((e) => (
              <div key={e.id} className="exec-row">
                <button className="exec-head" onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <span className={`exec-status ${STATUS_CLASS[e.status] ?? "muted"}`}>
                    {e.status_label}
                  </span>
                  <code>{e.command}</code>
                  <span className="exec-meta">
                    {e.exit_code != null ? `exit ${e.exit_code} · ` : ""}
                    {seconds(e.duration_ms)} · {e.requested_by === "agent" ? "AI 요청" : "사용자"}
                  </span>
                </button>
                {open === e.id && (
                  <pre className="exec-out">
                    {e.stdout || "(출력 없음)"}
                    {e.stderr ? `\n\n[stderr]\n${e.stderr}` : ""}
                    {e.detail ? `\n\n(${e.detail})` : ""}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
