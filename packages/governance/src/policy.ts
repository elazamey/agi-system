// ============================================================================
// AGI OS - Policy Engine
// Evaluates intents against a strict constitution
// ============================================================================

import { isAbsolute } from 'node:path';
import { now } from '@agi-os/kernel';
import type { ActionIntent, PolicyRule } from './types.js';
import { PolicyDecision } from './types.js';
import { normalizeModule, normalizeOperation, isMutatingOperation } from './vocabulary.js';

/** Synthetic rule id recorded when the fail-closed default makes the decision. */
export const FAIL_CLOSED_RULE_ID = 'FAIL-CLOSED';

/**
 * Multi-token dangerous phrases. Substring matching is correct for these —
 * they are specific enough not to occur by accident.
 */
export const DANGEROUS_PHRASES = [
  'rm -rf', 'rm -fr', 'chmod 777', 'chown root', 'fork bomb',
  'docker run --privileged', 'mkfs', ':(){', 'eval(', 'new function',
  'shutdown', 'reboot', '> /dev/sda', 'wget', 'curl',
] as const;

/**
 * Single-token dangerous commands. These MUST be matched on word boundaries:
 * a naive `includes('format')` blocked every command containing the word
 * "information", and `includes('dd')` blocked "added" and "address".
 */
export const DANGEROUS_WORDS = ['dd', 'format', 'crontab', 'fdisk', 'parted', 'shred'] as const;

/**
 * Read a boolean flag off an intent payload.
 *
 * `ActionIntent.payload` is `unknown` by design — callers put whatever they
 * need on it — so reading a property requires narrowing rather than a cast at
 * every use site.
 */
function payloadFlag(intent: ActionIntent, key: string): boolean {
  const payload = intent.payload;
  if (typeof payload !== 'object' || payload === null) return false;
  return (payload as Record<string, unknown>)[key] === true;
}

/** True when a command string contains a known destructive operation. */
export function matchesDangerousCommand(target: unknown): boolean {
  if (typeof target !== 'string' || target.length === 0) return false;
  const lower = target.toLowerCase();

  for (const phrase of DANGEROUS_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  for (const word of DANGEROUS_WORDS) {
    if (new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`).test(lower)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PolicyEngine — first-match-wins rule evaluation
// ---------------------------------------------------------------------------
export class PolicyEngine {
  private rules: PolicyRule[] = [];
  /** Unmatched state-changing operations require approval instead of allowing. */
  private failClosed = true;
  /** A rule whose condition throws requires approval instead of being skipped. */
  private failClosedOnRuleError = true;

  constructor(options?: { failClosed?: boolean; failClosedOnRuleError?: boolean }) {
    this.failClosed = options?.failClosed ?? true;
    this.failClosedOnRuleError = options?.failClosedOnRuleError ?? true;
    this.initializeDefaultPolicies();
  }

  // ---- Default policies --------------------------------------------------

  private initializeDefaultPolicies(): void {
    // POL-001: Block access to sensitive system files
    this.addRule({
      id: 'POL-001',
      description: 'Block access to sensitive system files',
      condition: (i) => i.module === 'fs' && (
        i.target.includes('/etc/') ||
        i.target.includes('.env') ||
        i.target.includes('.ssh/') ||
        i.target.includes('id_rsa') ||
        i.target.includes('/proc/') ||
        i.target.includes('/sys/')
      ),
      enforce: PolicyDecision.BLOCK,
      priority: 100,
      enabled: true,
      tags: ['filesystem', 'security'],
    });

    // POL-002: Require approval for database modifications
    this.addRule({
      id: 'POL-002',
      description: 'Require approval for database modifications',
      condition: (i) => i.module === 'db' && ['insert', 'update', 'delete', 'drop', 'truncate'].includes(i.operation),
      enforce: PolicyDecision.REQUIRE_APPROVAL,
      priority: 90,
      enabled: true,
      tags: ['database', 'destructive'],
    });

    // POL-003: Block destructive git operations without approval
    this.addRule({
      id: 'POL-003',
      description: 'Block force-push and git reset --hard',
      condition: (i) => i.module === 'git' && (i.operation === 'force-push' || i.operation === 'reset-hard'),
      enforce: PolicyDecision.BLOCK,
      priority: 95,
      enabled: true,
      tags: ['git', 'destructive'],
    });

    // POL-004: Require approval for network calls to external APIs
    this.addRule({
      id: 'POL-004',
      description: 'Require approval for outbound network calls',
      condition: (i) => i.module === 'network' && i.operation === 'request',
      enforce: PolicyDecision.REQUIRE_APPROVAL,
      priority: 80,
      enabled: true,
      tags: ['network', 'external'],
    });

    // POL-005: Block execution of dangerous commands
    this.addRule({
      id: 'POL-005',
      description: 'Block execution of shell-dangerous commands',
      condition: (i) => {
        if (i.module !== 'exec' && i.module !== 'process') return false;
        return matchesDangerousCommand(i.target);
      },
      enforce: PolicyDecision.BLOCK,
      priority: 100,
      enabled: true,
      tags: ['exec', 'dangerous', 'security'],
    });

    // POL-006: Block writes outside workspace
    this.addRule({
      id: 'POL-006',
      description: 'Block filesystem writes outside workspace',
      condition: (i) => {
        if (i.module !== 'fs' || !['write', 'delete', 'modify'].includes(i.operation)) return false;
        const target = i.target;
        // Block absolute paths that aren't in common safe locations
        if (target.startsWith('/') && !target.startsWith('/tmp/') && !target.startsWith('/var/tmp/')) {
          return true;
        }
        return false;
      },
      enforce: PolicyDecision.BLOCK,
      priority: 85,
      enabled: true,
      tags: ['filesystem', 'sandbox'],
    });

    // POL-008: Sandbox execution is permitted *because* it runs inside an
    // enforced isolation boundary (see @agi-os/sandbox). Declared explicitly so
    // it never depends on the fail-closed default, and so an operator can
    // disable or escalate it like any other rule.
    this.addRule({
      id: 'POL-008',
      description: 'Allow execution inside an enforced isolation boundary',
      condition: (i) => i.module === 'sandbox',
      enforce: PolicyDecision.ALLOW,
      priority: 70,
      enabled: true,
      tags: ['sandbox', 'exec'],
    });

    // POL-009: Allow filesystem writes that are workspace-relative and free of
    // traversal. Absolute paths are deliberately NOT matched here: they fall
    // through to POL-006 (blocked outside the workspace) or to the fail-closed
    // default (approval required). Without this rule the fail-closed default
    // would escalate every ordinary workspace write to REQUIRE_APPROVAL.
    this.addRule({
      id: 'POL-009',
      description: 'Allow workspace-relative, traversal-free filesystem writes',
      condition: (i) => {
        if (i.module !== 'fs') return false;
        if (!['write', 'create', 'append', 'modify', 'delete', 'move', 'copy', 'rename'].includes(i.operation)) return false;
        const target = i.target;
        if (typeof target !== 'string' || target.length === 0) return false;
        if (/(^|[\\/])\.\.([\\/]|$)/.test(target)) return false;   // traversal
        if (isAbsolute(target)) return false;                            // absolute → POL-006 / fail-closed
        return true;
      },
      enforce: PolicyDecision.ALLOW,
      priority: 50,
      enabled: true,
      tags: ['filesystem', 'workspace'],
    });

    // POL-010: Allow execution of an allowlisted binary inside a jailed working
    // directory. The caller must vouch for both facts in the payload, and the
    // vouching is only credible if it enforces them first — see
    // @agi-os/os-skills TerminalExecutor. POL-005 (priority 100) still blocks
    // dangerous command strings before this rule is reached, and a command that
    // is neither allowlisted nor jailed falls through to the fail-closed default.
    this.addRule({
      id: 'POL-010',
      description: 'Allow allowlisted binary execution inside a jailed cwd',
      condition: (i) =>
        i.module === 'exec' &&
        i.operation === 'execute' &&
        payloadFlag(i, 'allowlisted') &&
        payloadFlag(i, 'jailed'),
      enforce: PolicyDecision.ALLOW,
      priority: 60,
      enabled: true,
      tags: ['exec', 'terminal', 'workspace'],
    });

    // POL-007: Allow all reads by default
    this.addRule({
      id: 'POL-007',
      description: 'Allow read operations by default',
      condition: (i) => i.operation === 'read' || i.operation === 'list' || i.operation === 'get',
      enforce: PolicyDecision.ALLOW,
      priority: 1,
      enabled: true,
      tags: ['default', 'read'],
    });
  }

  // ---- Rule management ---------------------------------------------------

  addRule(rule: Omit<PolicyRule, 'createdAt'>): PolicyRule {
    const fullRule: PolicyRule = {
      ...rule,
      createdAt: now().toISOString(),
    };
    this.rules.push(fullRule);
    this.rules.sort((a, b) => b.priority - a.priority);
    return fullRule;
  }

  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  enableRule(ruleId: string): void {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (rule) rule.enabled = true;
  }

  disableRule(ruleId: string): void {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (rule) rule.enabled = false;
  }

  getRule(ruleId: string): PolicyRule | undefined {
    return this.rules.find((r) => r.id === ruleId);
  }

  getRules(): PolicyRule[] {
    return [...this.rules];
  }

  getEnabledRules(): PolicyRule[] {
    return this.rules.filter((r) => r.enabled);
  }

  getRulesByTag(tag: string): PolicyRule[] {
    return this.rules.filter((r) => r.tags.includes(tag));
  }

  // ---- Evaluation --------------------------------------------------------

  evaluateIntent(intent: ActionIntent): { decision: PolicyDecision; matchedRuleId: string | null } {
    // Canonicalise the vocabulary before matching. Policies are written against
    // 'fs' / 'exec' / 'network'; callers have historically sent 'filesystem',
    // 'terminal', 'filesystem.read'. Without this step those policies simply
    // never fire and the action is allowed by default.
    const normalized: ActionIntent = {
      ...intent,
      module: normalizeModule(intent.module),
      operation: normalizeOperation(intent.operation),
    };

    const enabledRules = this.getEnabledRules();

    for (const rule of enabledRules) {
      try {
        // Rules see the canonical intent; a rule written against a legacy alias
        // still works because the raw fields are preserved on `intent`.
        if (rule.condition(normalized) || rule.condition(intent)) {
          return { decision: rule.enforce, matchedRuleId: rule.id };
        }
      } catch {
        // A throwing condition must not become an implicit allow.
        if (this.failClosedOnRuleError) {
          return { decision: PolicyDecision.REQUIRE_APPROVAL, matchedRuleId: `RULE_ERROR:${rule.id}` };
        }
        continue;
      }
    }

    // ── Fail closed ─────────────────────────────────────────────────────────
    // "No rule matched" used to mean ALLOW for everything, including writes and
    // executions. Reads stay allowed by default (POL-007 covers them anyway);
    // any state-changing or unrecognised operation now requires approval.
    if (this.failClosed && isMutatingOperation(normalized.operation)) {
      return { decision: PolicyDecision.REQUIRE_APPROVAL, matchedRuleId: FAIL_CLOSED_RULE_ID };
    }

    return { decision: PolicyDecision.ALLOW, matchedRuleId: null };
  }

  /** Turn fail-closed enforcement on or off (on by default). */
  setFailClosed(enabled: boolean): void {
    this.failClosed = enabled;
  }

  isFailClosed(): boolean {
    return this.failClosed;
  }

  /**
   * Check if an intent would be allowed (without side effects)
   */
  wouldAllow(intent: ActionIntent): boolean {
    const { decision } = this.evaluateIntent(intent);
    return decision === PolicyDecision.ALLOW;
  }

  /**
   * Reset to defaults
   */
  reset(): void {
    this.rules = [];
    this.initializeDefaultPolicies();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createPolicyEngine(options?: { failClosed?: boolean; failClosedOnRuleError?: boolean }): PolicyEngine {
  return new PolicyEngine(options);
}
