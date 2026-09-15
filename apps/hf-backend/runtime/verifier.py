import asyncio
import os
from typing import Dict, Any

WORKSPACE_ROOT = os.environ.get(
    "AGI_OS_WORKSPACE",
    os.path.join(os.path.dirname(__file__), "..", "..", ".."),
)


async def _run_cmd(cmd: list[str], cwd: str) -> Dict[str, Any]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )

    stdout_bytes, stderr_bytes = await asyncio.wait_for(
        proc.communicate(),
        timeout=120,
    )

    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")

    return {
        "exit_code": proc.returncode or 0,
        "stdout": stdout,
        "stderr": stderr,
        "ok": proc.returncode == 0,
    }


async def run_verification() -> Dict[str, Any]:
    logs: list[str] = []
    typecheck_ok = False
    test_ok = False
    verify_ok = False

    # Step 1: pnpm typecheck
    logs.append("$ pnpm typecheck")
    try:
        result = await _run_cmd(
            ["pnpm", "typecheck"],
            WORKSPACE_ROOT,
        )
        typecheck_ok = result["ok"]

        if result["stdout"].strip():
            for line in result["stdout"].strip().split("\n")[-5:]:
                logs.append(f"  {line}")

        if result["ok"]:
            logs.append("✔ Typecheck PASSED")
        else:
            logs.append(f"✘ Typecheck FAILED (exit {result['exit_code']})")
            if result["stderr"].strip():
                for line in result["stderr"].strip().split("\n")[-3:]:
                    logs.append(f"  ERR: {line}")
    except asyncio.TimeoutError:
        logs.append("✘ Typecheck TIMEOUT (120s)")
    except FileNotFoundError:
        logs.append("✘ Typecheck SKIPPED (pnpm not found)")

    # Step 2: pnpm test
    logs.append("$ pnpm test")
    try:
        result = await _run_cmd(
            ["pnpm", "test"],
            WORKSPACE_ROOT,
        )
        test_ok = result["ok"]

        if result["stdout"].strip():
            for line in result["stdout"].strip().split("\n")[-5:]:
                logs.append(f"  {line}")

        if result["ok"]:
            logs.append("✔ Tests PASSED")
        else:
            logs.append(f"✘ Tests FAILED (exit {result['exit_code']})")
            if result["stderr"].strip():
                for line in result["stderr"].strip().split("\n")[-3:]:
                    logs.append(f"  ERR: {line}")
    except asyncio.TimeoutError:
        logs.append("✘ Tests TIMEOUT (120s)")
    except FileNotFoundError:
        logs.append("✘ Tests SKIPPED (pnpm not found)")

    # Step 3: pnpm verify (quick)
    logs.append("$ pnpm verify:quick")
    try:
        result = await _run_cmd(
            ["pnpm", "verify:quick"],
            WORKSPACE_ROOT,
        )
        verify_ok = result["ok"]

        if result["stdout"].strip():
            for line in result["stdout"].strip().split("\n")[-5:]:
                logs.append(f"  {line}")

        if result["ok"]:
            logs.append("✔ Verify PASSED")
        else:
            logs.append(f"✘ Verify FAILED (exit {result['exit_code']})")
            if result["stderr"].strip():
                for line in result["stderr"].strip().split("\n")[-3:]:
                    logs.append(f"  ERR: {line}")
    except asyncio.TimeoutError:
        logs.append("✘ Verify TIMEOUT (120s)")
    except FileNotFoundError:
        logs.append("✘ Verify SKIPPED (pnpm not found)")

    return {
        "typecheck": typecheck_ok,
        "test": test_ok,
        "verify": verify_ok,
        "logs": logs,
    }
