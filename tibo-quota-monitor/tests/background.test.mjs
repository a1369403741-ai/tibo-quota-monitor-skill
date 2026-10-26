import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialize, configure, collect, activate, testNotification, load, readJson, writeJson, requestJson } from '../scripts/core.mjs';
import { analyze, modelStatus, modelState, monthKey, importModelFile, prepareModelFile, BUDGET_CNY, prepareSetup, importSetup } from '../scripts/deepseek.mjs';
import { runOnce, runnerLock, launchAgentXml, proxyEnvironment, checkModel, setup } from '../scripts/background.mjs';

const NOW = Date.parse('2026-10-26T10:30:00Z');
const KEY = 'test-only-not-a-real-deepseek-key';
const success = async () => ({ status: 200, data: { code: 0 } });
const timeline = (texts = []) => ({ status: 200, data: { code: 200, results: texts.map((text, i) => ({
  id: String(100 + i), text, created_timestamp: NOW / 1000 - 60 + i, author: { screen_name: 'thsottiaux' },
})) } });
function homeFor(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tibo-background-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
async function ready(t) {
  const home = homeFor(t);
  await initialize(home);
  await configure(home, { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only-not-real', notificationAuthorized: true });
  await testNotification(home, { request: success, now: NOW });
  await collect(home, { request: async () => timeline(), now: NOW - 3600_000 });
  await activate(home, 'test-background');
  writeJson(path.join(home, 'deepseek.json'), { apiKey: KEY });
  return home;
}
function responseFor(options, { badEvidence = false, kinds } = {}) {
  const input = JSON.parse(options.body.messages[1].content);
  return { status: 200, data: { usage: { prompt_tokens: 3000, prompt_cache_hit_tokens: 500, completion_tokens: 500 },
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ batchId: input.batchId, policy: input.policy,
      decisions: input.posts.map((p, i) => ({ postId: p.id, kind: kinds?.[i] || 'quota_reset', confidence: 0.95,
        title: '额度重置', summary: 'Codex 额度重置', reason: '原文依据', evidence: [{ postId: p.id, quote: badEvidence ? 'invented quote' : p.text }],
        confirms: null, duplicateOf: null })) }) } }] } };
}

test('private key import is non-echoing and rejects symlinks', async t => {
  const home = await ready(t);
  const { file } = await prepareModelFile(home);
  fs.writeFileSync(file, `DEEPSEEK_API_KEY=${KEY}\n`);
  const result = await importModelFile(home);
  assert.equal(fs.existsSync(file), false);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(modelStatus(home)).includes(KEY), false);
  assert.equal(fs.statSync(path.join(home, 'deepseek.json')).mode & 0o777, 0o600);
  fs.symlinkSync(path.join(home, 'deepseek.json'), file);
  await assert.rejects(importModelFile(home), { code: 'INVALID_MODEL_FILE' });
});

test('no new posts means zero model calls, and pause means zero network calls', async t => {
  const home = await ready(t);
  let calls = 0;
  const first = await runOnce(home, { now: NOW, sourceRequest: async () => timeline(), modelRequest: async () => { calls++; } });
  assert.equal(first.ok, true); assert.equal(calls, 0); assert.equal(first.usage.total, 0);
  const { config } = load(home); config.enabled = false; writeJson(path.join(home, 'config.json'), config);
  const second = await runOnce(home, { sourceRequest: async () => { throw Error('must not run'); } });
  assert.equal(second.skipped, 'paused');
});

test('independent runner validates, sends once, records usage and deduplicates after restart', async t => {
  const home = await ready(t);
  let modelCalls = 0, notifications = 0;
  const options = { now: NOW, sourceRequest: async () => timeline(['Codex usage limits have been reset.']),
    modelRequest: async (url, options) => {
      modelCalls++;
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(options.apiKey, KEY);
      assert.equal(JSON.stringify(options.body).includes(KEY), false);
      assert.equal(JSON.stringify(options.body).includes('webhook'), false);
      assert.equal(options.body.thinking.type, 'disabled');
      assert.equal(options.body.tools, undefined);
      return responseFor(options);
    }, notificationRequest: async () => { notifications++; return success(); } };
  const first = await runOnce(home, options);
  assert.equal(first.ok, true); assert.equal(first.sent, 1); assert.equal(first.usage.input, 3000);
  assert.equal(first.usage.cachedInput, 500); assert.equal(first.usage.output, 500); assert.equal(first.usage.total, 3500);
  assert.ok(Math.abs(first.usage.accountedUpperCny - 0.00902) < 1e-9);
  const second = await runOnce(home, options);
  assert.equal(second.ok, true); assert.equal(modelCalls, 1); assert.equal(notifications, 1);
});

test('invalid model evidence never produces a quota alert, retries cap at three', async t => {
  const home = await ready(t);
  let modelCalls = 0, healthNotices = 0;
  const options = { now: NOW, sourceRequest: async () => timeline(['Codex usage limits reset.']),
    modelRequest: async (url, options) => { modelCalls++; return responseFor(options, { badEvidence: true }); },
    notificationRequest: async (url, options) => { assert.match(options.body.content.text, /运行故障提醒/); healthNotices++; return success(); } };
  for (let i = 0; i < 4; i++) assert.equal((await runOnce(home, options)).ok, false);
  assert.equal(modelCalls, 3); assert.equal(Object.keys(load(home).state.decisions).length, 0);
  assert.ok(load(home).state.pending); assert.ok(healthNotices <= 2);
});

test('budget guard stops paid requests but retains pending data and rolls over next month', async t => {
  const home = await ready(t);
  const state = modelState(home);
  state.months[monthKey(NOW)] = { accountedUpperCny: BUDGET_CNY };
  writeJson(path.join(home, 'model-state.json'), state);
  let calls = 0;
  const options = { now: NOW, sourceRequest: async () => timeline(['Codex usage limits reset.']),
    modelRequest: async (url, options) => { calls++; return responseFor(options); }, notificationRequest: success };
  const blocked = await runOnce(home, options);
  assert.equal(blocked.error.code, 'MODEL_BUDGET_LIMIT'); assert.equal(calls, 0); assert.ok(load(home).state.pending);
  const resumed = await runOnce(home, { ...options, now: Date.parse('2026-11-01T02:00:00Z') });
  assert.equal(resumed.ok, true); assert.equal(calls, 1);
});

test('unknown model charge is reserved and a completed response is reused after interruption', async t => {
  const home = await ready(t);
  const batch = await collect(home, { now: NOW, request: async () => timeline(['Codex usage limits reset.']) });
  await assert.rejects(analyze(home, batch, { now: NOW, request: async () => { throw Error('network failed'); } }));
  assert.equal(modelStatus(home, NOW).usage.unresolvedCalls, 1);
  assert.ok(modelStatus(home, NOW).usage.accountedUpperCny > 0);
  let calls = 0;
  const options = { now: NOW, request: async (url, options) => { calls++; return responseFor(options); } };
  const result = await analyze(home, batch, options);
  assert.deepEqual(await analyze(home, batch, options), result); assert.equal(calls, 1);
});

test('source failure is persisted as failure and never called no-new-posts', async t => {
  const home = await ready(t);
  const before = load(home).state.lastFetchAt;
  const result = await runOnce(home, { now: NOW, sourceRequest: async () => ({ status: 502, data: null }), notificationRequest: success });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'SOURCE_UNAVAILABLE');
  assert.equal(load(home).state.lastFetchAt, before);
  assert.equal(readJson(path.join(home, 'background-status.json')).ok, false);
});

test('one runner owns the pipeline and model credentials cannot be sent to another endpoint', async t => {
  const home = await ready(t);
  await runnerLock(home, async () => { await assert.rejects(runnerLock(home, async () => {}), { code: 'BUSY' }); });
  for (const url of ['https://api.deepseek.com/other', 'https://example.com/chat/completions',
    'https://open.feishu.cn/open-apis/bot/v2/hook/test-only-not-real'])
    await assert.rejects(requestJson(url, { method: 'POST', apiKey: KEY }), { code: 'NETWORK_DESTINATION_BLOCKED' });
});

test('launchd configuration uses absolute runtime paths, no Codex or credentials, and no restart loop', () => {
  const xml = launchAgentXml('/private/example', '/usr/local/bin/node', '/skill/background.mjs', { HTTPS_PROXY: 'http://127.0.0.1:7890' });
  assert.match(xml, /<integer>15<\/integer>/); assert.match(xml, /RunAtLoad/);
  assert.doesNotMatch(xml, /KeepAlive|DEEPSEEK_API_KEY|CODEX_THREAD|codex exec/);
  assert.match(xml, /http:\/\/127.0.0.1:7890/);
  assert.throws(() => proxyEnvironment({ HTTPS_PROXY: 'http://user:secret@127.0.0.1:7890' }), { code: 'UNSUPPORTED_PROXY' });
});

test('model self-check validates four semantic cases without live notifications', async t => {
  const home = await ready(t);
  const result = await checkModel(home, { request: async (url, options) => responseFor(options,
    { kinds: ['quota_reset', 'quota_announcement', 'ordinary', 'ordinary'] }) });
  assert.equal(result.ok, true); assert.ok(modelStatus(home).verifiedAt);
});

test('a failed recheck revokes a prior model verification', async t => {
  const home = await ready(t);
  await checkModel(home, { request: async (url, options) => responseFor(options,
    { kinds: ['quota_reset', 'quota_announcement', 'ordinary', 'ordinary'] }) });
  assert.ok(modelStatus(home).verifiedAt);
  await assert.rejects(checkModel(home, { request: async (url, options) => responseFor(options,
    { kinds: ['ordinary', 'ordinary', 'ordinary', 'ordinary'] }) }), { code: 'MODEL_CHECK_FAILED' });
  assert.equal(modelStatus(home).verifiedAt, null);
});

test('standalone CLI starts with no Codex environment and respects persistent pause', async t => {
  const home = homeFor(t);
  await initialize(home);
  const result = spawnSync(process.execPath,
    [fileURLToPath(new URL('../scripts/background.mjs', import.meta.url)), 'run'], {
      env: { PATH: '/usr/bin:/bin', TIBO_MONITOR_HOME: home }, encoding: 'utf8', timeout: 10_000,
    });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { skipped: 'paused' });
  assert.equal(fs.existsSync(path.join(home, 'model-state.json')), false);
});

test('new users supply exactly two fields and setup verifies all services before starting', async t => {
  const home = homeFor(t);
  const prepared = await prepareSetup(home);
  const fields = fs.readFileSync(prepared.file, 'utf8').split('\n').filter(line => line && !line.startsWith('#'));
  assert.deepEqual(fields, ['DEEPSEEK_API_KEY=', 'FEISHU_WEBHOOK_URL=']);
  fs.writeFileSync(prepared.file, `DEEPSEEK_API_KEY=${KEY}\nFEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/test-only-not-real\n`);
  const order = [];
  const result = await setup(home, {
    modelRequest: async (url, options) => { order.push('model'); return responseFor(options,
      { kinds: ['quota_reset', 'quota_announcement', 'ordinary', 'ordinary'] }); },
    sourceRequest: async () => { order.push('source'); return timeline(); },
    notificationRequest: async () => { order.push('notification'); return success(); },
    start: async () => { order.push('start'); assert.ok(modelStatus(home).verifiedAt);
      assert.ok(load(home).state.notificationTestAt); assert.ok(load(home).state.lastFetchAt); return { installed: true }; },
  });
  assert.equal(result.installed, true);
  assert.deepEqual(order, ['model', 'source', 'notification', 'start']);
  assert.equal(fs.existsSync(prepared.file), false);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(load(home).config.notificationAuthorized, true);
});

test('invalid combined setup cannot partially replace credentials or enable monitoring', async t => {
  const home = await ready(t);
  const previous = fs.readFileSync(path.join(home, 'deepseek.json'), 'utf8');
  const { file } = await prepareSetup(home);
  fs.writeFileSync(file, `DEEPSEEK_API_KEY=${KEY}\nFEISHU_WEBHOOK_URL=https://example.com/hook\n`);
  await assert.rejects(importSetup(home), { code: 'INVALID_WEBHOOK' });
  assert.equal(fs.readFileSync(path.join(home, 'deepseek.json'), 'utf8'), previous);
  fs.writeFileSync(file, `DEEPSEEK_API_KEY=${KEY}\nDEEPSEEK_API_KEY=${KEY}\nFEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/test-only-not-real\n`);
  await assert.rejects(importSetup(home), { code: 'INVALID_SETUP_FILE' });
});

test('failed initial model check never sends notifications or starts a background service', async t => {
  const home = homeFor(t);
  const { file } = await prepareSetup(home);
  fs.writeFileSync(file, `DEEPSEEK_API_KEY=${KEY}\nFEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/test-only-not-real\n`);
  let started = false, sent = false;
  await assert.rejects(setup(home, { modelRequest: async () => ({ status: 401, data: {} }),
    notificationRequest: async () => { sent = true; return success(); }, start: async () => { started = true; } }),
  { code: 'MODEL_REJECTED' });
  assert.equal(started, false); assert.equal(sent, false); assert.equal(load(home).config.enabled, false);
});
