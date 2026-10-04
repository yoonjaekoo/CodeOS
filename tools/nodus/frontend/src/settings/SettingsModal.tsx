import { useState } from "react";
import FolderPicker from "../components/FolderPicker";

export interface NewProjectSettings {
  title: string;
  topic: string;
  agent_count: number;
  graph_interval: number;
  graph_interval_custom: number;
  max_turns: number; // -1 == unlimited
  project_path: string;
}

const INTERVALS = [5, 10, 20, 30, 50];
const MAX_TURNS = [50, 100, 200];

export default function SettingsModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (s: { title: string; topic: string; agent_count: number; graph_interval: number; max_turns: number; project_path: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [agents, setAgents] = useState(3);
  const [interval, setInterval] = useState<number | "custom">(10);
  const [custom, setCustom] = useState(15);
  const [maxTurns, setMaxTurns] = useState<number | "unlimited">(50);
  const [projectPath, setProjectPath] = useState("");
  const [showPicker, setShowPicker] = useState(false);

  const submit = () => {
    if (!title.trim() || !topic.trim()) return;
    onCreate({
      title: title.trim(),
      topic: topic.trim(),
      agent_count: agents,
      graph_interval: interval === "custom" ? Math.max(1, Math.min(100, custom)) : interval,
      max_turns: maxTurns === "unlimited" ? -1 : maxTurns,
      project_path: projectPath.trim(),
    });
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0 }}>새 브레인스토밍</h2>
        <label>제목</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 펫케어 앱 구상" />
        <label>만들고 있는 것 & 궁금한 점</label>
        <textarea value={topic} onChange={(e) => setTopic(e.target.value)} placeholder='예: "반려동물 병원비 절약 앱을 만들려고 하는데, 어떤 기능을 넣으면 좋을까?"' />
        <label>프로젝트 폴더 경로 (선택)</label>
        <div className="row">
          <input
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            placeholder="폴더를 고르면 AI가 코드를 먼저 분석합니다"
          />
          <button type="button" onClick={() => setShowPicker(true)} style={{ flex: "none" }}>
            📁 폴더 선택
          </button>
        </div>
        <label>AI 토론자 수 (2–5)</label>
        <input type="number" min={2} max={5} value={agents} onChange={(e) => setAgents(Math.max(2, Math.min(5, Number(e.target.value) || 3)))} />
        <label>지도 갱신 주기 (발언 수)</label>
        <div className="row">
          <select value={String(interval)} onChange={(e) => setInterval(e.target.value === "custom" ? "custom" : Number(e.target.value))}>
            {INTERVALS.map((v) => (
              <option key={v} value={v}>{v}턴</option>
            ))}
            <option value="custom">직접 입력</option>
          </select>
          {interval === "custom" && (
            <input type="number" min={1} max={100} value={custom} onChange={(e) => setCustom(Number(e.target.value) || 15)} />
          )}
        </div>
        <label>최대 토론 턴</label>
        <select value={String(maxTurns)} onChange={(e) => setMaxTurns(e.target.value === "unlimited" ? "unlimited" : Number(e.target.value))}>
          {MAX_TURNS.map((v) => (
            <option key={v} value={v}>{v}턴</option>
          ))}
          <option value="unlimited">제한 없음</option>
        </select>
        <div className="row" style={{ marginTop: 16 }}>
          <button onClick={onClose}>취소</button>
          <button className="primary" onClick={submit} disabled={!title.trim() || !topic.trim()}>
            브레인스토밍 시작
          </button>
        </div>
      </div>
      {showPicker && (
        <FolderPicker
          initialPath={projectPath}
          onSelect={(p) => { setProjectPath(p); setShowPicker(false); }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
