from pydantic import BaseModel
from typing import Dict, Any
import time


class EvidencePackage(BaseModel):
    run_id: str
    timestamp: float
    verification_status: bool
    policy_decision: Dict[str, Any]
    details: Dict[str, Any]


def create_evidence(
    run_id: str,
    policy_res: Dict[str, Any],
    verify_res: Dict[str, Any],
) -> EvidencePackage:
    return EvidencePackage(
        run_id=run_id,
        timestamp=time.time(),
        verification_status=verify_res.get("verify", False),
        policy_decision=policy_res,
        details=verify_res,
    )
