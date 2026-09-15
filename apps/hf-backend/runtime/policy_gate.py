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
    "sudo",
    "process.exit",
    "exec(",
    "child_process",
    "__import__('os')",
    "subprocess",
    "os.system",
    "eval(__import__('code'))",
]

SENSITIVE_PATTERNS = [
    "eval(",
    "fs.unlink",
    "innerHTML",
    "document.write",
    "localStorage",
    "sessionStorage",
    "fetch(",
    "XMLHttpRequest",
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
