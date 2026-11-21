import { streamText } from "ai";
import { createCustomOpenAI } from "@/lib/reasoningStream";

const FALLBACK_MODELS = ["qwen3:8b", "qwen3:30b"];
const DEFAULT_MODEL = "qwen3:8b";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "El cuerpo de la solicitud no es JSON válido." },
      { status: 400 },
    );
  }

  if (!isRecord(body)) {
    return Response.json(
      { error: "El cuerpo de la solicitud debe ser un objeto JSON." },
      { status: 400 },
    );
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return Response.json(
      { error: "Se requiere un prompt no vacío para la prueba de estrés." },
      { status: 400 },
    );
  }

  const baseURL = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  if (!baseURL || !apiKey) {
    return Response.json(
      { error: "Falta configurar LLM_BASE_URL o LLM_API_KEY en el servidor." },
      { status: 500 },
    );
  }

  const requestedModel =
    typeof body.model === "string" ? body.model.trim() : "";
  const model =
    requestedModel || process.env.LLM_DEFAULT_MODEL || DEFAULT_MODEL;

  if (model.length > 200) {
    return Response.json(
      { error: "El nombre del modelo no es válido." },
      { status: 400 },
    );
  }

  const maxTokens =
    typeof body.maxTokens === "number" &&
    Number.isFinite(body.maxTokens) &&
    body.maxTokens > 0
      ? Math.min(Math.floor(body.maxTokens), 8192)
      : undefined;

  // Control de Thinking (Qwen 3): cuando está en false, inyecta la directiva /no_think en el system prompt
  const thinking = body.thinking === true;

  try {
    const localLLM = createCustomOpenAI(baseURL, apiKey);
    const result = streamText({
      model: localLLM.chat(model),
      system: !thinking ? "/no_think" : undefined,
      prompt,
      maxTokens,
    });

    return result.toTextStreamResponse();
  } catch (err: unknown) {
    const errorRecord = isRecord(err) ? err : {};
    const statusCode =
      typeof errorRecord.statusCode === "number"
        ? errorRecord.statusCode
        : typeof errorRecord.status === "number"
          ? errorRecord.status
          : 500;

    const message =
      typeof errorRecord.message === "string"
        ? errorRecord.message
        : "Error al procesar la solicitud de estrés con el modelo remoto.";

    const safeStatus =
      statusCode >= 400 && statusCode < 600 ? statusCode : 500;

    return Response.json(
      {
        error: message,
        statusCode: safeStatus,
        model,
      },
      { status: safeStatus },
    );
  }
}
