// 写接口的集中防护：来源（Origin）校验、令牌校验、Content-Type 校验。
// 所有 /api 请求都经过这里，路由里不再各自判断，避免遗漏。
import crypto from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export const TOKEN_HEADER = 'X-Agentree-Token';

export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 本机来源：http(s)://127.0.0.1|localhost|[::1][:port]。
 * 桌面壳直接加载 http://127.0.0.1:<端口>，不需要放行 tauri://localhost 之类的来源——
 * 那些是所有 Tauri 应用共用的，放行等于信任本机任何一个 Tauri 应用的页面。
 */
export function isLocalOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname.toLowerCase());
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * - 带了 Origin 且不是本机来源：403（所有方法）
 * - 非 GET：必须带正确的 X-Agentree-Token（403），且 Content-Type 必须是 application/json（415）
 * 不设置任何 Access-Control-Allow-* 响应头，其他来源的网页读不到响应（包括 GET /api/token）。
 */
export function apiGuard(token: string): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && !isLocalOrigin(origin)) {
      return c.json({ error: `拒绝来自 ${origin} 的请求：只接受本机页面的请求` }, 403);
    }
    if (!READ_METHODS.has(c.req.method.toUpperCase())) {
      const given = c.req.header(TOKEN_HEADER);
      if (!given || !safeEqual(given, token)) {
        return c.json({ error: `缺少或错误的 ${TOKEN_HEADER} 请求头，请先调用 GET /api/token` }, 403);
      }
      const ct = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') {
        return c.json({ error: '写接口只接受 Content-Type: application/json' }, 415);
      }
    }
    await next();
  };
}
