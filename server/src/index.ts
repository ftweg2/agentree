// agentree 后端入口。只绑定 127.0.0.1。
import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Analyzer } from './aggregate.ts';
import { createApp } from './app.ts';
import { agentreeHome, claudeConfigDirs, FULL_SCAN_MS, HOST, port } from './config.ts';
import { Store } from './db.ts';
import { Desktop } from './desktop.ts';
import { Indexer } from './indexer.ts';
import { PresetStore } from './preset.ts';
import { Pricing } from './pricing.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const distDir = path.resolve(here, '..', '..', 'web', 'dist');
const staticDir = production && existsSync(distDir) ? distDir : null;

const store = new Store();
const indexer = new Indexer(store);
const pricing = new Pricing();
pricing.load();
const desktop = new Desktop();
const presets = new PresetStore();
const analyzer = new Analyzer(store, indexer, pricing, desktop, presets);
const app = createApp({ analyzer, indexer, presets, store, desktop, staticDir });

const server = serve({ fetch: app.fetch, hostname: HOST, port: port() }, (info) => {
  console.log(`[agentree] 监听 http://${HOST}:${info.port}`);
  console.log(`[agentree] 日志目录：${claudeConfigDirs().join(', ')}`);
  console.log(`[agentree] 数据目录：${agentreeHome()}`);
  console.log(staticDir ? `[agentree] 托管前端：${staticDir}` : '[agentree] 未托管前端（开发模式或 web/dist 不存在）');
});

indexer.onFullScanDone = (ms) => {
  const s = indexer.status;
  console.log(`[agentree] 启动扫描完成：${s.filesTotal} 个文件，耗时 ${Math.round(ms)} ms，跳过坏行 ${s.skippedLines}`);
};
void desktop.refresh();
indexer.start();
void pricing.refresh();
const desktopTimer = setInterval(() => void desktop.refresh(), FULL_SCAN_MS);
const pricingTimer = setInterval(() => void pricing.refresh(), 3600_000);

function shutdown() {
  indexer.stop();
  clearInterval(desktopTimer);
  clearInterval(pricingTimer);
  server.close();
  try {
    store.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
