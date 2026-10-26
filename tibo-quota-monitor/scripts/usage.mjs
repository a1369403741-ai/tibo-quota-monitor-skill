import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const FIELDS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const unavailable = reason => ({ available: false, reason, note: '不使用账号额度百分比推算单轮 Token，也不把不可读取记为零。' });
export function summarizeUsageEvents(events) {
  let latest = null, baseline = null, current = null, completed = false, observedAt = null;
  for (const event of events) {
    const p = event.payload || {};
    if (event.type === 'event_msg' && p.type === 'task_started') {
      current = p.turn_id || p.turn_attribution?.turn_id;
      baseline = latest; completed = false;
    } else if (event.type === 'turn_context' && p.turn_id && p.turn_id !== current) {
      current = p.turn_id; baseline = latest; completed = false;
    } else if (event.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      latest = p.info.total_token_usage; observedAt = event.timestamp;
    } else if (event.type === 'event_msg' && ['task_complete', 'task_completed'].includes(p.type)
      && (!p.turn_id || p.turn_id === current)) completed = true;
  }
  if (!current || !latest || latest === baseline) return unavailable('当前轮次尚无可读取的 Token 计数。');
  if (!baseline) return unavailable('缺少本轮开始前的累计计数，无法可靠分离单轮消耗。');
  const usage = {};
  for (const field of FIELDS) {
    if (!Number.isSafeInteger(latest[field]) || !Number.isSafeInteger(baseline[field])
      || latest[field] < baseline[field]) return unavailable('Token 计数缺失、重置或不连续，无法可靠计算。');
    usage[field] = latest[field] - baseline[field];
  }
  if (usage.cached_input_tokens > usage.input_tokens || usage.reasoning_output_tokens > usage.output_tokens)
    return unavailable('缓存或推理计数不符合包含关系，停止计算。');
  return { available: true, source: 'local_codex_token_count', turnId: current,
    observedAt, complete: completed, scope: completed ? 'completed_turn' : 'current_turn_so_far',
    ...usage, uncached_input_tokens: usage.input_tokens - usage.cached_input_tokens,
    note: '缓存输入包含在输入中，推理输出包含在输出中，不重复相加。运行中统计不包含本次统计调用之后的操作和最终汇报；Token 数不直接等于套餐额度扣减百分比。' };
}
export async function readThreadUsage(threadId, { sessionsRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions') } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId || ''))
    return unavailable('需要宿主提供当前聊天的有效 ID。');
  try {
    const matches = fs.readdirSync(sessionsRoot, { recursive: true, withFileTypes: true })
      .filter(p => p.isFile() && p.name.endsWith(`-${threadId}.jsonl`))
      .map(p => path.join(p.parentPath || p.path, p.name));
    if (matches.length !== 1) return unavailable('找不到当前聊天唯一的本地运行记录。');
    const events = []; let verified = false;
    const lines = readline.createInterface({ input: fs.createReadStream(matches[0]), crlfDelay: Infinity });
    for await (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'session_meta') {
        if (event.payload?.id !== threadId) { lines.close(); return unavailable('运行记录不属于当前聊天。'); }
        verified = true;
      }
      if (event.type === 'turn_context') events.push({ type: event.type, payload: { turn_id: event.payload?.turn_id } });
      if (event.type === 'event_msg' && ['task_started', 'task_complete', 'task_completed', 'token_count'].includes(event.payload?.type))
        events.push({ type: event.type, timestamp: event.timestamp, payload: event.payload });
    }
    return verified ? summarizeUsageEvents(events) : unavailable('无法验证运行记录的聊天身份。');
  } catch { return unavailable('宿主没有开放本地用量记录或文件访问受限。'); }
}
