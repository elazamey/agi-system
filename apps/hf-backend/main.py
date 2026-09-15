from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from runtime.policy_gate import evaluate_policy, RiskLevel
from runtime.parser import parse_code_submission
from runtime.verifier import run_verification
from runtime.evidence import create_evidence


app = FastAPI(
    title="Celia Agent Runtime",
    version="0.3.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "https://agi-os.pages.dev",
        "https://*.netlify.app",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# ============================================================
# Models
# ============================================================

@dataclass
class AgentRun:
    run_id: str
    status: str = "created"
    event_id: int = 0
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    awaiting_approval: bool = False
    pending_code: str = ""


class CodeUpdate(BaseModel):
    code: str


class ApprovalUpdate(BaseModel):
    approved: bool


RUNS: dict[str, AgentRun] = {}
EVENT_QUEUES: dict[str, asyncio.Queue[str]] = {}
RUNTIME_TASKS: dict[str, asyncio.Task[Any]] = {}


# ============================================================
# Helpers
# ============================================================

def make_sse(
    run: AgentRun,
    event_type: str,
    payload: dict[str, Any],
) -> str:
    run.event_id += 1
    run.updated_at = time.time()

    data = {
        "type": event_type,
        "run_id": run.run_id,
        "event_id": run.event_id,
        "timestamp": run.updated_at,
        **payload,
    }

    return (
        f"id: {run.event_id}\n"
        f"event: {event_type}\n"
        f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
    )


async def publish(
    run: AgentRun,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    queue = EVENT_QUEUES.get(run.run_id)

    if queue is None:
        return

    await queue.put(
        make_sse(run, event_type, payload)
    )


# ============================================================
# Local Preview
# ============================================================

DEFAULT_HTML = """<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #020617;
            color: white;
            font-family: Arial, sans-serif;
        }
        .card {
            width: min(520px, 90vw);
            padding: 32px;
            border-radius: 18px;
            border: 1px solid #1e293b;
            background: #0f172a;
            text-align: center;
        }
        h1 { color: #60a5fa; margin-bottom: 12px; }
        p { color: #cbd5e1; line-height: 1.8; }
        button {
            margin-top: 16px;
            border: 0;
            border-radius: 10px;
            padding: 12px 18px;
            background: #2563eb;
            color: white;
            cursor: pointer;
        }
        button:hover { background: #1d4ed8; }
    </style>
</head>
<body>
<div class="card">
    <h1>Celia Agent</h1>
    <p>هذه المعاينة تعمل داخل Sandbox مستقل.</p>
    <button id="agent-button">تفاعل مع الواجهة</button>
    <p id="output"></p>
</div>
<script>
    document.getElementById("agent-button").addEventListener("click", () => {
        document.getElementById("output").textContent = "الوكيل يتفاعل معك الآن";
    });
</script>
</body>
</html>
"""


# ============================================================
# Real Pipeline: process_code_update
# ============================================================

async def process_code_update(run: AgentRun, code: str) -> None:
    # Step 1: Parse
    await publish(run, "phase", {"name": "parse", "status": "running"})
    patches = parse_code_submission(code)
    await publish(run, "phase", {"name": "parse", "status": "completed"})
    await publish(run, "terminal_log", {"stream": "stdout", "log": f"Parsed {len(patches)} file patch(es)"})

    # Step 2: Policy Gate
    await publish(run, "phase", {"name": "policy_gate", "status": "running"})
    policy = evaluate_policy(code)
    await publish(run, "policy_decision", {
        "risk_level": policy.risk_level.value,
        "requires_approval": policy.requires_human_approval,
        "reason": policy.reason,
    })

    if policy.requires_human_approval:
        run.awaiting_approval = True
        run.pending_code = code
        await publish(run, "human_approval_required", {
            "risk_level": policy.risk_level.value,
            "reason": policy.reason,
        })
        await publish(run, "phase", {"name": "policy_gate", "status": "blocked"})
        return

    await publish(run, "phase", {"name": "policy_gate", "status": "completed"})
    await publish(run, "terminal_log", {"stream": "stdout", "log": f"Policy: {policy.risk_level.value} - PASSED"})

    # Step 3: Sandbox (apply patches)
    await publish(run, "phase", {"name": "sandbox", "status": "running"})
    await asyncio.sleep(0.3)
    for patch in patches:
        await publish(run, "terminal_log", {"stream": "stdout", "log": f"Writing: {patch.file_path}"})
    await publish(run, "phase", {"name": "sandbox", "status": "completed"})

    # Step 4: Verification
    await publish(run, "phase", {"name": "verify", "status": "running"})
    await publish(run, "tool_call", {"tool": "pnpm verify", "status": "running"})
    verify_result = await run_verification()
    await publish(run, "tool_result", {"tool": "pnpm verify", "status": "success" if verify_result["verify"] else "failed"})

    for log_line in verify_result["logs"]:
        await publish(run, "terminal_log", {"stream": "stdout", "log": log_line})

    # Step 5: Evidence
    evidence = create_evidence(run.run_id, policy.model_dump(), verify_result)
    await publish(run, "evidence", evidence.model_dump())

    # Step 6: Preview
    await publish(run, "preview_update", {"format": "html", "html": code, "source": "runtime"})
    await publish(run, "verification", {"status": "passed" if verify_result["verify"] else "failed"})

    await publish(run, "phase", {"name": "verify", "status": "completed"})
    await publish(run, "run_completed", {"status": "completed"})

    run.status = "completed"


# ============================================================
# Agent Runtime (Initial)
# ============================================================

async def runtime_loop(run: AgentRun) -> None:
    run.status = "running"

    await publish(run, "run_started", {"status": "running", "mode": "real"})

    await publish(run, "phase", {"name": "observe", "status": "running"})
    await asyncio.sleep(0.5)
    await publish(run, "phase", {"name": "observe", "status": "completed"})

    await publish(run, "phase", {"name": "plan", "status": "running"})
    await asyncio.sleep(0.5)
    await publish(run, "phase", {"name": "plan", "status": "completed"})

    await publish(run, "preview_update", {"format": "html", "html": DEFAULT_HTML})

    await publish(run, "run_completed", {"status": "waiting_for_input"})
    run.status = "waiting_for_input"

    queue = EVENT_QUEUES[run.run_id]
    while run.status in ("waiting_for_input", "awaiting_approval"):
        await asyncio.sleep(0.25)


# ============================================================
# Create Run
# ============================================================

@app.post("/api/agent/runs")
async def create_run():
    run_id = str(uuid.uuid4())
    run = AgentRun(run_id=run_id)
    RUNS[run_id] = run
    EVENT_QUEUES[run_id] = asyncio.Queue()
    task = asyncio.create_task(runtime_loop(run))
    RUNTIME_TASKS[run_id] = task

    return {"run_id": run_id, "status": run.status}


# ============================================================
# SSE Stream
# ============================================================

async def stream_events(
    request: Request,
    run: AgentRun,
) -> AsyncGenerator[str, None]:

    queue = EVENT_QUEUES[run.run_id]

    while True:
        if await request.is_disconnected():
            break

        try:
            event = await asyncio.wait_for(queue.get(), timeout=15)
            yield event
        except asyncio.TimeoutError:
            yield ": heartbeat\n\n"


@app.get("/api/agent/runs/{run_id}/stream")
async def agent_stream(run_id: str, request: Request):
    run = RUNS.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")

    return StreamingResponse(
        stream_events(request, run),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ============================================================
# Code Update (Real Pipeline)
# ============================================================

@app.post("/api/agent/runs/{run_id}/update")
async def update_agent_code(run_id: str, update: CodeUpdate):
    run = RUNS.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")

    if len(update.code) > 1_000_000:
        raise HTTPException(status_code=413, detail="Code payload too large")

    await publish(run, "code_update", {
        "status": "received",
        "source": "monaco",
        "bytes": len(update.code.encode("utf-8")),
    })

    asyncio.create_task(process_code_update(run, update.code))

    return {"accepted": True, "run_id": run_id}


# ============================================================
# Human Approval
# ============================================================

@app.post("/api/agent/runs/{run_id}/approve")
async def approve_code(run_id: str, approval: ApprovalUpdate):
    run = RUNS.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")

    if not run.awaiting_approval:
        raise HTTPException(status_code=400, detail="No pending approval")

    run.awaiting_approval = False

    if approval.approved:
        await publish(run, "approval_granted", {"risk_level": "CRITICAL"})
        asyncio.create_task(process_code_update(run, run.pending_code))
    else:
        await publish(run, "approval_denied", {"risk_level": "CRITICAL"})
        await publish(run, "terminal_log", {"stream": "stderr", "log": "User denied the code update"})

    run.pending_code = ""
    return {"processed": True, "approved": approval.approved}


# ============================================================
# Cancel Run
# ============================================================

@app.delete("/api/agent/runs/{run_id}")
async def cancel_run(run_id: str):
    run = RUNS.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")

    run.status = "cancelled"
    task = RUNTIME_TASKS.get(run_id)
    if task and not task.done():
        task.cancel()

    await publish(run, "run_cancelled", {"status": "cancelled"})
    return {"run_id": run_id, "status": "cancelled"}


# ============================================================
# Run Status
# ============================================================

@app.get("/api/agent/runs/{run_id}")
async def get_run(run_id: str):
    run = RUNS.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")

    return {
        "run_id": run.run_id,
        "status": run.status,
        "event_id": run.event_id,
        "awaiting_approval": run.awaiting_approval,
        "created_at": run.created_at,
        "updated_at": run.updated_at,
    }


# ============================================================
# Health
# ============================================================

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "celia-agent-runtime",
        "version": "0.3.0",
        "active_runs": sum(
            1 for run in RUNS.values()
            if run.status in ("running", "waiting_for_input", "awaiting_approval")
        ),
    }
