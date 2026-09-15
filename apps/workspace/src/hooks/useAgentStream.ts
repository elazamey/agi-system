import { useCallback, useEffect, useState } from "react";

export interface AgentEvent {
  type:
    | "run_started"
    | "phase"
    | "thought"
    | "tool_call"
    | "tool_result"
    | "terminal_log"
    | "preview_update"
    | "verification"
    | "code_update"
    | "run_completed"
    | "run_cancelled"
    | "human_approval_required"
    | "approval_granted"
    | "approval_denied"
    | "policy_decision"
    | "evidence";

  run_id?: string;
  event_id?: number;
  timestamp?: number;

  content?: string;
  name?: string;

  tool?: string;
  status?: string;
  exit_code?: number;

  log?: string;

  format?: string;
  html?: string;

  source?: string;
  bytes?: number;
  reason?: string;

  risk_level?: string;
  requires_approval?: boolean;
}

interface UseAgentStreamResult {
  events: AgentEvent[];
  previewHtml: string;
  terminalLogs: string[];
  connected: boolean;
  error: string | null;
  awaitingApproval: boolean;
  approvalRiskLevel: string;
  approvalReason: string;
  sendCode: (code: string) => Promise<void>;
  approveCode: (approved: boolean) => Promise<void>;
}

export function useAgentStream(
  apiBaseUrl: string,
  runId: string | null,
): UseAgentStreamResult {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [previewHtml, setPreviewHtml] = useState("");
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [approvalRiskLevel, setApprovalRiskLevel] = useState("");
  const [approvalReason, setApprovalReason] = useState("");

  useEffect(() => {
    if (!runId) {
      return;
    }

    const url = `${apiBaseUrl}/api/agent/runs/${runId}/stream`;

    const source = new EventSource(url);

    source.onopen = () => {
      setConnected(true);
      setError(null);
    };

    source.onmessage = handleMessage;

    source.onerror = () => {
      setConnected(false);
      setError("Connection lost");
    };

    function handleMessage(event: MessageEvent) {
      try {
        const parsed = JSON.parse(event.data) as AgentEvent;

        setEvents((prev) => [...prev, parsed]);

        if (parsed.type === "preview_update" && parsed.html) {
          setPreviewHtml(parsed.html);
        }

        if (parsed.type === "terminal_log" && parsed.log) {
          setTerminalLogs((prev) => [...prev, parsed.log!]);
        }

        if (parsed.type === "human_approval_required") {
          setAwaitingApproval(true);
          setApprovalRiskLevel(parsed.risk_level || "CRITICAL");
          setApprovalReason(parsed.reason || "");
        }

        if (parsed.type === "approval_granted" || parsed.type === "approval_denied") {
          setAwaitingApproval(false);
          setApprovalRiskLevel("");
          setApprovalReason("");
        }
      } catch (err) {
        console.error("SSE parse error:", err);
      }
    }

    return () => {
      source.close();
      setConnected(false);
    };
  }, [apiBaseUrl, runId]);

  const sendCode = useCallback(
    async (code: string) => {
      if (!runId) {
        throw new Error("No active agent run");
      }

      const response = await fetch(
        `${apiBaseUrl}/api/agent/runs/${runId}/update`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Code update failed: ${body}`);
      }
    },
    [apiBaseUrl, runId],
  );

  const approveCode = useCallback(
    async (approved: boolean) => {
      if (!runId) {
        throw new Error("No active agent run");
      }

      const response = await fetch(
        `${apiBaseUrl}/api/agent/runs/${runId}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Approval failed: ${body}`);
      }
    },
    [apiBaseUrl, runId],
  );

  return {
    events,
    previewHtml,
    terminalLogs,
    connected,
    error,
    awaitingApproval,
    approvalRiskLevel,
    approvalReason,
    sendCode,
    approveCode,
  };
}
