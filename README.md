# hi-proxy

把 [OpenTiny GenUI playground](https://opentiny.github.io/genui-sdk/playground/) 背后的模型服务，包装成一个**标准 OpenAI 接口**的本地网关，顺带把原始页面和模型接口也透传出来，并完整落盘每一次请求/响应。

一个进程，三种能力：

| 能力 | 路径 | 说明 |
| --- | --- | --- |
| OpenAI 兼容网关 | `/v1/models`、`/v1/chat/completions` | 任何说 OpenAI 协议的客户端（openai SDK、LangChain、deepseek-harness、WorkBuddy…）把 `base_url` 指过来即可 |
| 透明反代 | `/get-models`、`/chat-genui`、`/chat-template` 等 | 原样转发到上游，请求体与 SSE 流完整落盘，可改写模型 / 温度 / 上游 |
| 页面透传 | `/genui-sdk/playground/` | 转发 playground 静态资源，并把 JS 里写死的接口地址回写成当前代理地址 |

## 快速开始

```bash
pnpm install
pnpm start                 # 默认 3010 端口
```

启动后：

- OpenAI 网关：`http://localhost:3010/v1`
- 原版 playground UI（流量走本地）：`http://localhost:3010/genui-sdk/playground/`
- 健康检查：`http://localhost:3010/__proxy/health`

```bash
# 模型列表
curl http://localhost:3010/v1/models

# 对话
curl http://localhost:3010/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"routing/glm-5.2","messages":[{"role":"user","content":"你好"}]}'
```

用 SDK 接入时只需替换 base_url，`api_key` 随便填（除非启动时加了 `--api-key`）：

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3010/v1", api_key="sk-local")
print(client.chat.completions.create(
    model="routing/glm-5.2",
    messages=[{"role": "user", "content": "用三句话解释什么是反向代理"}],
).choices[0].message.content)
```

> 局域网内其它机器要用本机 IP：`http://<本机IP>:3010/v1`。

## 命令行参数

pnpm 直接跟参数即可，不需要 npm 那样的 `--` 分隔符。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-p, --port` | `3010` | 监听端口 |
| `-u, --upstream` | `https://playground.bytedev.site/genui-server` | 模型服务上游 |
| `--web-upstream` | `https://opentiny.github.io` | 页面透传的静态资源上游 |
| `--mode` | `chat` | `chat`：追加覆盖指令，输出普通对话；`genui`：保留上游 GenUI 行为，输出 `schemaJson` |
| `-k, --api-key` | 无 | 设置后网关校验 `Authorization: Bearer <key>`（或 `x-api-key`） |
| `-m, --model` | 无 | 强制改写 `metadata.playground.model`，常用于反代时锁模型 |
| `-t, --temperature` | 无 | 强制改写温度，常用于反代时降随机性 |
| `--header` | 无 | 额外注入上游的请求头，如 `--header "authorization: Bearer xxx"`，可重复 |
| `--no-web` | 页面透传开启 | 只做网关 / API 代理，不透传页面 |
| `--no-log` | 落盘开启 | 只转发不落盘 |
| `--log-dir` | `./logs` | 抓包目录 |
| `--body-limit` | `100mb` | 请求体上限 |
| `--quiet` | 关闭 | 少打印 |
| `-h, --help` | — | 打印源文件头部注释里的用法 |

环境变量（命令行参数优先）：`HI_PROXY_PORT`、`HI_PROXY_UPSTREAM`、`HI_PROXY_WEB_UPSTREAM`、`HI_PROXY_API_KEY`、`HI_PROXY_MODE`、`HI_PROXY_LOG_DIR`。

常见组合：

```bash
pnpm start --mode genui                 # 网关保留 GenUI 行为（返回 schemaJson）
pnpm start --api-key sk-local           # 网关加鉴权
pnpm start --model "routing_GLM 5.2"    # 反代时强制锁模型
pnpm start --temperature 0.1            # 反代时锁温度
pnpm start --upstream http://localhost:3008   # 改打自建 playground server
pnpm start --no-web --no-log --quiet    # 纯网关模式，最省事
```

## 网关行为细节

**模型 ID 映射**：上游模型名形如 `routing_GLM 5.2`，网关对外暴露为 `provider/slug`，即 `routing/glm-5.2`。请求时三种写法都能命中：

- 网关 ID：`routing/glm-5.2`
- 上游原名：`routing_GLM 5.2`
- 唯一短名：`glm-5.2`

模型列表缓存 60 秒，来源是上游 `/get-models`。

**chat / genui 两种模式**：上游 `/chat-genui` 会**无条件**注入 GenUI 系统提示词，所以问「什么是快排」也会给你返回 `schemaJson`。默认的 `chat` 模式会在消息末尾追加一条覆盖指令，把模型拉回通用助手，并改用 `promptVariant: mini` 显著缩短注入的提示词；`--mode genui` 关闭这一行为。

**流式**：上游返回的本来就是 `chat.completion.chunk` 形态的 SSE，所以流式只做透传 + 回写 `model` 字段；`[DONE]` 时按需补发 `usage`（`stream_options.include_usage`）。上游单帧出错会以 `{"error":…}` 帧透传下去。

**function calling**：上游不支持原生 tools，网关用提示词 + 约定代码块模拟——

1. 请求带 `tools` 时不注入覆盖指令（两者冲突），改为追加工具说明，要求模型按 `` ```tool_call {"name":…,"arguments":{…}} `` 输出；
2. 聚合响应后从文本里提取这些代码块，转换成标准 `tool_calls`，`finish_reason` 置为 `tool_calls`；
3. `role: "tool"` 的历史结果降级为 `user` 文本喂回上游，`assistant` 的 `tool_calls` 按同一格式回放，保证多轮工具循环能跑通；
4. 带 `tools` 且要求流式时是**伪流式**：整段生成完再一次性下发（agent 客户端能接受）。

上游其实没有 tool 角色，也不能保证模型一定按格式输出，所以这是「能用」而非「可靠」——复杂 agent 场景请自行重试或降级。

**不支持的参数**：`max_tokens`、`stop` 会被静默忽略，并在日志里记一条 warning。

## 日志

`--no-log` 之外的每次调用都会落盘到 `logs/`：

- `summary.jsonl`：一行一条汇总，含状态码、耗时、TTFB、字数、模型、SSE 帧数等，适合直接 `jq` 分析；
- `<id>-<path>.req.json` / `.res.txt`：单次请求体与响应原文（网关请求是 `<id>-openai.*`）。

API 反代路径的响应头里带 `x-proxy-id`，可以拿它去 `logs/` 里对照原始报文（网关请求的 id 形如 `gw-…`，见 `summary.jsonl`）。

```bash
# 最近 10 次调用的耗时/字数
tail -n 10 logs/summary.jsonl | jq -c '{at,path,status,durationMs,ttfbMs,promptChars,completionChars}'
```

## 开发

```bash
pnpm dev        # tsx watch
pnpm typecheck  # tsc --noEmit
pnpm test       # node:test + tsx，上游用本地 http server 模拟，不走真实网络
pnpm build      # tsc → dist/
pnpm serve      # node dist/index.js
```

## 目录结构

```
src/index.ts            代理进程：三种路由 + 命令行 + 落盘
src/openai-gateway.ts   OpenAI 兼容网关：模型映射、SSE 转换、工具调用模拟
test/openai-gateway.test.ts
logs/                   抓包目录（git 忽略）
```

## 注意

- 上游是公开的 playground 服务，随时可能变更或限流，别拿它当生产依赖。
- `--api-key` 只是本地一层轻校验，不做转发隔离；暴露到公网前请自行加 TLS 和访问控制。
- 抓包文件里含完整对话内容，`logs/` 已在 `.gitignore` 中，分享日志前先脱敏。
