import type { DagNode, FileTreeItem, Message, PatchAuditItem, SystemLevel, TelemetryState } from '../types';

export const SYSTEM_LEVELS: Record<string, SystemLevel> = {
  L0: {
    code: 'L0',
    nameAr: 'مدى الاستعداد الأساسي',
    nameEn: 'Base Readiness',
    descriptionAr: 'النظام في وضع الاستعداد الأساسي',
    descriptionEn: 'System at base readiness',
    accentColor: '#64748b',
    badgeBg: 'bg-slate-500/20',
    badgeBorder: 'border-slate-500/40',
    badgeText: 'text-slate-300',
  },
  L1: {
    code: 'L1',
    nameAr: 'التحليل المعرفي',
    nameEn: 'Cognitive Analysis',
    descriptionAr: 'جاري تحليل السياق وفهم الطلب',
    descriptionEn: 'Analyzing context and understanding request',
    accentColor: '#38bdf8',
    badgeBg: 'bg-sky-500/20',
    badgeBorder: 'border-sky-500/40',
    badgeText: 'text-sky-300',
  },
  L2: {
    code: 'L2',
    nameAr: 'التخطيط الخوارزمي',
    nameEn: 'Algorithmic Planning',
    descriptionAr: 'وضع خطة التنفيذ عبر MCTS',
    descriptionEn: 'Formulating execution plan via MCTS',
    accentColor: '#a78bfa',
    badgeBg: 'bg-violet-500/20',
    badgeBorder: 'border-violet-500/40',
    badgeText: 'text-violet-300',
  },
  L3: {
    code: 'L3',
    nameAr: 'التنفيذ المعزول',
    nameEn: 'Sandboxed Execution',
    descriptionAr: 'تنفيذ الكود في بيئة معزولة آمنة',
    descriptionEn: 'Executing code in secure sandbox',
    accentColor: '#34d399',
    badgeBg: 'bg-emerald-500/20',
    badgeBorder: 'border-emerald-500/40',
    badgeText: 'text-emerald-300',
  },
  L4: {
    code: 'L4',
    nameAr: 'الحوكمة والتحقق',
    nameEn: 'Governance & Verification',
    descriptionAr: 'ختم النتيجة بالتحقق النهائي',
    descriptionEn: 'Final verification and governance seal',
    accentColor: '#fbbf24',
    badgeBg: 'bg-amber-500/20',
    badgeBorder: 'border-amber-500/40',
    badgeText: 'text-amber-300',
  },
  L5: {
    code: 'L5',
    nameAr: 'التعلم التكيفي',
    nameEn: 'Adaptive Learning',
    descriptionAr: 'تحسين الأداء من النتائج السابقة',
    descriptionEn: 'Improving performance from past results',
    accentColor: '#f472b6',
    badgeBg: 'bg-pink-500/20',
    badgeBorder: 'border-pink-500/40',
    badgeText: 'text-pink-300',
  },
};

export const INITIAL_MESSAGES: Message[] = [
  {
    id: 'msg-1',
    role: 'system',
    content: 'AGI-OS Autonomous Agent Engine v1.34 — 5-Layer Governance Active',
    timestamp: '00:00',
  },
  {
    id: 'msg-2',
    role: 'assistant',
    content: 'مرحباً! أنا وكيل AGI-OS الذكي. أستطيع مساعدتك في كتابة الكود، تحليل المشاريع، نشر التطبيقات، واختبار الثغرات الأمنية — كل ذلك مع حوكمة 5 طبقات وبيئة معزولة آمنة.',
    timestamp: '00:01',
    thoughtProcess: 'تم تهيئة السياق وتفعيل طبقة الحوكمة L0 → L1',
  },
];

export const INITIAL_TELEMETRY: TelemetryState = {
  totalTokens: 12480,
  costUsd: 0.034,
  uptime: '2h 14m',
  missionsCompleted: 47,
  governanceScore: 100,
};

export const INITIAL_DAG_NODES: DagNode[] = [
  { id: 'n1', label: 'User Prompt', status: 'completed', executionTimeMs: 12, dependencies: [] },
  { id: 'n2', label: 'Context Analysis', status: 'completed', executionTimeMs: 45, dependencies: ['n1'] },
  { id: 'n3', label: 'MCTS Planning', status: 'completed', executionTimeMs: 89, dependencies: ['n2'] },
  { id: 'n4', label: 'Tool Selection', status: 'completed', executionTimeMs: 23, dependencies: ['n3'] },
  { id: 'n5', label: 'Sandbox Execution', status: 'running', executionTimeMs: 156, dependencies: ['n4'] },
  { id: 'n6', label: 'Governance Gate', status: 'pending', dependencies: ['n5'] },
  { id: 'n7', label: 'Response Synthesis', status: 'pending', dependencies: ['n6'] },
];

export const INITIAL_PATCH_AUDIT: PatchAuditItem = {
  id: 'patch-1',
  fileName: 'packages/gateway/src/middleware/auth-guard.ts',
  description: 'Add rate limiting to authentication middleware to prevent brute-force attacks',
  diff: `@@ -12,6 +12,18 @@
+import { RateLimiter } from '../utils/rate-limiter';
+
+const limiter = new RateLimiter({
+  windowMs: 60 * 1000,
+  max: 10,
+  message: 'Too many auth attempts',
+});
+
 export async function authGuard(req: Request) {
+  await limiter.check(req.ip);
   const token = req.headers.authorization;
   if (!token) throw new AuthError('Missing token');`,
  riskLevel: 'low',
  applied: false,
  governanceScore: 98,
};

export const INITIAL_FILES: FileTreeItem[] = [
  {
    id: 'f1',
    name: 'packages',
    type: 'folder',
    children: [
      {
        id: 'f2',
        name: 'gateway',
        type: 'folder',
        children: [
          {
            id: 'f3',
            name: 'src',
            type: 'folder',
            children: [
              {
                id: 'f4',
                name: 'auth-guard.ts',
                path: '/packages/gateway/src/auth-guard.ts',
                type: 'file',
                language: 'typescript',
                content: `import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';

export async function authGuard(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  try {
    const payload = await verifyToken(token);
    (req as any).user = payload;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}`,
              },
              {
                id: 'f5',
                name: 'rate-limiter.ts',
                path: '/packages/gateway/src/rate-limiter.ts',
                type: 'file',
                language: 'typescript',
                content: `interface RateLimiterConfig {
  windowMs: number;
  max: number;
  message: string;
}

export class RateLimiter {
  private hits: Map<string, number[]> = new Map();
  constructor(private config: RateLimiterConfig) {}

  async check(key: string): Promise<void> {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const timestamps = (this.hits.get(key) || []).filter(t => t > windowStart);
    if (timestamps.length >= this.config.max) {
      throw new Error(this.config.message);
    }
    timestamps.push(now);
    this.hits.set(key, timestamps);
  }
}`,
              },
            ],
          },
        ],
      },
      {
        id: 'f6',
        name: 'sdk',
        type: 'folder',
        children: [
          {
            id: 'f7',
            name: 'src',
            type: 'folder',
            children: [
              {
                id: 'f8',
                name: 'client.ts',
                path: '/packages/sdk/src/client.ts',
                type: 'file',
                language: 'typescript',
                content: `export interface AGIOSConfig {
  endpoint: string;
  apiKey?: string;
}

export class AGIOSAgent {
  constructor(private config: AGIOSConfig) {}

  async runMission(params: { prompt: string }) {
    const res = await fetch(\`\${this.config.endpoint}/v1/chat/completions\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'agi-os-cortex', messages: [{ role: 'user', content: params.prompt }] }),
    });
    return res.json();
  }
}`,
              },
            ],
          },
        ],
      },
    ],
  },
];
