"use client";

import { useChat, type Message } from "@ai-sdk/react";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const SESSION_STORAGE_KEY = "local-llm-benchmark-session-v1";

type MessageMetrics = {
  model?: string;
  ttftMs?: number;
  generationSeconds?: number;
  promptTokens?: number;
  completionTokens?: number;
  tokensEstimated?: boolean;
};

type SessionSnapshot = {
  version: 2;
  messages: Message[];
  metrics: Record<string, MessageMetrics>;
  selectedModel: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelResponse(
  value: unknown,
): value is { models: string[]; defaultModel: string; warning?: string } {
  return (
    isRecord(value) &&
    Array.isArray(value.models) &&
    value.models.every((entry) => typeof entry === "string") &&
    typeof value.defaultModel === "string" &&
    (value.warning === undefined || typeof value.warning === "string")
  );
}

function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false;
  const message = value;
  return (
    typeof message.id === "string" &&
    typeof message.content === "string" &&
    ["system", "user", "assistant", "data"].includes(String(message.role))
  );
}

function isMessageMetrics(value: unknown): value is MessageMetrics {
  if (!isRecord(value)) return false;
  const metrics = value;
  return (
    (metrics.model === undefined || typeof metrics.model === "string") &&
    ["ttftMs", "generationSeconds", "promptTokens", "completionTokens"].every(
      (key) =>
        metrics[key] === undefined ||
        (typeof metrics[key] === "number" &&
          Number.isFinite(metrics[key]) &&
          metrics[key] >= 0),
    ) &&
    (metrics.tokensEstimated === undefined ||
      typeof metrics.tokensEstimated === "boolean")
  );
}

function parseSessionSnapshot(value: unknown): SessionSnapshot | null {
  if (!isRecord(value)) return null;
  const snapshot = value;
  if (
    (snapshot.version !== 1 && snapshot.version !== 2) ||
    !Array.isArray(snapshot.messages) ||
    !snapshot.messages.every(isMessage) ||
    !snapshot.metrics ||
    !isRecord(snapshot.metrics) ||
    (snapshot.selectedModel !== undefined &&
      snapshot.selectedModel !== null &&
      typeof snapshot.selectedModel !== "string")
  ) {
    return null;
  }

  const metrics = snapshot.metrics;
  if (!Object.values(metrics).every(isMessageMetrics)) return null;

  return {
    version: 2,
    messages: snapshot.messages,
    metrics: metrics as Record<string, MessageMetrics>,
    selectedModel:
      typeof snapshot.selectedModel === "string" ? snapshot.selectedModel : null,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function splitThinkingContent(content: string): {
  reasoning: string[];
  answer: string;
} {
  const reasoning: string[] = [];
  let answer = "";
  let remaining = content;

  while (true) {
    const openingTag = remaining.indexOf("<think>");
    if (openingTag < 0) {
      answer += remaining;
      break;
    }

    answer += remaining.slice(0, openingTag);
    const reasoningStart = openingTag + "<think>".length;
    const closingTag = remaining.indexOf("</think>", reasoningStart);
    if (closingTag < 0) {
      reasoning.push(remaining.slice(reasoningStart));
      break;
    }

    reasoning.push(remaining.slice(reasoningStart, closingTag));
    remaining = remaining.slice(closingTag + "</think>".length);
  }

  return { reasoning, answer };
}

function BenchmarkChat() {
  const [metrics, setMetrics] = useState<Record<string, MessageMetrics>>({});
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelWarning, setModelWarning] = useState<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const pendingPromptTokensRef = useRef(0);
  const pendingAssistantIdRef = useRef<string | null>(null);
  const submittedModelRef = useRef<string | null>(null);
  const pendingSessionModelRef = useRef<string | null>(null);
  const availableModelsRef = useRef<string[]>([]);
  const defaultModelRef = useRef("qwen3:8b");
  const firstTokenAtRef = useRef<number | null>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);

  const onFinish = useCallback(
    (
      message: Message,
      options: {
        usage?: { promptTokens?: number; completionTokens?: number };
      },
    ) => {
      const startedAt = startedAtRef.current;
      if (startedAt === null) return;

      const finishedAt = performance.now();
      const generationSeconds = Math.max(0, (finishedAt - startedAt) / 1000);
      const firstTokenAt = firstTokenAtRef.current;
      const completionText = message.content;
      const promptTokens = options.usage?.promptTokens;
      const completionTokens = options.usage?.completionTokens;
      const hasUsage =
        typeof promptTokens === "number" &&
        Number.isFinite(promptTokens) &&
        typeof completionTokens === "number" &&
        Number.isFinite(completionTokens);

      setMetrics((current) => ({
        ...current,
        [message.id]: {
          model: submittedModelRef.current ?? undefined,
          ttftMs:
            firstTokenAt === null
              ? undefined
              : Math.max(0, firstTokenAt - startedAt),
          generationSeconds,
          promptTokens: hasUsage
            ? promptTokens
            : pendingPromptTokensRef.current,
          completionTokens: hasUsage
            ? completionTokens
            : estimateTokens(completionText),
          tokensEstimated: !hasUsage,
        },
      }));
      startedAtRef.current = null;
      pendingPromptTokensRef.current = 0;
      pendingAssistantIdRef.current = null;
      submittedModelRef.current = null;
      firstTokenAtRef.current = null;
    },
    [],
  );

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    setMessages,
    setInput,
    status,
    stop,
    error,
  } = useChat({
    api: "/api/chat",
    id: "local-llm-benchmark",
    initialMessages: [],
    onFinish,
    onError: () => {
      startedAtRef.current = null;
      pendingPromptTokensRef.current = 0;
      pendingAssistantIdRef.current = null;
      submittedModelRef.current = null;
      firstTokenAtRef.current = null;
    },
  });

  useEffect(() => {
    let active = true;

    async function loadModel() {
      try {
        const response = await fetch("/api/chat");
        if (!response.ok) {
          throw new Error(`El servidor respondió con HTTP ${response.status}.`);
        }
        const result: unknown = await response.json();
        if (!isModelResponse(result)) {
          throw new Error("La respuesta del servidor no contiene modelos válidos.");
        }
        const availableModels = result.models
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (availableModels.length === 0) {
          throw new Error("El servidor no devolvió ningún modelo disponible.");
        }
        if (active) {
          availableModelsRef.current = availableModels;
          defaultModelRef.current = result.defaultModel;
          setModels(availableModels);
          setModelWarning(
            typeof result.warning === "string" ? result.warning : null,
          );
          const restoredModel = pendingSessionModelRef.current;
          setSelectedModel((current) => {
            const preferred = restoredModel ?? current ?? result.defaultModel;
            return availableModels.includes(preferred)
              ? preferred
              : availableModels.includes(result.defaultModel)
                ? result.defaultModel
                : availableModels[0];
          });
          pendingSessionModelRef.current = null;
        }
      } catch (loadError) {
        if (active) {
          setModelError(
            loadError instanceof Error
              ? loadError.message
              : "No se pudo consultar el modelo local.",
          );
        }
      }
    }

    loadModel();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      try {
        const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (stored) {
          const snapshot = parseSessionSnapshot(JSON.parse(stored) as unknown);
          if (!snapshot) {
            throw new Error("Los datos guardados no tienen un formato válido.");
          }
          setMessages(snapshot.messages);
          setMetrics(snapshot.metrics);
          pendingSessionModelRef.current = snapshot.selectedModel;
          if (
            snapshot.selectedModel &&
            availableModelsRef.current.includes(snapshot.selectedModel)
          ) {
            setSelectedModel(snapshot.selectedModel);
            pendingSessionModelRef.current = null;
          }
        }
      } catch (restoreError) {
        setStorageError(
          restoreError instanceof Error
            ? `No se pudo restaurar la sesión: ${restoreError.message}`
            : "No se pudo restaurar la sesión del navegador.",
        );
      } finally {
        if (active) setSessionReady(true);
      }
    }, 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [setMessages]);

  useEffect(() => {
    if (!sessionReady) return;

    try {
      if (messages.length === 0 && Object.keys(metrics).length === 0) {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        return;
      }
      const snapshot: SessionSnapshot = {
        version: 2,
        messages,
        metrics,
        selectedModel,
      };
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    } catch (writeError) {
      const message =
        writeError instanceof Error
          ? `No se pudo guardar la sesión: ${writeError.message}`
          : "No se pudo guardar la sesión en este navegador.";
      window.setTimeout(() => setStorageError(message), 0);
    }
  }, [messages, metrics, selectedModel, sessionReady]);

  useLayoutEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (
      startedAtRef.current === null ||
      !lastMessage ||
      lastMessage.role !== "assistant" ||
      lastMessage.content.length === 0 ||
      pendingAssistantIdRef.current === lastMessage.id
    ) {
      return;
    }

    const firstTokenAt = performance.now();
    pendingAssistantIdRef.current = lastMessage.id;
    firstTokenAtRef.current = firstTokenAt;
    const ttftMs = Math.max(0, firstTokenAt - startedAtRef.current);
    setMetrics((current) => ({
      ...current,
      [lastMessage.id]: {
        ...current[lastMessage.id],
        model: submittedModelRef.current ?? undefined,
        ttftMs,
      },
    }));
  }, [messages]);

  useLayoutEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  function submitPrompt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      status === "submitted" ||
      status === "streaming" ||
      !input.trim() ||
      !selectedModel
    ) {
      return;
    }

    const promptText = [...messages.map((message) => message.content), input].join(
      "\n",
    );
    startedAtRef.current = performance.now();
    pendingPromptTokensRef.current = estimateTokens(promptText);
    pendingAssistantIdRef.current = null;
    submittedModelRef.current = selectedModel;
    firstTokenAtRef.current = null;
    handleSubmit(event, { body: { model: selectedModel } });
  }

  function clearSession() {
    stop();
    startedAtRef.current = null;
    pendingPromptTokensRef.current = 0;
    pendingAssistantIdRef.current = null;
    submittedModelRef.current = null;
    firstTokenAtRef.current = null;
    setMessages([]);
    setMetrics({});
    setInput("");
    setSelectedModel(
      availableModelsRef.current.includes(defaultModelRef.current)
        ? defaultModelRef.current
        : (availableModelsRef.current[0] ?? null),
    );
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      setStorageError(null);
    } catch (removeError) {
      setStorageError(
        removeError instanceof Error
          ? `No se pudo limpiar el almacenamiento: ${removeError.message}`
          : "No se pudo limpiar el almacenamiento de sesión.",
      );
    }
  }

  const completedMetrics = Object.values(metrics).filter(
    (entry) =>
      entry.generationSeconds !== undefined &&
      entry.ttftMs !== undefined &&
      entry.completionTokens !== undefined,
  );
  const averageTtft =
    completedMetrics.length > 0
      ? completedMetrics.reduce((sum, entry) => sum + (entry.ttftMs ?? 0), 0) /
        completedMetrics.length
      : null;
  const tpsMetrics = completedMetrics.filter(
    (entry) => (entry.generationSeconds ?? 0) > 0,
  );
  const averageTps =
    tpsMetrics.length > 0
      ? tpsMetrics.reduce(
          (sum, entry) =>
            sum +
            (entry.completionTokens ?? 0) / (entry.generationSeconds ?? 1),
          0,
        ) / tpsMetrics.length
      : null;
  const isGenerating = status === "submitted" || status === "streaming";

  return (
    <main className="benchmark-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◉
          </span>
          <div>
            <p className="eyebrow">LOCAL INFERENCE</p>
            <h1>LLM Benchmark</h1>
          </div>
        </div>
        <div className="session-summary" aria-label="Resumen de sesión">
          <div className="summary-item">
            <label className="summary-label" htmlFor="model-select">
              MODELO
            </label>
            <select
              className="model-select"
              disabled={models.length === 0}
              id="model-select"
              onChange={(event) => setSelectedModel(event.target.value)}
              value={selectedModel ?? ""}
            >
              <option disabled value="">
                {modelError ? "No disponible" : "Cargando modelos…"}
              </option>
              {models.map((availableModel) => (
                <option key={availableModel} value={availableModel}>
                  {availableModel}
                </option>
              ))}
            </select>
          </div>
          <div className="summary-item">
            <span className="summary-label">TTFT PROM.</span>
            <span className="summary-value">
              {averageTtft === null ? "—" : `${averageTtft.toFixed(0)} ms`}
            </span>
          </div>
          <div className="summary-item">
            <span className="summary-label">TPS PROM.</span>
            <span className="summary-value">
              {averageTps === null ? "—" : `${averageTps.toFixed(1)} tok/s`}
            </span>
          </div>
        </div>
        <button
          className="clear-button"
          disabled={!sessionReady}
          onClick={clearSession}
          type="button"
        >
          Limpiar sesión
        </button>
      </header>
      {modelWarning && (
        <p className="model-warning" role="status">
          {modelWarning}
        </p>
      )}

      <section className="conversation" aria-label="Conversación de benchmark">
        {messages.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              ⌁
            </span>
            <h2>Prueba tu modelo local</h2>
            <p>
              Envía un prompt para medir latencia, duración y velocidad de
              generación en tiempo real.
            </p>
            <div className="connection-status">
              <span
                className={selectedModel ? "status-dot connected" : "status-dot"}
              />
              {selectedModel
                ? `Conectado a ${selectedModel}`
                : modelError
                  ? `Error de conexión: ${modelError}`
                  : "Conectando con el servidor local…"}
            </div>
            {isGenerating && (
              <div className="streaming-indicator" role="status">
                <span className="status-dot connected" />
                Generando respuesta…
              </div>
            )}
          </div>
        ) : (
          <div className="message-list">
            {messages.map((message) => {
              const isAssistant = message.role === "assistant";
              const messageMetrics = metrics[message.id];
              const thinking = isAssistant
                ? splitThinkingContent(message.content)
                : { reasoning: [], answer: message.content };
              const tps =
                messageMetrics?.generationSeconds &&
                messageMetrics.generationSeconds > 0 &&
                messageMetrics.completionTokens !== undefined
                  ? messageMetrics.completionTokens /
                    messageMetrics.generationSeconds
                  : null;

              return (
                <article
                  className={`message-row ${isAssistant ? "assistant-row" : "user-row"}`}
                  key={message.id}
                >
                  <div className="message-avatar" aria-hidden="true">
                    {isAssistant ? "AI" : "YO"}
                  </div>
                  <div className="message-body">
                    <div className="message-heading">
                      <span>{isAssistant ? "Asistente" : "Tú"}</span>
                      {isAssistant && messageMetrics?.tokensEstimated && (
                        <span className="estimate-label">TOKENS ESTIMADOS</span>
                      )}
                    </div>
                    {thinking.reasoning.length > 0 && (
                      <details className="thinking-block">
                        <summary>Proceso de razonamiento</summary>
                        <p className="thinking-content whitespace-pre-wrap">
                          {thinking.reasoning.join("\n")}
                        </p>
                      </details>
                    )}
                    {thinking.answer && (
                      <p className="message-content whitespace-pre-wrap">
                        {thinking.answer}
                      </p>
                    )}
                    {isAssistant && (
                      <div className="metrics-strip" aria-label="Métricas de respuesta">
                        <Metric label="MODELO">
                          {messageMetrics?.model ?? "—"}
                        </Metric>
                        <Metric label="TTFT">
                          {messageMetrics?.ttftMs === undefined
                            ? "—"
                            : `${messageMetrics.ttftMs.toFixed(0)} ms`}
                        </Metric>
                        <Metric label="TOTAL">
                          {messageMetrics?.generationSeconds === undefined
                            ? "—"
                            : `${messageMetrics.generationSeconds.toFixed(2)} s`}
                        </Metric>
                        <Metric label="TPS">
                          {tps === null ? "—" : `${tps.toFixed(1)} tok/s`}
                        </Metric>
                        <Metric label="TOKENS">
                          {messageMetrics?.promptTokens === undefined ||
                          messageMetrics.completionTokens === undefined
                            ? "—"
                            : `${messageMetrics.promptTokens} in / ${messageMetrics.completionTokens} out`}
                        </Metric>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
            {isGenerating && (
              <div className="streaming-indicator" role="status">
                <span className="status-dot connected" />
                Generando respuesta…
              </div>
            )}
            <div ref={conversationEndRef} />
          </div>
        )}
      </section>

      <div className="composer-wrap">
        {(storageError || error) && (
          <p className="error-banner" role="alert">
            {storageError ?? error?.message}
          </p>
        )}
        {modelError && !error && (
          <p className="error-banner" role="alert">
            No se pudo obtener el modelo configurado: {modelError}
          </p>
        )}
        <form className="composer" onSubmit={submitPrompt}>
          <textarea
            aria-label="Prompt"
            autoComplete="off"
            disabled={!sessionReady || isGenerating}
            onChange={handleInputChange}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Escribe un prompt para tu modelo local…"
            rows={1}
            value={input}
          />
          <button
            aria-label="Enviar prompt"
            className="send-button"
            disabled={!sessionReady || isGenerating || !input.trim()}
            type="submit"
          >
            {isGenerating ? "…" : "Enviar"}
          </button>
        </form>
        <p className="composer-hint">
          Intro para enviar <span>·</span> Tus datos permanecen en esta pestaña
        </p>
      </div>
    </main>
  );
}

function Metric({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="metric-item">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{children}</span>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <main className="benchmark-shell">
          <div className="empty-state">
            <p>Preparando sesión local…</p>
          </div>
        </main>
      }
    >
      <BenchmarkChat />
    </Suspense>
  );
}
