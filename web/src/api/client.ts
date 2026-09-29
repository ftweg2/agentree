import { API_VERSION } from '../../../shared/version';
import type {
  AgentDefinitionDetail,
  AgentTemplateInfo,
  ApplyResult,
  BackupEntry,
  ChangePlan,
  ClaudeConfigSnapshot,
  ClaudeMdRuleState,
  ConfigAction,
  EffectReport,
  IndexStatus,
  LiveState,
  ModelOption,
  Overview,
  SchemeInfo,
  Preset,
  PresetTemplate,
  SessionDetail,
  SessionSummary,
} from '../types';

export const USE_MOCK = import.meta.env.VITE_USE_MOCK === '1' || import.meta.env.VITE_USE_MOCK === 'true';

export type ApiErrorKind = 'offline' | 'http' | 'notfound' | 'bad-response' | 'forbidden' | 'conflict';

/** 统一的接口错误，message 是给用户看的中文说明 */
export class ApiFailure extends Error {
  kind: ApiErrorKind;
  status: number | null;
  detail: string | null;
  constructor(kind: ApiErrorKind, message: string, status: number | null = null, detail: string | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

const OFFLINE_MSG = '无法连接后端：agentree 后端未启动，或没有监听 127.0.0.1:4777';

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';

/** 模拟模式和真实模式共用的"发一次请求"，返回解析后的 JSON，出错抛 ApiFailure */
async function send<T>(method: Method, path: string, body: unknown, headers: Record<string, string>): Promise<T> {
  if (USE_MOCK) {
    const { mockRequest } = await import('../mocks/handler');
    return mockRequest<T>(method, path, body, headers);
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      cache: 'no-store',
    });
  } catch (e) {
    throw new ApiFailure('offline', OFFLINE_MSG, null, e instanceof Error ? e.message : String(e));
  }

  const text = await res.text().catch(() => '');
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  if (!res.ok) {
    const serverMsg =
      json && typeof json === 'object' && 'error' in json && typeof (json as { error: unknown }).error === 'string'
        ? (json as { error: string }).error
        : null;
    // 开发代理连不上后端时返回 502 且没有正文
    if (!serverMsg && (res.status === 502 || res.status === 503 || res.status === 504)) {
      throw new ApiFailure('offline', OFFLINE_MSG, res.status);
    }
    if (res.status === 404) throw new ApiFailure('notfound', serverMsg ?? '请求的资源不存在（404）', 404);
    if (res.status === 403) throw new ApiFailure('forbidden', serverMsg ? `后端拒绝了请求：${serverMsg}` : '后端拒绝了请求（403）', 403);
    if (res.status === 409) throw new ApiFailure('conflict', serverMsg ?? '文件已被其他程序修改（409）', 409);
    throw new ApiFailure('http', serverMsg ? `后端返回错误：${serverMsg}` : `后端返回错误（HTTP ${res.status}）`, res.status);
  }

  if (json === undefined) {
    // 常见于后端未启动时静态服务器回退到 index.html
    const looksHtml = text.trimStart().startsWith('<');
    throw new ApiFailure(looksHtml ? 'offline' : 'bad-response', looksHtml ? OFFLINE_MSG : '后端返回的数据不是有效的 JSON', res.status);
  }
  return json as T;
}

// ---------- 写接口令牌 ----------
// 后端启动时生成随机令牌，所有非 GET 请求要带 X-Agentree-Token。
// 后端重启后令牌会变：收到 403 时重新获取一次再重试一次。

let token: string | null = null;
let tokenPromise: Promise<string> | null = null;

export function fetchToken(force = false): Promise<string> {
  if (!force && token) return Promise.resolve(token);
  if (!force && tokenPromise) return tokenPromise;
  tokenPromise = send<{ token: string }>('GET', '/api/token', undefined, {})
    .then((r) => {
      if (!r || typeof r.token !== 'string' || !r.token) throw new ApiFailure('bad-response', '后端没有返回有效的写入令牌');
      token = r.token;
      return r.token;
    })
    .finally(() => {
      tokenPromise = null;
    });
  return tokenPromise;
}

// ---------- 后端版本 ----------
// 界面文件从磁盘读，后端是常驻进程。更新后没重启应用时，会出现新界面配旧后端。
// 旧后端遇到不认识的参数会直接忽略，所以任何写入之前都先核对版本，对不上就不发请求。

export type BackendState = 'ok' | 'backend-old' | 'frontend-old' | 'unknown';
export const BACKEND_OLD_MSG = 'agentree 的后端还是旧版本，这次操作没有执行。请退出 agentree（托盘图标 → 退出）后重新打开，再试一次。';
export const FRONTEND_OLD_MSG = '这个页面是旧版本，这次操作没有执行。请刷新页面（Ctrl+R）后再试一次。';

let backendState: BackendState = 'unknown';
let backendCheckedAt = 0;

export async function checkBackend(force = false): Promise<BackendState> {
  if (USE_MOCK) return 'ok';
  if (!force && backendState === 'ok' && Date.now() - backendCheckedAt < 5000) return backendState;
  try {
    const r = await send<{ api: number }>('GET', '/api/version', undefined, {});
    const v = r && typeof r.api === 'number' ? r.api : 0;
    backendState = v === API_VERSION ? 'ok' : v < API_VERSION ? 'backend-old' : 'frontend-old';
  } catch (e) {
    // 旧后端没有这个接口，返回 404
    backendState = e instanceof ApiFailure && e.kind === 'notfound' ? 'backend-old' : 'unknown';
  }
  backendCheckedAt = Date.now();
  return backendState;
}

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (method === 'GET') return send<T>(method, path, undefined, {});

  const state = await checkBackend();
  if (state === 'backend-old') throw new ApiFailure('http', BACKEND_OLD_MSG);
  if (state === 'frontend-old') throw new ApiFailure('http', FRONTEND_OLD_MSG);

  const withToken = async (force: boolean) => {
    const t = await fetchToken(force);
    return send<T>(method, path, body ?? {}, { 'Content-Type': 'application/json', 'X-Agentree-Token': t });
  };
  try {
    return await withToken(false);
  } catch (e) {
    if (e instanceof ApiFailure && e.kind === 'forbidden') {
      try {
        return await withToken(true);
      } catch (e2) {
        if (e2 instanceof ApiFailure && e2.kind === 'forbidden') {
          throw new ApiFailure('forbidden', `${e2.message}。已重新获取令牌仍被拒绝，请刷新页面后再试。`, 403, e2.detail);
        }
        throw e2;
      }
    }
    throw e;
  }
}

const cwdQuery = (cwd: string | null) => (cwd ? `?cwd=${encodeURIComponent(cwd)}` : '');

export const api = {
  overview: (days: number) => request<Overview>('GET', `/api/overview?days=${days}`),
  sessions: (limit = 1000, project?: string) =>
    request<SessionSummary[]>('GET', `/api/sessions?limit=${limit}${project ? `&project=${encodeURIComponent(project)}` : ''}`),
  session: (id: string) => request<SessionDetail>('GET', `/api/sessions/${encodeURIComponent(id)}`),
  live: () => request<LiveState>('GET', '/api/live'),
  config: () => request<ClaudeConfigSnapshot>('GET', '/api/config'),
  // 方案分全局和项目两种范围：cwd 为 null 是全局方案，否则是那个项目目录的方案
  presets: () => request<SchemeInfo[]>('GET', '/api/presets'),
  preset: (cwd: string | null = null) => request<Preset>('GET', `/api/preset${cwdQuery(cwd)}`),
  savePreset: (p: Preset, cwd: string | null = null) => request<Preset>('PUT', `/api/preset${cwdQuery(cwd)}`, p),
  deletePreset: (cwd: string) => request<{ ok: true }>('DELETE', `/api/preset${cwdQuery(cwd)}`),
  presetFromConfig: (cwd: string | null = null) => request<Preset>('POST', `/api/preset/from-config${cwdQuery(cwd)}`),
  reindex: () => request<IndexStatus>('POST', '/api/reindex'),
  models: () => request<ModelOption[]>('GET', '/api/models'),

  // 第二阶段
  agentDetail: (filePath: string) => request<AgentDefinitionDetail>('GET', `/api/config/agent?path=${encodeURIComponent(filePath)}`),
  rule: (cwd: string | null = null) => request<ClaudeMdRuleState>('GET', `/api/config/rule${cwdQuery(cwd)}`),
  templates: () => request<PresetTemplate[]>('GET', '/api/config/templates'),
  plan: (actions: ConfigAction[]) => request<ChangePlan>('POST', '/api/config/plan', { actions }),
  apply: (planId: string) => request<ApplyResult>('POST', '/api/config/apply', { planId }),
  backups: () => request<BackupEntry[]>('GET', '/api/config/backups'),
  restore: (backupId: string) => request<ChangePlan>('POST', '/api/config/restore', { backupId }),
  agentTemplates: () => request<AgentTemplateInfo[]>('GET', '/api/config/agent-templates'),
  /** 生效检查：只读，不写任何文件 */
  effect: (preset: Preset, includeRule: boolean, ruleText: string | null, projectCwd: string | null = null) =>
    request<EffectReport>('POST', '/api/config/effect', { preset, includeRule, ruleText, projectCwd }),
};
