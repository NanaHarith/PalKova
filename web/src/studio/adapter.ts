/**
 * AG Studio's agents, talking to OpenAI's Responses API through our server (`/api/studio/responses`),
 * which holds the key and picks the model. Adapted from AG Studio 3.0.0's documented example adapter
 * (https://www.ag-grid.com/studio/archive/3.0.0/react/ai-adapter/), trimmed to what PalKova sends:
 * text in, text and tool calls out, no images, files or citations.
 */
import type {
  AgAiConversationItem, AgAiEvent, AgAiOutputItem, AgAiToolSchema, AgLlmAdapter, AgLlmJsonFormat, AgLlmRequest,
  AgLlmResponse, AgLlmResponseHandler, AgLlmTextFormat,
} from "ag-studio";

type Json = Record<string, unknown>;
type Wire = Record<string, any>;  // eslint-disable-line @typescript-eslint/no-explicit-any

// ---- JSON Schema -> OpenAI strict mode -------------------------------------------------------
// Studio's tool schemas are JSON Schema 2020-12; strict mode takes a subset. Optional properties
// become required + nullable, `const` becomes a one-value enum, and the undefined sentinel `{ not: {} }`
// is dropped from unions.

const isSchema = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isUndefinedSentinel = (s: unknown) =>
  isSchema(s) && Object.keys(s).length === 1 && isSchema(s.not) && Object.keys(s.not).length === 0;

function nullable(schema: Json): Json {
  if (typeof schema.type === "string") return schema.type === "null" ? schema : { ...schema, type: [schema.type, "null"] };
  if (Array.isArray(schema.type)) return schema.type.includes("null") ? schema : { ...schema, type: [...schema.type, "null"] };
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as Json[]).some((b) => b.type === "null") ? schema : { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
  }
  return { anyOf: [schema, { type: "null" }] };
}

function strict(input: Json): Json {
  let schema = input;
  if (Array.isArray(schema.anyOf)) {
    const kept = (schema.anyOf as unknown[]).filter((b) => !isUndefinedSentinel(b));
    const { anyOf: _drop, ...rest } = schema;  // eslint-disable-line @typescript-eslint/no-unused-vars
    schema = kept.length === 1 && isSchema(kept[0]) ? { ...kept[0], ...rest } : { ...rest, anyOf: kept };
  }
  if ("$ref" in schema) return "$defs" in schema ? { $ref: schema.$ref, $defs: schema.$defs } : { $ref: schema.$ref };
  if ("const" in schema) {
    const { const: value, ...rest } = schema;
    const type = value === null ? "null" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number")
      : typeof value === "string" || typeof value === "boolean" ? typeof value : undefined;
    return strict({ ...(type && !rest.type ? { type } : {}), ...rest, enum: [value] });
  }
  const out: Json = { ...schema };
  if (Array.isArray(out.anyOf)) out.anyOf = (out.anyOf as unknown[]).map((b) => (isSchema(b) ? strict(b) : b));
  if (isSchema(out.$defs)) out.$defs = Object.fromEntries(Object.entries(out.$defs).map(([k, v]) => [k, isSchema(v) ? strict(v) : v]));
  if (out.type === "object" || isSchema(out.properties)) {
    const props = isSchema(out.properties) ? out.properties : {};
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => {
      const s = isSchema(v) ? strict(v) : v;
      return [k, required.has(k) || !isSchema(s) ? s : nullable(s)];
    }));
    out.required = Object.keys(out.properties as Json);
    out.additionalProperties = false;
  }
  if (isSchema(out.items)) out.items = strict(out.items);
  return out;
}

// Strict mode sends null for an unset optional; Studio expects the key to be absent.
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (isSchema(value)) return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, stripNulls(v)]));
  return value;
}
const cleanArgs = (args: string) => { try { return JSON.stringify(stripNulls(JSON.parse(args))); } catch { return args; } };

// ---- AG -> OpenAI ----------------------------------------------------------------------------

function encode(items: AgAiConversationItem[]): Wire[] {
  return items.map((item) => {
    if (item.kind === "input" && item.type === "message") {
      return { type: "message", role: item.role, content: item.content.flatMap((c) => (c.type === "text" ? [{ type: "input_text", text: c.text }] : [])) };
    }
    if (item.type === "function_call_output") return { type: "function_call_output", call_id: item.callId, output: item.output };
    if (item.kind === "output" && item.type === "message") {
      // No id: replayed history is context, not a resumed response.
      return { type: "message", role: "assistant", content: item.content.map((c) =>
        c.type === "text" ? { type: "output_text", text: c.text, annotations: [] } : { type: "refusal", refusal: c.refusal }) };
    }
    if (item.kind === "output" && item.type === "function_call") {
      return { type: "function_call", call_id: item.callId, name: item.name, arguments: item.arguments };
    }
    if (item.kind === "output" && item.type === "reasoning") {
      return { id: item.id, type: "reasoning", summary: item.summary.map((s) => ({ type: "summary_text", text: s.text })) };
    }
    throw new Error(`Unknown conversation item: ${(item as { type: string }).type}`);
  });
}

const format = (f: AgLlmTextFormat | AgLlmJsonFormat) => (f.type === "text" ? { type: "text" }
  : { type: "json_schema", name: f.name, description: f.description, schema: strict(f.schema as Json), strict: true });

// ---- OpenAI -> AG ----------------------------------------------------------------------------

function decodeItem(o: Wire): AgAiOutputItem {
  if (o.type === "message") {
    return { id: o.id ?? "", kind: "output", type: "message", role: "assistant", status: o.status ?? "completed",
      content: o.content.map((c: Wire) => (c.type === "output_text" ? { type: "text", text: c.text, annotations: [] } : c)) };
  }
  if (o.type === "function_call") {
    return { id: o.id ?? "", kind: "output", type: "function_call", callId: o.call_id, name: o.name,
      arguments: cleanArgs(o.arguments ?? ""), status: o.status };
  }
  if (o.type === "reasoning") {
    return { id: o.id ?? "", kind: "output", type: "reasoning", summary: (o.summary ?? []).map((s: Wire) => ({ type: "summary", text: s.text })) };
  }
  throw new Error(`Unknown output item: ${o.type}`);
}

const decode = (r: Wire): AgLlmResponse => ({
  id: r.id, createdAt: r.created_at, model: r.model, status: r.status, output: r.output.map(decodeItem),
  error: r.error ? { code: r.error.code, message: r.error.message } : undefined,
  incompleteDetails: r.incomplete_details ? { reason: r.incomplete_details.reason } : undefined,
  usage: r.usage ? { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, totalTokens: r.usage.total_tokens } : undefined,
});

type Outcome = { response?: AgLlmResponse; error?: Error };

/** OpenAI's item-shaped stream into Studio's message-shaped events. */
function translator() {
  const callOf = new Map<string, string>();
  const kindOf = new Map<string, string>();
  return (e: Wire, outcome: Outcome): AgAiEvent[] => {
    switch (e.type) {
      case "response.output_item.added": {
        const it = e.item;
        kindOf.set(it.id, it.type);
        if (it.type === "message") return [{ type: "TEXT_MESSAGE_START", messageId: it.id, role: "assistant" }];
        if (it.type === "reasoning") return [{ type: "REASONING_MESSAGE_START", messageId: it.id, role: "reasoning" }];
        if (it.type === "function_call") {
          callOf.set(it.id, it.call_id);
          return [{ type: "TOOL_CALL_START", toolCallId: it.call_id, toolCallName: it.name }];
        }
        return [];
      }
      case "response.output_item.done": {
        const kind = kindOf.get(e.item?.id);
        if (kind === "message") return [{ type: "TEXT_MESSAGE_END", messageId: e.item.id }];
        if (kind === "reasoning") return [{ type: "REASONING_MESSAGE_END", messageId: e.item.id }];
        const call = callOf.get(e.item?.id);
        return kind === "function_call" && call ? [{ type: "TOOL_CALL_END", toolCallId: call }] : [];
      }
      case "response.output_text.delta":
      case "response.refusal.delta":
        return [{ type: "TEXT_MESSAGE_CONTENT", messageId: e.item_id, delta: e.delta }];
      case "response.reasoning_summary_text.delta":
        return [{ type: "REASONING_MESSAGE_CONTENT", messageId: e.item_id, delta: e.delta }];
      case "response.function_call_arguments.delta": {
        const call = callOf.get(e.item_id);
        return call ? [{ type: "TOOL_CALL_ARGS", toolCallId: call, delta: e.delta }] : [];
      }
      case "response.completed":
        outcome.response = decode(e.response);
        return [];
      case "response.failed":
      case "response.incomplete":
        outcome.error ??= new Error(e.response?.error?.message ?? "The assistant couldn't finish that answer.");
        return [];
      case "error":
        outcome.error ??= new Error(e.message ?? "The assistant ran into an error.");
        return [];
      default:
        return [];
    }
  };
}

async function* events(endpoint: string, body: Json, outcome: Outcome, signal?: AbortSignal): AsyncIterableIterator<AgAiEvent> {
  const r = await fetch(`${endpoint}/responses`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(r.status === 401 ? "You've been signed out. Sign in again to use the assistant."
      : err.error?.message ?? "The assistant couldn't be reached.");
  }
  const translate = translator();
  const reader = r.body!.getReader();
  const text = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += text.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const line of frames.flatMap((f) => f.split("\n"))) {
      if (!line.startsWith("data: ")) continue;
      try { yield* translate(JSON.parse(line.slice(6)), outcome); }
      catch (e) { outcome.error ??= e instanceof Error ? e : new Error(String(e)); }
    }
  }
}

function turn(endpoint: string, request: AgLlmRequest, signal?: AbortSignal): AgLlmResponseHandler {
  const { tools = [], toolChoice, responseFormat, input, model, ...rest } = request;
  const body: Json = {
    ...rest,
    input: encode(input),
    tools: tools.map((t: AgAiToolSchema) => ({ type: "function", name: t.name, description: t.description,
      parameters: strict(t.parameters as unknown as Json), strict: true })),
    tool_choice: !toolChoice || typeof toolChoice === "string" ? toolChoice : { type: "function", name: toolChoice.name },
    text: { format: format(responseFormat) },
    reasoning: { effort: model?.effort ?? "medium" },  // the server drops it for models that don't reason
    parallel_tool_calls: true,
  };
  const outcome: Outcome = {};
  let resolve!: (r: AgLlmResponse) => void, reject!: (e: Error) => void;
  const complete = new Promise<AgLlmResponse>((res, rej) => { resolve = res; reject = rej; });
  void complete.catch(() => {});  // observed even when a cancelled run stops reading
  async function* stream() {
    try { yield* events(endpoint, body, outcome, signal); }
    catch (e) { outcome.error ??= e instanceof Error ? e : new Error(String(e)); }
    if (outcome.error) reject(outcome.error);
    else if (outcome.response) resolve(outcome.response);
    else reject(new Error("The answer stopped before it finished."));
  }
  const it = stream();
  return { stream: { [Symbol.asyncIterator]: () => it }, complete };
}

export const palkovaAdapter = (endpoint = "/api/studio"): AgLlmAdapter => ({
  executeTurn: (request, options) => turn(endpoint, request, options?.signal),
});
