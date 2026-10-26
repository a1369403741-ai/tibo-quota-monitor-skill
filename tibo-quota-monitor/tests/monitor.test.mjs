import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT, POLICY, SKILL_DIR, MonitorError, initialize, configure, load, status,
  writeJson, ensureHome, validateCredentials, requestJson, fetchTimeline,
  collect, applyDecisions, testNotification, activate, pause, sendPending,
  retryNotification, withLock, recoverLock, safeError,
  prepareTextConfiguration, configureFromText,
  messageFor, requestUsageReport,
} from '../scripts/core.mjs';
import { startConfiguration } from '../scripts/configure.mjs';
import { summarizeUsageEvents, readThreadUsage } from '../scripts/usage.mjs';

const NOW = Date.parse('2026-10-26T08:00:00Z');
const FAKE_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only-not-a-real-bot';
const credentials = { webhookUrl: FAKE_WEBHOOK, signingSecret: 'test-only-signing-value', notificationAuthorized: true };
function homeFor(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tibo-skill-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const raw = (id = '100', text = 'Codex limits have been reset.', secondsAgo = 60, extra = {}) => ({
  type: 'status', id, text, created_timestamp: NOW / 1000 - secondsAgo,
  author: { screen_name: ACCOUNT }, ...extra,
});
const response = (posts, cursor = null) => ({ status: 200, data: { code: 200, results: posts, cursor: { bottom: cursor } } });
const success = async () => ({ status: 200, data: { code: 0 } });
const classify = (batch, options = {}) => ({ batchId: batch.batch.id, policy: POLICY,
  decisions: batch.posts.map(p => ({ postId: p.id, kind: 'quota_reset', confidence: 0.95,
    title: 'Codex 额度重置', summary: 'Tibo 宣布 Codex 额度已重置。', reason: '原文明确说明重置已经发生。',
    evidence: [{ postId: p.id, quote: p.text }], confirms: null, duplicateOf: null, ...options })) });
async function seed(t, posts = [raw()]) {
  const home = homeFor(t);
  await initialize(home);
  const batch = await collect(home, { now: NOW, request: async () => response(posts) });
  return { home, batch };
}
async function enabled(t, posts = [raw()]) {
  const value = await seed(t, posts);
  await configure(value.home, credentials);
  await testNotification(value.home, { request: success, now: NOW });
  await activate(value.home, 'test-schedule-id');
  return value;
}

test('initialization is paused, private, repeatable, and status does not expose credentials', async t => {
  const home = homeFor(t);
  const first = await initialize(home);
  assert.equal(first.config.enabled, false);
  await configure(home, credentials);
  const before = fs.readFileSync(path.join(home, 'credentials.json'), 'utf8');
  await initialize(home);
  assert.equal(fs.readFileSync(path.join(home, 'credentials.json'), 'utf8'), before);
  assert.equal(JSON.stringify(status(home)).includes('test-only-signing-value'), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, 'credentials.json')).mode & 0o777, 0o600);
  }
});

test('private files cannot be placed in a skill or Git repository, or reached through a symlink', t => {
  const home = homeFor(t);
  assert.throws(() => ensureHome(path.join(SKILL_DIR, 'runtime')), { code: 'UNSAFE_HOME' });
  fs.mkdirSync(path.join(home, '.git'));
  assert.throws(() => ensureHome(path.join(home, 'data')), { code: 'UNSAFE_HOME' });
  fs.rmdirSync(path.join(home, '.git'));
  fs.symlinkSync(home, path.join(home, 'alias'));
  assert.throws(() => ensureHome(path.join(home, 'alias', 'data')), { code: 'UNSAFE_HOME' });
});

test('unsafe notification endpoints are rejected before any request', async () => {
  for (const webhookUrl of ['http://open.feishu.cn/open-apis/bot/v2/hook/12345678',
    FAKE_WEBHOOK + '?redirect=https://example.com', FAKE_WEBHOOK.replace('open.feishu.cn', 'example.com'),
    FAKE_WEBHOOK.replace('https://', 'https://user:password@')]) {
    assert.throws(() => validateCredentials({ webhookUrl }), { code: 'INVALID_WEBHOOK' });
  }
  await assert.rejects(requestJson('https://example.com/'), { code: 'NETWORK_DESTINATION_BLOCKED' });
  await assert.rejects(requestJson(FAKE_WEBHOOK), { code: 'NETWORK_DESTINATION_BLOCKED' });
  assert.equal(JSON.stringify(safeError(new Error(FAKE_WEBHOOK))).includes(FAKE_WEBHOOK), false);
});

test('timeline includes author replies, excludes other authors, and ignores tombstones', async () => {
  let called;
  const result = await fetchTimeline({ since: NOW - 3600_000, now: NOW, request: async url => {
    called = new URL(url);
    return response([raw('100', 'Reset.', 90, { replying_to: 'another_user', replying_to_status: '99' }),
      raw('101', 'Other author.', 80, { author: { screen_name: 'other' } }), { type: 'tombstone' }]);
  } });
  assert.equal(called.searchParams.get('with_replies'), '1');
  assert.deepEqual(result.posts.map(p => p.id), ['100']);
  assert.equal(result.posts[0].replyTo.id, '99');
});

test('pinned old posts do not stop pagination before recent posts are covered', async () => {
  let calls = 0;
  const result = await fetchTimeline({ since: NOW - 3600_000, now: NOW, request: async url => {
    calls++;
    if (calls === 1) return response([raw('1', 'Pinned old.', 90000), raw('2', 'New.', 60)], 'cursor-two');
    assert.equal(new URL(url).searchParams.get('cursor'), 'cursor-two');
    return response([raw('3', 'Older but in window.', 1800), raw('4', 'Outside.', 7200)]);
  } });
  assert.equal(calls, 2);
  assert.deepEqual(result.posts.map(p => p.id), ['3', '2']);
});

test('older author context and reply parents support analysis without becoming new alerts', async t => {
  const home = homeFor(t);
  await initialize(home);
  const batch = await collect(home, { now: NOW, request: async () => response([
    raw('100', 'Codex quotas reset today.', 9000),
    raw('101', 'Will Codex quotas reset?', 120, { author: { screen_name: 'reader' } }),
    raw('102', 'Yes, reset now.', 60, { replying_to: 'reader', replying_to_status: '101' }),
  ]) });
  assert.deepEqual(batch.posts.map(p => p.id), ['102']);
  assert.deepEqual(new Set(batch.context.map(p => p.id)), new Set(['100', '101']));
  const input = classify(batch);
  input.decisions[0].evidence.push({ postId: '101', quote: 'Will Codex quotas reset?' });
  assert.equal((await applyDecisions(home, input, { now: NOW })).queued, 1);
  assert.deepEqual(Object.keys(load(home).state.decisions), ['102']);
});

test('repeated cursors and page limits fail closed instead of claiming complete coverage', async () => {
  await assert.rejects(fetchTimeline({ since: NOW - 3600_000, now: NOW,
    request: async () => response([raw()], 'repeating') }), { code: 'COVERAGE_INCOMPLETE' });
  await assert.rejects(fetchTimeline({ since: NOW - 3600_000, now: NOW, maxPages: 1,
    request: async () => response([raw()], 'next') }), { code: 'COVERAGE_INCOMPLETE' });
});

test('source failures and schema changes do not advance the last successful check', async t => {
  const home = homeFor(t);
  await initialize(home);
  await collect(home, { now: NOW, request: async () => response([]) });
  const before = status(home).lastFetchAt;
  await assert.rejects(collect(home, { now: NOW + 3600_000,
    request: async () => ({ status: 200, data: { code: 500, results: [] } }) }), { code: 'SOURCE_UNAVAILABLE' });
  assert.equal(status(home).lastFetchAt, before);
  await assert.rejects(collect(home, { now: NOW + 3600_000,
    request: async () => response([{ unexpected: true }]) }), { code: 'SOURCE_SCHEMA_CHANGED' });
  assert.equal(status(home).lastFetchAt, before);
  assert.equal(status(home).consecutiveFailures, 2);
});

test('pending batches survive a restart, and processed identical posts do not need reanalysis', async t => {
  const { home, batch } = await seed(t);
  let requests = 0;
  const pending = await collect(home, { now: NOW, request: async () => { requests++; throw Error('must not fetch'); } });
  assert.equal(pending.batch.id, batch.batch.id);
  assert.equal(requests, 0);
  await applyDecisions(home, classify(batch, { kind: 'ordinary', title: '', summary: '' }), { now: NOW });
  const repeat = await collect(home, { now: NOW + 60_000, request: async () => response([raw()]) });
  assert.equal(repeat.status, 'no_new_posts');
  assert.deepEqual(status(home).notifications, {});
});

test('invalid evidence rejects the whole batch without partial decisions or notifications', async t => {
  const { home, batch } = await seed(t, [raw('100', 'Reset.', 120), raw('101', 'Reset now.', 60)]);
  const input = classify(batch);
  input.decisions[1].evidence[0].quote = 'Invented text';
  await assert.rejects(applyDecisions(home, input, { now: NOW }), { code: 'INVALID_EVIDENCE' });
  assert.deepEqual(load(home).state.decisions, {});
  assert.deepEqual(load(home).state.outbox, {});
  assert.equal(status(home).pendingBatchId, batch.batch.id);
});

test('future context, unrelated duplicate relations, and stale batches are rejected', async t => {
  const { home, batch } = await seed(t, [raw('100', 'Soon.', 120), raw('101', 'Reset now.', 60)]);
  const input = classify(batch);
  input.decisions[0].evidence.push({ postId: '101', quote: 'Reset now.' });
  await assert.rejects(applyDecisions(home, input, { now: NOW }), { code: 'INVALID_EVIDENCE' });
  const unrelated = classify(batch);
  unrelated.decisions[1].duplicateOf = '100';
  await assert.rejects(applyDecisions(home, unrelated, { now: NOW }), { code: 'INVALID_RELATION' });
  await assert.rejects(applyDecisions(home, { ...classify(batch), batchId: 'wrong' }), { code: 'STALE_BATCH' });
});

test('low confidence and disabled teasers stay in records without queuing notifications', async t => {
  const { home, batch } = await seed(t, [raw('100', 'Reset.', 120), raw('101', 'Quota reset soon.', 60)]);
  await configure(home, { ...credentials, includeTeasers: false });
  const input = classify(batch);
  input.decisions[0].confidence = 0.69;
  input.decisions[1].kind = 'quota_teaser';
  const result = await applyDecisions(home, input, { now: NOW });
  assert.equal(result.queued, 0);
  assert.equal(Object.keys(load(home).state.decisions).length, 2);
});

test('confirmation replaces an unsent teaser, and later duplicates do not notify again', async t => {
  const { home, batch } = await enabled(t, [raw('100', 'Codex quota reset soon.', 180), raw('101', 'Codex quota reset now.', 120), raw('102', 'Same Codex quota reset.', 60)]);
  const input = classify(batch);
  input.decisions[0].kind = 'quota_teaser';
  input.decisions[1].confirms = '100';
  input.decisions[1].evidence.push({ postId: '100', quote: 'Codex quota reset soon.' });
  input.decisions[2].duplicateOf = '101';
  input.decisions[2].evidence.push({ postId: '101', quote: 'Codex quota reset now.' });
  assert.equal((await applyDecisions(home, input, { now: NOW })).queued, 1);
  let calls = 0;
  const sent = await sendPending(home, { now: NOW, request: async (_url, options) => {
    calls++;
    assert.match(options.body.content.text, /先前预告已确认/);
    assert.equal(options.body.timestamp, String(NOW / 1000));
    assert.match(options.body.sign, /^[A-Za-z0-9+/]{43}=$/);
    return success();
  } });
  assert.equal(sent.sent, 1);
  await sendPending(home, { now: NOW, request: async () => { calls++; return success(); } });
  assert.equal(calls, 1);
});

test('configuration and pause prevent delivery; activation requires setup evidence', async t => {
  const { home, batch } = await seed(t);
  await applyDecisions(home, classify(batch), { now: NOW });
  let calls = 0;
  const request = async () => { calls++; return success(); };
  await assert.rejects(activate(home, 'schedule'), { code: 'SETUP_INCOMPLETE' });
  await sendPending(home, { now: NOW, request });
  await configure(home, credentials);
  await sendPending(home, { now: NOW, request });
  assert.equal(calls, 0);
  await testNotification(home, { now: NOW, request });
  await activate(home, 'schedule');
  await pause(home);
  await sendPending(home, { now: NOW, request });
  assert.equal(calls, 1);
});

test('unknown delivery result is held for explicit review, never automatically resent', async t => {
  const { home, batch } = await enabled(t);
  await applyDecisions(home, classify(batch), { now: NOW });
  let calls = 0;
  const request = async () => { calls++; throw new MonitorError('NETWORK_UNCERTAIN', 'network failed'); };
  const failed = await sendPending(home, { now: NOW, request });
  assert.equal(failed.attention.status, 'uncertain');
  await sendPending(home, { now: NOW + 3600_000, request });
  assert.equal(calls, 1);
  await retryNotification(home, failed.attention.id);
  assert.equal((await sendPending(home, { now: NOW + 3600_000, request: success })).sent, 1);
});

test('explicit Feishu rejection backs off and retries at most five times', async t => {
  const { home, batch } = await enabled(t);
  await applyDecisions(home, classify(batch), { now: NOW });
  let calls = 0;
  const request = async () => { calls++; return { status: 200, data: { code: 19024, msg: FAKE_WEBHOOK } }; };
  await sendPending(home, { now: NOW, request });
  await sendPending(home, { now: NOW + 1000, request });
  assert.equal(calls, 1);
  for (let i = 1; i < 7; i++) await sendPending(home, { now: NOW + i * 3600_000, request });
  assert.equal(calls, 5);
  assert.equal(status(home).attention.length, 1);
  assert.equal(fs.readFileSync(path.join(home, 'state.json'), 'utf8').includes(FAKE_WEBHOOK), false);
});

test('historical confirmed resets are delivered with original and current push times', async t => {
  const { home, batch } = await enabled(t);
  await applyDecisions(home, classify(batch), { now: NOW });
  let text;
  const sent = await sendPending(home, { now: NOW + 25 * 3600_000, request: async (_url, options) => {
    text = options.body.content.text; return success();
  } });
  assert.equal(sent.sent, 1);
  assert.match(text, /历史消息补发/);
  assert.match(text, /原文发布时间：2026\/10\/26 15:59:00/);
  assert.match(text, /本次推送时间：2026\/10\/27 17:00:00/);
  assert.match(text, /不代表现在再次重置/);
  assert.equal((await sendPending(home, { now: NOW + 26 * 3600_000, request: success })).sent, 0);
});

test('newly classified old resets and previously expired resets are recoverable, old teasers still expire', async t => {
  const { home, batch } = await enabled(t, [raw('100', 'Codex quota reset.', 120), raw('101', 'Quota reset soon.', 60)]);
  const input = classify(batch); input.decisions[1].kind = 'quota_teaser';
  await applyDecisions(home, input, { now: NOW + 25 * 3600_000 });
  assert.equal(status(home).notifications.pending, 1);
  assert.equal(status(home).notifications.expired, 1);
  const { state } = load(home);
  const reset = Object.values(state.outbox).find(d => d.postId === '100');
  reset.status = 'expired';
  writeJson(path.join(home, 'state.json'), state);
  assert.equal((await sendPending(home, { now: NOW + 26 * 3600_000, request: success })).sent, 1);
  assert.equal(status(home).notifications.expired, 1);
});

test('offline catchup crosses 72 hours and resumes pagination without advancing past unfinished history', async t => {
  const home = homeFor(t); await initialize(home);
  const { state } = load(home);
  state.lastFetchAt = new Date(NOW - 100 * 3600_000).toISOString();
  writeJson(path.join(home, 'state.json'), state);
  let page = 0;
  const first = await collect(home, { now: NOW, request: async () => {
    page++; return response([raw('100', 'Codex quota reset.', 90 * 3600)], `page-${page}`);
  } });
  assert.equal(first.posts[0].id, '100');
  assert.equal(first.catchup.cursor, 'page-5');
  assert.equal(status(home).lastFetchAt, state.lastFetchAt);
  await applyDecisions(home, classify(first), { now: NOW });
  const second = await collect(home, { now: NOW + 3600_000, request: async url => {
    assert.equal(new URL(url).searchParams.get('cursor'), 'page-5');
    return response([raw('99', 'Outside range.', 103 * 3600)], 'end');
  } });
  assert.equal(second.catchup, null);
  assert.equal(status(home).lastFetchAt, new Date(NOW).toISOString());
  assert.equal(status(home).gap, null);
});

test('fresh messages also include a separate push timestamp', () => {
  const text = messageFor({ post: { publishedAt: new Date(NOW - 60000).toISOString(), url: 'https://x.com/thsottiaux/status/100', id: '100' },
    decision: { kind: 'quota_reset', title: 'Reset', summary: 'Reset', reason: 'Explicit.' } }, 'Asia/Shanghai', NOW).content.text;
  assert.match(text, /本次推送时间：2026\/10\/26 16:00:00/);
  assert.doesNotMatch(text, /历史消息补发/);
});

test('concurrent operations are locked, and active locks cannot be recovered', async t => {
  const home = homeFor(t);
  await initialize(home);
  await withLock(home, async () => {
    await assert.rejects(initialize(home), { code: 'BUSY' });
    writeJson(path.join(home, '.lock', 'owner.json'), { pid: process.pid, startedAt: Date.now() - 120000 });
    assert.throws(() => recoverLock(home), { code: 'BUSY' });
  });
  assert.equal(fs.existsSync(path.join(home, '.lock')), false);
});

test('configuration form is loopback-only, rejects cross-origin posts, and never echoes secrets', async t => {
  const home = homeFor(t);
  const setup = await startConfiguration(home, { timeoutMs: 10000 });
  t.after(() => { setup.close(); setup.server.closeAllConnections(); });
  assert.equal(setup.server.address().address, '127.0.0.1');
  const page = await fetch(setup.url);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /type="password"/);
  const body = new URLSearchParams({ webhookUrl: FAKE_WEBHOOK, signingSecret: credentials.signingSecret, notificationAuthorized: 'yes' });
  const blocked = await fetch(setup.url, { method: 'POST', body, headers: { origin: 'https://evil.example' } });
  assert.equal(blocked.status, 403);
  assert.equal(fs.existsSync(path.join(home, 'credentials.json')), false);
  const saved = await fetch(setup.url, { method: 'POST', body, headers: { origin: new URL(setup.url).origin } });
  assert.equal(saved.status, 200);
  const html = await saved.text();
  assert.equal(html.includes(credentials.signingSecret), false);
  assert.equal(html.includes(FAKE_WEBHOOK), false);
  assert.equal(status(home).config.enabled, false);
  assert.equal(load(home).config.notificationAuthorized, true);
});

test('private text configuration imports only after explicit authorization and never echoes credentials', async t => {
  const home = homeFor(t);
  await initialize(home);
  const prepared = await prepareTextConfiguration(home);
  assert.equal(prepared.file, path.join(home, 'setup.txt'));
  assert.equal((await prepareTextConfiguration(home)).file, prepared.file);
  const draft = fs.readFileSync(prepared.file, 'utf8');
  assert.match(draft, /AUTHORIZE_NOTIFICATIONS=NO/);
  fs.writeFileSync(prepared.file, draft.replace('WEBHOOK_URL=', `WEBHOOK_URL=${FAKE_WEBHOOK}`)
    .replace('SIGNING_SECRET=', `SIGNING_SECRET=${credentials.signingSecret}`));
  await assert.rejects(configureFromText(home), { code: 'NOT_AUTHORIZED' });
  assert.equal(fs.existsSync(path.join(home, 'credentials.json')), false);
  fs.writeFileSync(prepared.file, fs.readFileSync(prepared.file, 'utf8').replace('AUTHORIZE_NOTIFICATIONS=NO', 'AUTHORIZE_NOTIFICATIONS=YES'));
  const result = await configureFromText(home);
  assert.equal(result.configured, true);
  assert.equal(JSON.stringify(result).includes(FAKE_WEBHOOK), false);
  assert.equal(fs.existsSync(prepared.file), false);
  assert.equal(status(home).configured, true);
  assert.equal(JSON.stringify(status(home)).includes(credentials.signingSecret), false);
  assert.equal(status(home).config.enabled, false);
});

test('next-run usage reporting is explicit, persistent, and one-shot', async t => {
  const home = homeFor(t); await initialize(home);
  assert.equal(status(home).config.reportNextUsage, false);
  await requestUsageReport(home);
  assert.equal(status(home).config.reportNextUsage, true);
  await requestUsageReport(home, false);
  assert.equal(status(home).config.reportNextUsage, false);
});

test('usage accounting uses this turn cumulative delta and does not double-count cached or reasoning tokens', () => {
  const count = (input, cached, output, reasoning) => ({ type: 'event_msg', timestamp: '2026-10-26T08:00:00Z', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output } } } });
  const result = summarizeUsageEvents([count(1000, 800, 100, 50),
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'current' } },
    { type: 'turn_context', payload: { turn_id: 'current' } },
    count(1400, 1100, 150, 70), count(2000, 1600, 200, 100)]);
  assert.equal(result.available, true);
  assert.equal(result.input_tokens, 1000);
  assert.equal(result.cached_input_tokens, 800);
  assert.equal(result.uncached_input_tokens, 200);
  assert.equal(result.output_tokens, 100);
  assert.equal(result.total_tokens, 1100);
  assert.equal(result.complete, false);
  assert.match(result.note, /最终汇报/);
});

test('missing usage data is unavailable, never fabricated as zero, and unrelated chats are not read', async t => {
  assert.equal(summarizeUsageEvents([]).available, false);
  const home = homeFor(t);
  fs.writeFileSync(path.join(home, 'other-thread.jsonl'), 'not a valid log');
  const result = await readThreadUsage('00000000-0000-0000-0000-000000000000', { sessionsRoot: home });
  assert.equal(result.available, false);
  assert.equal('total_tokens' in result, false);
});
