import { useEffect, useRef } from "react";
import { api } from "../api/client";

export type SSEHandlers = {
  onToken: (agentId: string, token: string) => void;
  onEvent: (event: string, data: unknown) => void;
};

/** Subscribe to a branch SSE stream. Re-subscribes when branchId changes. */
export function useEventStream(branchId: string | null, handlers: SSEHandlers) {
  const ref = useRef<SSEHandlers>(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!branchId) return;
    const src = new EventSource(api.streamUrl(branchId));
    const events = [
      "agent_start",
      "token",
      "agent_message",
      "user_message",
      "turn_complete",
      "graph_snapshot_start",
      "graph_update",
      "moderator_alert",
      "branch_created",
      "conclusion",
      "execution_start",
      "execution_result",
      "done",
      "error",
    ];
    const listeners: Array<() => void> = [];
    for (const ev of events) {
      const fn = (e: MessageEvent) => {
        let data: unknown = {};
        try {
          data = JSON.parse(e.data);
        } catch {
          /* keep {} */
        }
        if (ev === "token") {
          const d = data as { agent_id?: string; token?: string };
          ref.current.onToken(d.agent_id ?? "", d.token ?? "");
        } else {
          ref.current.onEvent(ev, data);
        }
      };
      src.addEventListener(ev, fn as EventListener);
      listeners.push(() => src.removeEventListener(ev, fn as EventListener));
    }
    return () => {
      listeners.forEach((off) => off());
      src.close();
    };
  }, [branchId]);
}
