// HTTP 路由。全部 JSON，前缀 /api。生产模式下托管 web/dist。
import { modelCatalog } from './models.ts';
import { API_VERSION } from '../../shared/version.ts';
import { Hono } from 'hono';
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ApiError } from '../../shared/types.ts';
import type { Analyzer } from './aggregate.ts';
import { configSnapshot, presetFromConfig, presetFromProject, type PresetFallback } from './claudeConfig.ts';
import type { Desktop } from './desktop.ts';
import type { Indexer } from './indexer.ts';
import type { PresetStore } from './preset.ts';
import type { Store } from './db.ts';
import { projectParam, registerConfigRoutes } from './configRoutes.ts';
import { apiGuard, newToken } from './security.ts';

export interface AppDeps {
  analyzer: Analyzer;
  indexer: Indexer;
  presets: PresetStore;
  store: Store;
  desktop: Desktop;
  /** 写接口令牌；不传则随机生成 */
  token?: string;
  /** 为 null 时不托管静态文件 */
  staticDir: string | null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function err(message: string): ApiError {
  return { error: message };
}

/**
 * 索引里出现过的会话工作目录：按最近活跃排序、去重（Windows 上不区分大小写），磁盘上已经不存在的不列出。
 * 既用于 ClaudeConfigSnapshot.projectCwds，也是项目级 agent 的写入白名单。
 */
export function knownProjectCwds(store: Store): string[] {
  const rows = store.db
    .prepare(
      `SELECT s.cwd AS cwd, MAX(f.last_ts) AS t FROM sessions s LEFT JOIN files f ON f.session_id = s.session_id
       WHERE s.cwd IS NOT NULL AND s.cwd <> '' GROUP BY s.cwd ORDER BY t IS NULL, t DESC`,
    )
    .all() as Array<{ cwd: string; t: string | null }>;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const abs = path.resolve(r.cwd);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue; // 目录已经不存在
    }
    out.push(r.cwd);
  }
  return out;
}

/** 从配置生成预设时的兜底：桌面版最近活跃会话的 model / effort；最近有 advisorModel 的会话的 advisorModel */
export function presetFallback(desktop: Desktop, analyzer: Analyzer): PresetFallback {
  let latest: { model: string | null; effort: string | null; t: number } | null = null;
  for (const s of desktop.sessions.values()) {
    const t = s.lastActivityAt ?? s.createdAt ?? 0;
    if (!latest || t > latest.t) latest = { model: s.model, effort: s.effort, t };
  }
  const withAdvisor = analyzer.sessions(100000).find((s) => s.advisorModel);
  return { model: latest?.model ?? null, effort: latest?.effort ?? null, advisorModel: withAdvisor?.advisorModel ?? null };
}

export function createApp(deps: AppDeps): Hono {
  const { analyzer, indexer, presets, store } = deps;
  const app = new Hono();

  // 所有 JSON 响应明确声明 charset=utf-8（放在最外层，403 等提前返回的响应也会经过这里）
  app.use('*', async (c, next) => {
    await next();
    const ct = c.res.headers.get('content-type');
    if (ct && /^application\/json\b/i.test(ct) && !/charset=/i.test(ct)) {
      c.res.headers.set('Content-Type', 'application/json; charset=utf-8');
    }
  });

  // 防 DNS 重绑定：只接受以回环地址访问的请求（开发代理转发的 Host 也是 localhost/127.0.0.1）
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    if (hostname && !['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
      return c.json(err('只允许通过 127.0.0.1 或 localhost 访问'), 403);
    }
    await next();
  });

  // 写接口的集中防护（来源、令牌、Content-Type）
  const token = deps.token ?? newToken();
  app.use('/api/*', apiGuard(token));

  app.onError((e, c) => {
    console.error('[agentree] 接口出错', e);
    return c.json(err(e instanceof Error ? e.message : String(e)), 500);
  });

  // 令牌：不设置任何跨域允许的响应头，其他来源的网页读不到
  app.get('/api/token', (c) => c.json({ token }));

  // 界面在写入之前用它确认后端不是旧版本
  app.get('/api/version', (c) => c.json({ api: API_VERSION }));

  app.get('/api/overview', async (c) => {
    const raw = c.req.query('days');
    let days: number | null = 30;
    if (raw !== undefined && raw !== '') {
      if (raw === 'all' || raw === '0') days = null;
      else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 3650) return c.json(err('days 必须是 0 到 3650 的整数，或 all'), 400);
        days = n === 0 ? null : n;
      }
    }
    return c.json(await analyzer.overview(days));
  });

  app.get('/api/sessions', (c) => {
    const rawLimit = c.req.query('limit');
    let limit = 200;
    if (rawLimit !== undefined && rawLimit !== '') {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < 0) return c.json(err('limit 必须是非负整数'), 400);
      limit = n;
    }
    const project = c.req.query('project') || null;
    return c.json(analyzer.sessions(limit, project));
  });

  app.get('/api/sessions/:id', (c) => {
    const d = analyzer.sessionDetail(c.req.param('id'));
    if (!d) return c.json(err('会话不存在'), 404);
    return c.json(d);
  });

  app.get('/api/live', (c) => c.json(analyzer.live()));

  app.get('/api/config', async (c) => c.json(await configSnapshot(knownProjectCwds(store))));

  app.get('/api/models', (c) => c.json(modelCatalog(analyzer.pricing, store)));

  // 方案：不带 cwd 是全局方案，带 cwd=<项目目录> 是项目方案（cwd 为空字符串当作没带）
  app.get('/api/presets', (c) => c.json(presets.list()));

  app.get('/api/preset', (c) => {
    const p = projectParam(c.req.query('cwd'), null);
    if ('error' in p) return c.json(err(p.error), 400);
    return c.json(presets.get(p.cwd));
  });

  app.put('/api/preset', async (c) => {
    // 保存项目方案要求是索引里出现过的会话目录
    const p = projectParam(c.req.query('cwd'), () => knownProjectCwds(store));
    if ('error' in p) return c.json(err(p.error), 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(err('请求体不是合法的 JSON'), 400);
    }
    try {
      return c.json(presets.save(body, p.cwd));
    } catch (e) {
      return c.json(err((e as Error).message), 400);
    }
  });

  app.delete('/api/preset', (c) => {
    const p = projectParam(c.req.query('cwd'), null);
    if ('error' in p) return c.json(err(p.error), 400);
    if (p.cwd === null) return c.json(err('不能删除全局方案，只能删除项目方案（带 cwd=<项目目录>）'), 400);
    // 只删 agentree 自己的记录，不动 Claude Code 的配置文件
    if (!presets.remove(p.cwd)) return c.json(err(`没有 ${p.cwd} 的项目方案`), 404);
    return c.json({ ok: true });
  });

  app.post('/api/preset/from-config', async (c) => {
    const p = projectParam(c.req.query('cwd'), () => knownProjectCwds(store));
    if ('error' in p) return c.json(err(p.error), 400);
    if (p.cwd !== null) return c.json(await presetFromProject(p.cwd));
    await deps.desktop.refresh();
    return c.json(presetFromConfig(await configSnapshot(knownProjectCwds(store)), presetFallback(deps.desktop, analyzer)));
  });

  app.post('/api/reindex', (c) => {
    indexer.requestFullScan();
    return c.json({ ...indexer.status });
  });

  registerConfigRoutes(app, () => knownProjectCwds(store), undefined, { presets, store, analyzer });

  app.all('/api/*', (c) => c.json(err('接口不存在'), 404));

  if (deps.staticDir) {
    const root = path.resolve(deps.staticDir);
    const indexHtml = path.join(root, 'index.html');
    app.get('*', async (c) => {
      let rel: string;
      try {
        rel = decodeURIComponent(new URL(c.req.url).pathname);
      } catch {
        return c.text('Bad Request', 400);
      }
      const target = path.resolve(root, '.' + path.posix.normalize('/' + rel));
      let file = indexHtml;
      if (target.startsWith(root + path.sep) && existsSync(target) && statSync(target).isFile()) file = target;
      try {
        const data = await fs.readFile(file);
        const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        const headers: Record<string, string> = { 'Content-Type': type };
        if (file !== indexHtml && /[\\/]assets[\\/]/.test(file)) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        else headers['Cache-Control'] = 'no-cache';
        return c.body(data, 200, headers);
      } catch {
        return c.text('Not Found', 404);
      }
    });
  }

  return app;
}
