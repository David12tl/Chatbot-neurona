# Especificación: Benchmark remoto de Ollama

## 1. Objetivo y alcance

Aplicación web de diagnóstico y pruebas de rendimiento para comparar el streaming de los modelos Qwen alojados en un servidor Ollama remoto compatible con OpenAI (`https://neurona.scstarnet.uk`). La aplicación incluye un **Chat de Diagnóstico** interactivo y un **Módulo de Pruebas de Estrés (Load & Stress Testing)** concurrente. No persiste sesiones en servidor ni necesita base de datos.

## 2. Arquitectura, autenticación y almacenamiento

- **Interfaz:** Next.js App Router, TypeScript estricto, Tailwind CSS y Vercel AI SDK v4.
- **Proxy backend:** Rutas server-side (`/api/chat` y `/api/stress`) en Next.js con interceptación de stream para razonamiento. El navegador solo se comunica con estas rutas locales; la URL remota y la clave Bearer nunca se entregan al cliente.
- **Autenticación:** usar `LLM_API_KEY` exclusivamente en cabeceras `Authorization: Bearer ...` entre backend y servidor Ollama. No exponer ni persistir la clave en mensajes, métricas, errores, logs, estado cliente o `sessionStorage`.
- **Modelos:** `GET /api/chat` consulta `OLLAMA_TAGS_URL` con autenticación, extrae nombres de modelo de la respuesta Ollama (`models[].name`) y devuelve `{ models, defaultModel }`. Si no puede obtenerse una lista válida, devuelve los nombres por defecto (`qwen3:8b`, `qwen3:30b`) e incluye un aviso explícito de fallback.
- **Generación interactiva:** `POST /api/chat` acepta `{ messages, model, thinking }`, valida campos, inyecta la directiva `/no_think` si thinking está en OFF, y genera con Vercel AI SDK.
- **Sin base de datos:** no se crean conexiones o dependencias de persistencia externa para mensajes ni métricas.
- **Estado de sesión:** el historial de chat, modelo seleccionado, modo thinking, métricas interactivas e historial de corridas de estrés viven en React y se respaldan en `sessionStorage`. Se restauran tras la carga del cliente y se validan antes de usarlos.
- **Limpieza:** “Limpiar sesión” vacía mensajes, métricas, modelo de sesión guardado, historial de estrés y cronómetros pendientes; también elimina las claves de `sessionStorage` y aborta peticiones activas.
- `.env.local` contiene únicamente configuración local y está ignorado por Git.

## 3. Selección de modelos y comparación

- La cabecera incluye selector de modelo alimentado por `GET /api/chat`. Fallback por defecto: `qwen3:8b` y `qwen3:30b`.
- Permite cambiar el modelo entre solicitudes. Cada envío captura el modelo seleccionado.
- **Atribución garantizada de modelo:** cada respuesta y métrica registran el identificador exacto del modelo utilizado (`qwen3:8b` o `qwen3:30b`), mapeado directamente desde el momento de envío por `message.id` para garantizar que la etiqueta nunca muestre valores vacíos o `—`.

## 4. Telemetría, razonamiento y timeouts (Chat de Diagnóstico)

Cada respuesta del asistente guarda por `message.id`:
- **Modelo utilizado:** identificador exacto enviado en la solicitud, nunca `—`.
- **Modo Thinking (Qwen 3):**
  - Toggle en la barra superior: **Thinking ON** (predeterminado en chat) vs. **Thinking OFF**.
  - Cuando esté en **OFF**, el backend inyecta la directiva `/no_think` en el `system` prompt para suprimir la generación de bloques `<think>`, evitando que Qwen 3 consuma >5,000 tokens de razonamiento oculto y sature el proxy.
- **Telemetría precisa de razonamiento:**
  - El backend intercepta los eventos SSE de Ollama/OpenAI para extraer `reasoning_content` o `reasoning` y encapsularlos en `<think>...</think>`.
  - El **TTFT (ms)** mide el tiempo hasta el primer token real generado por la GPU (sea razonamiento o respuesta).
  - El recuento de **Tokens** y el **TPS** consolidan tanto los tokens de razonamiento como los de la respuesta final.
- **Manejo de Timeout (300s):**
  - Si el proxy corta el stream abruptamente (ej. corte a los 300 segundos, o código HTTP 504), se captura el evento y se marca la respuesta con una alerta visual explícita: `"⚠️ Corte por timeout de servidor (300s)"`.
- **Tiempo total (s):** diferencia entre el instante de envío y la finalización o corte.
- **Contenido `<think>`:** desplegable “Proceso de razonamiento”, separando el texto final y conservando tokens.

## 5. Módulo de Pruebas de Estrés (Load & Stress Testing)

Módulo especializado en benchmarking de concurrencia y saturación de VRAM contra el servidor Ollama remoto.

### 5.1 Parámetros Configurables de la Prueba
- **Modelo(s) objetivo:**
  - `qwen3:8b` (modelo base ligero).
  - `qwen3:30b` (modelo de alta demanda de memoria y procesamiento).
  - Modo **Alternado (Stress de VRAM / Model Swap)**: intercala peticiones sucesivamente entre `qwen3:8b` y `qwen3:30b` (petición par vs. impar) para forzar desalojo y recarga en la memoria GPU del servidor remoto y cuantificar la penalización por model swapping.
- **Modo Thinking (Qwen 3):** Interruptor configurable (desactivado por defecto en estrés) para inyectar `/no_think` y evitar que ráfagas de peticiones concurrentes superen el timeout de 300s.
- **Concurrencia (Hilos simultáneos):** Selector / slider de `1` a `20` trabajadores concurrentes (`workers`) que despachan peticiones en paralelo.
- **Total de peticiones:** Cantidad total de solicitudes a ejecutar en la corrida (presets rápidos: `5`, `10`, `25`, `50` o valor personalizado).
- **Perfil de carga (Prompt Preset):**
  - *Latencia pura (Corto):* Prompt breve con salida corta (~50 tokens) para medir la sobrecarga mínima de red, enrutamiento y cola del proxy.
  - *Razonamiento profundo (Thinking):* Problema lógico/matemático complejo que fuerza la activación y retención del bloque `<think>` en Qwen 3, midiendo la retención prolongada de slots y recursos computacionales en la GPU.
  - *Generación extensa:* Solicitud de desarrollo técnico extenso (~500+ tokens) para estresar el throughput sostenido de generación de tokens y detectar timeouts de proxy o desbordamiento de colas.
- **Botón de Cancelación (`AbortController`):** Control de parada de emergencia que aborta inmediatamente todas las solicitudes HTTP en vuelo mediante `AbortSignal`.

### 5.2 Métricas de Estrés y Percentiles (Cálculo en Memoria)
- **Por cada petición individual en la ráfaga:**
  - ID secuencial de petición.
  - Trabajador asignado (`Worker #`).
  - Modelo evaluado (`qwen3:8b` o `qwen3:30b`).
  - Estado HTTP real: `200 OK`, `503 Overloaded`, `504 Timeout`, `429 Too Many Requests`, `500 Server Error`, `Aborted` o `Error`.
  - **Detección de Timeout:** Si el servidor/proxy corta el stream a los 300 segundos, se marca con `"⚠️ Corte por timeout de servidor (300s)"`.
  - **TTFT (`ms`):** Tiempo transcurrido con `performance.now()` entre el envío de la petición y la recepción del primer token (incluyendo fragmentos de razonamiento inicial).
  - **Latencia Total (`s`):** Tiempo transcurrido desde el inicio de la petición hasta el cierre del stream.
  - **Tokens generados:** Recuento de tokens sumando razonamiento y respuesta.
  - **TPS individual:** Tasa de tokens por segundo de la petición (`tokens / latenciaTotal`).
- **Métricas Agregadas de la Corrida en Tiempo Real:**
  - **Progreso y Tasa de Éxito:** Peticiones completadas vs. Total programado, porcentaje (%) de fallos y conteo de cortes por timeout (300s).
  - **TTFT (Time To First Token):** Promedio, **P50 (Mediana)**, **P95** y Máximo (`ms`).
  - **Latencia End-to-End:** Promedio y **P95** (`s`).
  - **Throughput:** Comparativa entre el **TPS Promedio por Petición** y el **Throughput Agregado del Servidor** (`Total de tokens generados de todas las peticiones / Tiempo total transcurrido de la corrida`).

### 5.3 Persistencia en Caché y Exportación
- **Almacenamiento local en pestaña:** Historial de corridas de estrés persistido en `sessionStorage` (`local-llm-stress-history-v1`).
- **Exportación en CSV:** Descarga instantánea de archivo CSV delimitado por comas (`reporte-estres-<config>-<timestamp>.csv`) con el desglose tabular completo de cada petición incluyendo la columna de alertas de timeout.

## 6. Interfaz y tipografía

- Pestañas superiores limpias para alternar entre **"Chat de Diagnóstico"** y **"Pruebas de Estrés"**.
- Tipografía estricta en todo el sistema: `"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif` sin fuentes externas remotas.
- Modo oscuro por defecto con paleta optimizada (`#090b0f`, `#101318`, `#15191f`, acentos verdes `#73e0b0` y alertas rojas/ámbar).
- Tarjetas de KPIs en vivo, barra de progreso porcentual, consola de estado y tabla de resultados con scroll virtualizado/adaptable.

## 7. Stack y configuración

- Next.js App Router, TypeScript estricto y Tailwind CSS.
- Dependencias: `ai@^4`, `@ai-sdk/react@^1`, `@ai-sdk/openai@^1`.
- `LLM_BASE_URL=https://neurona.scstarnet.uk/v1`
- `OLLAMA_TAGS_URL=https://neurona.scstarnet.uk/api/tags`
- `LLM_API_KEY` cargada solo en el backend desde `.env.local`.
- `LLM_DEFAULT_MODEL=qwen3:8b`.
- Sin APIs deprecadas de streaming (`OpenAIStream`, `StreamingTextResponse`).

## 8. Criterios de aceptación verificables

- [ ] `SPEC.md` define arquitectura, parámetros y métricas de estrés antes de implementar.
- [ ] No hay conexión a base de datos; la memoria y `sessionStorage` gestionan el estado y se limpian completamente con el botón de limpieza.
- [ ] La etiqueta `MODELO` siempre muestra el modelo activo (`qwen3:8b` o `qwen3:30b`) y nunca `—`.
- [ ] El toggle `Modo Thinking (Qwen 3)` permite activar/desactivar el razonamiento e inyecta `/no_think` en el prompt de sistema cuando está en OFF.
- [ ] El stream captura fragmentos de razonamiento (`reasoning` / `reasoning_content`) para reflejar el TTFT del primer token de GPU y computar tokens completos.
- [ ] Si el stream se corta abruptamente a los 300s por el proxy, se muestra la alerta `"⚠️ Corte por timeout de servidor (300s)"`.
- [ ] `POST /api/stress` recibe `{ model, prompt, maxTokens, thinking }`, utiliza streaming directo con Vercel AI SDK y propaga errores HTTP reales (`503`, `504`, `429`, `500`).
- [ ] El motor de concurrencia cliente (`lib/stressRunner.ts`) soporta de `1` a `20` workers exactos, modo alternado de modelos y presets de prompt.
- [ ] El motor calcula con `performance.now()` TTFT, Latencia Total, TPS y percentiles P50/P95 en tiempo real.
- [ ] Soporte completo para cancelación inmediata mediante `AbortController`.
- [ ] La interfaz permite alternar fluidamente entre Chat de Diagnóstico y Pruebas de Estrés manteniendo `"Segoe UI"` y modo oscuro.
- [ ] Las tarjetas KPI muestran TTFT P50/P95, Throughput Agregado del Servidor vs TPS promedio, Latencia P95 y Tasa de Errores.
- [ ] La tabla detallada muestra cada petición de la ráfaga y el botón "Exportar CSV" genera la descarga del reporte.
- [ ] TypeScript estricto pasa sin errores (`npx.cmd tsc --noEmit`).
