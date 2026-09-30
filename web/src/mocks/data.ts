// 模拟数据：结构符合 shared/types.ts 契约。
// 覆盖：3 层嵌套、四种状态、四种检查级别与四种判定、costUsd 为 null、
// 一个 agent 用多个模型、advisor 配置了但调用 0 次、索引进行中。
import type {
  AgentNode,
  AgentStatus,
  AgentTypeUsage,
  CompactionStats,
  ModelUsage,
  Preset,
  ReplyWaitStats,
  SessionDetail,
  SessionSummary,
  TokenTotals,
} from '../types';
import { agentConformance, sessionChecks } from './conformance';

const OPUS = 'claude-opus-5-5';
const OPUS_1M = 'claude-opus-5-5[1m]';
const OPUS_OLD = 'claude-opus-5';
const SONNET = 'claude-sonnet-5';
const HAIKU = 'claude-haiku-4-5-20251001';
const FABLE = 'claude-fable-5-1'; // 模拟"价格表里查不到"的模型，costUsd 为 null

// 每百万 token 的美元价格（input, output）；fable 故意缺失
const PRICES: Record<string, [number, number]> = {
  opus: [5, 25],
  sonnet: [3, 15],
  haiku: [1, 5],
};

function priceOf(model: string): [number, number] | null {
  const m = model.toLowerCase();
  for (const k of Object.keys(PRICES)) if (m.includes(k)) return PRICES[k];
  return null;
}

export function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, total: 0 };
}

export function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    total: a.total + b.total,
  };
}

export function addCost(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return a + b;
}

function seeded(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000; // 0..1
}

function makeUsage(model: string, requests: number, key: string, isMain: boolean): ModelUsage {
  const v = 0.6 + seeded(key + model) * 0.8;
  const input = Math.round(requests * 140 * v);
  const output = Math.round(requests * 820 * v);
  const cacheRead = Math.round(requests * (isMain ? 52000 : 21000) * v);
  const cacheWrite5m = isMain ? 0 : Math.round(requests * 1600 * v);
  const cacheWrite1h = isMain ? Math.round(requests * 2400 * v) : 0;
  const tokens: TokenTotals = {
    input,
    output,
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    total: input + output + cacheRead + cacheWrite5m + cacheWrite1h,
  };
  const p = priceOf(model);
  const costUsd = p
    ? (input * p[0] + output * p[1] + cacheRead * p[0] * 0.1 + cacheWrite5m * p[0] * 1.25 + cacheWrite1h * p[0] * 2) / 1e6
    : null;
  return { model, requests, tokens, costUsd };
}

// ---------- 会话规格 ----------

interface NodeSpec {
  id: string;
  type?: string; // 主会话省略
  desc?: string;
  status: AgentStatus;
  bg?: boolean;
  /** [模型, 请求数] */
  models: Array<[string, number]>;
  efforts?: string[];
  requestedModel?: string;
  advisorModel?: string;
  advisorCalls?: number;
  /** 上下文压缩：自动压缩前的 token 数列表、手动压缩次数 */
  compactions?: { autoPreTokens: number[]; manual?: number };
  /** 回复等待：最长一次等了多少秒、那次的输出 token、超过 2 分钟的次数。省略时按节点生成几十秒以内的值 */
  wait?: { longestSec: number; out: number; slow: number };
  /** 相对会话开始的分钟数 */
  start: number;
  /** 持续分钟数；运行中的节点省略 */
  dur?: number;
  tools: number;
  children?: NodeSpec[];
}

interface SessionSpec {
  id: string;
  projectDir: string;
  cwd: string;
  title: string | null;
  entrypoint: string;
  version: string;
  /** 会话开始距现在的分钟数 */
  startedMinAgo: number;
  /** 是否活跃（运行中的节点会随时间增长） */
  active: boolean;
  /** 主对话被用户中断的次数 */
  interrupts?: number;
  /** 中断前最长等了多少秒 */
  interruptMaxWaitSec?: number;
  /** 主对话正在等回复：从模块加载时刻往前推多少分钟开始等 */
  awaitingMin?: number;
  root: NodeSpec;
}

const E = (s: string) => [s];

const LIVE_ROOT: NodeSpec = {
  id: 'main',
  status: 'running',
  models: [[OPUS_1M, 86]],
  efforts: E('xhigh'),
  advisorModel: OPUS,
  advisorCalls: 0,
  // 在阈值 500K 附近自动压缩过一次
  compactions: { autoPreTokens: [498_300] },
  // xhigh 下有一次先思考了 6 分钟才出第一段内容
  wait: { longestSec: 368, out: 43_616, slow: 3 },
  start: 0,
  tools: 142,
  children: [
    { id: 'a01-explore', type: 'Explore', desc: '梳理 server 目录结构和入口文件', status: 'completed', models: [[HAIKU, 14]], start: 1, dur: 2, tools: 23 },
    { id: 'a02-plan', type: 'Plan', desc: '设计增量索引与字节偏移量的持久化方案', status: 'completed', models: [[OPUS, 9]], efforts: E('high'), start: 3, dur: 4, tools: 11 },
    {
      id: 'a03-research',
      type: 'researcher',
      desc: '调研 node:sqlite 在 Windows 上的并发写入限制和 WAL 模式行为',
      status: 'completed',
      models: [[OPUS_OLD, 22]],
      efforts: E('high'),
      requestedModel: 'opus',
      wait: { longestSec: 151, out: 12_400, slow: 1 },
      start: 4,
      dur: 11,
      tools: 38,
      children: [
        { id: 'a03a-explore', type: 'Explore', desc: '查找 node:sqlite 官方文档', status: 'completed', models: [[HAIKU, 6]], start: 5, dur: 1, tools: 9 },
        { id: 'a03b-explore', type: 'Explore', desc: '对比 better-sqlite3 的 WAL 行为', status: 'completed', models: [[HAIKU, 8]], start: 5, dur: 2, tools: 12 },
        {
          id: 'a03c-research',
          type: 'researcher',
          desc: '验证 WAL 模式下的读写锁与 busy_timeout',
          status: 'completed',
          models: [[OPUS, 12]],
          efforts: E('high'),
          start: 7,
          dur: 7,
          tools: 19,
          children: [
            { id: 'a03c1-test', type: 'test-runner', desc: '跑并发写入基准（4 个写进程）', status: 'completed', models: [[HAIKU, 7]], efforts: E('medium'), start: 8, dur: 3, tools: 14 },
            { id: 'a03c2-test', type: 'test-runner', desc: '跑并发读取基准', status: 'failed', models: [[HAIKU, 5]], efforts: E('medium'), start: 8, dur: 2, tools: 9 },
          ],
        },
      ],
    },
    { id: 'a04-review', type: 'code-reviewer', desc: '审查解析器的去重逻辑（逐字段取最大值）', status: 'completed', models: [[SONNET, 11]], efforts: E('xhigh'), start: 12, dur: 5, tools: 17 },
    { id: 'a05-review', type: 'code-reviewer', desc: '审查 API 路由的错误处理', status: 'completed', models: [[SONNET, 7]], efforts: E('medium'), start: 13, dur: 3, tools: 10 },
    { id: 'a06-gp', type: 'general-purpose', desc: '修复 Windows 路径大小写导致的重复索引', status: 'completed', models: [[OPUS, 18]], efforts: E('xhigh'), start: 14, dur: 6, tools: 31 },
    {
      id: 'a07-review',
      type: 'code-reviewer',
      desc: '复查修复后的去重实现，确认子 agent 副本被丢弃',
      status: 'running',
      bg: true,
      models: [
        [SONNET, 9],
        [HAIKU, 3],
      ],
      efforts: E('high'),
      start: 18,
      tools: 12,
    },
    {
      id: 'a08-test',
      type: 'test-runner',
      desc: '运行解析器单元测试并收集失败用例',
      status: 'running',
      bg: true,
      models: [[HAIKU, 10]],
      efforts: E('medium'),
      start: 19,
      tools: 16,
      children: [
        {
          id: 'a08a-gp',
          type: 'general-purpose',
          desc: '生成 84MB 大文件测试样本',
          status: 'running',
          models: [[SONNET, 6]],
          efforts: E('high'),
          start: 20,
          tools: 8,
          children: [
            { id: 'a08a1-explore', type: 'Explore', desc: '查找本机最大的 jsonl 日志作为样本模板', status: 'running', models: [[HAIKU, 4]], start: 21, tools: 7 },
          ],
        },
      ],
    },
    { id: 'a09-doc', type: 'doc-writer', desc: '更新 README 的安装与启动步骤', status: 'completed', models: [[FABLE, 5]], start: 15, dur: 3, tools: 6 },
    { id: 'a10-perf', type: 'perf-profiler', desc: '分析流式读取大文件时的内存占用', status: 'completed', models: [[OPUS, 13]], efforts: E('high'), start: 9, dur: 6, tools: 21 },
    { id: 'a11-perf', type: 'perf-profiler', desc: '测量首次全量扫描 454MB 日志的耗时', status: 'failed', models: [[OPUS, 4]], efforts: E('high'), start: 16, dur: 1, tools: 5 },
    { id: 'a12-explore', type: 'Explore', desc: '检查 cc-switch 的 live-state.json 位置', status: 'unknown', bg: true, models: [[HAIKU, 3]], start: 10, tools: 4 },
    { id: 'a13-research', type: 'researcher', desc: '查 LiteLLM 价格表里 1 小时缓存写入的字段名', status: 'stopped', bg: true, models: [[OPUS, 6]], efforts: E('medium'), start: 11, dur: 2, tools: 8 },
    {
      id: 'a14-test',
      type: 'test-runner',
      desc: '端到端测试 /api/sessions 与 /api/sessions/:id',
      status: 'completed',
      models: [[HAIKU, 9]],
      efforts: E('medium'),
      start: 17,
      dur: 5,
      tools: 18,
      children: [
        { id: 'a14a-test', type: 'test-runner', desc: '准备测试夹具（3 层嵌套的会话）', status: 'completed', models: [[HAIKU, 4]], efforts: E('medium'), start: 17, dur: 1, tools: 6 },
        { id: 'a14b-explore', type: 'Explore', desc: '定位 fixture 目录', status: 'completed', models: [[HAIKU, 2]], start: 17, dur: 1, tools: 3 },
        {
          id: 'a14c-gp',
          type: 'general-purpose',
          desc: '修复失败的快照测试',
          status: 'completed',
          models: [[SONNET, 8]],
          efforts: E('high'),
          start: 19,
          dur: 3,
          tools: 15,
          children: [
            { id: 'a14c1-explore', type: 'Explore', desc: '对比快照差异', status: 'completed', models: [[HAIKU, 3]], start: 19, dur: 1, tools: 5 },
            { id: 'a14c2-explore', type: 'Explore', desc: '找出与时区相关的断言', status: 'completed', models: [[HAIKU, 3]], start: 20, dur: 1, tools: 4 },
          ],
        },
      ],
    },
    { id: 'a15-plan', type: 'Plan', desc: '拆分前端五个页面的实现任务', status: 'completed', models: [[OPUS, 7]], efforts: E('high'), start: 6, dur: 3, tools: 6 },
    {
      id: 'a16-gp',
      type: 'general-purpose',
      desc: '实现 /api/live 接口与 120 秒活跃判断',
      status: 'completed',
      models: [[OPUS, 16]],
      efforts: E('xhigh'),
      start: 12,
      dur: 8,
      tools: 29,
      children: [
        { id: 'a16a-explore', type: 'Explore', desc: '查找 fs.watch 在 Windows 上的已知问题', status: 'completed', models: [[HAIKU, 4]], start: 12, dur: 1, tools: 6 },
        { id: 'a16b-explore', type: 'Explore', desc: '检查 NTFS mtime 精度', status: 'completed', models: [[HAIKU, 3]], start: 12, dur: 1, tools: 4 },
        { id: 'a16c-explore', type: 'Explore', desc: '读取 spec 里的状态判断规则', status: 'completed', models: [[HAIKU, 2]], start: 13, dur: 1, tools: 2 },
        { id: 'a16d-review', type: 'code-reviewer', desc: '审查 live 接口实现', status: 'completed', models: [[SONNET, 6]], efforts: E('high'), start: 18, dur: 2, tools: 9 },
      ],
    },
    { id: 'a17-explore', type: 'Explore', desc: '统计本机 jsonl 文件数量和总大小', status: 'completed', models: [[HAIKU, 3]], start: 2, dur: 1, tools: 5 },
    { id: 'a18-review', type: 'code-reviewer', desc: '审查一致性检查的模型匹配规则', status: 'running', bg: true, models: [[SONNET, 5]], efforts: E('high'), start: 22, tools: 7 },
    { id: 'a19-gp', type: 'general-purpose', desc: '调整 effort 比较顺序并补充单元测试', status: 'completed', models: [[OPUS, 10]], efforts: E('xhigh'), start: 20, dur: 3, tools: 14 },
  ],
};

const SESSIONS: SessionSpec[] = [
  {
    id: '7f3c2a10-5b1e-4c7d-9a2f-live00000001',
    projectDir: 'C--Users-you-Desktop-agentree',
    cwd: 'C:\\Users\\you\\Desktop\\agentree',
    title: '实现 agentree 后端：增量索引、去重和一致性检查',
    entrypoint: 'claude-desktop',
    version: '2.1.263',
    startedMinAgo: 25,
    active: true,
    interrupts: 3,
    // 用户消息之后 11 分钟没有任何输出，被中断
    interruptMaxWaitSec: 662,
    root: LIVE_ROOT,
  },
  {
    id: '2b8e91c4-0d6a-4f3e-8c55-live00000002',
    projectDir: 'C--Users-you-Desktop-agentree',
    cwd: 'C:\\Users\\you\\Desktop\\agentree',
    title: '写 agentree 前端页面',
    entrypoint: 'claude-desktop',
    version: '2.1.263',
    startedMinAgo: 14,
    active: true,
    awaitingMin: 4,
    root: {
      id: 'main',
      status: 'running',
      models: [[OPUS, 31]],
      efforts: E('xhigh'),
      advisorModel: OPUS,
      advisorCalls: 3,
      start: 0,
      tools: 58,
      children: [
        { id: 'b1-explore', type: 'Explore', desc: '读 shared/types.ts 的接口契约', status: 'completed', models: [[HAIKU, 4]], start: 1, dur: 1, tools: 5 },
        { id: 'b2-gp', type: 'general-purpose', desc: '实现 agent 树组件', status: 'running', bg: true, models: [[OPUS, 12]], efforts: E('high'), start: 3, tools: 22 },
        { id: 'b3-review', type: 'code-reviewer', desc: '审查图表配色的对比度', status: 'running', bg: true, models: [[SONNET, 4]], efforts: E('high'), start: 9, tools: 6 },
        { id: 'b4-explore', type: 'Explore', desc: '查找 recharts 的主题配置（被用户中止）', status: 'stopped', models: [[HAIKU, 2]], start: 6, dur: 1, tools: 3 },
      ],
    },
  },
  {
    id: 'c41d7e22-9f08-4b1a-a3c6-000000000003',
    projectDir: 'C--Users-you-Desktop-agentree',
    cwd: 'C:\\Users\\you\\Desktop\\agentree',
    title: '排查 advisor 从不触发的原因',
    entrypoint: 'claude-desktop',
    version: '2.1.259',
    startedMinAgo: 60 * 26,
    active: false,
    root: {
      id: 'main',
      status: 'completed',
      models: [[SONNET, 44]],
      efforts: E('high'),
      advisorModel: OPUS,
      advisorCalls: 0,
      start: 0,
      dur: 95,
      tools: 77,
      children: [
        { id: 'c1-research', type: 'researcher', desc: '读 advisor 相关的官方文档', status: 'completed', models: [[SONNET, 12]], efforts: E('high'), start: 5, dur: 12, tools: 20 },
        { id: 'c2-explore', type: 'Explore', desc: '在日志里搜索 advisor_message', status: 'completed', models: [[HAIKU, 9]], start: 20, dur: 4, tools: 16 },
        { id: 'c3-gp', type: 'general-purpose', desc: '检查注册表环境变量', status: 'completed', models: [[SONNET, 6]], efforts: E('high'), start: 30, dur: 5, tools: 8 },
      ],
    },
  },
  {
    id: 'd5a0b3f1-2e7c-4d98-b614-000000000004',
    projectDir: 'C--Users-you-Desktop-agentree',
    cwd: 'C:\\Users\\you\\Desktop\\agentree',
    title: '前期调研：竞品源码与本机日志交叉验证',
    entrypoint: 'claude-desktop',
    version: '2.1.255',
    startedMinAgo: 60 * 24 * 3 + 120,
    active: false,
    root: {
      id: 'main',
      status: 'completed',
      models: [[OPUS_1M, 120]],
      efforts: E('max'),
      advisorModel: OPUS,
      advisorCalls: 0,
      // 到接近 1M 才自动压缩：说明当时 500K 的阈值没有生效；另外手动 /compact 过一次
      compactions: { autoPreTokens: [966_800, 971_200], manual: 1 },
      start: 0,
      dur: 260,
      tools: 210,
      children: [
        { id: 'd1-research', type: 'researcher', desc: '读 ccusage 源码的去重实现', status: 'completed', models: [[OPUS, 30]], efforts: E('high'), start: 10, dur: 30, tools: 60 },
        { id: 'd2-research', type: 'researcher', desc: '读 cc-switch 源码的增量读取', status: 'completed', models: [[OPUS, 26]], efforts: E('high'), start: 12, dur: 28, tools: 51 },
        {
          id: 'd3-research',
          type: 'researcher',
          desc: '读 claude-code-log 的子 agent 解析',
          status: 'completed',
          models: [[OPUS, 22]],
          efforts: E('high'),
          start: 15,
          dur: 25,
          tools: 44,
          children: [
            { id: 'd3a-explore', type: 'Explore', desc: '定位 meta.json 解析代码', status: 'completed', models: [[HAIKU, 8]], start: 16, dur: 5, tools: 14 },
          ],
        },
        { id: 'd4-explore', type: 'Explore', desc: '统计本机日志的多行请求', status: 'completed', models: [[HAIKU, 48]], start: 40, dur: 20, tools: 70 },
        { id: 'd5-plan', type: 'Plan', desc: '汇总调研结论', status: 'completed', models: [[OPUS, 11]], efforts: E('high'), start: 200, dur: 30, tools: 12 },
      ],
    },
  },
  {
    id: 'e6b1c4a2-3f8d-4e09-c725-000000000005',
    projectDir: 'C--Users-you-Documents-blog',
    cwd: 'C:\\Users\\you\\Documents\\blog',
    title: '把博客迁移到 Astro',
    entrypoint: 'cli',
    version: '2.1.250',
    startedMinAgo: 60 * 24 * 5,
    active: false,
    root: {
      id: 'main',
      status: 'completed',
      models: [[OPUS, 38]],
      efforts: E('high'),
      start: 0,
      dur: 80,
      tools: 64,
      children: [
        { id: 'e1-migrator', type: 'migrator', desc: '批量改写 frontmatter', status: 'completed', models: [[SONNET, 15]], efforts: E('medium'), start: 10, dur: 15, tools: 40 },
        { id: 'e2-explore', type: 'Explore', desc: '查找所有用到短代码的文章', status: 'completed', models: [[HAIKU, 6]], start: 5, dur: 3, tools: 12 },
      ],
    },
  },
  {
    id: 'f7c2d5b3-4a9e-4f1a-d836-000000000006',
    projectDir: 'C--Users-you-Documents-notes',
    cwd: 'C:\\Users\\you\\Documents\\notes',
    title: '整理读书笔记',
    entrypoint: 'claude-desktop',
    version: '2.1.248',
    startedMinAgo: 60 * 24 * 8,
    active: false,
    root: {
      id: 'main',
      status: 'completed',
      models: [[FABLE, 21]],
      efforts: [],
      start: 0,
      dur: 40,
      tools: 18,
      children: [],
    },
  },
  {
    id: '08d3e6c4-5b0f-4a2b-e947-000000000007',
    projectDir: 'C--Users-you-Documents-notes',
    cwd: 'C:\\Users\\you\\Documents\\notes',
    title: null,
    entrypoint: 'cli',
    version: '2.1.240',
    startedMinAgo: 60 * 24 * 12,
    active: false,
    root: {
      id: 'main',
      status: 'unknown',
      models: [[HAIKU, 4]],
      efforts: E('low'),
      start: 0,
      dur: 3,
      tools: 2,
      children: [],
    },
  },
  {
    id: '19e4f7d5-6c1a-4b3c-f058-000000000008',
    projectDir: 'C--Users-you-Desktop-agentree',
    cwd: 'C:\\Users\\you\\Desktop\\agentree',
    title: '评估套 Tauri 壳的工作量',
    entrypoint: 'claude-desktop',
    version: '2.1.261',
    startedMinAgo: 60 * 6,
    active: false,
    root: {
      id: 'main',
      status: 'completed',
      models: [
        [OPUS, 28],
        [SONNET, 9],
      ],
      efforts: ['xhigh', 'high'],
      advisorModel: OPUS,
      advisorCalls: 5,
      start: 0,
      dur: 70,
      tools: 49,
      children: [
        { id: 'h1-research', type: 'researcher', desc: '对比 Tauri 2 与 Electron 的打包体积', status: 'completed', models: [[OPUS, 14]], efforts: E('high'), start: 5, dur: 18, tools: 25 },
        { id: 'h2-test', type: 'test-runner', desc: '在 Windows 上试打包', status: 'failed', models: [[HAIKU, 7]], efforts: E('high'), start: 30, dur: 9, tools: 13 },
      ],
    },
  },
];

// ---------- 构建 ----------

/** 模拟"时间在走"：活跃会话里运行中的节点每 2 秒多一次请求 */
function liveBump(t0: number): number {
  return Math.min(400, Math.floor((Date.now() - t0) / 2000));
}

const TOOLS = ['Read', 'Grep', 'Bash', 'Edit', 'Glob', 'WebFetch', 'Write', 'Agent'];

export function currentToolFor(id: string): string {
  const i = Math.floor(Date.now() / 3000 + seeded(id) * 10) % TOOLS.length;
  return TOOLS[i];
}

function replyWaitOf(ns: NodeSpec, requests: number, startedAt: string): ReplyWaitStats {
  if (requests === 0) return { replies: 0, slowReplies: 0, longest: null };
  const w = ns.wait ?? { longestSec: 4 + Math.round(seeded(ns.id + 'w') * 40), out: 800 + Math.round(seeded(ns.id + 'o') * 6000), slow: 0 };
  const waitMs = w.longestSec * 1000;
  const at = new Date(new Date(startedAt).getTime() + 60_000 + waitMs).toISOString();
  return { replies: requests, slowReplies: w.slow, longest: { waitMs, durationMs: waitMs + 40_000, outputTokens: w.out, at } };
}

function compactionsOf(ns: NodeSpec): CompactionStats {
  const auto = ns.compactions?.autoPreTokens ?? [];
  const manual = ns.compactions?.manual ?? 0;
  return { total: auto.length + manual, auto: auto.length, manual, autoPreTokens: [...auto] };
}

export function buildSession(spec: SessionSpec, preset: Preset, t0: number): SessionDetail {
  const now = Date.now();
  // 以模块加载时刻为基准，运行中的节点耗时会随时间增长
  const startMs = t0 - spec.startedMinAgo * 60_000;
  const bump = spec.active ? liveBump(t0) : 0;
  const agents: AgentNode[] = [];

  function build(ns: NodeSpec, parentId: string | null, depth: number, parentToolIdx: number): AgentNode {
    const isMain = parentId === null;
    const running = ns.status === 'running';
    const extra = running ? bump : 0;
    const models = ns.models.map(([m, r], i) => makeUsage(m, r + (i === 0 ? extra : 0), spec.id + ns.id, isMain));
    const tokens = models.reduce((a, m) => addTokens(a, m.tokens), emptyTokens());
    const cost = models.reduce<number | null>((a, m) => addCost(a, m.costUsd), null);
    const requests = models.reduce((a, m) => a + m.requests, 0);
    const primary = models.length ? [...models].sort((a, b) => b.requests - a.requests)[0].model : null;
    const started = new Date(startMs + ns.start * 60_000 + (isMain ? 0 : 7_000)).toISOString();
    const ended = ns.dur != null && !running ? new Date(startMs + (ns.start + ns.dur) * 60_000).toISOString() : null;
    const node: AgentNode = {
      id: ns.id,
      kind: isMain ? 'main' : 'subagent',
      agentType: isMain ? null : ns.type ?? null,
      description: isMain ? null : ns.desc ?? null,
      parentId,
      depth,
      toolUseId: isMain ? null : `toolu_01${(ns.id + 'xxxxxxxxxxxx').slice(0, 12).replace(/[^a-z0-9]/gi, 'x')}${parentToolIdx}`,
      status: ns.status,
      background: !!ns.bg,
      startedAt: started,
      endedAt: ended,
      durationMs: ended ? new Date(ended).getTime() - new Date(started).getTime() : running ? now - new Date(started).getTime() : null,
      requests,
      toolCalls: ns.tools + (running ? Math.floor(extra * 1.5) : 0),
      tokens,
      costUsd: cost,
      subtree: { agents: 0, requests: 0, toolCalls: 0, tokens: emptyTokens(), costUsd: null },
      models,
      primaryModel: primary,
      efforts: ns.efforts ?? [],
      requestedModel: ns.requestedModel ?? null,
      advisorModel: ns.advisorModel ?? null,
      advisorCalls: ns.advisorCalls ?? 0,
      compactions: compactionsOf(ns),
      replyWait: replyWaitOf(ns, requests, started),
      conformance: { verdict: 'not-checked', presetAgent: null, checks: [] },
      children: [],
    };
    agents.push(node);
    const kids = [...(ns.children ?? [])].sort((a, b) => a.start - b.start);
    const childNodes = kids.map((k, i) => build(k, ns.id, depth + 1, i));
    node.children = childNodes.map((c) => c.id);
    node.subtree = childNodes.reduce(
      (acc, c) => ({
        agents: acc.agents + c.subtree.agents + 1,
        requests: acc.requests + c.subtree.requests,
        toolCalls: acc.toolCalls + c.subtree.toolCalls,
        tokens: addTokens(acc.tokens, c.subtree.tokens),
        costUsd: addCost(acc.costUsd, c.subtree.costUsd),
      }),
      { agents: 0, requests, toolCalls: node.toolCalls, tokens, costUsd: cost },
    );
    if (!isMain) node.conformance = agentConformance(node, preset);
    return node;
  }

  const main = build(spec.root, null, 0, 0);
  // 主节点放第一位，其余按开始时间
  const ordered = [main, ...agents.filter((a) => a !== main).sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))];

  const sChecks = sessionChecks(main, preset);
  main.conformance = {
    verdict: sChecks.some((c) => c.level === 'fail') ? 'mismatch' : sChecks.length ? 'match' : 'not-checked',
    presetAgent: null,
    checks: sChecks,
  };

  // 会话级模型与 agent 类型汇总
  const modelMap = new Map<string, ModelUsage>();
  const typeMap = new Map<string, AgentTypeUsage>();
  for (const a of ordered) {
    for (const m of a.models) {
      const cur = modelMap.get(m.model);
      modelMap.set(
        m.model,
        cur
          ? { model: m.model, requests: cur.requests + m.requests, tokens: addTokens(cur.tokens, m.tokens), costUsd: addCost(cur.costUsd, m.costUsd) }
          : { ...m },
      );
    }
    const t = a.kind === 'main' ? 'main' : a.agentType ?? 'unknown';
    const cur = typeMap.get(t);
    const models = a.models.map((m) => m.model);
    typeMap.set(
      t,
      cur
        ? {
            agentType: t,
            spawns: cur.spawns + (a.kind === 'main' ? 0 : 1),
            requests: cur.requests + a.requests,
            tokens: addTokens(cur.tokens, a.tokens),
            costUsd: addCost(cur.costUsd, a.costUsd),
            models: Array.from(new Set([...cur.models, ...models])),
          }
        : { agentType: t, spawns: a.kind === 'main' ? 0 : 1, requests: a.requests, tokens: a.tokens, costUsd: a.costUsd, models },
    );
  }

  const allChecks = [...sChecks, ...ordered.filter((a) => a.kind !== 'main').flatMap((a) => a.conformance.checks)];
  const verdicts = ordered.filter((a) => a.kind !== 'main').map((a) => a.conformance.verdict);
  const verdict = sChecks.some((c) => c.level === 'fail') || verdicts.includes('mismatch')
    ? 'mismatch'
    : verdicts.includes('unplanned')
      ? 'unplanned'
      : sChecks.length || verdicts.includes('match')
        ? 'match'
        : 'not-checked';

  const lastActivity = spec.active
    ? new Date(now - 3000).toISOString()
    : ordered.reduce((acc, a) => ((a.endedAt ?? '') > acc ? a.endedAt ?? acc : acc), main.startedAt ?? '');

  const summary: SessionSummary = {
    scheme: { scope: 'user', projectCwd: null },
    id: spec.id,
    projectDir: spec.projectDir,
    cwd: spec.cwd,
    title: spec.title,
    entrypoint: spec.entrypoint,
    version: spec.version,
    startedAt: main.startedAt,
    lastActivityAt: lastActivity,
    isActive: spec.active,
    mainModel: main.primaryModel,
    mainEffort: main.efforts[main.efforts.length - 1] ?? null,
    advisorModel: main.advisorModel,
    advisorCalls: main.advisorCalls,
    compactions: main.compactions,
    replyWait: main.replyWait,
    interrupts: spec.interrupts ?? 0,
    interruptMaxWaitMs: spec.interruptMaxWaitSec != null ? spec.interruptMaxWaitSec * 1000 : null,
    awaitingReply:
      spec.awaitingMin != null
        ? { since: new Date(t0 - spec.awaitingMin * 60_000).toISOString(), waitedMs: now - (t0 - spec.awaitingMin * 60_000) }
        : null,
    agentCount: ordered.length - 1,
    maxDepth: Math.max(...ordered.map((a) => a.depth)),
    requests: main.subtree.requests,
    tokens: main.subtree.tokens,
    costUsd: main.subtree.costUsd,
    conformance: {
      verdict,
      fail: allChecks.filter((c) => c.level === 'fail').length,
      warn: allChecks.filter((c) => c.level === 'warn').length,
    },
  };

  return {
    summary,
    agents: ordered,
    models: [...modelMap.values()].sort((a, b) => b.tokens.total - a.tokens.total),
    agentTypes: [...typeMap.values()].sort((a, b) => b.tokens.total - a.tokens.total),
    sessionChecks: sChecks,
  };
}

export function allSpecs(): SessionSpec[] {
  return SESSIONS;
}

export const DEFAULT_MOCK_PRESET: Preset = {
  version: 1,
  main: { model: 'opus', effort: 'xhigh', autoCompactWindow: 500_000 },
  advisor: { model: OPUS },
  agents: [
    { name: 'code-reviewer', model: 'sonnet', effort: 'high', note: '只读审查，不改代码' },
    // 用完整 ID：一致性检查结果不变，但"应用到 Claude Code"时会去改只读的 test-runner.md，用来演示部分失败
    { name: 'test-runner', model: 'claude-haiku-4-5', effort: 'medium' },
    // 往下派发时指定 haiku：researcher.md 里还没有派发块，生效检查里这一项是"还没写入"
    { name: 'researcher', model: OPUS, effort: 'high', note: '需要读长文档', dispatchModel: 'haiku' },
    { name: 'doc-writer', model: 'fable', effort: null },
  ],
  allowBuiltins: true,
  updatedAt: '2026-09-27T10:12:00.000Z',
};

export const MODELS = { OPUS, OPUS_1M, OPUS_OLD, SONNET, HAIKU, FABLE };
