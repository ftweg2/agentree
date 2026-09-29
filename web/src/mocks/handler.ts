// 模拟后端：只在 VITE_USE_MOCK=1 时被动态加载。
import type {
  AgentTypeUsage,
  ClaudeConfigSnapshot,
  DailyPoint,
  IndexStatus,
  LiveSession,
  LiveState,
  ModelUsage,
  Overview,
  Preset,
  QuotaSample,
  SessionDetail,
} from '../types';
import { ApiFailure } from '../api/client';
import { BUILTIN_TYPES } from './conformance';
import { DEFAULT_MOCK_PRESET, MODELS, addCost, addTokens, allSpecs, buildSession, currentToolFor, emptyTokens } from './data';
import * as store from './configStore';
import { CONFIG_DIR } from './configStore';
import type { ConfigAction, PlanNote } from '../types';

// ---------- 写接口令牌（模拟后端的防护） ----------
let mockToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
declare global {
  interface Window {
    /** 仅模拟模式：在控制台调用 __agentreeMock.rotateToken() 模拟后端重启、令牌变化 */
    __agentreeMock?: { rotateToken: () => void; breakClaudeMd: () => void };
  }
}
if (typeof window !== 'undefined') {
  window.__agentreeMock = {
    rotateToken: () => {
      mockToken = Math.random().toString(36).slice(2);
      console.info('[mock] 令牌已更换，下一次写请求会先收到 403，再自动重新获取令牌重试');
    },
    breakClaudeMd: () => {
      store.breakRuleForDemo();
      console.info('[mock] CLAUDE.md 现在只有开始标记，刷新配置页可以看到规则区域被禁用');
    },
  };
}
let tokenRejections = 0;
export function mockStats() {
  return { tokenRejections };
}

const T0 = Date.now();
let indexStartedAt = T0;
const FILES_TOTAL = 85;
const INDEX_SECONDS = 40;

let preset: Preset = structuredClone(DEFAULT_MOCK_PRESET);

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function indexStatus(): IndexStatus {
  const elapsed = (Date.now() - indexStartedAt) / 1000;
  const done = elapsed >= INDEX_SECONDS;
  return {
    state: done ? 'idle' : 'indexing',
    filesTotal: FILES_TOTAL,
    filesIndexed: done ? FILES_TOTAL : Math.floor((elapsed / INDEX_SECONDS) * FILES_TOTAL),
    lastIndexedAt: done ? new Date(indexStartedAt + INDEX_SECONDS * 1000).toISOString() : new Date(T0 - 3600_000).toISOString(),
    skippedLines: 3,
  };
}

function details(): SessionDetail[] {
  return allSpecs().map((s) => buildSession(s, preset, T0));
}

function overview(days: number): Overview {
  const ds = details();
  const modelMap = new Map<string, ModelUsage>();
  const typeMap = new Map<string, AgentTypeUsage>();
  let requests = 0;
  let tokens = emptyTokens();
  let cost: number | null = null;
  let agents = 0;
  for (const d of ds) {
    requests += d.summary.requests;
    tokens = addTokens(tokens, d.summary.tokens);
    cost = addCost(cost, d.summary.costUsd);
    agents += d.summary.agentCount;
    for (const m of d.models) {
      const c = modelMap.get(m.model);
      modelMap.set(
        m.model,
        c ? { model: m.model, requests: c.requests + m.requests, tokens: addTokens(c.tokens, m.tokens), costUsd: addCost(c.costUsd, m.costUsd) } : structuredClone(m),
      );
    }
    for (const t of d.agentTypes) {
      const c = typeMap.get(t.agentType);
      typeMap.set(
        t.agentType,
        c
          ? {
              agentType: t.agentType,
              spawns: c.spawns + t.spawns,
              requests: c.requests + t.requests,
              tokens: addTokens(c.tokens, t.tokens),
              costUsd: addCost(c.costUsd, t.costUsd),
              models: Array.from(new Set([...c.models, ...t.models])),
            }
          : structuredClone(t),
      );
    }
  }

  // 每日趋势：合成一条平滑但有起伏的曲线
  const daily: DailyPoint[] = [];
  const today = new Date();
  const fam: Array<[string, number]> = [
    [MODELS.OPUS_1M, 0.42],
    [MODELS.OPUS, 0.25],
    [MODELS.SONNET, 0.15],
    [MODELS.HAIKU, 0.13],
    [MODELS.FABLE, 0.05],
  ];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const wave = 0.55 + 0.45 * Math.sin(i / 3.1) ** 2;
    const base = weekend ? 0.25 : 1;
    const reqs = i > 26 ? 0 : Math.round(260 * wave * base + (i % 5) * 13);
    const byModel: DailyPoint['byModel'] = {};
    let tk = 0;
    for (const [m, share] of fam) {
      if (m === MODELS.FABLE && i % 4 !== 0) continue;
      const r = Math.round(reqs * share);
      const t = r * (m.includes('haiku') ? 21000 : m.includes('1m') ? 58000 : 34000);
      if (r > 0) byModel[m] = { requests: r, tokens: t };
      tk += t;
    }
    daily.push({ date, requests: Object.values(byModel).reduce((a, b) => a + b.requests, 0), tokens: tk, byModel });
  }

  // 额度：7 天，每 15 分钟一个点
  const samples: QuotaSample[] = [];
  const end = Math.floor(Date.now() / 900_000) * 900_000;
  const start = end - 7 * 86400_000;
  let sd = 0;
  for (let t = start; t <= end; t += 900_000) {
    const h = (t - start) / 3600_000;
    const inWindow = h % 5;
    const activeHour = new Date(t).getHours() >= 9 && new Date(t).getHours() <= 23;
    const fh = activeHour ? Math.min(88, inWindow * 17 + (Math.sin(h) + 1) * 3) : 0;
    sd = Math.min(35, sd + (activeHour ? 0.055 : 0.005));
    samples.push({ t, fiveHourPct: Math.round(fh * 10) / 10, sevenDayPct: Math.round(sd * 10) / 10 });
  }

  const from = daily[0]?.date ?? null;
  return {
    range: { from: from ? `${from}T00:00:00.000Z` : null, to: new Date().toISOString() },
    totals: { sessions: ds.length, agents, requests, tokens, costUsd: cost },
    models: [...modelMap.values()].sort((a, b) => b.tokens.total - a.tokens.total),
    agentTypes: [...typeMap.values()].sort((a, b) => b.tokens.total - a.tokens.total),
    daily,
    quota: { source: 'C:\\Users\\you\\AppData\\Roaming\\Claude\\plan-usage-history.json', latest: samples[samples.length - 1] ?? null, samples },
    index: indexStatus(),
  };
}

function live(): LiveState {
  const sessions: LiveSession[] = details()
    .filter((d) => d.summary.isActive)
    .map((d) => {
      const main = d.agents[0];
      return {
        sessionId: d.summary.id,
        title: d.summary.title,
        cwd: d.summary.cwd,
        lastActivityAt: d.summary.lastActivityAt,
        mainActive: main.status === 'running',
        mainModel: main.primaryModel,
        mainTool: main.status === 'running' ? currentToolFor(main.id) : null,
        requests: d.summary.requests,
        tokens: d.summary.tokens.total,
        agentCount: d.summary.agentCount,
        runningAgents: d.agents
          .filter((a) => a.kind !== 'main' && a.status === 'running')
          .map((a) => ({
            id: a.id,
            agentType: a.agentType,
            description: a.description,
            model: a.primaryModel,
            depth: a.depth,
            parentId: a.parentId,
            lastActivityAt: new Date(Date.now() - Math.floor(Math.random() * 8000)).toISOString(),
            currentTool: currentToolFor(a.id),
            startedAt: a.startedAt,
            requests: a.requests,
            tokens: a.tokens.total,
            toolCalls: a.toolCalls,
          })),
      };
    });
  return { now: new Date().toISOString(), sessions };
}

function config(): ClaudeConfigSnapshot {
  return {
    configDir: CONFIG_DIR,
    // 第二阶段：定义文件和 settings 都来自模拟的文件存储，应用修改后会跟着变
    definitions: store.definitions(),
    settings: store.settingsSnapshot(),
    env: [
      { name: 'CLAUDE_CODE_EFFORT_LEVEL', value: null, scope: 'user', level: 'ok', impact: '未设置。设置后会覆盖所有 effort 配置，包括子 agent 定义文件里的。' },
      { name: 'CLAUDE_CODE_SUBAGENT_MODEL', value: 'claude-sonnet-5', scope: 'user', level: 'warn', impact: '子 agent 没有指定模型时使用 claude-sonnet-5，而不是主会话的模型。' },
      { name: 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', value: null, scope: 'user', level: 'ok', impact: '未设置。设置后所有子 agent 强制使用同一个模型。' },
      { name: 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL', value: null, scope: 'user', level: 'ok', impact: '未设置。设置为 1 会禁用 advisor。' },
      { name: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: null, scope: 'user', level: 'ok', impact: '未设置。设置后会覆盖 settings.json 里的 autoCompactWindow。' },
      { name: 'DISABLE_AUTO_COMPACT', value: null, scope: 'user', level: 'ok', impact: '未设置。设置为 1 会关闭自动压缩，autoCompactWindow 不生效。' },
      { name: 'DISABLE_COMPACT', value: null, scope: 'user', level: 'ok', impact: '未设置。设置为 1 会关闭所有压缩。' },
      { name: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', value: null, scope: 'user', level: 'ok', impact: '未设置。设置后会把自动压缩的触发点降到阈值的这个百分比。' },
      { name: 'DISABLE_TELEMETRY', value: '1', scope: 'machine', level: 'warn', impact: '会导致功能开关无法拉取，advisor 可能不可用。' },
      { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: null, scope: 'user', level: 'ok', impact: '未设置。设置后功能开关无法拉取，advisor 可能不可用。' },
      { name: 'CLAUDE_CONFIG_DIR', value: null, scope: 'user', level: 'info', impact: '未设置，使用默认配置目录 C:\\Users\\you\\.claude。' },
      { name: 'ANTHROPIC_BASE_URL', value: 'http…', scope: 'settings', level: 'fail', impact: '请求走了本机代理（127.0.0.1:15721，疑似 cc-switch），advisor 可能不可用。' },
    ],
    builtinAgentTypes: BUILTIN_TYPES,
    ccSwitchDetected: true,
    projectCwds: store.KNOWN_PROJECTS,
  };
}

function presetFromConfig(): Preset {
  const c = config();
  return {
    version: 1,
    main: { model: c.settings.model, effort: c.settings.effortLevel, autoCompactWindow: c.settings.autoCompactWindow },
    advisor: { model: c.settings.advisorModel },
    agents: c.definitions.map((d) => ({
      name: d.name,
      model: d.model === 'inherit' ? null : d.model,
      effort: d.effort,
      note: d.source === 'project' ? `项目级：${d.projectCwd ?? ''}` : '用户级',
    })),
    allowBuiltins: true,
    updatedAt: null,
  };
}

function envWarnings(): PlanNote[] {
  const out: PlanNote[] = [];
  const env = config().env;
  const set = (n: string) => env.some((e) => e.name === n && e.value != null);
  if (set('CLAUDE_CODE_EFFORT_LEVEL')) out.push({ level: 'warn', message: '设置了 CLAUDE_CODE_EFFORT_LEVEL：它会覆盖所有 effort 设置，包括 agent 定义文件里的。' });
  if (set('CLAUDE_CODE_SUBAGENT_MODEL_FORCE')) out.push({ level: 'warn', message: '设置了 CLAUDE_CODE_SUBAGENT_MODEL_FORCE：所有子 agent 会被强制使用同一个模型，定义文件里的 model 不生效。' });
  if (set('CLAUDE_CODE_DISABLE_ADVISOR_TOOL')) out.push({ level: 'warn', message: '设置了 CLAUDE_CODE_DISABLE_ADVISOR_TOOL：advisor 被禁用，advisorModel 设置不生效。' });
  return out;
}

export async function mockRequest<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  await delay(120 + Math.random() * 120);
  const url = new URL(path, 'http://mock');
  const p = url.pathname;

  if (method === 'GET' && p === '/api/token') return { token: mockToken } as T;
  if (method === 'GET' && p === '/api/version') return { api: 9999 } as T;
  if (method !== 'GET') {
    if (headers['Content-Type'] !== 'application/json') throw new ApiFailure('http', '后端返回错误：写接口只接受 application/json', 415);
    if (headers['X-Agentree-Token'] !== mockToken) {
      tokenRejections++;
      throw new ApiFailure('forbidden', '后端拒绝了请求：令牌无效', 403);
    }
  }

  // 第二阶段
  if (method === 'GET' && p === '/api/config/agent') return store.agentDetail(url.searchParams.get('path') ?? '') as T;
  if (method === 'GET' && p === '/api/config/rule') return store.ruleState() as T;
  if (method === 'GET' && p === '/api/config/templates') return store.templates() as T;
  if (method === 'GET' && p === '/api/config/agent-templates') return [] as T;
  // 返回空清单，前端会用内置的清单
  if (method === 'GET' && p === '/api/models') return [] as T;
  // 模拟数据不做生效检查，返回空报告
  if (method === 'POST' && p === '/api/config/effect') {
    return { generatedAt: new Date().toISOString(), scheme: { scope: 'user', projectCwd: null }, appliedAt: null, since: null, sessionsSince: 0, lastEntrypoint: null, items: [], blockers: [] } as T;
  }
  if (method === 'GET' && p === '/api/config/backups') return store.backupList() as T;
  if (method === 'POST' && p === '/api/config/plan') {
    return store.makePlan((body as { actions: ConfigAction[] }).actions, envWarnings()) as T;
  }
  if (method === 'POST' && p === '/api/config/restore') return store.restorePlan((body as { backupId: string }).backupId) as T;
  if (method === 'POST' && p === '/api/config/apply') {
    const r = store.applyPlan((body as { planId: string }).planId);
    return { ...r, config: config() } as T;
  }

  if (method === 'GET' && p === '/api/overview') {
    return overview(Number(url.searchParams.get('days') ?? 30)) as T;
  }
  if (method === 'GET' && p === '/api/sessions') {
    const project = url.searchParams.get('project');
    const limit = Number(url.searchParams.get('limit') ?? 200);
    return details()
      .map((d) => d.summary)
      .filter((s) => !project || s.projectDir === project)
      .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
      .slice(0, limit) as T;
  }
  if (method === 'GET' && p.startsWith('/api/sessions/')) {
    const id = decodeURIComponent(p.slice('/api/sessions/'.length));
    const d = details().find((x) => x.summary.id === id);
    if (!d) throw new ApiFailure('notfound', `会话 ${id} 不存在`, 404);
    return d as T;
  }
  if (method === 'GET' && p === '/api/live') return live() as T;
  if (method === 'GET' && p === '/api/config') return config() as T;
  // 模拟数据只有全局方案
  if (method === 'GET' && p === '/api/presets') {
    return [{ scope: 'user', projectCwd: null, agents: preset.agents.length, updatedAt: preset.updatedAt, appliedAt: null }] as T;
  }
  if (method === 'DELETE' && p === '/api/preset') return { ok: true } as T;
  if (method === 'GET' && p === '/api/preset') return structuredClone(preset) as T;
  if (method === 'PUT' && p === '/api/preset') {
    preset = { ...(body as Preset), updatedAt: new Date().toISOString() };
    return structuredClone(preset) as T;
  }
  if (method === 'POST' && p === '/api/preset/from-config') return presetFromConfig() as T;
  if (method === 'POST' && p === '/api/reindex') {
    indexStartedAt = Date.now();
    return indexStatus() as T;
  }
  throw new ApiFailure('notfound', `模拟接口不存在：${method} ${p}`, 404);
}
