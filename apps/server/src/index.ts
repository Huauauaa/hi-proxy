/**
 * hi-proxy —— 把 OpenTiny GenUI playground 的模型服务包装成标准 OpenAI 接口。
 *
 * 一个进程三种能力：
 *   1) OpenAI 兼容网关：/v1/models、/v1/chat/completions。任何说 OpenAI 协议的 agent
 *      （workbuddy、deepseek-harness、openai SDK、LangChain …）把 base_url 指向
 *      http://localhost:3010/v1 即可。
 *   2) 透明反代：/get-models、/chat-genui、/chat-template 等原样转发到上游，
 *      请求体与 SSE 流完整落盘，支持改写模型 / 温度 / 上游。
 *   3) 页面透传：转发 playground 静态资源，并把打包时写死的接口地址回写成当前代理地址，
 *      打开 http://localhost:3010/genui-sdk/playground/ 得到原版 UI，但模型流量走本地。
 *
 * 用法（pnpm；pnpm 直接跟参数，不需要 npm 那样的 `--` 分隔符）：
 *   pnpm start                                      # 默认：网关 chat 模式 + 公网模型服务 + 透传页面
 *   pnpm start --mode genui                         # 网关保留上游 GenUI 行为（输出 schemaJson）
 *   pnpm start --api-key sk-local                   # 网关校验 Authorization: Bearer
 *   pnpm start --model "routing_GLM 5.2"            # 强制改写 metadata.playground.model
 *   pnpm start --temperature 0.1                    # 强制改写温度
 *   pnpm start --upstream http://localhost:3008     # 改打自建 playground server
 *   pnpm start --header "authorization: Bearer xxx"
 *   pnpm start --no-web                             # 只做网关 / API 代理，不透传页面
 *   pnpm start --no-log                             # 只转发不落盘
 *   pnpm start --port 3010 --quiet                  # 换端口 / 少打印
 *
 * 也可用环境变量：HI_PROXY_PORT、HI_PROXY_UPSTREAM、HI_PROXY_API_KEY、HI_PROXY_MODE、
 * HI_PROXY_LOG_DIR（命令行参数优先）。
 *
 * 网关调用示例（base_url = http://<本机IP>:3010/v1，api_key 随便填）：
 *   curl http://localhost:3010/v1/models
 *   curl http://localhost:3010/v1/chat/completions -H 'content-type: application/json' \
 *     -d '{"model":"routing/glm-5.2","messages":[{"role":"user","content":"你好"}]}'
 */
import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import minimist from 'minimist';
import { createOpenAIGateway, textOf, type GatewayLogRecord, type GatewayMode } from './openai-gateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录（monorepo 中源码位于 apps/server/src，运行产物在 apps/server/dist，都往上退三层） */
const ROOT_DIR = path.resolve(__dirname, '../../..');

const args = minimist(process.argv.slice(2), {
  string: ['port', 'upstream', 'web-upstream', 'model', 'log-dir', 'header', 'body-limit', 'mode', 'api-key'],
  boolean: ['help', 'quiet'],
  alias: { p: 'port', u: 'upstream', m: 'model', h: 'help', t: 'temperature', k: 'api-key' },
  default: {
    port: Number(process.env.HI_PROXY_PORT) || 3010,
    upstream: process.env.HI_PROXY_UPSTREAM || 'https://playground.bytedev.site/genui-server',
    'web-upstream': process.env.HI_PROXY_WEB_UPSTREAM || 'https://opentiny.github.io',
    'log-dir': process.env.HI_PROXY_LOG_DIR || path.join(ROOT_DIR, 'logs'),
    'body-limit': '100mb',
    mode: process.env.HI_PROXY_MODE || 'chat',
    'api-key': process.env.HI_PROXY_API_KEY,
  },
});

if (args.help) {
  console.info(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
  process.exit(0);
}

const PORT = Number(args.port) || 3010;
const UPSTREAM = String(args.upstream).replace(/\/+$/, '');
const WEB_UPSTREAM = String(args['web-upstream']).replace(/\/+$/, '');
const WEB_ENABLED = args.web !== false; // --no-web → { web: false }
const FORCE_MODEL: string | undefined = args.model;
const FORCE_TEMPERATURE = args.temperature;
const LOG_ENABLED = args.log !== false; // --no-log → { log: false }
const QUIET = Boolean(args.quiet);
const LOG_DIR = args['log-dir'];
const GATEWAY_MODE = (args.mode === 'genui' ? 'genui' : 'chat') as GatewayMode;
const GATEWAY_API_KEY: string | undefined = args['api-key'];

/** 前端 API 前缀：公网包里的地址是 <host>/genui-server/chat-genui，回写后会带这个前缀 */
const API_PREFIX = '/genui-server';

/** 已知的模型接口路径；不带前缀直接打代理时按这些路径识别为 API 请求 */
const API_ENDPOINTS = new Set([
  '/get-models',
  '/chat-genui',
  '/chat-template',
  '/check-mcp',
  '/check-openapi-tools',
  '/fetch-agent-card',
]);

const isApiPath = (p: string) =>
  p === API_PREFIX || p.startsWith(`${API_PREFIX}/`) || API_ENDPOINTS.has(`/${p.split('/')[1]}`);

/** 额外注入到上游的 header，如 --header "authorization: Bearer xxx"（可重复） */
const EXTRA_HEADERS: Record<string, string> = ([] as string[])
  .concat(args.header || [])
  .reduce((acc: Record<string, string>, item: string) => {
    const idx = item.indexOf(':');
    if (idx > 0) acc[item.slice(0, idx).trim().toLowerCase()] = item.slice(idx + 1).trim();
    return acc;
  }, {});

/** hop-by-hop 头不能透传；accept-encoding 交给 undici 自己协商（它会自动解压） */
const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
]);

const SKIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

if (LOG_ENABLED) fs.mkdirSync(LOG_DIR, { recursive: true });

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d = new Date()) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(
    d.getSeconds(),
  )}`;
const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const size = (n: number) =>
  n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`;
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

let seq = 0;

interface ChatMeta {
  model?: string;
  framework?: string;
  componentLib?: string;
  temperature?: number;
  messageCount?: number;
  lastUserText?: string;
}

/** 从 /chat-genui 请求体里提取可读信息：模型、框架、最后一条用户输入 */
const describeChatBody = (body: any): ChatMeta => {
  const meta: ChatMeta = {};
  try {
    const pg = JSON.parse(body?.metadata?.playground || '{}');
    meta.model = pg.model;
    meta.framework = pg.framework;
    meta.componentLib = pg.componentLib;
    meta.temperature = pg.temperature;
  } catch {
    /* metadata.playground 不是合法 JSON，忽略 */
  }
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  meta.messageCount = messages.length;
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
  if (lastUser) meta.lastUserText = truncate(textOf(lastUser.content).replace(/\s+/g, ' '), 120);
  return meta;
};

/** 按 --model / --temperature 改写请求体；返回是否真的改过 */
const rewriteChatBody = (body: any): boolean => {
  if (FORCE_MODEL === undefined && FORCE_TEMPERATURE === undefined) return false;
  try {
    const pg = JSON.parse(body?.metadata?.playground || '{}');
    if (FORCE_MODEL !== undefined) pg.model = FORCE_MODEL;
    if (FORCE_TEMPERATURE !== undefined) pg.temperature = Number(FORCE_TEMPERATURE);
    body.metadata = { ...(body.metadata || {}), playground: JSON.stringify(pg) };
    return true;
  } catch {
    return false;
  }
};

const countSseEvents = (text: string) => (text.match(/^data:/gm) || []).length;

const pickRequestHeaders = (req: express.Request): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (SKIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    if (typeof v === 'string') headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(', ');
  }
  return { ...headers, ...EXTRA_HEADERS };
};

const writeResponseHeaders = (res: express.Response, upstreamRes: Response) => {
  res.status(upstreamRes.status);
  upstreamRes.headers.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
  });
};

/** 把上游流写回客户端（自带背压处理）；onChunk 传入时顺带逐块回调给调用方记账 */
const pump = async (res: express.Response, body: ReadableStream<Uint8Array>, onChunk?: (buf: Buffer) => void) => {
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const buf = Buffer.from(value);
    if (!res.write(buf)) await new Promise<void>((resolve) => res.once('drain', resolve));
    onChunk?.(buf);
  }
};

/** 网关请求落盘：一个大 JSONL 汇总 + 每个请求的 req/res 原始文件 */
const logGatewayCall = (record: GatewayLogRecord, requestBody: any, responseText: string) => {
  if (!QUIET) {
    const statusColor = record.status < 400 ? c.green : c.red;
    const detail = record.model ? ` model=${c.magenta(record.model)}` : '';
    const ttfb = record.ttfbMs != null ? ` ttfb=${record.ttfbMs}ms` : '';
    const extra = record.warning ? ` ${c.yellow('!')} ${c.dim(record.warning.slice(0, 60))}` : '';
    console.info(
      `${c.dim(clock())} ${statusColor('⇄')} ${statusColor(String(record.status))} /v1/chat/completions${detail} ` +
        `${record.durationMs}ms${ttfb} in=${record.promptChars}字 out=${record.completionChars}字${extra}`,
    );
  }
  if (!LOG_ENABLED) return;
  try {
    const base = path.join(LOG_DIR, `${record.id}-openai`);
    fs.writeFileSync(`${base}.req.json`, JSON.stringify(requestBody, null, 2));
    fs.writeFileSync(`${base}.res.txt`, responseText);
    fs.appendFileSync(
      path.join(LOG_DIR, 'summary.jsonl'),
      `${JSON.stringify({ kind: 'openai-gateway', at: new Date().toISOString(), upstream: UPSTREAM, ...record })}\n`,
    );
  } catch (error: any) {
    console.warn(`日志写入失败: ${error?.message}`);
  }
};

const app = express();
app.disable('x-powered-by');
app.use(
  cors({
    origin: true,
    credentials: true,
    exposedHeaders: ['x-proxy-id'],
  }),
);
app.use(express.raw({ type: () => true, limit: args['body-limit'] }));

// OpenAI 兼容网关：任何说 OpenAI 协议的 agent 都可以把 base_url 指到 /v1
app.use(
  '/v1',
  createOpenAIGateway({
    upstream: UPSTREAM,
    mode: GATEWAY_MODE,
    apiKey: GATEWAY_API_KEY,
    log: logGatewayCall,
  }),
);

app.get('/__proxy/health', (req, res) => {
  res.send({
    ok: true,
    upstream: UPSTREAM,
    web: WEB_ENABLED ? WEB_UPSTREAM : null,
    gateway: { baseUrl: `http://${req.headers.host}/v1`, mode: GATEWAY_MODE, auth: Boolean(GATEWAY_API_KEY) },
    model: FORCE_MODEL ?? null,
    temperature: FORCE_TEMPERATURE ?? null,
    logDir: LOG_ENABLED ? LOG_DIR : null,
  });
});

app.use(async (req, res) => {
  const isApi = isApiPath(req.path);

  if (!isApi) {
    // 站点实际部署在 /genui-sdk/ 下，顺手把 /playground 重定向过去，少记一个前缀
    if (req.path === '/playground' || req.path.startsWith('/playground/')) {
      return res.redirect(302, `/genui-sdk${req.originalUrl}`);
    }

    // ---------- 页面/静态资源透传：只改写 JS 里写死的模型服务地址 ----------
    const target = `${WEB_UPSTREAM}${req.originalUrl}`;
    try {
      const upstreamRes = await fetch(target, {
        method: req.method,
        headers: pickRequestHeaders(req),
        body: Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined,
      });
      const contentType = upstreamRes.headers.get('content-type') || '';
      const origin = `http://${req.headers.host}`;

      if (contentType.includes('javascript')) {
        const code = await upstreamRes.text();
        const rewritten = code.split(UPSTREAM).join(`${origin}${API_PREFIX}`);
        res.status(upstreamRes.status);
        res.setHeader('content-type', contentType);
        res.setHeader('cache-control', 'no-store');
        res.send(rewritten);
        return;
      }

      writeResponseHeaders(res, upstreamRes);
      if (!upstreamRes.body) return res.end();
      await pump(res, upstreamRes.body);
      res.end();
    } catch (error: any) {
      if (!QUIET) console.error(`${c.dim(clock())} ${c.red('✕')} 页面透传失败 ${req.path}: ${error?.message}`);
      if (!res.headersSent) res.status(502).send('proxy error');
    }
    return;
  }

  // ---------- 模型接口代理 ----------
  const id = `${stamp()}-${String(++seq).padStart(3, '0')}`;
  const startedAt = Date.now();
  const apiPath = req.path.startsWith(API_PREFIX) ? req.path.slice(API_PREFIX.length) || '/' : req.path;
  const target = `${UPSTREAM}${apiPath}${req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : ''}`;

  const rawBuf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let bodyBuf = rawBuf;
  let chatMeta: ChatMeta = {};

  if (rawBuf.length && (req.headers['content-type'] || '').includes('json')) {
    try {
      const parsed = JSON.parse(rawBuf.toString('utf8'));
      chatMeta = describeChatBody(parsed);
      if (rewriteChatBody(parsed)) {
        if (FORCE_MODEL !== undefined) chatMeta.model = FORCE_MODEL;
        if (FORCE_TEMPERATURE !== undefined) chatMeta.temperature = Number(FORCE_TEMPERATURE);
        bodyBuf = Buffer.from(JSON.stringify(parsed));
      }
    } catch {
      /* 非 JSON 或解析失败，原样转发 */
    }
  }

  if (!QUIET) {
    const detail = chatMeta.model
      ? ` model=${c.magenta(chatMeta.model)} fw=${chatMeta.framework ?? '-'}/${chatMeta.componentLib ?? '-'} msgs=${
          chatMeta.messageCount
        } temp=${chatMeta.temperature ?? '-'}`
      : '';
    console.info(`${c.dim(clock())} ${c.cyan('→')} ${req.method} ${apiPath}${detail}`);
    if (chatMeta.lastUserText) console.info(`${c.dim('        ')}「${chatMeta.lastUserText}」`);
  }

  const controller = new AbortController();
  let finished = false;
  res.on('close', () => {
    if (!finished) controller.abort();
  });

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(target, {
      method: req.method,
      headers: pickRequestHeaders(req),
      body: bodyBuf.length && req.method !== 'GET' && req.method !== 'HEAD' ? bodyBuf : undefined,
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (error: any) {
    const message = error?.name === 'AbortError' ? 'client aborted' : error?.message || String(error);
    if (!QUIET) console.error(`${c.dim(clock())} ${c.red('✕')} ${req.method} ${apiPath} 上游请求失败: ${message}`);
    if (!res.headersSent) res.status(502).send({ error: 'proxy upstream failed', message });
    return;
  }

  writeResponseHeaders(res, upstreamRes);
  res.setHeader('x-proxy-id', id);

  const isStream = (upstreamRes.headers.get('content-type') || '').includes('event-stream');
  if (isStream) {
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
  }
  res.flushHeaders?.();

  let firstByteAt: number | null = null;
  let total = 0;
  let chunks = 0;
  const collected: Buffer[] = [];
  const COLLECT_LIMIT = 8 * 1024 * 1024;

  if (upstreamRes.body) {
    try {
      await pump(res, upstreamRes.body, (buf) => {
        if (firstByteAt === null) firstByteAt = Date.now();
        chunks += 1;
        total += buf.length;
        if (total <= COLLECT_LIMIT) collected.push(buf);
      });
    } catch (error: any) {
      if (!QUIET) console.error(`${c.dim(clock())} ${c.red('✕')} 流中断 ${apiPath}: ${error?.message}`);
    }
  }

  finished = true;
  res.end();

  const duration = Date.now() - startedAt;
  const bodyText = Buffer.concat(collected).toString('utf8');
  const statusColor = upstreamRes.status < 400 ? c.green : c.red;

  if (!QUIET) {
    const ttfb = firstByteAt ? ` ttfb=${firstByteAt - startedAt}ms` : '';
    const extra = isStream ? ` events=${countSseEvents(bodyText)}` : '';
    console.info(
      `${c.dim(clock())} ${statusColor('←')} ${statusColor(String(upstreamRes.status))} ${apiPath} ` +
        `${duration}ms${ttfb} ${size(total)} chunks=${chunks}${extra} ${c.dim(id)}`,
    );
  }

  if (!LOG_ENABLED) return;

  const baseName = path.join(
    LOG_DIR,
    `${id}-${apiPath.replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '') || 'root'}`,
  );
  try {
    if (bodyBuf.length) fs.writeFileSync(`${baseName}.req.json`, bodyBuf.toString('utf8'));
    if (total) fs.writeFileSync(`${baseName}.res.txt`, bodyText);
    fs.appendFileSync(
      path.join(LOG_DIR, 'summary.jsonl'),
      `${JSON.stringify({
        id,
        at: new Date(startedAt).toISOString(),
        method: req.method,
        path: req.originalUrl,
        upstream: target,
        status: upstreamRes.status,
        durationMs: duration,
        ttfbMs: firstByteAt ? firstByteAt - startedAt : null,
        responseBytes: total,
        chunks,
        streaming: isStream,
        sseEvents: isStream ? countSseEvents(bodyText) : 0,
        ...chatMeta,
        files: {
          request: bodyBuf.length ? `${baseName}.req.json` : null,
          response: total ? `${baseName}.res.txt` : null,
        },
      })}\n`,
    );
  } catch (error: any) {
    console.warn(`日志写入失败: ${error?.message}`);
  }
});

app.listen(PORT, () => {
  console.info('');
  console.info(`  ${c.cyan('Playground 大模型代理')}   http://localhost:${PORT}`);
  console.info(`  ${c.dim('模型接口上游')}     ${UPSTREAM}`);
  if (WEB_ENABLED)
    console.info(`  ${c.dim('页面透传')}         http://localhost:${PORT}/genui-sdk/playground/  ← ${WEB_UPSTREAM}`);
  console.info(`  ${c.dim('OpenAI 网关')}      http://localhost:${PORT}/v1  (mode=${GATEWAY_MODE}${GATEWAY_API_KEY ? ', 需要 api-key' : ''})`);
  if (FORCE_MODEL) console.info(`  ${c.dim('改写模型')}         ${FORCE_MODEL}`);
  if (FORCE_TEMPERATURE !== undefined) console.info(`  ${c.dim('改写温度')}         ${FORCE_TEMPERATURE}`);
  console.info(`  ${c.dim('抓包目录')}         ${LOG_ENABLED ? LOG_DIR : '已关闭'}`);
  console.info(`  ${c.dim('健康检查')}         http://localhost:${PORT}/__proxy/health`);
  console.info('');
});
