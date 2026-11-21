export type StressModelMode = "qwen3:8b" | "qwen3:30b" | "alternate";

export type PromptPresetKey = "latency" | "reasoning" | "extensive";

export interface PromptPreset {
  id: PromptPresetKey;
  name: string;
  badge: string;
  description: string;
  prompt: string;
  maxTokens?: number;
}

export const PROMPT_PRESETS: Record<PromptPresetKey, PromptPreset> = {
  latency: {
    id: "latency",
    name: "Latencia pura (Corto)",
    badge: "~50 tokens",
    description:
      "Prompt breve con salida corta (~50 tokens) para medir sobrecarga de red y cola.",
    prompt:
      "Responde de forma concisa en una sola frase: ¿Cuál es el puerto predeterminado de Ollama y para qué se usa?",
    maxTokens: 50,
  },
  reasoning: {
    id: "reasoning",
    name: "Razonamiento profundo (Thinking)",
    badge: "Forzar <think>",
    description:
      "Problema lógico/matemático que fuerce el bloque <think> de Qwen 3 para medir retención prolongada de slots en GPU.",
    prompt:
      "Analiza paso a paso el siguiente acertijo lógico mostrando todo tu proceso de razonamiento detallado: En una isla hay tres tipos de habitantes: Veraces (siempre dicen la verdad), Embusteros (siempre mienten) y Normales (a veces dicen la verdad y a veces mienten). Te encuentras con tres personas A, B y C. A dice: 'Soy normal'. B dice: 'A dice la verdad'. C dice: 'Yo no soy normal'. Determina las identidades exactas de A, B y C justificando cada paso.",
    maxTokens: 1024,
  },
  extensive: {
    id: "extensive",
    name: "Generación extensa",
    badge: "~500+ tokens",
    description:
      "Solicitud de desarrollo largo (~500+ tokens) para estresar el throughput sostenido y detectar timeouts de proxy.",
    prompt:
      "Redacta un manual técnico minucioso sobre cómo optimizar la inferencia de LLMs en clusters de GPUs con vLLM y Ollama. Explica con detalle la arquitectura de PagedAttention, Continuous Batching, cuantización AWQ frente a GPTQ, compresión de KV Cache, y el impacto de los cambios de contexto (context switching) en la latencia de primer token (TTFT) y el rendimiento agregado (TPS).",
    maxTokens: 2048,
  },
};

export type RequestStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "aborted";

export interface StressRequestResult {
  id: number;
  workerId: number;
  model: string;
  status: RequestStatus;
  httpStatus?: number;
  httpStatusText?: string;
  error?: string;
  isTimeout?: boolean;
  startTime?: number;
  firstTokenTime?: number;
  endTime?: number;
  ttftMs?: number;
  totalLatencySec?: number;
  tokens: number;
  tps: number;
  previewText?: string;
}

export interface AggregateMetrics {
  totalRequests: number;
  completedRequests: number;
  successfulRequests: number;
  failedRequests: number;
  inFlightRequests: number;
  timeoutRequests: number;
  errorRatePercent: number;
  avgTtftMs: number;
  p50TtftMs: number;
  p95TtftMs: number;
  maxTtftMs: number;
  avgLatencySec: number;
  p95LatencySec: number;
  avgTps: number;
  aggregateThroughputTps: number;
  elapsedTimeSec: number;
}

export interface StressTestConfig {
  modelMode: StressModelMode;
  concurrency: number;
  totalRequests: number;
  presetKey: PromptPresetKey;
  thinking: boolean;
  customPrompt?: string;
  customMaxTokens?: number;
}

export interface StressRunSnapshot {
  id: string;
  timestamp: number;
  config: StressTestConfig;
  status: "completed" | "aborted" | "running";
  results: StressRequestResult[];
  summary: AggregateMetrics;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function calculatePercentile(
  values: number[],
  percentile: number,
): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];

  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (upper === lower) return sorted[lower];
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function computeAggregateMetrics(
  results: StressRequestResult[],
  totalPlanned: number,
  testStartTime: number,
  testEndTime?: number,
): AggregateMetrics {
  const completed = results.filter(
    (r) =>
      r.status === "success" ||
      r.status === "error" ||
      r.status === "aborted",
  );
  const successful = results.filter((r) => r.status === "success");
  const failed = results.filter((r) => r.status === "error");
  const inFlight = results.filter((r) => r.status === "running").length;
  const timeoutRequests = results.filter((r) => r.isTimeout === true).length;

  const errorRatePercent =
    completed.length > 0
      ? Math.round((failed.length / completed.length) * 1000) / 10
      : 0;

  const ttftValues = successful
    .map((r) => r.ttftMs)
    .filter((v): v is number => typeof v === "number" && v >= 0);

  const avgTtftMs =
    ttftValues.length > 0
      ? Math.round(
          ttftValues.reduce((acc, curr) => acc + curr, 0) / ttftValues.length,
        )
      : 0;

  const p50TtftMs = Math.round(calculatePercentile(ttftValues, 50));
  const p95TtftMs = Math.round(calculatePercentile(ttftValues, 95));
  const maxTtftMs =
    ttftValues.length > 0 ? Math.round(Math.max(...ttftValues)) : 0;

  const latencyValues = successful
    .map((r) => r.totalLatencySec)
    .filter((v): v is number => typeof v === "number" && v >= 0);

  const avgLatencySec =
    latencyValues.length > 0
      ? Math.round(
          (latencyValues.reduce((acc, curr) => acc + curr, 0) /
            latencyValues.length) *
            100,
        ) / 100
      : 0;

  const p95LatencySec =
    Math.round(calculatePercentile(latencyValues, 95) * 100) / 100;

  const tpsValues = successful
    .map((r) => r.tps)
    .filter((v): v is number => typeof v === "number" && v > 0);

  const avgTps =
    tpsValues.length > 0
      ? Math.round(
          (tpsValues.reduce((acc, curr) => acc + curr, 0) / tpsValues.length) *
            10,
        ) / 10
      : 0;

  const now = testEndTime ?? performance.now();
  const elapsedTimeSec =
    testStartTime > 0
      ? Math.max(0.001, Math.round(((now - testStartTime) / 1000) * 10) / 10)
      : 0;

  const totalTokensGenerated = successful.reduce(
    (acc, curr) => acc + curr.tokens,
    0,
  );

  const aggregateThroughputTps =
    elapsedTimeSec > 0
      ? Math.round((totalTokensGenerated / elapsedTimeSec) * 10) / 10
      : 0;

  return {
    totalRequests: totalPlanned,
    completedRequests: completed.length,
    successfulRequests: successful.length,
    failedRequests: failed.length,
    inFlightRequests: inFlight,
    timeoutRequests,
    errorRatePercent,
    avgTtftMs,
    p50TtftMs,
    p95TtftMs,
    maxTtftMs,
    avgLatencySec,
    p95LatencySec,
    avgTps,
    aggregateThroughputTps,
    elapsedTimeSec,
  };
}

export function getModelForRequest(
  requestIndex: number,
  mode: StressModelMode,
): string {
  if (mode === "alternate") {
    return requestIndex % 2 === 0 ? "qwen3:8b" : "qwen3:30b";
  }
  return mode;
}

export class StressTestRunner {
  private config: StressTestConfig;
  private abortController: AbortController | null = null;
  private results: StressRequestResult[] = [];
  private onUpdate: (
    results: StressRequestResult[],
    summary: AggregateMetrics,
  ) => void;
  private testStartTime = 0;
  private isRunning = false;

  constructor(
    config: StressTestConfig,
    onUpdate: (
      results: StressRequestResult[],
      summary: AggregateMetrics,
    ) => void,
  ) {
    this.config = config;
    this.onUpdate = onUpdate;
  }

  public getResults(): StressRequestResult[] {
    return [...this.results];
  }

  public getSummary(): AggregateMetrics {
    return computeAggregateMetrics(
      this.results,
      this.config.totalRequests,
      this.testStartTime,
      this.isRunning ? undefined : performance.now(),
    );
  }

  public abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isRunning = false;

    this.results = this.results.map((req) => {
      if (req.status === "pending" || req.status === "running") {
        return {
          ...req,
          status: "aborted",
          error: "Prueba cancelada por el usuario",
          httpStatus: req.httpStatus || 499,
          httpStatusText: "Aborted",
        };
      }
      return req;
    });

    this.onUpdate(this.results, this.getSummary());
  }

  public async run(): Promise<StressRunSnapshot> {
    this.isRunning = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.testStartTime = performance.now();

    const { totalRequests, concurrency, modelMode, presetKey, thinking } =
      this.config;
    const preset = PROMPT_PRESETS[presetKey];
    const prompt = this.config.customPrompt || preset.prompt;
    const maxTokens = this.config.customMaxTokens || preset.maxTokens;

    this.results = Array.from({ length: totalRequests }, (_, i) => ({
      id: i + 1,
      workerId: (i % concurrency) + 1,
      model: getModelForRequest(i, modelMode),
      status: "pending",
      tokens: 0,
      tps: 0,
    }));

    this.onUpdate(this.results, this.getSummary());

    let nextIndex = 0;
    const activeWorkers: Promise<void>[] = [];
    const workerCount = Math.min(concurrency, totalRequests);

    const runWorker = async (workerId: number): Promise<void> => {
      while (nextIndex < totalRequests) {
        if (signal.aborted) break;

        const currentIndex = nextIndex++;
        const targetReq = this.results[currentIndex];
        if (!targetReq) break;

        targetReq.workerId = workerId;
        targetReq.status = "running";
        targetReq.startTime = performance.now();
        this.onUpdate(this.results, this.getSummary());

        try {
          await this.executeRequest(
            targetReq,
            prompt,
            maxTokens,
            thinking,
            signal,
          );
        } catch (err: unknown) {
          if (signal.aborted) {
            targetReq.status = "aborted";
            targetReq.error = "Cancelado por el usuario";
          } else {
            targetReq.status = "error";
            targetReq.error =
              err instanceof Error ? err.message : "Error desconocido";
          }
        } finally {
          this.onUpdate(this.results, this.getSummary());
        }
      }
    };

    for (let w = 1; w <= workerCount; w++) {
      activeWorkers.push(runWorker(w));
    }

    await Promise.all(activeWorkers);

    this.isRunning = false;
    const testEndTime = performance.now();
    const finalSummary = computeAggregateMetrics(
      this.results,
      totalRequests,
      this.testStartTime,
      testEndTime,
    );

    const snapshot: StressRunSnapshot = {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      config: this.config,
      status: signal.aborted ? "aborted" : "completed",
      results: this.results,
      summary: finalSummary,
    };

    this.onUpdate(this.results, finalSummary);
    return snapshot;
  }

  private async executeRequest(
    req: StressRequestResult,
    prompt: string,
    maxTokens: number | undefined,
    thinking: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const startTime = req.startTime ?? performance.now();

    let response: Response;
    try {
      response = await fetch("/api/stress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: req.model,
          prompt,
          maxTokens,
          thinking,
        }),
        signal,
      });
    } catch (fetchErr: unknown) {
      const elapsedSec = (performance.now() - startTime) / 1000;
      if (signal.aborted) {
        req.status = "aborted";
        req.httpStatus = 499;
        req.httpStatusText = "Client Closed Request";
        req.error = "Petición abortada";
        return;
      }

      req.status = "error";
      req.httpStatus = elapsedSec >= 290 ? 504 : 0;
      req.httpStatusText = elapsedSec >= 290 ? "Gateway Timeout" : "Network Error";

      if (elapsedSec >= 290) {
        req.isTimeout = true;
        req.error = "⚠️ Corte por timeout de servidor (300s)";
      } else {
        req.error =
          fetchErr instanceof Error ? fetchErr.message : "Fallo de red o timeout";
      }
      return;
    }

    req.httpStatus = response.status;
    req.httpStatusText = response.statusText;

    if (!response.ok) {
      req.status = "error";
      req.endTime = performance.now();
      req.totalLatencySec =
        Math.round(((req.endTime - startTime) / 1000) * 100) / 100;

      if (response.status === 504 || req.totalLatencySec >= 290) {
        req.isTimeout = true;
        req.error = "⚠️ Corte por timeout de servidor (300s)";
        return;
      }

      let errorBody = "";
      try {
        const errorJson = await response.json();
        errorBody =
          typeof errorJson.error === "string"
            ? errorJson.error
            : JSON.stringify(errorJson);
      } catch {
        errorBody = await response.text().catch(() => "");
      }

      req.error =
        errorBody ||
        `HTTP ${response.status} ${response.statusText || "Error del servidor"}`;
      return;
    }

    if (!response.body) {
      req.status = "error";
      req.error = "Respuesta sin stream legible";
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = "";
    let firstTokenReceived = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        if (chunk.length > 0 && !firstTokenReceived) {
          firstTokenReceived = true;
          req.firstTokenTime = performance.now();
          req.ttftMs = Math.round(req.firstTokenTime - startTime);
          this.onUpdate(this.results, this.getSummary());
        }
        accumulatedText += chunk;
      }

      const endTime = performance.now();
      req.endTime = endTime;
      req.totalLatencySec =
        Math.round(((endTime - startTime) / 1000) * 100) / 100;
      req.tokens = estimateTokens(accumulatedText);
      req.tps =
        req.totalLatencySec > 0
          ? Math.round((req.tokens / req.totalLatencySec) * 10) / 10
          : 0;
      req.status = "success";
      req.previewText = accumulatedText.slice(0, 90).trim();

      if (!req.ttftMs && req.totalLatencySec) {
        req.ttftMs = Math.round(req.totalLatencySec * 1000);
      }
    } catch (readErr: unknown) {
      const elapsedSec = (performance.now() - startTime) / 1000;
      req.endTime = performance.now();
      req.totalLatencySec = Math.round(elapsedSec * 100) / 100;

      if (signal.aborted) {
        req.status = "aborted";
        req.error = "Stream interrumpido por cancelación";
      } else if (elapsedSec >= 290) {
        req.status = "error";
        req.isTimeout = true;
        req.httpStatus = 504;
        req.httpStatusText = "Gateway Timeout";
        req.error = "⚠️ Corte por timeout de servidor (300s)";
      } else {
        req.status = "error";
        req.error =
          readErr instanceof Error
            ? readErr.message
            : "Error durante la lectura del stream";
      }
    }
  }
}

export function exportStressResultsToCSV(
  results: StressRequestResult[],
  config: StressTestConfig,
): void {
  const headers = [
    "ID",
    "Trabajador",
    "Modelo",
    "Thinking",
    "Estado",
    "Codigo_HTTP",
    "Estado_HTTP",
    "TTFT_ms",
    "Latencia_Total_s",
    "Tokens",
    "TPS",
    "Alerta_Timeout",
    "Detalle_Error",
  ];

  const escapeCell = (val: unknown): string => {
    if (val === undefined || val === null) return "";
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = results.map((r) => [
    escapeCell(r.id),
    escapeCell(`Worker-${r.workerId}`),
    escapeCell(r.model),
    escapeCell(config.thinking ? "ON" : "OFF (/no_think)"),
    escapeCell(r.status),
    escapeCell(r.httpStatus ?? ""),
    escapeCell(r.httpStatusText ?? ""),
    escapeCell(r.ttftMs ?? ""),
    escapeCell(r.totalLatencySec ?? ""),
    escapeCell(r.tokens),
    escapeCell(r.tps),
    escapeCell(r.isTimeout ? "Corte timeout 300s" : "NO"),
    escapeCell(r.error ?? ""),
  ]);

  const csvContent =
    "\uFEFF" +
    [headers.join(","), ...rows.map((row) => row.join(","))].join("\r\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  anchor.href = url;
  anchor.download = `reporte-estres-${config.modelMode}-${config.concurrency}w-${config.thinking ? "thinkON" : "thinkOFF"}-${timestamp}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
