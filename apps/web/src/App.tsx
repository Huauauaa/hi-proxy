import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ModelInfo {
  id: string;
  display_name?: string;
  owned_by?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  model?: string;
  error?: boolean;
}

const SYSTEM_PROMPT_KEY = "hi-proxy.system-prompt";

function classNames(...xs: Array<string | false | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export default function App() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<string>("");
  const [systemPrompt, setSystemPrompt] = useState(
    () => localStorage.getItem(SYSTEM_PROMPT_KEY) ?? "",
  );
  const [showSystem, setShowSystem] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 拉取模型列表
  useEffect(() => {
    fetch("/v1/models")
      .then((r) => r.json())
      .then((data) => {
        const list: ModelInfo[] = data?.data ?? [];
        setModels(list);
        if (list.length > 0) setModel((cur) => cur || list[0].id);
      })
      .catch(() => setError("无法获取模型列表，请确认 hi-proxy 已启动"));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || !model) return;

    const history = [...messages, { role: "user" as const, content: text }];
    setMessages([...history, { role: "assistant", content: "", model }]);
    setInput("");
    setError(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(systemPrompt.trim()
          ? [{ role: "system", content: systemPrompt.trim() }]
          : []),
        ...history.map(({ role, content }) => ({ role, content })),
      ],
      stream: true,
    };

    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload);
            if (json.error) throw new Error(json.error?.message ?? "上游返回错误");
            const delta = json.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) {
              acc += delta;
              setMessages((ms) => {
                const next = [...ms];
                next[next.length - 1] = {
                  ...next[next.length - 1],
                  content: acc,
                  model,
                };
                return next;
              });
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue; // 非完整 JSON，忽略
            throw e;
          }
        }
      }

      if (!acc) {
        setMessages((ms) => {
          const next = [...ms];
          next[next.length - 1] = {
            ...next[next.length - 1],
            content: "（上游未返回内容）",
            error: true,
          };
          return next;
        });
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // 用户主动停止，保留已生成内容
      } else {
        const msg = (e as Error).message ?? String(e);
        setError(msg);
        setMessages((ms) => {
          const next = [...ms];
          if (next.length && !next[next.length - 1].content) {
            next[next.length - 1] = {
              ...next[next.length - 1],
              content: `请求失败：${msg}`,
              error: true,
            };
          }
          return next;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, streaming, model, messages, systemPrompt]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    if (streaming) return;
    setMessages([]);
    setError(null);
  }, [streaming]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4 py-3 backdrop-blur">
        <h1 className="text-sm font-semibold tracking-wide text-zinc-200">
          hi-proxy
          <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] font-normal text-zinc-400">
            /v1
          </span>
        </h1>

        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="max-w-[240px] rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-emerald-600"
        >
          {models.length === 0 && <option value="">加载模型中…</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name ? `${m.display_name} (${m.id})` : m.id}
            </option>
          ))}
        </select>

        <button
          onClick={() => setShowSystem((v) => !v)}
          className={classNames(
            "rounded-md border px-2.5 py-1.5 text-xs transition-colors",
            showSystem || systemPrompt
              ? "border-emerald-700 bg-emerald-900/40 text-emerald-300"
              : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700",
          )}
        >
          系统提示词
        </button>

        <div className="ml-auto flex items-center gap-2">
          {lastAssistant && !streaming && (
            <button
              onClick={() => {
                navigator.clipboard.writeText(lastAssistant.content);
              }}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              复制回复
            </button>
          )}
          <button
            onClick={clear}
            disabled={streaming || messages.length === 0}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
          >
            清空会话
          </button>
        </div>
      </header>

      {/* 系统提示词编辑 */}
      {showSystem && (
        <div className="border-b border-zinc-800 bg-zinc-900/40 px-4 py-3">
          <textarea
            value={systemPrompt}
            onChange={(e) => {
              setSystemPrompt(e.target.value);
              localStorage.setItem(SYSTEM_PROMPT_KEY, e.target.value);
            }}
            rows={3}
            placeholder="可选。设置后会作为 system 消息发送给模型…"
            className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-emerald-600"
          />
        </div>
      )}

      {/* 消息区 */}
      <main className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {messages.length === 0 && (
            <div className="mt-16 text-center text-sm text-zinc-500">
              <p className="text-base text-zinc-300">hi-proxy chat</p>
              <p className="mt-2">
                本地 OpenAI 兼容网关的测试页面 · 模型列表来自{" "}
                <code className="rounded bg-zinc-800 px-1">/v1/models</code>
              </p>
            </div>
          )}

          {messages.map((m, i) => (
            <div
              key={i}
              className={classNames(
                "flex flex-col rounded-xl border px-4 py-3",
                m.role === "user"
                  ? "self-end border-emerald-800/60 bg-emerald-950/40 text-emerald-50"
                  : "self-stretch border-zinc-800 bg-zinc-900/70",
              )}
            >
              <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-500">
                <span className="font-medium text-zinc-400">
                  {m.role === "user" ? "你" : "助手"}
                </span>
                {m.model && <span className="rounded bg-zinc-800 px-1.5">{m.model}</span>}
              </div>
              {m.role === "assistant" ? (
                <div className="prose-invert max-w-none break-words text-sm leading-6 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-600 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:text-[13px] [&_h1]:mt-3 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-zinc-950 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-2 [&_table]:w-full [&_td]:border [&_td]:border-zinc-700 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-zinc-700 [&_th]:bg-zinc-800 [&_th]:px-2 [&_th]:py-1 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
                  <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown>
                </div>
              ) : (
                <div className="whitespace-pre-wrap break-words text-sm leading-6">
                  {m.content}
                </div>
              )}
            </div>
          ))}

          {streaming && (
            <div className="flex items-center gap-2 self-stretch text-xs text-zinc-500">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              生成中…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      {/* 错误提示 */}
      {error && (
        <div className="mx-4 mb-2 rounded-md border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* 输入区 */}
      <footer className="border-t border-zinc-800 bg-zinc-900/60 px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            className="max-h-40 min-h-[44px] flex-1 resize-y rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-emerald-600"
          />
          {streaming ? (
            <button
              onClick={stop}
              className="h-[44px] rounded-lg bg-red-800 px-4 text-sm font-medium text-red-100 hover:bg-red-700"
            >
              停止
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!input.trim() || !model}
              className="h-[44px] rounded-lg bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
            >
              发送
            </button>
          )}
        </div>
        <p className="mx-auto mt-2 max-w-3xl text-[11px] text-zinc-600">
          流式响应 · max_tokens / stop 会被上游忽略 · 服务：hi-proxy @ :3010
        </p>
      </footer>
    </div>
  );
}
