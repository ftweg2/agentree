// 第二阶段接口：配置管理。所有写操作都是"生成计划 -> 应用"两步；防护在 security.ts 里集中处理。
import type { Hono } from 'hono';
import path from 'node:path';
import type { AgentDefinitionDetail, ApiError, ApplyResult, ClaudeMdRuleState, ConfigAction, Preset } from '../../shared/types.ts';
import type { Analyzer } from './aggregate.ts';
import { configSnapshot } from './claudeConfig.ts';
import { claudeConfigDirs } from './config.ts';
import { applyPlan, PlanStore } from './config/applier.ts';
import { listBackups } from './config/backups.ts';
import { defaultRuleText } from '../../shared/rule.ts';
import { FALLBACK_RULE_TEXT, findRuleBlock, RuleBlockError } from './config/claudeMd.ts';
import { FrontmatterError, getField, parseAgentDoc, promptOf } from './config/frontmatter.ts';
import { checkWritable, isConfigDirProject, isKnownProjectCwd, PathError, projectClaudeMdPath } from './config/paths.ts';
import { makePlan, makeRestorePlan, type PlanContext } from './config/planner.ts';
import { agentTemplateInfos, PRESET_TEMPLATES } from './config/templates.ts';
import { readTextFile } from './config/text.ts';
import type { Store } from './db.ts';
import { effectReport, EffectInputError, recentSessionsDesktopOnly } from './effect.ts';
import { checkProjectCwd, PresetScopeError, readApplied, type PresetStore } from './preset.ts';

const MANAGED = new Set(['name', 'description', 'model', 'effort', 'tools']);

export interface ConfigRouteDeps {
  /** 应用 preset.apply 的计划成功后，把预设保存为检查标准 */
  presets?: PresetStore;
  /** 生效检查用：索引数据库和会话还原 */
  store?: Store;
  analyzer?: Analyzer;
}

/**
 * 查询参数 / 请求体里的项目目录。缺失、null 或空字符串表示全局方案（cwd 为 null）。
 * 带了就必须是绝对路径；knownCwds 不为 null 时（只在带了 cwd 时才调用）还必须是索引里出现过的会话目录，且不能是用户配置目录所在的目录
 */
export function projectParam(raw: unknown, knownCwds: (() => string[]) | null): { cwd: string | null } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return { cwd: null };
  let cwd: string;
  try {
    cwd = checkProjectCwd(raw);
  } catch (e) {
    if (e instanceof PresetScopeError) return { error: e.message };
    throw e;
  }
  if (knownCwds !== null) {
    if (!isKnownProjectCwd(cwd, knownCwds())) return { error: `项目目录 ${cwd} 没有在索引过的会话里出现过` };
    if (isConfigDirProject(cwd)) return { error: `${cwd} 下的 .claude 就是全局配置目录，这个目录不能用项目方案` };
  }
  return { cwd };
}

function err(message: string): ApiError {
  return { error: message };
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function registerConfigRoutes(app: Hono, getKnownCwds: () => string[], plans = new PlanStore(), deps: ConfigRouteDeps = {}): PlanStore {
  const context = async (): Promise<PlanContext> => {
    const knownCwds = getKnownCwds();
    const snap = await configSnapshot(knownCwds);
    const applied = readApplied();
    // 和生效检查同一个起点：上次应用的时间，其次已保存预设的时间
    const since = applied?.appliedAt ?? deps.presets?.get().updatedAt ?? null;
    const desktopOnly = deps.store ? recentSessionsDesktopOnly(deps.store, since) : false;
    return {
      knownCwds,
      env: snap.env,
      ccSwitchDetected: snap.ccSwitchDetected,
      applied,
      desktopOnly,
      projectApplied: (cwd: string) => deps.presets?.getApplied(cwd) ?? null,
      globalPreset: () => deps.presets?.get() ?? null,
    };
  };

  app.get('/api/config/agent', (c) => {
    const p = c.req.query('path');
    if (!p) return c.json(err('缺少 path 参数'), 400);
    let target;
    try {
      target = checkWritable(p, getKnownCwds());
    } catch (e) {
      return c.json(err((e as Error).message), 403);
    }
    if (target.kind !== 'agent') return c.json(err('不是 agent 定义文件'), 400);
    const f = readTextFile(target.path);
    if (!f.exists) return c.json(err('文件不存在'), 404);
    if (f.text === null) return c.json(err('文件不是 UTF-8 编码'), 422);
    try {
      const doc = parseAgentDoc(f.text, f.bom);
      const detail: AgentDefinitionDetail = {
        name: getField(doc, 'name') ?? target.agentName ?? path.basename(target.path, '.md'),
        source: target.scope ?? 'user',
        filePath: target.path,
        description: getField(doc, 'description'),
        model: getField(doc, 'model'),
        effort: getField(doc, 'effort'),
        tools: getField(doc, 'tools'),
        projectCwd: target.projectCwd,
        body: promptOf(doc),
        otherFields: doc.fields.map((x) => x.key).filter((k) => !MANAGED.has(k)),
        hash: f.hash!,
      };
      return c.json(detail);
    } catch (e) {
      if (e instanceof FrontmatterError) return c.json(err(`frontmatter 格式异常：${e.message}`), 422);
      throw e;
    }
  });

  app.get('/api/config/rule', (c) => {
    // 带 cwd 时是这个项目根目录下的 CLAUDE.md
    const p = projectParam(c.req.query('cwd'), getKnownCwds);
    if ('error' in p) return c.json(err(p.error), 400);
    const filePath = p.cwd === null ? path.join(claudeConfigDirs()[0], 'CLAUDE.md') : projectClaudeMdPath(p.cwd);
    const f = readTextFile(filePath);
    // 默认文字按已保存的方案生成：项目方案叠加全局方案；方案为空时用兜底的 advisor 三条（和 claudeMd.rule 不带正文时写入的一致）
    const auto = deps.presets ? (p.cwd === null ? defaultRuleText(deps.presets.get()) : defaultRuleText(deps.presets.get(p.cwd), deps.presets.get())) : '';
    const state: ClaudeMdRuleState = {
      filePath,
      fileExists: f.exists,
      enabled: false,
      text: null,
      defaultText: auto || FALLBACK_RULE_TEXT,
      error: null,
    };
    if (f.exists && f.text === null) {
      state.error = 'CLAUDE.md 不是 UTF-8 编码的文本，agentree 不会修改它，请手动处理';
    } else if (f.text) {
      try {
        const b = findRuleBlock(f.text);
        if (b) {
          state.enabled = true;
          state.text = b.text;
        }
      } catch (e) {
        if (!(e instanceof RuleBlockError)) throw e;
        // 标记损坏：enabled 为 false，error 给出原因（生成计划时同样会 blocked）
        state.error = e.message;
      }
    }
    return c.json(state);
  });

  app.get('/api/config/templates', (c) => c.json(PRESET_TEMPLATES));

  app.get('/api/config/agent-templates', (c) => c.json(agentTemplateInfos()));

  app.get('/api/config/backups', (c) => c.json(listBackups()));

  app.post('/api/config/plan', async (c) => {
    const body = await readBody(c);
    if (!body || !Array.isArray(body.actions)) return c.json(err('请求体必须是 { actions: ConfigAction[] }'), 400);
    if (body.actions.length === 0) return c.json(err('actions 不能为空'), 400);
    const stored = makePlan(body.actions as ConfigAction[], await context());
    plans.put(stored);
    return c.json(stored.plan);
  });

  app.post('/api/config/restore', async (c) => {
    const body = await readBody(c);
    if (!body || typeof body.backupId !== 'string') return c.json(err('请求体必须是 { backupId: string }'), 400);
    const stored = makeRestorePlan(body.backupId, await context());
    plans.put(stored);
    return c.json(stored.plan);
  });

  app.post('/api/config/apply', async (c) => {
    const body = await readBody(c);
    if (!body || typeof body.planId !== 'string') return c.json(err('请求体必须是 { planId: string }'), 400);
    const stored = plans.take(body.planId);
    if (typeof stored === 'string') return c.json(err(stored), 409);
    const knownCwds = getKnownCwds();
    const r = await applyPlan(stored, knownCwds);
    // 计划来自 preset.apply 且全部成功：把预设保存为检查标准，记下应用时间和 agentree 写过的 settings 键
    let preset: Preset | null = null;
    // 项目方案保存到这个项目自己的记录里，不动全局的
    if (stored.presetApply && r.failed.length === 0 && deps.presets) {
      const scope = stored.presetApply.projectCwd;
      preset = deps.presets.save(stored.presetApply.preset, scope);
      deps.presets.setApplied({ appliedAt: new Date().toISOString(), includeRule: stored.presetApply.includeRule, wrote: stored.presetApply.wrote }, scope);
    }
    const result: ApplyResult = { ...r, config: await configSnapshot(knownCwds), preset };
    return c.json(result);
  });

  app.post('/api/config/effect', async (c) => {
    const body = await readBody(c);
    if (!body) return c.json(err('请求体必须是 { preset, includeRule, ruleText? }'), 400);
    if (!deps.store || !deps.analyzer) return c.json(err('生效检查不可用：没有索引数据'), 500);
    try {
      const projects = (deps.presets?.listProjects() ?? []).map((p) => ({ projectCwd: p.projectCwd, preset: p.preset }));
      const input = { preset: body.preset, includeRule: body.includeRule, ruleText: body.ruleText, projectCwd: body.projectCwd };
      return c.json(effectReport(input, { store: deps.store, analyzer: deps.analyzer, ctx: await context(), projects }));
    } catch (e) {
      if (e instanceof EffectInputError) return c.json(err(e.message), 400);
      throw e;
    }
  });

  return plans;
}

export { PathError };
