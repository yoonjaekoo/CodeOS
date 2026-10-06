export interface Project {
  id: string;
  title: string;
  topic: string;
  created_at: string;
  updated_at: string;
  root_branch_id?: string;
  project_path?: string | null;
  context_status?: string;
  context_summary?: string;
  is_analyzing?: boolean;
  analysis?: AnalysisProgress | null;
}

export interface AnalysisStage {
  key: string;
  label: string;
  status: "pending" | "running" | "done";
  detail: string;
}

export interface AnalysisFile {
  path: string;
  purpose: string;
  importance: string;
  read: boolean;
  chars: number;
}

export interface AnalysisProgress {
  project_id: string;
  project_path: string;
  status: "running" | "done" | "failed";
  stage: string;
  stages: AnalysisStage[];
  files: AnalysisFile[];
  counts: { scanned: number; selected: number; read: number; chars: number };
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface ProjectContextInfo {
  project: { name: string; description: string; purpose: string };
  stack: { languages: string[]; frameworks: string[]; database: string[]; infrastructure: string[] };
  architecture: { overview: string; components: string[]; data_flow: string[] };
  entry_points: string[];
  important_files: { path: string; purpose: string; importance: string }[];
  apis: string[];
  database: { technology: string; schema_summary: string; important_entities: string[] };
  workflows: string[];
  technical_concerns: string[];
  development_notes: string[];
  context_summary: string;
}

export interface BranchInfo {
  id: string;
  name: string;
  parent_branch_id: string | null;
  fork_node_id: string | null;
  fork_source_node_id: string | null;
  fork_turn: number;
  agent_count: number;
  graph_interval: number;
  max_turns: number;
  ai_turn_count: number;
  status: string;
  message_count?: number;
  node_count?: number;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  role: "agent" | "user" | "moderator" | "conclusion" | "execution";
  agent_id?: string | null;
  agent_name?: string | null;
  content: string;
  turn?: number | null;
  created_at: string;
}

export interface ExecutionRun {
  id: string;
  project_id: string;
  branch_id: string | null;
  kind: "run" | "test" | "custom";
  kind_label: string;
  command: string;
  image: string;
  status: "ok" | "failed" | "timeout" | "error" | "unavailable";
  status_label: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timed_out: boolean;
  duration_ms: number;
  requested_by: "user" | "agent";
  message_id: string | null;
  detail: string;
  created_at: string;
}

export interface DetectedCommand {
  kind: "run" | "test";
  command: string;
  image: string;
  reason: string;
  confidence: string;
}

export interface SandboxInfo {
  enabled: boolean;
  driver: string;
  available: boolean;
  image: string;
  network: string;
  writable: boolean;
  timeout_sec: number;
  agent_commands: boolean;
  detail: string;
}

export interface ExecutionConfig {
  project_path: string | null;
  configured: { run_command: string; test_command: string };
  detected: DetectedCommand[];
  sandbox: SandboxInfo;
  can_run: boolean;
}

export interface GraphNode {
  id: string;
  type: "idea" | "question" | "objection" | "problem" | "decision" | "conclusion" | "evidence";
  label: string;
  description: string;
  status: string;
  source_messages: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
}

export interface Discussion {
  id: string;
  project_id: string;
  topic: string;
  title: string;
  name: string;
  parent_branch_id: string | null;
  fork_node_id: string | null;
  fork_turn: number;
  agent_count: number;
  graph_interval: number;
  max_turns: number;
  ai_turn_count: number;
  status: string;
  is_running: boolean;
  messages: ChatMessage[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
}

export interface ModeratorAlert {
  type: string;
  message: string;
}

export const NODE_TYPE_LABEL: Record<string, string> = {
  idea: "아이디어",
  question: "질문",
  objection: "반론",
  problem: "문제",
  decision: "결정",
  conclusion: "정리",
  evidence: "실행 근거",
};

export const EDGE_TYPE_LABEL: Record<string, string> = {
  supports: "지지",
  contradicts: "반대",
  refines: "다듬음",
  derives_from: "파생",
  related_to: "연관",
  duplicates: "중복",
  verifies: "검증",
};

export const NODE_STATUS_LABEL: Record<string, string> = {
  active: "진행 중",
  refined: "다려짐",
  merged: "합쳐짐",
  dropped: "보류",
};
