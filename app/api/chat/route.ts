import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type CoreMessage } from "ai";

const FALLBACK_MODELS = ["qwen3:8b", "qwen3:30b"];
const DEFAULT_MODEL = "qwen3:8b";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatRole(
  value: unknown,
): value is "system" | "user" | "assistant" {
  return value === "system" || value === "user" || value === "assistant";
}

function parseMessages(value: unknown): CoreMessage[] | null {
  if (!Array.isArray(value)) return null;

  const messages: CoreMessage[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.content !== "string" ||
      !isChatRole(item.role)
    ) {
      return null;
    }

    messages.push({ role: item.role, content: item.content });
  }
  return messages;
}

function fallbackModels(warning: string) {
  return Response.json({
    models: FALLBACK_MODELS,
    defaultModel: process.env.LLM_DEFAULT_MODEL || DEFAULT_MODEL,
    warning,
  });
}

export async function GET() {
  const tagsUrl = process.env.OLLAMA_TAGS_URL;
  const apiKey = process.env.LLM_API_KEY;
  if (!tagsUrl || !apiKey) {
    return fallbackModels(
      "Falta configurar OLLAMA_TAGS_URL o LLM_API_KEY; se muestra la lista predeterminada.",
    );
  }

  try {
    const response = await fetch(tagsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    if (!response.ok) {
      return fallbackModels(
        `El servidor de modelos respondió HTTP ${response.status}; se muestra la lista predeterminada.`,
      );
    }

    const payload: unknown = await response.json();
    const models =
      isRecord(payload) && Array.isArray(payload.models)
        ? Array.from(
            new Set(
              payload.models
                .filter(
                  (entry): entry is Record<string, unknown> =>
                    isRecord(entry) && typeof entry.name === "string",
                )
                .map((entry) => (entry.name as string).trim())
                .filter(Boolean),
            ),
          )
        : [];
    if (models.length === 0) {
      return fallbackModels(
        "El servidor no devolvió nombres de modelos válidos; se muestra la lista predeterminada.",
      );
    }

    return Response.json({
      models,
      defaultModel: process.env.LLM_DEFAULT_MODEL || DEFAULT_MODEL,
    });
  } catch {
    return fallbackModels(
      "No se pudo consultar la lista remota; se muestra la lista predeterminada.",
    );
  }
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

  const messages = parseMessages(body.messages);
  if (!messages || messages.length === 0) {
    return Response.json(
      { error: "Se requiere una lista válida de mensajes." },
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

  const localLLM = createOpenAI({ baseURL, apiKey });
  const result = streamText({
    model: localLLM.chat(model),
    messages,
  });

  return result.toDataStreamResponse();
}
