import type { AnalysisProgress, ProjectContextInfo } from "../types";

const STAGE_MARK: Record<string, string> = { done: "✓", running: "◌", pending: "○" };
const IMPORTANCE_LABEL: Record<string, string> = { high: "높음", medium: "보통", low: "낮음" };
const STATUS_LABEL: Record<string, string> = { running: "분석 중", done: "완료", failed: "실패" };

export default function AnalysisPanel({
  path,
  progress,
  context,
  status,
  onClose,
}: {
  path: string;
  progress: AnalysisProgress | null;
  context: ProjectContextInfo | null;
  status: string;
  onClose: () => void;
}) {
  // Live progress only exists for the current process; fall back to the stored result.
  const files = progress?.files.length
    ? progress.files
    : (context?.important_files ?? []).map((f) => ({ ...f, read: true, chars: 0 }));
  const stack = [
    ...(context?.stack.languages ?? []),
    ...(context?.stack.frameworks ?? []),
    ...(context?.stack.database ?? []),
    ...(context?.stack.infrastructure ?? []),
  ];

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="analysis-head">
          <h2 style={{ margin: 0 }}>프로젝트 폴더 분석</h2>
          <button onClick={onClose}>닫기</button>
        </div>
        <div className="meta" style={{ margin: "6px 0 12px", fontSize: 12, color: "var(--muted)" }}>
          <b style={{ wordBreak: "break-all" }}>{path || "(연결된 폴더 없음)"}</b>
          {progress && <span> · {STATUS_LABEL[progress.status] ?? progress.status}</span>}
          {!progress && <span> · {STATUS_LABEL[status] ?? status}</span>}
        </div>

        {progress ? (
          <>
            <ol className="steps">
              {progress.stages.map((s) => (
                <li key={s.key} className={`step ${s.status}`}>
                  <span className="dot">{STAGE_MARK[s.status] ?? "○"}</span>
                  <span className="label">{s.label}</span>
                  {s.detail && <span className="detail">{s.detail}</span>}
                </li>
              ))}
            </ol>
            <div className="meta" style={{ fontSize: 12, color: "var(--muted)" }}>
              스캔 {progress.counts.scanned}개 파일 · 선택 {progress.counts.selected}개 · 읽음{" "}
              {progress.counts.read}개 · {progress.counts.chars.toLocaleString()}자
            </div>
          </>
        ) : (
          <div className="meta">
            {status === "done"
              ? "이전 세션의 분석 결과입니다 (단계별 진행 기록은 서버 메모리에만 남습니다)."
              : "아직 분석 기록이 없습니다."}
          </div>
        )}

        {progress?.error && <div className="alert" style={{ margin: "10px 0 0" }}>{progress.error}</div>}

        {files.length > 0 && (
          <>
            <h4 className="sec">선정된 파일</h4>
            <div className="file-list">
              {files.map((f) => (
                <div key={f.path} className="file-row">
                  <span className={`imp imp-${f.importance}`}>{IMPORTANCE_LABEL[f.importance] ?? f.importance}</span>
                  <span className="path">{f.path}</span>
                  <span className="detail">
                    {f.chars > 0 ? `${f.chars.toLocaleString()}자` : f.read ? "내용 없음" : "읽는 중…"}
                  </span>
                  {f.purpose && <div className="purpose">{f.purpose}</div>}
                </div>
              ))}
            </div>
          </>
        )}

        {context && (
          <>
            <h4 className="sec">분석 결과</h4>
            {stack.length > 0 && (
              <div className="chips">
                {stack.map((s) => (
                  <span key={s} className="badge">
                    {s}
                  </span>
                ))}
              </div>
            )}
            {context.project.name && (
              <p style={{ fontSize: 13, margin: "8px 0 0" }}>
                <b>{context.project.name}</b>
                {context.project.description && ` — ${context.project.description}`}
              </p>
            )}
            {context.architecture.overview && (
              <p style={{ fontSize: 13, lineHeight: 1.6 }}>{context.architecture.overview}</p>
            )}
            {context.entry_points.length > 0 && (
              <p style={{ fontSize: 12, color: "var(--muted)", margin: "4px 0" }}>
                시작점: {context.entry_points.join(", ")}
              </p>
            )}
            {context.context_summary && (
              <p style={{ fontSize: 13, lineHeight: 1.6 }}>{context.context_summary}</p>
            )}
            {context.technical_concerns.length > 0 && (
              <>
                <h4 className="sec">기술적 주의사항</h4>
                <ul className="rel-list">
                  {context.technical_concerns.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
