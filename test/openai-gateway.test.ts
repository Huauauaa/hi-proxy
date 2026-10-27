/**
 * 网关单元测试：node:test（零依赖），tsx --test 运行。
 * 覆盖三块非平凡逻辑：SSE 解析器、非流式聚合、流式透传，外加鉴权一个用例。
 * 上游用本地 http server 模拟，不起真实网络。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { createOpenAIGateway, sseEvents } from '../src/openai-gateway.js';

const sse = (events: string[]) => events.map((e) => `data: ${e}\n\n`).join('');

describe('sseEvents 解析器', () => {
  it('跨 chunk 分帧、跳过非 data 行、保留 [DONE]', async () => {
    const chunks = ['data: {"a"', ':1}\n\nevent: ping\ndata: ignored\n\n', '\ndata: [DONE]\n\n'];
    const stream = Readable.toWeb(Readable.from(chunks.map((c) => Buffer.from(c)))) as ReadableStream<Uint8Array>;
    const out: string[] = [];
    for await (const data of sseEvents(stream)) out.push(data);
    assert.deepEqual(out, ['{"a":1}', '[DONE]']);
  });
});

describe('OpenAI 网关', () => {
  let upstream: http.Server;
  let app: http.Server;
  let baseUrl: string;
  /** 每个用例设置上游 /chat-genui 返回的 SSE 剧本 */
  let chatReply = '';
  /** 上游最近一次收到的 /chat-genui 请求体 */
  let lastChatBody: string | null = null;

  before(async () => {
    upstream = http.createServer((req, res) => {
      if (req.url === '/get-models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([{ name: 'test_Foo Bar', features: {} }]));
        return;
      }
      if (req.url === '/chat-genui') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          lastChatBody = Buffer.concat(chunks).toString('utf8');
          res.setHeader('content-type', 'text/event-stream');
          res.end(chatReply);
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}`;

    const expressApp = express();
    expressApp.use(express.raw({ type: () => true }));
    expressApp.use('/v1', createOpenAIGateway({ upstream: upstreamUrl }));
    app = expressApp.listen(0, '127.0.0.1');
    await new Promise<void>((r) => app.on('listening', r));
    baseUrl = `http://127.0.0.1:${(app.address() as any).port}`;
  });

  after(async () => {
    await Promise.all([new Promise<void>((r) => app.close(() => r())), new Promise<void>((r) => upstream.close(() => r()))]);
  });

  const chat = (body: any) =>
    fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('非流式：SSE 聚合成 chat.completion，model 回写、usage 透传', async () => {
    chatReply = sse([
      '{"choices":[{"index":0,"delta":{"content":"你"}}]}',
      '{"choices":[{"index":0,"delta":{"content":"好"}}]}',
      '{"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      '[DONE]',
    ]);
    const res = await chat({ model: 'foo bar', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.object, 'chat.completion');
    assert.equal(json.model, 'test/foo-bar');
    assert.equal(json.choices[0].message.content, '你好');
    assert.equal(json.choices[0].finish_reason, 'stop');
    assert.equal(json.usage.total_tokens, 5);
  });

  it('流式：chunk 透传并回写 model，以 [DONE] 结尾', async () => {
    chatReply = sse([
      '{"choices":[{"index":0,"delta":{"content":"早"}}]}',
      '{"choices":[{"index":0,"delta":{"content":"安"}}]}',
      '[DONE]',
    ]);
    const res = await chat({ model: 'foo bar', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const text = await res.text();
    const lines = text.split('\n\n').filter((l) => l.startsWith('data: '));
    assert.equal(lines.at(-1), 'data: [DONE]');
    const chunks = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)));
    assert.equal(chunks.map((c: any) => c.choices?.[0]?.delta?.content || '').join(''), '早安');
    for (const c of chunks) assert.equal(c.model, 'test/foo-bar');
  });

  it('未知模型返回 404', async () => {
    const res = await chat({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 404);
  });

  describe('function calling 模拟', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'git_status',
          description: '查看仓库状态',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ];

    it('非流式：模型输出约定代码块时转为 tool_calls', async () => {
      chatReply = sse([
        `{"choices":[{"index":0,"delta":{"content":"\\u0060\\u0060\\u0060tool_call\\n{\\"name\\": \\"git_status\\", \\"arguments\\": {}}\\n\\u0060\\u0060\\u0060"}}]}`,
        '[DONE]',
      ]);
      const res = await chat({ model: 'foo bar', messages: [{ role: 'user', content: 'commit' }], tools });
      const json: any = await res.json();
      assert.equal(json.choices[0].finish_reason, 'tool_calls');
      const call = json.choices[0].message.tool_calls[0];
      assert.equal(call.type, 'function');
      assert.equal(call.function.name, 'git_status');
      assert.deepEqual(JSON.parse(call.function.arguments), {});
      assert.match(call.id, /^call_/);
      assert.equal(json.choices[0].message.content, '');
    });

    it('流式：带 tools 时返回合成的 tool_calls 增量并以 tool_calls 结束', async () => {
      chatReply = sse([
        `{"choices":[{"index":0,"delta":{"content":"\\u0060\\u0060\\u0060tool_call\\n{\\"name\\": \\"git_status\\", \\"arguments\\": {\\"q\\": 1}}\\n\\u0060\\u0060\\u0060"}}]}`,
        '[DONE]',
      ]);
      const res = await chat({ model: 'foo bar', stream: true, messages: [{ role: 'user', content: 'commit' }], tools });
      assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
      const lines = (await res.text()).split('\n\n').filter((l) => l.startsWith('data: '));
      assert.equal(lines.at(-1), 'data: [DONE]');
      const chunks = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)));
      const callDelta = chunks[0].choices[0].delta.tool_calls[0];
      assert.equal(callDelta.function.name, 'git_status');
      assert.deepEqual(JSON.parse(callDelta.function.arguments), { q: 1 });
      assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
    });

    it('role=tool 结果降级为 user 文本传给上游', async () => {
      chatReply = sse(['{"choices":[{"index":0,"delta":{"content":"ok"}}]}', '[DONE]']);
      await chat({
        model: 'foo bar',
        messages: [
          { role: 'user', content: 'commit' },
          { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'git_status', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c1', name: 'git_status', content: 'nothing to commit' },
        ],
        tools,
      });
      const sent = JSON.parse(lastChatBody!);
      // 网关会在末尾追加 NEUTRALIZE + 工具提示词两条 system 消息
      assert.deepEqual(
        sent.messages.slice(0, 3).map((m: any) => m.role),
        ['user', 'assistant', 'user'],
      );
      assert.match(sent.messages[2].content, /git_status.*nothing to commit/s);
      assert.match(sent.messages[1].content, /```tool_call[\s\S]*"git_status"/);
    });

    it('带 tools 但模型走自然语言时正常返回内容', async () => {
      chatReply = sse(['{"choices":[{"index":0,"delta":{"content":"直接回答"}}]}', '[DONE]']);
      const res = await chat({ model: 'foo bar', stream: true, messages: [{ role: 'user', content: 'hi' }], tools });
      const lines = (await res.text()).split('\n\n').filter((l) => l.startsWith('data: '));
      const chunks = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)));
      assert.equal(chunks[0].choices[0].delta.content, '直接回答');
      assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
    });

    it('兜底：模型输出 [调用工具 X，参数 {...}] 旧格式也能转成 tool_calls', async () => {
      chatReply = sse(['{"choices":[{"index":0,"delta":{"content":"[调用工具 bash，参数 {\\"command\\": \\"git status\\"}]"}}]}', '[DONE]']);
      const res = await chat({ model: 'foo bar', messages: [{ role: 'user', content: 'hi' }], tools });
      const json: any = await res.json();
      assert.equal(json.choices[0].finish_reason, 'tool_calls');
      assert.equal(json.choices[0].message.tool_calls[0].function.name, 'bash');
      assert.deepEqual(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments), { command: 'git status' });
      assert.equal(json.choices[0].message.content, '');
    });
  });

  it('设置了 api-key 后拒绝错误鉴权', async () => {
    const upstreamPort = (upstream.address() as any).port;
    const guarded = express();
    guarded.use(express.raw({ type: () => true }));
    guarded.use('/v1', createOpenAIGateway({ upstream: `http://127.0.0.1:${upstreamPort}`, apiKey: 'sk-secret' }));
    const server = guarded.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.on('listening', r));
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(res.status, 401);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
