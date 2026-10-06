import { useState } from "react";

import {
  EDGE_TYPE_LABEL,
  NODE_STATUS_LABEL,
  NODE_TYPE_LABEL,
  type BranchInfo,
  type ChatMessage,
  type GraphEdge,
  type GraphNode,
} from "../types";

export default function NodePanel({
  node,
  nodes,
  edges,
  messages,
  branches,
  onClose,
  onFork,
  onOpenBranch,
  forking,
}: {
  node: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  messages: ChatMessage[];
  branches: BranchInfo[];
  onClose: () => void;
  onFork: () => void;
  onOpenBranch: (branchId: string) => void;
  forking: boolean;
}) {
  const [tab, setTab] = useState<"node" | "all">("node");
  const byId = new Map(messages.map((m) => [m.id, m]));
  const related = edges.filter((e) => e.source === node.id || e.target === node.id).map((e) => {
    const otherId = e.source === node.id ? e.target : e.source;
    const other = nodes.find((n) => n.id === otherId);
    return { edge: e, other };
  });

  return (
    <aside className="side">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="badge">{NODE_TYPE_LABEL[node.type] ?? node.type}</span>
        <button onClick={onClose}>닫기</button>
      </div>
      <h3 style={{ marginTop: 8 }}>{node.label}</h3>
      <div className="meta">상태: {NODE_STATUS_LABEL[node.status] ?? node.status}</div>
      <p style={{ fontSize: 13, lineHeight: 1.6 }}>{node.description || "설명이 없습니다."}</p>
      {related.length > 0 && (
        <>
          <h4 style={{ fontSize: 12, color: "var(--muted)", margin: "12px 0 4px" }}>연관된 아이디어</h4>
          <ul className="rel-list">
            {related.map(({ edge, other }) => (
              <li key={edge.id}>
                {other?.label ?? other?.id}{" "}
                <span style={{ color: "var(--muted)" }}>({EDGE_TYPE_LABEL[edge.type] ?? edge.type})</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4 style={{ fontSize: 12, color: "var(--muted)", margin: "12px 0 4px" }}>발언</h4>
      <div className="tabs">
        <button className={`tab${tab === "node" ? " active" : ""}`} onClick={() => setTab("node")}>
          이 아이디어 {node.source_messages.length}
        </button>
        <button className={`tab${tab === "all" ? " active" : ""}`} onClick={() => setTab("all")}>
          전체 대화 {messages.length}
        </button>
      </div>
      <div className="src-list">
        {tab === "node" ? (
          <>
            {node.source_messages.length === 0 && <div className="meta">연결된 발언이 없습니다.</div>}
            {node.source_messages.map((mid) => {
              const m = byId.get(mid);
              return (
                <div key={mid} className="src">
                  <b>{m ? `${m.agent_name ?? (m.role === "user" ? "나" : m.role)}${m.turn ? ` · ${m.turn}번째 발언` : ""}` : mid}</b>
                  <div>{m ? m.content.slice(0, 160) : ""}</div>
                </div>
              );
            })}
          </>
        ) : (
          <>
            {messages.length === 0 && <div className="meta">아직 발언이 없습니다.</div>}
            {messages.map((m) => (
              <div key={m.id} className={`src${node.source_messages.includes(m.id) ? " hit" : ""}`}>
                <b>{`${m.agent_name ?? (m.role === "user" ? "나" : m.role)}${m.turn != null ? ` · ${m.turn}번째 발언` : ""}`}</b>
                <div>{m.content}</div>
              </div>
            ))}
          </>
        )}
      </div>
      <h4 style={{ fontSize: 12, color: "var(--muted)", margin: "12px 0 4px" }}>이 아이디어에서 갈라진 토론</h4>
      {branches.length === 0 ? (
        <div className="meta">아직 이 노드에서 분기된 토론이 없어요.</div>
      ) : (
        <div className="src-list">
          {branches.map((b) => (
            <div key={b.id} className="src" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div>
                <b>{b.name}</b>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{b.message_count ?? 0}개 발언</div>
              </div>
              <button className="primary" onClick={() => onOpenBranch(b.id)}>
                열기
              </button>
            </div>
          ))}
        </div>
      )}
      <button className="primary" style={{ width: "100%", marginTop: 14 }} onClick={onFork} disabled={forking}>
        {forking ? "분기 생성 중…" : "여기부터 새 토론 만들기"}
      </button>
    </aside>
  );
}
