# Happy ZCode —— 用 Happy 手机 App 控制 ZCode

这是 [happy-cli](https://github.com/slopus/happy-cli)（v0.14.0）的 fork，在原有
claude / codex / gemini 三种 agent 之外新增了 **zcode** 后端。改动已提交在
`zcode-support` 分支（commit `1d25f79`）。

装好之后，在手机上用官方 Happy App（App Store / Play Store 均可，无需改 App）
即可远程控制这台机器上的 ZCode：发消息、看实时回复、中止任务。

## 快速开始（NAS，已部署）

NAS 上已经装好的东西：

- `/home/weei/happy-cli/` —— 本 fork 的完整部署（含构建产物）
- `~/.local/bin/happy` —— 启动脚本（用 ZCode 自带 Electron 的 node 跑 happy-cli，
  因为 NAS 上没有独立 node；自动带上 `ZCODE_COMMAND` 指向 zcode CLI）
- `~/.local/bin/zcode` —— 你之前（codex 装的）zcode CLI，负责真正干活
- `~/.config/systemd/user/happy-zcode.service` —— 常驻服务定义（见下）

首次使用（用真实手机配对）：

```sh
# SSH 到 NAS 后执行（需要 TTY，用 ssh -t 或直接在终端里跑）
rm ~/.happy/access.key      # 清掉测试用的临时账号凭据
happy zcode
```

会出现认证选择界面 → 选 **Mobile App** → 用手机 Happy App 扫终端里的二维码 →
配对成功后终端显示 "Happy Zcode bridge active"。

之后在手机 App 里点进这个会话（或对终端扫描配对新会话）直接发消息即可。

## 常驻运行（重要）

`happy zcode` 在前台运行时，**关闭 SSH 终端进程就会退出**，手机发的消息将无人
接收。推荐二选一：

```sh
# 方式 A（无需 root，推荐）：临时后台运行，断开 SSH 后继续存活
cd ~/zcode-test && setsid nohup happy zcode > /tmp/happy-zcode-cli.log 2>&1 < /dev/null &

# 方式 B（一次性 sudo 配置后开机自启、崩溃自动重启）：
sudo loginctl enable-linger $USER     # 只需执行一次
systemctl --user enable --now happy-zcode
journalctl --user -u happy-zcode -f   # 看日志
```

**重启健壮性**（已内置）：桥接状态存在 `~/.happy/zcode-bridge-state.json`
（Happy 会话 tag、会话加密密钥、zcode 会话 id）。桥重启后会回到**同一个**
Happy 会话、继续同一段 zcode 对话；掉线期间手机发的消息会在启动时通过 REST
补收并逐条处理。删掉这个状态文件即可开一段全新会话。

## 工作原理

```
手机 Happy App ──(端到端加密)──> Happy 中继服务器
                                      │
                              NAS: happy zcode（本 fork）
                                      │  每条消息一次 headless 调用
                                      ▼
                              zcode -p <消息> [--resume <会话>] --mode <模式>
                                      │
                                      ▼ GLM 模型 / 工具执行
```

- **第一条消息**：`zcode -p <msg> --json`，结束时拿到 zcode 的 sessionId
  （此时回复在消息结束后一次性显示）
- **后续消息**：`zcode -p <msg> --resume <sid>`，stdout **实时流式**转发到手机
  （以 thinking 事件显示，完整回复随后作为正式消息出现）
- **多轮上下文**：由 zcode 自己的持久化会话（`--resume`）承担
- **中止**：App 里点 stop → 杀掉当次 zcode 进程（zcode 会话本身保留，可继续）
- **权限模式映射**（Happy App 里的模式切换）：
  - default → `--mode yolo`（zcode headless 默认就是 yolo，保证可用性）
  - safe-yolo → `--mode edit`
  - read-only → `--mode plan`
- 会话元数据 `flavor: "zcode"`，App 端对未知 flavor 会优雅显示（无需改 App）

## 已验证范围（全部实测通过）

- 本地冒烟测试 7/7（spawn/JSON 解析/流式增量/错误透传/缺命令提示/会话重置）
- NAS 端到端（脚本模拟手机端，走真实 Happy 生产服务器）：
  - 账号配对 → 会话创建 → 发消息 → zcode 执行 → 加密回流
  - 第一轮：`task_started` / `message` / `task_complete` 全部到达
  - 第二轮（resume 路径）：上下文保持正确，thinking 流式事件到达
- NAS 上以 `ELECTRON_RUN_AS_NODE` 方式运行 happy-cli（无独立 node 也能跑）

## 已知限制

1. **第一条消息没有流式**：需要 `--json` 拿 zcode sessionId，回复在结束时一次到达；
   从第二条消息起是实时流式。
2. **没有工具调用卡片**：zcode 的 `-p` 模式不输出工具事件，手机上只看到文本
   （工具实际在正常执行）。
3. **App 里的模型切换无效**：zcode 的模型由它自己的配置决定（NAS 上是
   `account:bigmodel-individual-coding-plan/GLM-5.3`），fork 会忽略模型切换 meta。
4. **中止的实现是杀进程**：正在进行的 zcode 回合会中断，但 zcode 会话持久化在
   `~/.zcode`，后续消息仍能续上。
5. **桌面机暂不能这样跑 headless zcode**：桌面版 ZCode 的 OAuth token 无法直接给
   CLI 用（缺签名交换），需要等 API key 或桌面 CLI 支持独立登录；NAS 上已经由
   account key 方案解决。
6. daemon 自启动在 NAS 上会失败（spawn `node` 不存在），已做容错处理，不影响使用。

## 本地开发

```
~/happy-zcode/happy-cli/            # 本 fork（分支 zcode-support）
├── src/zcode/                      # 适配器：constants/types/zcodeBackend/runZcode
├── sim/e2e.mjs                     # 脚本化手机端，对真实服务器做 E2E
├── scripts-dev/zcode-smoke.ts      # 本地冒烟测试（mock zcode）
└── ZCODE.md                        # 本文件
```

```sh
npm install && npm run build        # 构建
npx tsx scripts-dev/zcode-smoke.ts  # 本地冒烟（不需要账号）
node sim/e2e.mjs                    # NAS 全链路 E2E（在桌面机上跑）
```

上游同步：`git remote add upstream https://github.com/slopus/happy-cli.git &&
git fetch upstream && git rebase upstream/master zcode-support`
