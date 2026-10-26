import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { configure, initialize, safeError } from './core.mjs';

const page = action => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tibo 额度监控配置</title>
<style>body{font:16px/1.7 system-ui,sans-serif;background:#f4f5f7;color:#16212b;margin:0;padding:40px 20px}main{max-width:560px;margin:auto;background:white;border:1px solid #e0e4e8;border-radius:16px;padding:32px}h1{font-size:25px;margin:0 0 8px}p{color:#536170}label{display:block;margin:20px 0 6px}input[type=password]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #aeb8c2;border-radius:8px;font:inherit}button{margin-top:24px;background:#2048be;color:white;border:0;border-radius:8px;padding:12px 20px;font:inherit;cursor:pointer}small{display:block;color:#647080}</style>
<main><h1>Tibo 额度监控</h1><p>绑定你自己的飞书群机器人。凭据只保存在这台电脑的私人配置目录，页面不会回显已保存的值。</p>
<form method="post" action="${action}" autocomplete="off">
<label for="webhook">飞书 Webhook</label><input id="webhook" type="password" name="webhookUrl" required maxlength="300" autocomplete="new-password" placeholder="粘贴飞书官方机器人 Webhook">
<label for="sign">签名密钥（可选）</label><input id="sign" type="password" name="signingSecret" maxlength="256" autocomplete="new-password"><small>仅在机器人开启“签名校验”时填写。若使用自定义关键词，请设为“Tibo额度提醒”。</small>
<label><input type="checkbox" name="includeTeasers" value="yes" checked> 接收有依据的疑似额度预告</label>
<label><input type="checkbox" name="notificationAuthorized" value="yes" required> 允许这个监控向上述机器人发送连接测试和额度提醒</label>
<button type="submit">保存私人配置</button><small>保存后回到 Codex，它会测试采集与通知，再创建定时任务。无需模型 API Key。</small>
</form></main></html>`;

export async function startConfiguration(home, { timeoutMs = 600_000 } = {}) {
  await initialize(home);
  const token = randomBytes(24).toString('hex');
  const pathname = `/configure/${token}`;
  let expectedHost = '', timer;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.headers.host !== expectedHost || request.url !== pathname) {
      response.writeHead(404); response.end('Not found'); return;
    }
    if (request.method === 'GET') { response.end(page(pathname)); return; }
    if (request.method !== 'POST' || request.headers.origin !== `http://${expectedHost}`
      || !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
      response.writeHead(403); response.end('请求来源不符'); return;
    }
    let body = '';
    try {
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) { response.writeHead(413); response.end('请求过大'); return; }
      }
      const form = new URLSearchParams(body);
      await configure(home, { webhookUrl: (form.get('webhookUrl') || '').trim(),
        signingSecret: (form.get('signingSecret') || '').trim(),
        includeTeasers: form.get('includeTeasers') === 'yes',
        notificationAuthorized: form.get('notificationAuthorized') === 'yes' });
      response.end('<!doctype html><meta charset="utf-8"><title>已保存</title><p>私人配置已保存，请关闭此页并回到 Codex 继续连接测试。监控尚未启动。</p>');
      clearTimeout(timer); server.close();
    } catch (error) {
      response.writeHead(400); response.end(`<!doctype html><meta charset="utf-8"><p>${safeError(error).message}</p><p>请返回上一页修改后重试。</p>`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  expectedHost = `127.0.0.1:${server.address().port}`;
  timer = setTimeout(() => server.close(), timeoutMs);
  return { server, url: `http://${expectedHost}${pathname}`, close: () => { clearTimeout(timer); server.close(); } };
}

