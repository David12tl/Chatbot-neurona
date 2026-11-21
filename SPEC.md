# Especificación: Benchmark remoto de Ollama

## 1. Objetivo y alcance

Aplicación web de diagnóstico para comparar el rendimiento en streaming de los modelos Qwen alojados en un servidor Ollama remoto compatible con OpenAI. La aplicación no persiste sesiones en servidor ni necesita base de datos.

## 2. Arquitectura, autenticación y almacenamiento

- **Interfaz:** Next.js App Router, TypeScript estricto, Tailwind CSS y Vercel AI SDK v4.
- **Proxy backend:** `GET` y `POST /api/chat` se ejecutan en el servidor Next.js. El navegador solo se comunica con esta ruta local; la URL remota y la clave Bearer nunca se entregan al cliente.
- **Autenticación:** usar `LLM_API_KEY` exclusivamente en cabeceras `Authorization: Bearer ...` entre backend y servidor Ollama. No exponer ni persistir la clave en mensajes, métricas, errores, logs, estado cliente o `sessionStorage`.
- **Modelos:** `GET /api/chat` consulta `OLLAMA_TAGS_URL` con autenticación, extrae nombres de modelo de la respuesta Ollama (`models[].name`) y devuelve `{ models, defaultModel }`. Si no puede obtenerse una lista válida, devuelve los nombres por defecto (`qwen3:8b`, `qwen3:30b`) e incluye un aviso explícito de fallback, mostrado en la interfaz. El modelo predeterminado es `LLM_DEFAULT_MODEL` o `qwen3:8b`.
- **Generación:** `POST /api/chat` acepta `{ messages, model }`, valida ambos, configura `createOpenAI` con `LLM_BASE_URL` y `LLM_API_KEY`, y genera con `localLLM.chat(model || LLM_DEFAULT_MODEL || "qwen3:8b")`. La clave no se envía al navegador. Si faltan credenciales o URL requeridas para generar, la ruta devuelve un error explícito; no debe recurrir a OpenAI público.
- **Sin base de datos:** no se crean conexiones o dependencias de persistencia externa para mensajes ni métricas.
- **Estado de sesión:** mensajes, modelo seleccionado y métricas por ID de respuesta viven en React y se respaldan con una estructura versionada en `sessionStorage`. Se restauran tras la carga del cliente y se validan antes de usarlos. Fallos de lectura/escritura se muestran sin impedir el uso en memoria.
- **Limpieza:** “Limpiar sesión” vacía mensajes, métricas, modelo de sesión guardado y cronómetros pendientes; también elimina la clave de `sessionStorage` y detiene la generación activa de esta pestaña.
- `.env.local` contiene únicamente configuración local y está ignorado por Git. No usar cookies, `localStorage` ni servicios de terceros para sesiones.

## 3. Selección de modelos y comparación

- La cabecera incluye un selector alimentado por los modelos actuales recibidos de `GET /api/chat`. La lista por defecto ante fallo del endpoint incluye `qwen3:8b` y `qwen3:30b`.
- El selector permite cambiar el modelo entre solicitudes. Cada envío captura el modelo seleccionado; una modificación posterior no altera la atribución de la respuesta ya iniciada.
- Cada respuesta y su métrica registran el nombre exacto del modelo utilizado para comparar modelos dentro de la misma sesión.
- Al restaurar la sesión, se restaura también la selección si todavía está en la lista disponible; de otro modo se elige el modelo predeterminado disponible.

## 4. Telemetría y razonamiento

Cada respuesta del asistente guarda por `message.id`:

- **Modelo utilizado:** identificador exacto enviado en la solicitud.
- **TTFT (ms):** diferencia entre `performance.now()` capturado al enviar y la primera renderización de contenido no vacío del stream. Se registra una sola vez por respuesta.
- **Tiempo total (s):** diferencia entre el instante de envío y `onFinish`, en segundos.
- **TPS:** `completionTokens / tiempoTotalSegundos`, solo para respuestas finalizadas con duración positiva.
- **Tokens:** preferir `usage.promptTokens` y `usage.completionTokens` recibidos en `onFinish`. Si el servidor omite usage, estimar entrada y salida usando `ceil(caracteres / 4)` y marcar explícitamente los valores como estimados.
- **Contenido `<think>`:** preservar el mensaje original del stream y sus tokens para métricas. En la presentación, separar texto dentro de `<think>...</think>` en un bloque desplegable “Proceso de razonamiento” y mostrar fuera de él la respuesta final. Mientras el tag permanezca abierto durante el streaming, su contenido parcial se muestra dentro del bloque; si no existen tags, mostrar el texto normal.
- Las respuestas incompletas o fallidas no reciben duración/TPS final. Si ya hubo texto, su TTFT parcial puede mantenerse visible.
- La barra de telemetría al pie de cada respuesta muestra modelo, TTFT, duración, TPS y tokens de entrada/salida. El razonamiento se renderiza aparte, pero sigue incluido en los tokens de completion reportados por el SDK.

### Resumen de sesión

La barra superior muestra el selector de modelo y promedios aritméticos globales de TTFT y TPS de todas las respuestas finalizadas de la sesión, incluidas las de distintos modelos. Se excluyen métricas no disponibles; mostrar “—” cuando no existen muestras.

## 5. Interfaz y tipografía

- Diseño limpio para diagnóstico, oscuro por defecto y adaptable a pantallas estrechas.
- Fuente global: `"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif`, declarada en `app/globals.css` y aplicada en `app/layout.tsx`; no cargar fuentes remotas.
- Distinguir prompts y respuestas; conservar saltos de línea con `whitespace-pre-wrap`.
- Auto-scroll suave cuando aparece contenido nuevo y bloqueo de envío mientras el modelo genera.
- Mostrar errores de conexión, fallback de tags, almacenamiento y generación de manera explícita. No mostrar credenciales en mensajes de error.

## 6. Stack y configuración

- Next.js App Router, TypeScript estricto y Tailwind CSS.
- Dependencias: `ai@^4`, `@ai-sdk/react@^1`, `@ai-sdk/openai@^1`.
- Base compatible OpenAI: `LLM_BASE_URL=https://neurona.scstarnet.uk/v1`.
- Endpoint nativo de tags: `OLLAMA_TAGS_URL=https://neurona.scstarnet.uk/api/tags`.
- Autenticación: `LLM_API_KEY` cargada solo desde el entorno; no se incluye su valor en documentación o código.
- Modelo predeterminado: `LLM_DEFAULT_MODEL=qwen3:8b`.
- No usar `OpenAIStream` ni `StreamingTextResponse`, ni APIs deprecadas del SDK.

## 7. Criterios de aceptación verificables

- [ ] `SPEC.md` define arquitectura y criterios antes de los cambios de aplicación.
- [ ] No hay conexión a base de datos; mensajes, selección y métricas se restauran desde `sessionStorage` y el control de limpieza los elimina.
- [ ] `.env.local` usa los nombres y URL requeridos, está ignorado por Git y su clave no llega al cliente.
- [ ] `GET /api/chat` consulta los tags con Bearer, extrae nombres y muestra un aviso cuando usa modelos fallback.
- [ ] El selector presenta los modelos del servidor, restaura una selección válida y permite cambiarla entre solicitudes.
- [ ] `POST /api/chat` envía el modelo seleccionado a `localLLM.chat`, usa la URL/key del entorno y devuelve `toDataStreamResponse()`.
- [ ] Cada respuesta registra el modelo que realmente se solicitó y sus métricas se guardan por `message.id`.
- [ ] TTFT y tiempo total usan `performance.now()`; TPS se basa en usage o fallback estimado identificado.
- [ ] El bloque `<think>` se separa visualmente y los tokens de razonamiento permanecen incluidos en las métricas.
- [ ] El resumen superior calcula promedios globales de sesión; el diseño satisface tipografía, tema oscuro, espacios, auto-scroll y bloqueo.
- [ ] TypeScript estricto pasa `npx tsc --noEmit`.
- [ ] No se usan `OpenAIStream` ni `StreamingTextResponse`.
