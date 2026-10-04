import { useMemo } from "react";
import ReactFlow, { Background, Controls, MiniMap, type Edge, type Node } from "reactflow";
import "reactflow/dist/style.css";
import { EDGE_TYPE_LABEL, NODE_TYPE_LABEL, type GraphEdge, type GraphNode } from "../types";

const EDGE_COLOR: Record<string, string> = {
  supports: "var(--edge-supports)",
  contradicts: "var(--edge-contradicts)",
  refines: "var(--edge-refines)",
  derives_from: "var(--edge-derives_from)",
  related_to: "var(--edge-related_to)",
  duplicates: "var(--edge-duplicates)",
  verifies: "var(--edge-verifies)",
};

/** Simple layered layout: BFS depth from roots, spread horizontally. */
function layout(nodes: GraphNode[], edges: GraphEdge[]): Map<string, { x: number; y: number }> {
  const incoming = new Map<string, number>();
  const children = new Map<string, string[]>();
  nodes.forEach((n) => incoming.set(n.id, 0));
  edges.forEach((e) => {
    if (!incoming.has(e.target)) return;
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
    if (!children.has(e.source)) children.set(e.source, []);
    children.get(e.source)!.push(e.target);
  });
  const depth = new Map<string, number>();
  const queue: string[] = nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id);
  if (queue.length === 0 && nodes.length > 0) queue.push(nodes[0].id);
  queue.forEach((id) => depth.set(id, 0));
  const visited = new Set(queue);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const ch of children.get(cur) ?? []) {
      const d = (depth.get(cur) ?? 0) + 1;
      if (d > (depth.get(ch) ?? -1)) depth.set(ch, d);
      if (!visited.has(ch)) {
        visited.add(ch);
        queue.push(ch);
      }
    }
  }
  nodes.forEach((n) => {
    if (!depth.has(n.id)) depth.set(n.id, 0);
  });
  const layers = new Map<number, string[]>();
  nodes.forEach((n) => {
    const d = depth.get(n.id) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(n.id);
  });
  const pos = new Map<string, { x: number; y: number }>();
  [...layers.entries()]
    .sort((a, b) => a[0] - b[0])
    .forEach(([d, ids]) => {
      ids.forEach((id, i) => pos.set(id, { x: i * 230, y: d * 150 }));
    });
  return pos;
}

export default function GraphView({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const rfNodes: Node[] = useMemo(() => {
    const pos = layout(nodes, edges);
    return nodes.map((n) => ({
      id: n.id,
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      data: { label: n },
      type: "default",
    }));
  }, [nodes, edges]);

  const rfEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: EDGE_TYPE_LABEL[e.type] ?? e.type,
        animated: e.type === "contradicts",
        style: { stroke: EDGE_COLOR[e.type] ?? "var(--edge-related_to)", strokeWidth: 1.5 },
      })),
    [edges]
  );

  if (nodes.length === 0) {
    return (
      <div className="empty">
        아직 아이디어 지도가 없어요.
        <br />
        토론이 진행되면 설정한 주기마다 지도가 그려집니다.
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={rfNodes.map((n) => ({
        ...n,
        selected: n.id === selectedId,
        data: {
          label: (
            <div
              className={`node-card node-${(n.data.label as GraphNode).type}${n.id === selectedId ? " sel" : ""}`}
            >
              <div className="k">{NODE_TYPE_LABEL[(n.data.label as GraphNode).type] ?? (n.data.label as GraphNode).type}</div>
              <div className="t">{(n.data.label as GraphNode).label}</div>
            </div>
          ),
        },
        style: { background: "transparent", border: "none", padding: 0 },
      }))}
      edges={rfEdges}
      onNodeClick={(_, n) => onSelect(n.id)}
      onPaneClick={() => onSelect(null)}
      fitView
    >
      <Background />
      <Controls />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}
