#!/usr/bin/env node
import fs from 'node:fs';
import {
  DEFAULT_CONFIG, POLICY, defaultHome, initialize, status, collect, applyDecisions,
  testNotification, activate, pause, sendPending, retryNotification, recoverLock,
  requestJson, safeError, MonitorError, normalizePost,
  prepareTextConfiguration, configureFromText,
  requestUsageReport,
} from './core.mjs';
import { startConfiguration } from './configure.mjs';
import { readThreadUsage } from './usage.mjs';

const help = {
  name: 'tibo-quota-monitor', runtime: 'Node.js 20+ and curl; no npm packages',
  commands: {
    init: '创建仓库外私人目录；默认暂停',
    configure: '打开仅本机可访问的飞书凭据配置页，10 分钟后关闭',
    'prepare-file': '创建仓库外私人配置文本文档；不覆盖已填写内容',
    'import-file': '校验已保存的私人文本文档，导入配置并删除临时文档',
    status: '显示脱敏状态，不显示 Webhook 或签名密钥',
    probe: '只读检查数据源当前可达性，不表示长期稳定性',
    collect: '抓取并返回待判断批次；失败不会推进检查位置',
    'apply --stdin': '从标准输入读取本轮 JSON 判断，校验证据并入通知队列',
    send: '仅在已启用且已授权时发送待通知消息',
    'test-notification': '向已授权机器人发送一条明确标识的连接测试',
    'activate --schedule-id ID': '采集及通知测试通过后由调度安装器启用；不要单独用它冒充后台已安装',
    pause: '暂停本地发送；还需停止实际调度器',
    'retry-notification --id ID': '用户确认后重新排队指定失败或送达不明通知',
    'recover-lock': '仅恢复所有者进程已退出的旧锁',
    'request-usage-report': '请求下一轮监控结束时报告 Token 用量一次',
    'usage --thread-id ID': '只读取当前聊天的计数事件，返回截至统计时的单轮 Token 增量',
    'ack-usage-report': '结束本次用量报告请求，后续无消息时恢复安静',
  },
  defaults: DEFAULT_CONFIG, policy: POLICY,
  note: '这是基础采集与通知 CLI。独立 DeepSeek 后台模式使用 scripts/background.mjs；不需要 Codex 定时任务。',
};
const args = process.argv.slice(2);
const command = args.shift() || 'help';
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const home = defaultHome();
const print = value => console.log(JSON.stringify(value, null, 2));
try {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new MonitorError('NODE_VERSION', '需要 Node.js 20 或更新版本。');
  switch (command) {
    case 'help': case '--help': print(help); break;
    case 'init': print(await initialize(home)); break;
    case 'configure': {
      const setup = await startConfiguration(home);
      print({ setupUrl: setup.url, expiresInMinutes: 10, instruction: '请用户在本机浏览器填写；不要在聊天中粘贴凭据。' });
      break;
    }
    case 'prepare-file': print(await prepareTextConfiguration(home)); break;
    case 'import-file': print(await configureFromText(home)); break;
    case 'status': print(status(home)); break;
    case 'probe': {
      const started = Date.now();
      const url = 'https://api.fxtwitter.com/2/profile/thsottiaux/statuses?count=20&with_replies=1';
      const response = await requestJson(url);
      if (response.status !== 200 || response.data?.code !== 200 || !Array.isArray(response.data?.results))
        throw new MonitorError('SOURCE_UNAVAILABLE', `数据源返回 HTTP ${response.status} 或结构异常。`);
      const posts = response.data.results.filter(p => p.type !== 'tombstone').map(normalizePost);
      print({ ok: true, checkedAt: new Date().toISOString(), endpoint: url, durationMs: Date.now() - started,
        count: posts.length, authorPosts: posts.filter(p => p.author === 'thsottiaux').length,
        latestPublishedAt: posts.map(p => p.publishedAt).sort().at(-1) || null,
        note: '仅代表本次、当前运行环境可达；不是云端稳定性证明。' });
      break;
    }
    case 'collect': print(await collect(home)); break;
    case 'apply': {
      if (!args.includes('--stdin')) throw new MonitorError('ARGUMENT_REQUIRED', 'apply 必须通过 --stdin 提交 JSON。');
      const raw = fs.readFileSync(0, 'utf8');
      if (Buffer.byteLength(raw) > 100_000) throw new MonitorError('INPUT_TOO_LARGE', '判断输入过大。');
      let input;
      try { input = JSON.parse(raw); } catch { throw new MonitorError('INVALID_DECISIONS', '判断结果不是有效 JSON。'); }
      print(await applyDecisions(home, input)); break;
    }
    case 'send': print(await sendPending(home)); break;
    case 'test-notification': print(await testNotification(home)); break;
    case 'activate': print(await activate(home, option('--schedule-id'))); break;
    case 'pause': print(await pause(home)); break;
    case 'retry-notification': print(await retryNotification(home, option('--id'))); break;
    case 'recover-lock': print(recoverLock(home)); break;
    case 'request-usage-report': print(await requestUsageReport(home)); break;
    case 'usage': print(await readThreadUsage(option('--thread-id') || process.env.CODEX_THREAD_ID)); break;
    case 'ack-usage-report': print(await requestUsageReport(home, false)); break;
    default: throw new MonitorError('UNKNOWN_COMMAND', '未知命令；运行 help 查看。');
  }
} catch (error) { print({ ok: false, error: safeError(error) }); process.exitCode = 1; }

