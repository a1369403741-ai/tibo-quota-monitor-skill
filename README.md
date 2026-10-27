# Tibo 额度监控 Skill

监控 **Tibo（[@thsottiaux](https://x.com/thsottiaux)）发布的 Codex 额度重置、补充、恢复及可信预告**，包含作者回复，通过飞书群机器人提醒你。

这是一个已完成基础验证的 **macOS 试用版**。安装配置由 Coding 助手协助，日常监控由本机系统后台执行，语义判断调用使用者自己的 DeepSeek API。退出 Codex 或其他 Coding 软件后，后台仍可运行。

[下载 v0.2.0 安装包](https://github.com/a1369403741-ai/tibo-quota-monitor-skill/releases/download/v0.2.0/tibo-quota-monitor-deepseek.zip) · [版本说明](https://github.com/a1369403741-ai/tibo-quota-monitor-skill/releases/tag/v0.2.0) · [完整判断规则](tibo-quota-monitor/references/quota-policy.md)

## 使用前准备

| 项目 | 要求 |
| --- | --- |
| 电脑 | macOS；需要用户已登录、电脑未休眠 |
| 运行环境 | Node.js 20+ 和 curl；无需安装 npm 包，可让 Coding 助手检查环境 |
| DeepSeek | 自己的 API Key，账户有可用 API 余额；参考 [DeepSeek 官方入门文档](https://api-docs.deepseek.com/zh-cn/) |
| 飞书 | 自己群聊中的“自定义机器人”Webhook；参考 [飞书官方机器人指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot) |
| 网络 | 本机能够访问数据源、DeepSeek API 和飞书机器人接口 |

当前后台安装器只支持 macOS。Windows、Linux 暂未提供自动安装方案。

## 安装与配置

### 1. 安装 Skill

把下面这段话交给你的 Coding 助手：

```text
请从 https://github.com/a1369403741-ai/tibo-quota-monitor-skill
安装其中的 tibo-quota-monitor Skill，并按 SKILL.md 帮我配置和启动。
先检查 macOS、Node.js 20+ 和 curl；缺少运行环境时告诉我。
请打开本机私人配置文档让我填写凭据，不要让我把密钥发到聊天里。
```

也可以下载上方安装包，解压后把整个 `tibo-quota-monitor` 文件夹放入 Coding 软件的用户 Skill 目录。Codex 默认位置是：

```text
~/.codex/skills/tibo-quota-monitor/SKILL.md
```

该文件夹应同时保留 `scripts`、`references`、`agents` 等内容。其他 Coding 软件的安装位置按其 Skill 机制确定；如果未自动识别，可以让助手直接读取解压后的 `SKILL.md`。

### 2. 填写自己的两项配置

安装后对助手说：

```text
使用 tibo-quota-monitor，帮我配置并启动 Tibo 额度监控。
```

助手会打开本机私人文本文档 `monitor-setup.txt`。只在等号后填写自己的值，保持为纯文本，不加引号：

```ini
DEEPSEEK_API_KEY=
FEISHU_WEBHOOK_URL=
```

按 **Command + S** 保存，回到助手说“填好了”。不用在聊天中粘贴填写后的内容。

飞书机器人配置说明：

- 使用目标群里的“自定义机器人”Webhook，当前支持飞书官方 `open.feishu.cn` 地址。
- 如果设置了自定义关键词，可使用 `Tibo额度提醒`，程序发送的提醒和测试消息都包含这个词。
- **如果已开启签名校验**，还需要在同一私人文档中补充一行 `FEISHU_SIGNING_SECRET=` 并填写签名密钥。仅有 Webhook 无法满足签名校验。
- 如果设置了 IP 白名单，需要允许本机实际使用的出口 IP。

提交配置并请求启动，表示允许程序使用你的 DeepSeek API 进行少量连接测试和后续判断，并向这个机器人发送连接测试、额度提醒和运行故障通知。

### 3. 等待自动验证并确认启动

助手会调用 Skill 的脚本完成：导入配置 → 测试 DeepSeek 判断 → 检查 Tibo 数据源 → 发送飞书连接测试 → 安装系统后台定时任务。

请确认两件事：

1. 飞书群收到 **“Tibo额度提醒｜连接测试成功”**，这是测试消息。
2. 助手检查状态，确认后台已加载且首轮运行成功。只有文件安装完成或 Key 格式正确，还不代表监控已启动。

验证失败时，助手应报告具体原因。初次设置失败不会继续启动后台任务。

<details>
<summary>可选：手动执行配置命令（以 Codex 默认安装目录为例）</summary>

先检查环境：

```bash
node --version
curl --version
```

生成并打开私人配置文档：

```bash
node "$HOME/.codex/skills/tibo-quota-monitor/scripts/background.mjs" prepare-setup
open -a TextEdit "$HOME/Library/Application Support/tibo-quota-monitor/monitor-setup.txt"
```

填好两项并保存后，执行下列命令。`setup` 会产生少量真实 API 用量、发送飞书测试并安装后台任务：

```bash
node "$HOME/.codex/skills/tibo-quota-monitor/scripts/background.mjs" setup
node "$HOME/.codex/skills/tibo-quota-monitor/scripts/background.mjs" status
```

等待首轮结束，再次查看 `status`：`config.enabled` 和 `service.loaded` 应为 `true`，`lastRun.ok` 应为 `true`，并且 `lastRun.startedAt` 是这次启动后的时间。安装在其他目录时，把命令中的 Skill 路径替换为实际路径。

</details>

## 运行方式与注意事项

```text
系统定时 → 获取 Tibo 动态 → 去重 → DeepSeek 判断 → 原文证据校验 → 飞书通知
```

- **检查时间：**默认每小时第 15 分钟检查，加载服务和用户登录时也会执行一次。这不是实时推送，发现消息可能需要等到下一轮。
- **电脑状态：**退出 Codex 后仍可运行；电脑关机、休眠或用户注销期间暂停。不会自动阻止电脑休眠。恢复后补查数据源仍能提供的历史。
- **消息范围：**当前固定监控 Tibo 的 Codex 额度消息，不是通用账号订阅器。预告会标明“尚未生效”或“尚未确认”；语义评分不代表统计准确率。
- **没有消息：**没有新动态时不调用模型；没有符合条件的提醒时不会往飞书发送日常报平安消息。采集失败会记录为故障，不能当成没有新帖。
- **历史补发：**首次检查最近 2 小时；后续从上次成功位置续查。明确的历史重置也会补发，并标注原文发布时间、这次推送时间及历史消息说明。它不代表此刻再次重置，也不保证过去的额度仍然可用。
- **网络与数据源：**采集依赖第三方 FxEmbed 数据源，可能限流、故障、延迟或缺少历史记录。后台使用本机网络；如果依赖本机代理，代理也需要保持可用。
- **飞书提醒：**送达不明的通知会挂起，避免盲目重复发送；需要核对群消息后再决定是否重试。故障通知也依赖飞书网络，断网时可能只能留下本地记录。

## Token 与费用

语义判断使用 `deepseek-flash`。只把判断规则、待分析动态和有限上下文发给模型；后台不调用 Codex，也不加载 Coding 软件里的聊天记录。安装、维护时与 Coding 助手的对话仍按该软件自身规则消耗额度。

- 有新动态需要判断时才调用 DeepSeek；首次连接测试也会产生少量 API 用量。
- `status` 显示最近一轮与本月的输入、缓存输入、非缓存输入、输出及合计 Token。
- 默认按北京时间月份设置 **¥8 的模型估算预算**。费用按代码记录的保守单价计算，实际扣费以 DeepSeek 账单为准；价格变化会影响估算准确性。
- 预算不足时会保留待判断批次并暂停模型请求，后续采集也可能等待该批次处理；下月预算恢复后继续处理和补查。
- 请求结果不明时会保留预留费用，同一批次付费失败最多自动尝试 3 次，防止无限重试。不能保证任何情况下都完整补回停机或预算耗尽期间的消息。

模型实时价格请查看 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。

## 隐私与本地数据

仓库与发布安装包不包含开发者的 API Key、Webhook、签名密钥或运行记录。每位使用者填写自己的凭据。

配置、密钥、去重记录、历史游标、发送队列和用量统计默认保存在：

```text
~/Library/Application Support/tibo-quota-monitor/
```

这些文件独立于 Skill 和 Git 仓库。导入成功后会删除临时填写文档，凭据转存到私人文件；目录权限为 `700`、文件权限为 `600`。这是本机文件权限保护，凭据并非加密保险库中的内容，分享电脑或备份时也要保护这些文件。

请勿把私人目录、已填写配置、完整运行记录打包上传到 GitHub，或粘贴到公开 Issue。报告问题时只提供脱敏的错误代码和必要状态。

## 查看、暂停与恢复

可以直接对 Coding 助手说：

| 你想做什么 | 可以怎么说 |
| --- | --- |
| 查看状态与用量 | “查看 Tibo 监控的最近运行结果、Token 和费用估算。” |
| 暂停 | “暂停 Tibo 后台监控，保留配置与历史。” |
| 恢复 | “恢复 Tibo 后台监控。” |
| 更换凭据 | “帮我更换 DeepSeek Key／飞书机器人，用本机文档填写。” |

手动命令如下；分别按需要执行：

```bash
# 查看脱敏状态
node "$HOME/.codex/skills/tibo-quota-monitor/scripts/background.mjs" status

# 暂停后台，保留数据
node "$HOME/.codex/skills/tibo-quota-monitor/scripts/background.mjs" stop

# 恢复后台
node "$HOME/.codex/skills/tibo-quota-monitor/scripts/background.mjs" resume
```

暂停状态会保留，重新登录不会擅自恢复发送。更换飞书机器人后，原有待发送消息仍会保留，并在恢复后使用新机器人发送。

## 常见问题

| 情况 | 处理方式 |
| --- | --- |
| 飞书没有消息 | 先确认连接测试收到，再让助手检查最近一轮状态；没有符合条件的动态时保持安静是正常行为。 |
| DeepSeek 返回错误 | 核对 Key、API 余额和网络；不要把 Key 发到聊天里。 |
| 飞书拒绝消息 | 核对 Webhook、关键词、签名校验和 IP 白名单。 |
| 浏览器能看 Tibo，后台采集失败 | 检查后台网络和代理环境，以及第三方数据源是否可达；浏览器可用不代表后台网络相同。 |
| 显示预算不足或同一批次失败三次 | 让助手检查状态和原因，不要通过删除记录来绕过预算或重复发送。 |
| 安装后找不到 Skill | 核对安装目录是否包含 `SKILL.md`，并让 Coding 助手直接读取这个文件。 |
| 升级旧版后出现重复监控 | 暂停旧的 Codex 定时任务，复用私人数据目录，只保留一个系统后台任务。 |

## 已验证范围

v0.2.0 发布前完成了 41 项离线测试、4 个真实 DeepSeek 基础语义样例、6 条真实 Tibo 动态回放、飞书连接测试，以及一次由系统定时器实际触发的采集。该定时轮次没有新动态，模型调用为 0。

这些验证不等于长期稳定性或识别准确率保证。建议先在自己的环境确认连接测试和首轮运行结果，再持续观察。

进一步查看：[Skill 入口](tibo-quota-monitor/SKILL.md) · [配置与维护说明](tibo-quota-monitor/references/setup.md) · [判断规则](tibo-quota-monitor/references/quota-policy.md)
