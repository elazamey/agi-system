from enum import Enum
from pydantic import BaseModel


class RiskLevel(str, Enum):
    SAFE = "SAFE"
    SENSITIVE = "SENSITIVE"
    CRITICAL = "CRITICAL"


class PolicyDecision(BaseModel):
    risk_level: RiskLevel
    requires_human_approval: bool
    reason: str


CRITICAL_PATTERNS = [
    "rm -rf",
    "rm -r /",
    "sudo",
    "process.exit(",
    "exec(",
    "child_process",
    "__import__('os')",
    "__import__('subprocess')",
    "subprocess.Popen",
    "subprocess.run",
    "os.system(",
    "os.popen(",
    "eval(__import__('code'))",
    "compile(",
    "__import__('shutil')",
    "shutil.rmtree",
    "/etc/passwd",
    "/etc/shadow",
    "chmod 777",
    "curl.*|.*sh",
    "wget.*|.*sh",
]

SENSITIVE_PATTERNS = [
    "eval(",
    "new Function(",
    "setTimeout(",
    "setInterval(",
    "fs.unlink",
    "fs.rm",
    "fs.rmdir",
    "innerHTML",
    "outerHTML",
    "document.write(",
    "document.writeln(",
    "localStorage",
    "sessionStorage",
    "fetch(",
    "XMLHttpRequest",
    "WebSocket",
    "navigator.geolocation",
    "window.open(",
    "alert(",
    "confirm(",
    "prompt(",
    "require(",
    "import(",
    "process.env",
]


def evaluate_policy(code: str) -> PolicyDecision:
    for pattern in CRITICAL_PATTERNS:
        if pattern in code:
            return PolicyDecision(
                risk_level=RiskLevel.CRITICAL,
                requires_human_approval=True,
                reason=f"Critical pattern detected: '{pattern}'",
            )

    for pattern in SENSITIVE_PATTERNS:
        if pattern in code:
            return PolicyDecision(
                risk_level=RiskLevel.SENSITIVE,
                requires_human_approval=True,
                reason=f"Sensitive pattern detected: '{pattern}'",
            )

    return PolicyDecision(
        risk_level=RiskLevel.SAFE,
        requires_human_approval=False,
        reason="Code is safe and compliant with governance policy.",
    )
