"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROMPT_PRESETS,
  StressTestRunner,
  computeAggregateMetrics,
  exportStressResultsToCSV,
  type AggregateMetrics,
  type PromptPresetKey,
  type StressModelMode,
  type StressRequestResult,
  type StressTestConfig,
} from "@/lib/stressRunner";

const STRESS_STORAGE_KEY = "local-llm-stress-history-v1";

interface StressSessionStorage {
  version: 1;
  config: StressTestConfig;
  results: StressRequestResult[];
  summary: AggregateMetrics;
}

const DEFAULT_CONFIG: StressTestConfig = {
  modelMode: "qwen3:8b",
  concurrency: 5,
  totalRequests: 10,
  presetKey: "latency",
  thinking: false, // Desactivado por defecto en estrés
};

export function StressTestModule({
  availableModels = ["qwen3:8b", "qwen3:30b"],
}: {
  availableModels?: string[];
}) {
  const [config, setConfig] = useState<StressTestConfig>(DEFAULT_CONFIG);
  const [results, setResults] = useState<StressRequestResult[]>([]);
  const [summary, setSummary] = useState<AggregateMetrics>(() =>
    computeAggregateMetrics([], DEFAULT_CONFIG.totalRequests, 0),
  );
  const [isRunning, setIsRunning] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showPromptPreview, setShowPromptPreview] = useState(true);

  const runnerRef = useRef<StressTestRunner | null>(null);

  // Cargar desde sessionStorage al montar
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STRESS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as StressSessionStorage;
        if (parsed.version === 1 && Array.isArray(parsed.results)) {
          setConfig({
            ...DEFAULT_CONFIG,
            ...parsed.config,
          });
          setResults(parsed.results);
          setSummary(parsed.summary);
        }
      }
    } catch {
      // Ignorar fallos de lectura
    }
  }, []);

  const saveSnapshot = useCallback(
    (
      currentResults: StressRequestResult[],
      currentSummary: AggregateMetrics,
      currentConfig: StressTestConfig,
    ) => {
      try {
        const snapshot: StressSessionStorage = {
          version: 1,
          config: currentConfig,
          results: currentResults,
          summary: currentSummary,
        };
        sessionStorage.setItem(STRESS_STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // Ignorar fallos de escritura
      }
    },
    [],
  );

  const handleStartTest = async () => {
    if (isRunning) return;

    setIsRunning(true);
    const runner = new StressTestRunner(config, (newResults, newSummary) => {
      setResults([...newResults]);
      setSummary(newSummary);
    });

    runnerRef.current = runner;

    try {
      const snapshot = await runner.run();
      setResults(snapshot.results);
      setSummary(snapshot.summary);
      saveSnapshot(snapshot.results, snapshot.summary, config);
    } catch (err: unknown) {
      console.error("Error al ejecutar prueba de estrés:", err);
    } finally {
      setIsRunning(false);
      runnerRef.current = null;
    }
  };

  const handleStopTest = () => {
    if (runnerRef.current) {
      runnerRef.current.abort();
      setIsRunning(false);
    }
  };

  const handleClearMetrics = () => {
    if (isRunning) return;
    setResults([]);
    setSummary(computeAggregateMetrics([], config.totalRequests, 0));
    try {
      sessionStorage.removeItem(STRESS_STORAGE_KEY);
    } catch {
      // Ignorar
    }
  };

  const handleExportCSV = () => {
    if (results.length === 0) return;
    exportStressResultsToCSV(results, config);
  };

  const filteredResults = results.filter((r) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "success") return r.status === "success";
    if (statusFilter === "error") return r.status === "error";
    if (statusFilter === "timeout") return r.isTimeout === true;
    if (statusFilter === "running") return r.status === "running";
    return true;
  });

  const activePreset = PROMPT_PRESETS[config.presetKey];

  return (
    <div className="stress-shell">
      {/* PANEL DE CONFIGURACIÓN */}
      <section className="stress-config-card">
        <div className="config-header">
          <div className="config-title">
            <span>⚙️ Parámetros de la Prueba de Carga</span>
          </div>
          <div className="btn-group">
            <button
              className="btn-secondary"
              disabled={isRunning || results.length === 0}
              onClick={handleClearMetrics}
              title="Limpiar resultados actuales"
              type="button"
            >
              Reiniciar
            </button>
          </div>
        </div>

        <div className="config-grid">
          {/* MODELO OBJETIVO */}
          <div className="config-field">
            <label className="config-label" htmlFor="model-mode-select">
              Modelo(s) Objetivo
            </label>
            <select
              className="config-select"
              disabled={isRunning}
              id="model-mode-select"
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  modelMode: e.target.value as StressModelMode,
                }))
              }
              value={config.modelMode}
            >
              <option value="qwen3:8b">qwen3:8b (Ligero)</option>
              <option value="qwen3:30b">qwen3:30b (Alta Demanda)</option>
              <option value="alternate">
                Alternado (Stress de VRAM / Model Swap)
              </option>
              {availableModels
                .filter((m) => m !== "qwen3:8b" && m !== "qwen3:30b")
                .map((m) => (
                  <option key={m} value={m}>
                    {m} (Servidor)
                  </option>
                ))}
            </select>
          </div>

          {/* CONCURRENCIA */}
          <div className="config-field">
            <label className="config-label" htmlFor="concurrency-range">
              Concurrencia ({config.concurrency} Trabajadores)
            </label>
            <div className="range-wrap">
              <input
                className="config-range"
                disabled={isRunning}
                id="concurrency-range"
                max={20}
                min={1}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    concurrency: Number(e.target.value),
                  }))
                }
                type="range"
                value={config.concurrency}
              />
              <span className="range-val">{config.concurrency} w</span>
            </div>
          </div>

          {/* TOTAL PETICIONES */}
          <div className="config-field">
            <label className="config-label" htmlFor="total-requests-input">
              Total de Peticiones
            </label>
            <div className="range-wrap">
              <select
                className="config-select"
                disabled={isRunning}
                id="total-requests-input"
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    totalRequests: Number(e.target.value),
                  }))
                }
                value={config.totalRequests}
              >
                <option value={5}>5 requests</option>
                <option value={10}>10 requests</option>
                <option value={25}>25 requests</option>
                <option value={50}>50 requests</option>
                <option value={100}>100 requests</option>
              </select>
            </div>
          </div>

          {/* TOGGLE THINKING (QWEN 3) */}
          <div className="config-field">
            <label className="config-label">
              Modo Thinking (Qwen 3)
            </label>
            <div className="thinking-toggle-container">
              <button
                className={`thinking-toggle-btn ${config.thinking ? "on" : "off"}`}
                disabled={isRunning}
                onClick={() =>
                  setConfig((prev) => ({
                    ...prev,
                    thinking: !prev.thinking,
                  }))
                }
                title="Alternar generación de bloques <think>"
                type="button"
              >
                <span className="thinking-icon">🧠</span>
                <span>
                  {config.thinking
                    ? "Thinking ON (Razonamiento activo)"
                    : "Thinking OFF (/no_think inyectado)"}
                </span>
              </button>
              <p className="thinking-hint">
                {config.thinking
                  ? "Qwen 3 emitirá <think> completo. Podría tardar >5,000 tokens."
                  : "Inyecta /no_think en el prompt de sistema para prevenir timeouts de 300s."}
              </p>
            </div>
          </div>
        </div>

        {/* PERFIL DE CARGA (PROMPT PRESETS) */}
        <div className="config-field">
          <label className="config-label">
            Perfil de Carga (Prompt Preset)
          </label>
          <div className="presets-container">
            {(
              Object.keys(PROMPT_PRESETS) as Array<
                keyof typeof PROMPT_PRESETS
              >
            ).map((key) => {
              const preset = PROMPT_PRESETS[key];
              const isSelected = config.presetKey === key;
              return (
                <button
                  className={`preset-btn ${isSelected ? "active" : ""}`}
                  disabled={isRunning}
                  key={key}
                  onClick={() =>
                    setConfig((prev) => ({
                      ...prev,
                      presetKey: key as PromptPresetKey,
                    }))
                  }
                  type="button"
                >
                  <div className="preset-title-row">
                    <span className="preset-name">{preset.name}</span>
                    <span className="preset-badge">{preset.badge}</span>
                  </div>
                  <span className="preset-desc">{preset.description}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* PROMPT PREVIEW */}
        <div className="config-field">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span className="config-label">
              Vista previa del prompt (Max tokens: {activePreset.maxTokens})
            </span>
            <button
              onClick={() => setShowPromptPreview((v) => !v)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--muted)",
                fontSize: "11px",
                cursor: "pointer",
              }}
              type="button"
            >
              {showPromptPreview ? "Ocultar" : "Mostrar"}
            </button>
          </div>
          {showPromptPreview && (
            <div className="prompt-preview-box">{activePreset.prompt}</div>
          )}
        </div>

        {/* BOTONES DE ACCIÓN */}
        <div className="actions-row">
          <div className="btn-group">
            {!isRunning ? (
              <button
                className="btn-primary"
                onClick={handleStartTest}
                type="button"
              >
                <span>▶ Iniciar Prueba de Carga</span>
              </button>
            ) : (
              <button
                className="btn-danger"
                onClick={handleStopTest}
                type="button"
              >
                <span>⏹ Detener Corrida (Abortar)</span>
              </button>
            )}
            <button
              className="btn-secondary"
              disabled={results.length === 0}
              onClick={handleExportCSV}
              type="button"
            >
              <span>📥 Descargar Reporte en CSV</span>
            </button>
          </div>

          {isRunning && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                fontSize: "12px",
                color: "var(--accent)",
              }}
            >
              <span className="pulse-dot" />
              <span>
                Ejecutando ráfaga con {config.concurrency} trabajadores
                concurrentes…
              </span>
            </div>
          )}
        </div>
      </section>

      {/* TARJETAS KPI EN TIEMPO REAL */}
      <section className="kpi-grid">
        {/* KPI 1: PROGRESO Y TASA DE ÉXITO */}
        <div className="kpi-card">
          <div className="kpi-header">
            <span className="kpi-label">Progreso y Éxito</span>
            <span style={{ fontSize: "11px", color: "var(--muted)" }}>
              {summary.completedRequests} / {summary.totalRequests}
            </span>
          </div>
          <div className="kpi-highlight">
            {summary.totalRequests > 0
              ? Math.round(
                  (summary.completedRequests / summary.totalRequests) * 100,
                )
              : 0}
            <span className="kpi-unit">%</span>
          </div>
          <div className="kpi-progress-bar">
            <div
              className="kpi-progress-fill"
              style={{
                width: `${
                  summary.totalRequests > 0
                    ? (summary.completedRequests / summary.totalRequests) * 100
                    : 0
                }%`,
              }}
            />
          </div>
          <div className="kpi-details">
            <span className="kpi-detail-item">
              Exitosas: <strong>{summary.successfulRequests}</strong>
            </span>
            <span className="kpi-detail-item">
              En vuelo: <strong>{summary.inFlightRequests}</strong>
            </span>
            <span
              className={`kpi-detail-item ${
                summary.failedRequests > 0 ? "kpi-error-tag" : ""
              }`}
            >
              Errores: <strong>{summary.errorRatePercent}%</strong> (
              {summary.failedRequests})
            </span>
            {summary.timeoutRequests > 0 && (
              <span className="kpi-detail-item kpi-timeout-tag">
                Timeouts (300s): <strong>{summary.timeoutRequests}</strong>
              </span>
            )}
          </div>
        </div>

        {/* KPI 2: TTFT (TIME TO FIRST TOKEN) */}
        <div className="kpi-card">
          <div className="kpi-header">
            <span className="kpi-label">TTFT (Primer Token)</span>
            <span style={{ fontSize: "11px", color: "var(--accent)" }}>
              P50 / Mediana
            </span>
          </div>
          <div className="kpi-highlight">
            {summary.p50TtftMs > 0 ? summary.p50TtftMs : "—"}
            {summary.p50TtftMs > 0 && <span className="kpi-unit">ms</span>}
          </div>
          <div className="kpi-details">
            <span className="kpi-detail-item">
              P95:{" "}
              <strong>
                {summary.p95TtftMs > 0 ? `${summary.p95TtftMs} ms` : "—"}
              </strong>
            </span>
            <span className="kpi-detail-item">
              Promedio:{" "}
              <strong>
                {summary.avgTtftMs > 0 ? `${summary.avgTtftMs} ms` : "—"}
              </strong>
            </span>
            <span className="kpi-detail-item">
              Máx:{" "}
              <strong>
                {summary.maxTtftMs > 0 ? `${summary.maxTtftMs} ms` : "—"}
              </strong>
            </span>
          </div>
        </div>

        {/* KPI 3: LATENCIA END-TO-END */}
        <div className="kpi-card">
          <div className="kpi-header">
            <span className="kpi-label">Latencia End-to-End</span>
            <span style={{ fontSize: "11px", color: "var(--accent)" }}>
              P95
            </span>
          </div>
          <div className="kpi-highlight">
            {summary.p95LatencySec > 0 ? summary.p95LatencySec : "—"}
            {summary.p95LatencySec > 0 && <span className="kpi-unit">s</span>}
          </div>
          <div className="kpi-details">
            <span className="kpi-detail-item">
              Promedio:{" "}
              <strong>
                {summary.avgLatencySec > 0 ? `${summary.avgLatencySec} s` : "—"}
              </strong>
            </span>
            <span className="kpi-detail-item">
              Tiempo Corrida: <strong>{summary.elapsedTimeSec} s</strong>
            </span>
          </div>
        </div>

        {/* KPI 4: THROUGHPUT Y TPS */}
        <div className="kpi-card">
          <div className="kpi-header">
            <span className="kpi-label">Throughput Agregado</span>
            <span style={{ fontSize: "11px", color: "var(--accent)" }}>
              Servidor
            </span>
          </div>
          <div className="kpi-highlight">
            {summary.aggregateThroughputTps > 0
              ? summary.aggregateThroughputTps
              : "—"}
            {summary.aggregateThroughputTps > 0 && (
              <span className="kpi-unit">tok/s</span>
            )}
          </div>
          <div className="kpi-details">
            <span className="kpi-detail-item">
              TPS Promedio Req:{" "}
              <strong>
                {summary.avgTps > 0 ? `${summary.avgTps} tok/s` : "—"}
              </strong>
            </span>
            <span className="kpi-detail-item">
              Tokens Totales:{" "}
              <strong>
                {results.reduce((acc, r) => acc + (r.tokens || 0), 0)}
              </strong>
            </span>
          </div>
        </div>
      </section>

      {/* TABLA DETALLADA EN TIEMPO REAL */}
      <section className="table-card">
        <div className="table-header-bar">
          <div className="table-title">
            <span>📋 Detalle de Peticiones</span>
            <span
              style={{
                fontSize: "11px",
                color: "var(--muted)",
                fontWeight: "normal",
              }}
            >
              ({results.length} generadas)
            </span>
          </div>

          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <select
              className="config-select"
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{ padding: "4px 8px", fontSize: "11px" }}
              value={statusFilter}
            >
              <option value="all">Todas ({results.length})</option>
              <option value="success">
                Exitosas ({results.filter((r) => r.status === "success").length}
                )
              </option>
              <option value="timeout">
                Timeouts 300s ({results.filter((r) => r.isTimeout).length})
              </option>
              <option value="error">
                Errores ({results.filter((r) => r.status === "error").length})
              </option>
              <option value="running">
                En curso ({results.filter((r) => r.status === "running").length}
                )
              </option>
            </select>
          </div>
        </div>

        <div className="table-scroll">
          <table className="stress-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Trabajador</th>
                <th>Modelo</th>
                <th>Estado</th>
                <th>Código HTTP</th>
                <th>TTFT (ms)</th>
                <th>Latencia Total (s)</th>
                <th>Tokens</th>
                <th>TPS</th>
                <th>Observaciones / Detalle</th>
              </tr>
            </thead>
            <tbody>
              {filteredResults.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    style={{
                      textAlign: "center",
                      padding: "30px",
                      color: "var(--muted)",
                    }}
                  >
                    {results.length === 0
                      ? "Sin peticiones ejecutadas. Presiona 'Iniciar Prueba de Carga' para comenzar."
                      : "No hay peticiones que coincidan con el filtro seleccionado."}
                  </td>
                </tr>
              ) : (
                filteredResults.map((req) => {
                  let statusClass = "status-pending";
                  let statusLabel = "En cola";

                  if (req.status === "running") {
                    statusClass = "status-running";
                    statusLabel = "En curso…";
                  } else if (req.isTimeout) {
                    statusClass = "status-error";
                    statusLabel = "504 Timeout";
                  } else if (req.status === "success") {
                    statusClass = "status-success";
                    statusLabel = "200 OK";
                  } else if (req.status === "error") {
                    statusClass = "status-error";
                    statusLabel = req.httpStatus
                      ? `${req.httpStatus} Error`
                      : "Fallo";
                  } else if (req.status === "aborted") {
                    statusClass = "status-aborted";
                    statusLabel = "Cancelado";
                  }

                  return (
                    <tr key={req.id}>
                      <td>
                        <strong>{req.id}</strong>
                      </td>
                      <td>Worker-{req.workerId}</td>
                      <td>
                        <span
                          style={{
                            fontFamily: "monospace",
                            color:
                              req.model === "qwen3:30b"
                                ? "#a78bfa"
                                : "var(--accent)",
                          }}
                        >
                          {req.model}
                        </span>
                      </td>
                      <td>
                        <span className={`status-pill ${statusClass}`}>
                          {req.status === "running" && (
                            <span className="pulse-dot" />
                          )}
                          {statusLabel}
                        </span>
                      </td>
                      <td>
                        {req.httpStatus ? (
                          <span
                            style={{
                              fontWeight: 600,
                              color:
                                req.httpStatus === 200
                                  ? "var(--accent)"
                                  : "#f87171",
                            }}
                          >
                            {req.httpStatus} {req.httpStatusText || ""}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {req.ttftMs !== undefined ? `${req.ttftMs} ms` : "—"}
                      </td>
                      <td>
                        {req.totalLatencySec !== undefined
                          ? `${req.totalLatencySec} s`
                          : "—"}
                      </td>
                      <td>{req.tokens || "—"}</td>
                      <td>
                        {req.tps > 0 ? (
                          <strong style={{ color: "var(--accent)" }}>
                            {req.tps}
                          </strong>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td
                        style={{
                          maxWidth: "320px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontSize: "11px",
                          color: req.isTimeout
                            ? "#fbbf24"
                            : req.error
                              ? "#f87171"
                              : "var(--muted)",
                        }}
                        title={req.error || req.previewText || ""}
                      >
                        {req.isTimeout ? (
                          <span style={{ fontWeight: 600, color: "#fbbf24" }}>
                            ⚠️ Corte por timeout de servidor (300s)
                          </span>
                        ) : (
                          req.error || req.previewText || "—"
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
