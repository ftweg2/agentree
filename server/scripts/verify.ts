// 用本机真实数据核对解析结果（只读日志；使用 ~/.agentree/agentree.db，需先运行过一次服务或 --index）。
// 用法：npx tsx scripts/verify.ts [--index] [sessionId ...]
import { Analyzer } from '../src/aggregate.ts';
import { Store } from '../src/db.ts';
import { Desktop } from '../src/desktop.ts';
import { discover, Indexer } from '../src/indexer.ts';
import { PresetStore } from '../src/preset.ts';
import { Pricing } from '../src/pricing.ts';

const args = process.argv.slice(2);
const store = new Store();
const indexer = new Indexer(store);
if (args.includes('--index')) {
  const t0 = performance.now();
  await indexer.fullScan();
  console.log(`增量扫描耗时 ${Math.round(performance.now() - t0)} ms`);
}
const pricing = new Pricing();
pricing.load();
const desktop = new Desktop();
await desktop.refresh();
const analyzer = new Analyzer(store, indexer, pricing, desktop, new PresetStore());

const { files, metas } = await discover();
console.log(`jsonl 文件 ${files.length} 个（主会话 ${files.filter((f) => f.agent === 'main').length}，子 agent ${files.filter((f) => f.agent !== 'main').length}），meta.json ${metas.length} 个`);

const links = analyzer.linkReport();
const byLink = { meta: 0, result: 0, fallback: 0, none: 0 } as Record<string, number>;
for (const l of links) byLink[l.link ?? 'none']++;
const metaSet = new Set(metas.map((m) => `${m.sessionId}/${m.agentId}`));
const withMeta = links.filter((l) => metaSet.has(`${l.sessionId}/${l.agentId}`));
console.log(`子 agent 节点 ${links.length} 个；关联方式：meta ${byLink.meta}，result ${byLink.result}，fallback ${byLink.fallback}`);
console.log(
  `有 meta.json 的 ${withMeta.length} 个中：父级是 main ${withMeta.filter((l) => l.parentId === 'main').length}，嵌套 ${withMeta.filter((l) => l.parentId !== 'main').length}`,
);
const metaDepth = new Map<string, number | null>();
for (const m of metas) {
  const row = store.getMeta(m.sessionId, m.agentId);
  metaDepth.set(`${m.sessionId}/${m.agentId}`, row?.spawnDepth ?? null);
}
const depthMismatch = withMeta.filter((l) => metaDepth.get(`${l.sessionId}/${l.agentId}`) !== l.depth);
console.log(`spawnDepth 与建树深度不一致：${depthMismatch.length}`);
for (const l of links.filter((x) => x.link !== 'meta')) {
  console.log(`  非 meta 关联：${l.sessionId} ${l.agentId} link=${l.link} parent=${l.parentId} depth=${l.depth}`);
}

let advisorCalls = 0;
for (const s of analyzer.sessions(100000)) advisorCalls += s.advisorCalls;
console.log(`全部会话 advisor 实际调用次数合计：${advisorCalls}`);

for (const sid of args.filter((a) => !a.startsWith('--'))) {
  const d = analyzer.sessionDetail(sid);
  if (!d) {
    console.log(`会话 ${sid} 不存在`);
    continue;
  }
  console.log(`\n会话 ${sid}：主会话请求 ${d.agents[0].requests}，子 agent ${d.summary.agentCount} 个，整个会话请求 ${d.summary.requests}`);
  for (const n of d.agents.slice(1)) {
    console.log(`  ${n.id} ${n.agentType} parent=${n.parentId} depth=${n.depth} requests=${n.requests} tokens=${n.tokens.total} status=${n.status}`);
  }
}
store.close();
