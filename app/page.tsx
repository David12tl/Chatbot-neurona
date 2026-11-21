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
import { StressTestModule } from "./components/StressTestModule";

const SESSION_STORAGE_KEY = "local-llm-benchmark-session-v1";
const STRESS_STORAGE_KEY = "local-llm-stress-history-v1";

type MessageMetrics = {
  model?: string;
  ttftMs?: number;
  generationSeconds?: number;
  promptTokens?: number;
  completionTokens?: number;
  tokensEstimated?: boolean;
  timedOut?: boolean;
  error?: string;
};

type SessionSnapshot = {
  version: 2;
  messages: Message[];
  metrics: Record<string, MessageMetrics>;
  selectedModel: string | null;
  thinking?: boolean;
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
      typeof metrics.tokensEstimated === "boolean") &&
    (metrics.timedOut === undefined || typeof metrics.timedOut === "boolean") &&
    (metrics.error === undefined || typeof metrics.error === "string")
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
    thinking: typeof snapshot.thinking === "boolean" ? snapshot.thinking : true,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface ParsedThinking {
  reasoning: string;
  answer: string;
  isThinkingActive: boolean;
  hasReasoning: boolean;
}

function parseThinkingMessage(content: string): ParsedThinking {
  const reasoningChunks: string[] = [];
  let answer = "";
  let remaining = content;
  let isThinkingActive = false;
  let sawThinkTag = false;

  while (true) {
    const openIdx = remaining.indexOf("<think>");
    if (openIdx < 0) {
      answer += remaining;
      break;
    }

    sawThinkTag = true;
    answer += remaining.slice(0, openIdx);
    const reasoningStart = openIdx + "<think>".length;
    const closeIdx = remaining.indexOf("</think>", reasoningStart);

    if (closeIdx < 0) {
      // Bloque <think> abierto sin etiqueta de cierre </think> (streaming activo)
      reasoningChunks.push(remaining.slice(reasoningStart));
      isThinkingActive = true;
      break;
    }

    reasoningChunks.push(remaining.slice(reasoningStart, closeIdx));
    remaining = remaining.slice(closeIdx + "</think>".length);
  }

  const reasoning = reasoningChunks.join("\n\n").trim();
  const cleanAnswer = answer;

  return {
    reasoning,
    answer: cleanAnswer,
    isThinkingActive,
    hasReasoning: sawThinkTag || reasoning.length > 0,
  };
}

function ReasoningAccordion({
  reasoning,
  isThinkingActive,
}: {
  reasoning: string;
  isThinkingActive: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll interno para ver correr los tokens en tiempo real
  useEffect(() => {
    if (isThinkingActive && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [reasoning, isThinkingActive]);

  // Mientras la etiqueta </think> aún no haya llegado, mantener el bloque abierto
  const isOpen = isThinkingActive || !collapsed;
  const tokenCount = estimateTokens(reasoning);

  return (
    <div
      style={{
        margin: "0 0 14px 0",
        background: "rgba(14, 18, 23, 0.85)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderLeft: isThinkingActive
          ? "3px solid var(--accent)"
          : "3px solid rgba(115, 224, 176, 0.45)",
        borderRadius: "8px",
        overflow: "hidden",
        fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      <button
        onClick={() => {
          if (!isThinkingActive) {
            setCollapsed((prev) => !prev);
          }
        }}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          background: isThinkingActive
            ? "rgba(115, 224, 176, 0.06)"
            : "rgba(255, 255, 255, 0.02)",
          border: "none",
          borderBottom: isOpen ? "1px solid rgba(255, 255, 255, 0.05)" : "none",
          cursor: isThinkingActive ? "default" : "pointer",
          color: "inherit",
          textAlign: "left",
        }}
        type="button"
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {isThinkingActive ? (
            <span
              style={{
                display: "inline-block",
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: "var(--accent)",
                boxShadow: "0 0 8px var(--accent)",
                animation: "pulse-animation 1.2s infinite ease-in-out",
              }}
            />
          ) : (
            <span
              style={{
                fontSize: "10px",
                color: "var(--muted)",
                transition: "transform 0.15s ease",
                transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
              }}
            >
              ▶
            </span>
          )}

          <span
            style={{
              fontSize: "12px",
              fontWeight: 650,
              color: isThinkingActive ? "var(--accent)" : "#d1d5db",
            }}
          >
            {isThinkingActive ? "Razonando en vivo…" : "Proceso de razonamiento"}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {tokenCount > 0 && (
            <span
              style={{
                fontSize: "11px",
                color: "var(--muted)",
                background: "rgba(255, 255, 255, 0.06)",
                padding: "2px 7px",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                borderRadius: "4px",
              }}
            >
              ~{tokenCount} tokens
            </span>
          )}
          {!isThinkingActive && (
            <span style={{ fontSize: "11px", color: "var(--muted)" }}>
              {isOpen ? "Ocultar" : "Mostrar"}
            </span>
          )}
        </div>
      </button>

      {isOpen && (
        <div
          ref={scrollRef}
          style={{
            maxHeight: "280px",
            overflowY: "auto",
            padding: "10px 14px",
            fontSize: "12px",
            lineHeight: 1.6,
            color: "#9ca3af",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {reasoning || (
            <span style={{ fontStyle: "italic", color: "var(--muted)" }}>
              Generando proceso de razonamiento preliminar…
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function BenchmarkChat() {
  const [activeTab, setActiveTab] = useState<"chat" | "stress">("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [thinking, setThinking] = useState(true); // Thinking ON por defecto en Chat
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
  const messageModelMapRef = useRef<Record<string, string>>({});
  const pendingSessionModelRef = useRef<string | null>(null);
  const availableModelsRef = useRef<string[]>([]);
  const defaultModelRef = useRef("qwen3:8b");
  const [defaultModel, setDefaultModel] = useState("qwen3:8b");
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

      const assignedModel =
        submittedModelRef.current ||
        messageModelMapRef.current[message.id] ||
        selectedModel ||
        defaultModelRef.current ||
        "qwen3:8b";

      messageModelMapRef.current[message.id] = assignedModel;

      const isTimedOut = generationSeconds >= 295;

      setMetrics((current) => ({
        ...current,
        [message.id]: {
          ...current[message.id],
          model: assignedModel,
          ttftMs:
            firstTokenAt === null
              ? current[message.id]?.ttftMs
              : Math.max(0, firstTokenAt - startedAt),
          generationSeconds,
          promptTokens: hasUsage
            ? promptTokens
            : pendingPromptTokensRef.current,
          completionTokens: hasUsage
            ? completionTokens
            : estimateTokens(completionText),
          tokensEstimated: !hasUsage,
          timedOut: isTimedOut,
        },
      }));

      startedAtRef.current = null;
      pendingPromptTokensRef.current = 0;
      pendingAssistantIdRef.current = null;
      submittedModelRef.current = null;
      firstTokenAtRef.current = null;
    },
    [selectedModel],
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
    onError: (err) => {
      const startedAt = startedAtRef.current;
      const assistantId = pendingAssistantIdRef.current;
      const elapsedSec = startedAt ? (performance.now() - startedAt) / 1000 : 0;
      const isTimeout =
        elapsedSec >= 290 ||
        err.message?.includes("504") ||
        err.message?.toLowerCase().includes("timeout");

      if (assistantId) {
        setMetrics((current) => ({
          ...current,
          [assistantId]: {
            ...current[assistantId],
            model:
              submittedModelRef.current ||
              messageModelMapRef.current[assistantId] ||
              selectedModel ||
              "qwen3:8b",
            timedOut: isTimeout,
            error: isTimeout
              ? "⚠️ Corte por timeout de servidor (300s)"
              : err.message,
          },
        }));
      }

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
          setDefaultModel(result.defaultModel);
          setModels(availableModels);
          setModelWarning(
            result.warning && result.warning.trim().length > 0
              ? result.warning
              : null,
          );
          setSelectedModel((current) => {
            if (current && availableModels.includes(current)) {
              return current;
            }
            if (
              pendingSessionModelRef.current &&
              availableModels.includes(pendingSessionModelRef.current)
            ) {
              const restored = pendingSessionModelRef.current;
              pendingSessionModelRef.current = null;
              return restored;
            }
            if (availableModels.includes(result.defaultModel)) {
              return result.defaultModel;
            }
            return availableModels[0] ?? null;
          });
          setModelError(null);
        }
      } catch (err) {
        if (active) {
          const fallback = ["qwen3:8b", "qwen3:30b"];
          availableModelsRef.current = fallback;
          setModels(fallback);
          setSelectedModel((current) => current ?? fallback[0]);
          setModelError(
            err instanceof Error
              ? err.message
              : "No se pudieron obtener los modelos.",
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
          if (typeof snapshot.thinking === "boolean") {
            setThinking(snapshot.thinking);
          }
          // Restaurar mapa de modelos
          Object.entries(snapshot.metrics).forEach(([msgId, m]) => {
            if (m.model) messageModelMapRef.current[msgId] = m.model;
          });

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
        thinking,
      };
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    } catch (writeError) {
      const message =
        writeError instanceof Error
          ? `No se pudo guardar la sesión: ${writeError.message}`
          : "No se pudo guardar la sesión en este navegador.";
      window.setTimeout(() => setStorageError(message), 0);
    }
  }, [messages, metrics, selectedModel, thinking, sessionReady]);

  useLayoutEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (
      startedAtRef.current === null ||
      !lastMessage ||
      lastMessage.role !== "assistant" ||
      pendingAssistantIdRef.current === lastMessage.id
    ) {
      return;
    }

    const assignedModel =
      submittedModelRef.current ||
      selectedModel ||
      defaultModelRef.current ||
      "qwen3:8b";

    messageModelMapRef.current[lastMessage.id] = assignedModel;

    if (lastMessage.content.length > 0) {
      const firstTokenAt = performance.now();
      pendingAssistantIdRef.current = lastMessage.id;
      firstTokenAtRef.current = firstTokenAt;
      const ttftMs = Math.max(0, firstTokenAt - startedAtRef.current);
      setMetrics((current) => ({
        ...current,
        [lastMessage.id]: {
          ...current[lastMessage.id],
          model: assignedModel,
          ttftMs,
        },
      }));
    } else {
      // Guardar el modelo asignado inmediatamente aunque no haya llegado el primer token
      setMetrics((current) => ({
        ...current,
        [lastMessage.id]: {
          ...current[lastMessage.id],
          model: assignedModel,
        },
      }));
    }
  }, [messages, selectedModel]);

  useEffect(() => {
    if (activeTab === "chat") {
      conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, activeTab]);

  function submitPrompt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt || isGenerating || !sessionReady) return;

    const activeModel =
      selectedModel ??
      (availableModelsRef.current.includes(defaultModelRef.current)
        ? defaultModelRef.current
        : (availableModelsRef.current[0] ?? "qwen3:8b"));

    startedAtRef.current = performance.now();
    pendingPromptTokensRef.current = estimateTokens(prompt);
    submittedModelRef.current = activeModel;
    firstTokenAtRef.current = null;
    pendingAssistantIdRef.current = null;

    handleSubmit(event, {
      data: {
        model: activeModel,
        thinking,
      },
    });
  }

  function clearSession() {
    if (isGenerating) stop();
    startedAtRef.current = null;
    pendingPromptTokensRef.current = 0;
    pendingAssistantIdRef.current = null;
    submittedModelRef.current = null;
    firstTokenAtRef.current = null;
    messageModelMapRef.current = {};
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
      sessionStorage.removeItem(STRESS_STORAGE_KEY);
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
    <main
      className={`benchmark-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
    >
      <aside
        className="sidebar"
        id="app-sidebar"
        aria-label="Navegación principal"
      >
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <span className="brand-mark material-icons" aria-hidden="true">
              flash
            </span>
            <div className="sidebar-brand-copy">
              <p className="eyebrow">LOCAL INFERENCE</p>
              <h1>LLM Benchmark</h1>
            </div>
          </div>
          <button
            aria-label="Ocultar menú"
            className="sidebar-close"
            onClick={() => setSidebarCollapsed(true)}
            title="Ocultar menú"
            type="button"
          >
            <span className="material-icons" aria-hidden="true">
              close
            </span>
          </button>
        </div>

        <div className="nav-tabs" role="tablist" aria-label="Secciones">
          <button
            aria-selected={activeTab === "chat"}
            className={`nav-tab ${activeTab === "chat" ? "active" : ""}`}
            onClick={() => setActiveTab("chat")}
            role="tab"
            type="button"
          >
            <span className="material-icons">chat</span>
            <span className="nav-label">Chat de Diagnóstico</span>
          </button>
          <button
            aria-selected={activeTab === "stress"}
            className={`nav-tab ${activeTab === "stress" ? "active" : ""}`}
            onClick={() => setActiveTab("stress")}
            role="tab"
            type="button"
          >
            <span className="material-icons">flash</span>
            <span className="nav-label">Pruebas de Estrés</span>
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <button
              aria-controls="app-sidebar"
              aria-expanded={!sidebarCollapsed}
              aria-label={sidebarCollapsed ? "Mostrar menú" : "Ocultar menú"}
              className="sidebar-toggle"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              title={sidebarCollapsed ? "Mostrar menú" : "Ocultar menú"}
              type="button"
            >
              <span className="material-icons" aria-hidden="true">
                {sidebarCollapsed ? "menu" : "menu_open"}
              </span>
            </button>
            <h2>
              {activeTab === "chat"
                ? "Chat de Diagnóstico"
                : "Pruebas de Estrés"}
            </h2>
          </div>

          {activeTab === "chat" ? (
            <div className="session-summary" aria-label="Resumen de sesión">
              {/* TOGGLE THINKING (QWEN 3) */}
              <div className="summary-item">
                <span className="summary-label">THINKING</span>
                <button
                  className={`topbar-thinking-btn ${thinking ? "on" : "off"}`}
                  disabled={isGenerating}
                  onClick={() => setThinking((v) => !v)}
                  title={
                    thinking
                      ? "Thinking activado: Qwen 3 emite proceso de razonamiento <think>"
                      : "Thinking desactivado: Inyecta /no_think para evitar timeouts de 300s"
                  }
                  type="button"
                >
                  <span className="material-icons">brain</span>
                  {thinking ? "ON" : "OFF (/no_think)"}
                </button>
              </div>

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
          ) : null}

          <button
            className="clear-button"
            disabled={!sessionReady}
            onClick={clearSession}
            title="Limpiar estado de chat y pruebas de estrés en este navegador"
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

        {/* VISTA 1: CHAT DE DIAGNÓSTICO */}
        {activeTab === "chat" && (
          <>
            <section
              className="conversation"
              aria-label="Conversación de benchmark"
            >
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
                  <span className="status-dot connected" />
                  <span>
                    Conectado a{" "}
                    <strong>
                      {selectedModel ?? defaultModel}
                    </strong>{" "}
                    · Modo Thinking:{" "}
                    <strong style={{ color: thinking ? "var(--accent)" : "#fbbf24" }}>
                      {thinking ? "ON" : "OFF (/no_think)"}
                    </strong>
                  </span>
                </div>
              </div>
            ) : (
              <div className="message-list">
                {messages.map((message) => {
                  const messageMetric = metrics[message.id];
                  const assignedModel =
                    messageMetric?.model ||
                    selectedModel ||
                    defaultModel ||
                    "qwen3:8b";

                  const hasMetrics =
                    message.role === "assistant" &&
                    messageMetric &&
                    (messageMetric.ttftMs !== undefined ||
                      messageMetric.generationSeconds !== undefined ||
                      messageMetric.completionTokens !== undefined ||
                      messageMetric.timedOut === true);

                  const isMessageStreaming =
                    message.role === "assistant" &&
                    isGenerating &&
                    message.id === messages[messages.length - 1]?.id;

                  const parsed =
                    message.role === "assistant"
                      ? parseThinkingMessage(message.content)
                      : {
                          reasoning: "",
                          answer: message.content,
                          isThinkingActive: false,
                          hasReasoning: false,
                        };

                  const isActivelyThinking =
                    isMessageStreaming && parsed.isThinkingActive;

                  return (
                    <article
                      className={`message-row ${message.role}`}
                      key={message.id}
                    >
                      <div className="message-avatar">
                        {message.role === "user" ? "Tú" : "AI"}
                      </div>
                      <div className="message-card">
                        <div className="message-content">
                          {message.role === "assistant" &&
                            parsed.hasReasoning && (
                              <ReasoningAccordion
                                isThinkingActive={isActivelyThinking}
                                reasoning={parsed.reasoning}
                              />
                            )}
                          {parsed.answer ? (
                            <p className="answer-text">{parsed.answer}</p>
                          ) : isActivelyThinking ? null : message.role ===
                              "assistant" && !parsed.hasReasoning ? (
                            <p className="answer-text">{message.content}</p>
                          ) : null}
                          {messageMetric?.timedOut && (
                            <div className="timeout-warning-banner">
                              ⚠️ Corte por timeout de servidor (300s)
                            </div>
                          )}
                        </div>
                        {hasMetrics && (
                          <footer
                            className="metrics-strip"
                            aria-label="Métricas de generación"
                          >
                            <Metric label="MODELO">
                              {assignedModel}
                            </Metric>
                            <Metric label="TTFT">
                              {messageMetric?.ttftMs !== undefined
                                ? `${messageMetric.ttftMs.toFixed(0)} ms`
                                : "—"}
                            </Metric>
                            <Metric label="DURACIÓN">
                              {messageMetric?.generationSeconds !== undefined
                                ? `${messageMetric.generationSeconds.toFixed(2)} s`
                                : "—"}
                            </Metric>
                            <Metric label="TPS">
                              {messageMetric?.generationSeconds &&
                              messageMetric.generationSeconds > 0 &&
                              messageMetric.completionTokens !== undefined
                                ? `${(
                                    messageMetric.completionTokens /
                                    messageMetric.generationSeconds
                                  ).toFixed(1)} tok/s`
                                : "—"}
                            </Metric>
                            <Metric label="TOKENS">
                              {messageMetric?.completionTokens !== undefined
                                ? `${messageMetric.promptTokens ?? 0} in / ${
                                    messageMetric.completionTokens
                                  } out`
                                : "—"}
                              {messageMetric?.tokensEstimated && (
                                <span
                                  className="estimated-badge"
                                  title="Tokens estimados"
                                >
                                  *
                                </span>
                              )}
                            </Metric>
                          </footer>
                        )}
                      </div>
                    </article>
                  );
                })}
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
          </>
        )}

        {/* VISTA 2: PRUEBAS DE ESTRÉS */}
        {activeTab === "stress" && (
          <StressTestModule availableModels={models} />
        )}
      </section>
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
