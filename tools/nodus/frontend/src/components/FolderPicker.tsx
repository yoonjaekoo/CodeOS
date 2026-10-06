import { useEffect, useState } from "react";
import { api } from "../api/client";

interface DirEntry {
  name: string;
  path: string;
}

export default function FolderPicker({
  initialPath,
  onSelect,
  onClose,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileCount, setFileCount] = useState<number | null>(null);

  const load = async (p: string) => {
    setLoading(true);
    setError(null);
    setFileCount(null);
    try {
      const r = await api.browseDir(p);
      setPath(r.path);
      setParent(r.parent);
      setDirs(r.dirs);
    } catch (e) {
      setError(`${e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.listDrives().then((r) => setDrives(r.drives)).catch(() => {});
    load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!path) return;
    const t = setTimeout(async () => {
      try {
        const r = await api.validateDir(path);
        setFileCount(r.ok ? (r.file_count ?? null) : null);
      } catch {
        setFileCount(null);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [path]);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0 }}>프로젝트 폴더 선택</h2>
        <div className="meta" style={{ margin: "6px 0 10px", fontSize: 12, color: "var(--muted)" }}>
          현재: <b style={{ wordBreak: "break-all" }}>{path || "(드라이브 목록)"}</b>
          {fileCount !== null && fileCount >= 0 && <span> · 파일 약 {fileCount}개</span>}
        </div>
        {drives.length > 0 && (
          <div className="row" style={{ marginBottom: 8 }}>
            {drives.map((d) => (
              <button key={d} onClick={() => load(d)} style={{ flex: "none" }}>
                {d}
              </button>
            ))}
          </div>
        )}
        {parent && (
          <button onClick={() => load(parent)} style={{ marginBottom: 8 }}>
            ⬆ 상위 폴더
          </button>
        )}
        {error && <div className="alert">{error}</div>}
        <div className="folder-list" style={{ maxHeight: 300, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8 }}>
          {loading && <div className="empty">불러오는 중…</div>}
          {!loading &&
            dirs.map((d) => (
              <div
                key={d.path}
                className="folder-row"
                onClick={() => load(d.path)}
                style={{ padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid var(--line-soft)" }}
              >
                📁 {d.name}
              </div>
            ))}
          {!loading && dirs.length === 0 && <div className="empty">하위 폴더가 없습니다.</div>}
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <button onClick={onClose}>취소</button>
          <button className="primary" onClick={() => { if (path) onSelect(path); }} disabled={!path}>
            이 폴더 선택
          </button>
        </div>
      </div>
    </div>
  );
}
