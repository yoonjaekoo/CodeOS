import type {
  AnalysisProgress,
  BranchInfo,
  ChatMessage,
  Discussion,
  ExecutionConfig,
  ExecutionRun,
  GraphEdge,
  GraphNode,
  Project,
  ProjectContextInfo,
} from "../types";

const BASE = (import.meta.env.VITE_API_URL as string) || "http://localhost:8000";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<{ status: string; llm_configured: boolean }>("/api/health"),
  listProjects: () => req<Project[]>("/api/projects"),
  getProject: (id: string) =>
    req<Project & { branches: BranchInfo[] }>(`/api/projects/${id}`),
  createProject: (body: {
    title: string;
    topic: string;
    agent_count: number;
    graph_interval: number;
    max_turns: number;
    project_path?: string;
  }) => req<Project & { root_branch_id: string; context_status: string }>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  analyzeProject: (id: string) =>
    req<{ status: string }>(`/api/projects/${id}/analyze`, { method: "POST" }),
  getProjectContext: (id: string) =>
    req<{
      status: string;
      project_path: string | null;
      context: ProjectContextInfo | null;
      progress: AnalysisProgress | null;
    }>(`/api/projects/${id}/context`),
  listDrives: () => req<{ drives: string[] }>("/api/fs/drives"),
  browseDir: (path: string) =>
    req<{ path: string; parent: string | null; dirs: { name: string; path: string }[] }>(
      `/api/fs/browse?path=${encodeURIComponent(path)}`
    ),
  validateDir: (path: string) =>
    req<{ ok: boolean; file_count?: number }>("/api/fs/validate", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  deleteProject: (id: string) => req<{ status: string }>(`/api/projects/${id}`, { method: "DELETE" }),
  getDiscussion: (id: string) => req<Discussion>(`/api/discussions/${id}`),
  startDiscussion: (id: string, turns: number) =>
    req<{ status: string }>(`/api/discussions/${id}/start`, {
      method: "POST",
      body: JSON.stringify({ turns }),
    }),
  stopDiscussion: (id: string) =>
    req<{ status: string }>(`/api/discussions/${id}/stop`, { method: "POST" }),
  concludeDiscussion: (id: string) =>
    req<{ status: string }>(`/api/discussions/${id}/conclude`, { method: "POST" }),
  sendMessage: (id: string, content: string) =>
    req<ChatMessage>(`/api/discussions/${id}/message`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  forkBranch: (id: string, fork_node_id: string | null, name?: string) =>
    req<Discussion>(`/api/discussions/${id}/branches`, {
      method: "POST",
      body: JSON.stringify({ fork_node_id, name }),
    }),
  restartDiscussion: (id: string) =>
    req<Discussion>(`/api/discussions/${id}/restart`, { method: "POST" }),
  getExecutionConfig: (projectId: string) =>
    req<ExecutionConfig>(`/api/projects/${projectId}/execution`),
  updateExecutionConfig: (projectId: string, body: { run_command: string; test_command: string }) =>
    req<ExecutionConfig>(`/api/projects/${projectId}/execution`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  listExecutions: (branchId: string) =>
    req<{ is_running: boolean; executions: ExecutionRun[] }>(`/api/discussions/${branchId}/executions`),
  runCode: (branchId: string, kind: "run" | "test", command?: string) =>
    req<{ status: string }>(`/api/discussions/${branchId}/run`, {
      method: "POST",
      body: JSON.stringify({ kind, command }),
    }),
  streamUrl: (id: string) => `${BASE}/api/discussions/${id}/stream`,
};

export type { BranchInfo, ChatMessage, Discussion, ExecutionConfig, ExecutionRun, GraphEdge, GraphNode, Project };
