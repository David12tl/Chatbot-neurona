import { createOpenAI } from "@ai-sdk/openai";

/**
 * TransformStream que intercepta los chunks SSE del backend compatible con OpenAI (Ollama/vLLM/proxy)
 * y extrae los campos 'reasoning_content' o 'reasoning' emitidos por Qwen 3 u otros modelos con CoT.
 *
 * Transforma esos fragmentos en bloques '<think>...</think>' dentro de 'delta.content' para que:
 * 1. El primer token generado por la GPU (aunque sea de razonamiento) active inmediatamente el stream.
 * 2. El TTFT refleje con exactitud milimétrica la respuesta inicial del modelo.
 * 3. Tanto el razonamiento como la respuesta final sumen en el cómputo total de tokens y TPS.
 */
export function createReasoningTransformStream(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  let inReasoning = false;
  let buffer = "";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ") || line.trim() === "data: [DONE]") {
          controller.enqueue(encoder.encode(line + "\n"));
          continue;
        }

        try {
          const jsonStr = line.slice(6).trim();
          const parsed = JSON.parse(jsonStr) as {
            choices?: Array<{
              delta?: {
                content?: string | null;
                reasoning?: string | null;
                reasoning_content?: string | null;
              };
            }>;
          };
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;

          if (delta) {
            const reasoning = delta.reasoning_content ?? delta.reasoning;
            if (reasoning) {
              if (!inReasoning) {
                inReasoning = true;
                delta.content = `<think>${reasoning}`;
              } else {
                delta.content = reasoning;
              }
              delete delta.reasoning_content;
              delete delta.reasoning;
            } else if (inReasoning && delta.content) {
              inReasoning = false;
              delta.content = `</think>${delta.content}`;
            }
          }
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(parsed)}\n`),
          );
        } catch {
          controller.enqueue(encoder.encode(line + "\n"));
        }
      }
    },
    flush(controller) {
      if (inReasoning) {
        const closeChunk = { choices: [{ delta: { content: "</think>" } }] };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(closeChunk)}\n`),
        );
      }
      if (buffer) {
        controller.enqueue(encoder.encode(buffer));
      }
    },
  });
}

/**
 * Crea un cliente OpenAI configurado con interceptor de fetch para habilitar
 * telemetría de razonamiento en tiempo real con Ollama.
 */
export function createCustomOpenAI(baseURL: string, apiKey: string) {
  const customFetch: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (!response.ok || !response.body) {
      return response;
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      return response;
    }

    const transformedStream = response.body.pipeThrough(
      createReasoningTransformStream(),
    );
    return new Response(transformedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return createOpenAI({ baseURL, apiKey, fetch: customFetch });
}
