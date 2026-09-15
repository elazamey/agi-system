import React, { useEffect, useState } from "react";
import { useAgentStream } from "./hooks/useAgentStream";
import { LivePreview } from "./components/LivePreview";
import { CodeEditor } from "./components/CodeEditor";

const API_BASE = "http://localhost:8000";

export default function App() {
  const [runId, setRunId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"preview" | "terminal" | "code">("preview");
  const [initialCode, setInitialCode] = useState("");

  const {
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
  } = useAgentStream(API_BASE, runId);

  useEffect(() => {
    let cancelled = false;

    async function createRun() {
      const response = await fetch(`${API_BASE}/api/agent/runs`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Failed to create agent run");
      }

      const data = await response.json();

      if (!cancelled) {
        setRunId(data.run_id);
      }
    }

    createRun().catch(console.error);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (previewHtml) {
      setInitialCode(previewHtml);
    }
  }, [previewHtml]);

  return (
    <div className="flex h-screen bg-slate-950 text-white">

      {/* LEFT — Agent Stream */}
      <aside className="w-[30%] border-r border-slate-800 flex flex-col">
        <div className="px-4 py-3 border-b border-slate-800 flex justify-between">
          <span className="font-semibold">Celia Agent</span>
          <span className={connected ? "text-green-400 text-xs" : "text-red-400 text-xs"}>
            {connected ? "● connected" : "○ disconnected"}
          </span>
        </div>

        {error && (
          <div className="px-4 py-2 text-xs text-red-400 border-b border-red-900">
            {error}
          </div>
        )}

        {/* Human Approval Banner */}
        {awaitingApproval && (
          <div className="px-4 py-3 border-b border-amber-900 bg-amber-500/10">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-amber-400 text-sm font-bold">⚠ Human Approval Required</span>
              <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-amber-500/20 border border-amber-500/40 text-amber-300">
                {approvalRiskLevel}
              </span>
            </div>
            <p className="text-xs text-amber-300/70 mb-3">{approvalReason}</p>
            <div className="flex gap-2">
              <button
                onClick={() => approveCode(true)}
                className="flex-1 px-3 py-2 text-xs font-bold rounded-lg bg-green-600 hover:bg-green-500 text-white transition"
              >
                ✓ Approve
              </button>
              <button
                onClick={() => approveCode(false)}
                className="flex-1 px-3 py-2 text-xs font-bold rounded-lg bg-red-600 hover:bg-red-500 text-white transition"
              >
                ✕ Deny
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {events.map((event, index) => (
            <div
              key={`${event.event_id ?? "event"}-${index}`}
              className="rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs"
            >
              {event.type === "run_started" && (
                <div className="text-green-400">▶ Run started</div>
              )}
              {event.type === "phase" && (
                <div className="text-blue-400">
                  Phase: {event.name}
                  <span className="ml-2 text-slate-500">{event.status}</span>
                </div>
              )}
              {event.type === "tool_call" && (
                <div className="text-yellow-400 font-mono">
                  ⚙ {event.tool}
                  <span className="ml-2 text-slate-400">{event.status}</span>
                </div>
              )}
              {event.type === "tool_result" && (
                <div className="text-green-400 font-mono">✓ {event.tool}</div>
              )}
              {event.type === "terminal_log" && (
                <pre className="text-green-400 whitespace-pre-wrap">{event.log}</pre>
              )}
              {event.type === "preview_update" && (
                <div className="text-purple-400">✨ Preview updated</div>
              )}
              {event.type === "code_update" && (
                <div className="text-cyan-400">✎ Code received from Monaco</div>
              )}
              {event.type === "policy_decision" && (
                <div className="text-orange-400">
                  🛡 Policy: {event.risk_level}
                  <span className="ml-2 text-slate-400">{event.reason}</span>
                </div>
              )}
              {event.type === "human_approval_required" && (
                <div className="text-amber-400 font-bold">
                  ⚠ Waiting for human approval ({event.risk_level})
                </div>
              )}
              {event.type === "approval_granted" && (
                <div className="text-green-400">✓ Approval granted</div>
              )}
              {event.type === "approval_denied" && (
                <div className="text-red-400">✕ Approval denied</div>
              )}
              {event.type === "evidence" && (
                <div className="text-emerald-400">📋 Evidence package created</div>
              )}
              {event.type === "verification" && (
                <div className="text-orange-400">Verification: {event.status}</div>
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* RIGHT — Workspace */}
      <main className="flex-1 flex flex-col">
        <div className="flex border-b border-slate-800 bg-slate-900">
          <button
            onClick={() => setActiveTab("preview")}
            className={`px-4 py-2 text-sm ${
              activeTab === "preview"
                ? "text-blue-400 border-b-2 border-blue-500"
                : "text-slate-400"
            }`}
          >
            Preview
          </button>
          <button
            onClick={() => setActiveTab("code")}
            className={`px-4 py-2 text-sm ${
              activeTab === "code"
                ? "text-blue-400 border-b-2 border-blue-500"
                : "text-slate-400"
            }`}
          >
            Code
          </button>
          <button
            onClick={() => setActiveTab("terminal")}
            className={`px-4 py-2 text-sm ${
              activeTab === "terminal"
                ? "text-blue-400 border-b-2 border-blue-500"
                : "text-slate-400"
            }`}
          >
            Terminal
          </button>
        </div>

        <div className="flex-1 min-h-0 p-3">
          {activeTab === "preview" && <LivePreview htmlContent={previewHtml} />}
          {activeTab === "code" && (
            <CodeEditor initialCode={initialCode} onSubmit={sendCode} />
          )}
          {activeTab === "terminal" && (
            <div className="h-full overflow-auto bg-black rounded-lg p-4 font-mono text-xs">
              {terminalLogs.map((log, index) => (
                <pre key={index} className="text-green-400">{log}</pre>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
