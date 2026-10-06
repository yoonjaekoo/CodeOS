import { useEffect, useRef } from "react";
import type { ChatMessage } from "../types";

export default function ChatPane({
  messages,
  streaming,
  thinkingAgent,
}: {
  messages: ChatMessage[];
  streaming: { agentId: string; agentName?: string; text: string } | null;
  thinkingAgent: string | null;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streaming?.text.length]);

  return (
    <div className="chat-list">
      {messages.length === 0 && (
        <div className="empty">아직 발언이 없어요. 아래에서 "토론 시작"을 누르면 AI들이 아이디어 내기를 시작합니다.</div>
      )}
      {messages.map((m) => (
        <div key={m.id} className={`msg ${m.role}`}>
          <div className="who">
            {m.role === "user" ? (
              <span className="badge">나</span>
            ) : m.role === "moderator" ? (
              <span className="badge">진행 도우미</span>
            ) : m.role === "conclusion" ? (
              <span className="badge badge-conclusion">결론</span>
            ) : m.role === "execution" ? (
              <span className="badge badge-execution">코드 실행</span>
            ) : (
              <span className={`badge agent-${m.agent_id ?? ""}`}>{m.agent_name || "AI"}</span>
            )}
            {m.turn != null && <span className="turn">{m.turn}번째 발언</span>}
          </div>
          <div className={`body${m.role === "execution" ? " exec" : ""}`}>{m.content}</div>
        </div>
      ))}
      {thinkingAgent && !streaming && <div className="thinking">{thinkingAgent} 생각 중…</div>}
      {streaming && (
        <div className="msg streaming">
          <div className="who">
            <span className={`badge agent-${streaming.agentId}`}>{streaming.agentName || streaming.agentId || "AI"}</span>
          </div>
          <div className="body">{streaming.text}</div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
