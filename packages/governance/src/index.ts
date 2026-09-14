// ============================================================================
// AGI OS - Governance Package
// Policy engine, risk assessment, approval gates, audit trail
// ============================================================================

// Types
export {
  RiskLevel,
  PolicyDecision,
} from './types.js';

export type {
  ActionIntent,
  PolicyRule,
  PolicyCondition,
  RiskAssessment,
  RiskFactor,
  AuditRecord,
  ApprovalRequest,
  ApprovalStatus,
  GovernanceConfig,
  GateResult,
} from './types.js';

// Risk Evaluator
export { RiskEvaluator, createRiskEvaluator } from './risk.js';

// Policy Engine
export {
  PolicyEngine,
  createPolicyEngine,
  FAIL_CLOSED_RULE_ID,
  matchesDangerousCommand,
  DANGEROUS_PHRASES,
  DANGEROUS_WORDS,
} from './policy.js';

// Governance vocabulary (canonical module/operation names + fail-closed helper)
export {
  GOVERNANCE_MODULES,
  MUTATING_OPERATIONS,
  READ_OPERATIONS,
  normalizeModule,
  normalizeOperation,
  isMutatingOperation,
} from './vocabulary.js';
export type { GovernanceModule } from './vocabulary.js';

// Audit Ledger
export { AuditLedger, createAuditLedger } from './audit.js';

// Approval Manager
export { ApprovalManager, createApprovalManager } from './approval.js';

// Governance Gateway
export { GovernanceGateway, createGovernanceGateway } from './governance-core.js';
