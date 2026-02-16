# Durable AI Chat — Core Plan

Any client (web, desktop, mobile, MCP) can interact with an AI chat session backed by durable streams. The Mastra agent runs on the user's desktop machine with local filesystem access, streaming results through the durable session to all connected clients.

## Core Requirements

### 1. Presence

Who is currently looking at a specific chat session, with cursor context.

**Data model per participant:**
```typescript
interface ChatPresence {
  userId: string          // userId
  deviceId: string         // unique per device
  name: string             // display name
  avatarUrl?: string
  status: "active" | "idle" | "typing"
  cursorPosition?: number  // caret position in chat input (if focused)
  lastSeenAt: Date
}
```

**Synced via durable stream** — presence events are part of the STATE-PROTOCOL schema, not a separate channel. Every connected client sees every other client's presence in real-time.

**"Active"** = chat tab is open. **"Typing"** = chat input is focused and has content. **"Idle"** = tab backgrounded or no activity for 30s.

### 2. Shared Chat Input

The chat input text is synced through the durable session so all connected clients can see what's being composed.

**Approach: per-user draft via presence.** Each user's draft is their own — there's no collaborative editing of a single textarea. Instead, each user has their own input, and their current text is broadcast to other clients via a dedicated presence field.

```typescript
interface ChatPresence {
  // ... fields above
  draft?: string           // current input text (empty = not typing)
  cursorPosition?: number  // caret position in the draft
}
```

Other clients render these drafts as "X is typing: ..." indicators below the chat input. This avoids CRDT complexity while giving full visibility into what everyone is composing.

**Debounced**: Draft text synced at 300ms debounce to avoid flooding the stream with keystrokes.

### 3. AI SDK Compatible `useChat` Hook

We use the **actual AI SDK `useChat`** from `@ai-sdk/react` with a custom `ChatTransport` — not a wrapper or lookalike. This gives us exact API compatibility including all future AI SDK improvements.

**Approach: implement `DurableChatTransport` that satisfies `ChatTransport<UIMessage>` from `ai`.**

```typescript
import { useChat } from "@ai-sdk/react"
import { DurableChatTransport } from "@superset/durable-session"

// Consumer code — this is literally all they write:
const chat = useChat({
  id: sessionId,
  transport: new DurableChatTransport({ proxyUrl, authToken }),
  onError: (error) => console.error(error),
  onFinish: ({ message }) => console.log("done", message),
  onToolCall: ({ toolCall }) => console.log("tool", toolCall),
  experimental_throttle: 50,
})
```

**`ChatTransport` interface (from `ai@5.0.133`):**

```typescript
// This is the exact interface we implement — from ai/dist/index.d.ts
interface ChatTransport<UI_MESSAGE extends UIMessage> {
  sendMessages: (options: {
    trigger: "submit-message" | "regenerate-message"
    chatId: string
    messageId: string | undefined
    messages: UI_MESSAGE[]
    abortSignal: AbortSignal | undefined
  } & ChatRequestOptions) => Promise<ReadableStream<UIMessageChunk>>

  reconnectToStream: (options: {
    chatId: string
  } & ChatRequestOptions) => Promise<ReadableStream<UIMessageChunk> | null>
}
```

**`DurableChatTransport` implementation:**

```typescript
class DurableChatTransport implements ChatTransport<UIMessage> {
  constructor(private options: { proxyUrl: string; authToken: string }) {}

  async sendMessages({ chatId, messages, abortSignal, trigger, messageId }) {
    // 1. POST latest user message to proxy
    const latest = messages[messages.length - 1]
    await fetch(`${this.options.proxyUrl}/v1/sessions/${chatId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.authToken}`,
      },
      body: JSON.stringify({
        content: latest.parts.filter(p => p.type === "text").map(p => p.text).join(""),
        messageId,
      }),
      signal: abortSignal,
    })

    // 2. Return SSE stream as ReadableStream<UIMessageChunk>
    //    Connect to durable stream, convert chunks → UIMessageChunk format
    return this.connectToStream(chatId, abortSignal)
  }

  async reconnectToStream({ chatId }) {
    // Resume from last cursor position
    return this.connectToStream(chatId)
  }

  private async connectToStream(chatId: string, signal?: AbortSignal) {
    // GET /v1/stream/sessions/:chatId → SSE
    // Transform durable stream events → ReadableStream<UIMessageChunk>
    // The AI SDK's Chat class handles materialization from UIMessageChunk → UIMessage
  }
}
```

**What `useChat` returns (exact from `ai@5.0.133`):**

```typescript
// This is UseChatHelpers<UIMessage> — the actual return type
{
  readonly id: string
  messages: UIMessage[]  // { id, role, parts: UIMessagePart[], metadata? }
  status: "submitted" | "streaming" | "ready" | "error"
  error: Error | undefined

  sendMessage: (
    message?:
      | CreateUIMessage & { text?: never; files?: never; messageId?: string }
      | { text: string; files?: FileList | FileUIPart[]; metadata?: unknown; messageId?: string }
      | { files: FileList | FileUIPart[]; metadata?: unknown; messageId?: string },
    options?: ChatRequestOptions
  ) => Promise<void>

  regenerate: (options?: { messageId?: string } & ChatRequestOptions) => Promise<void>
  stop: () => Promise<void>
  resumeStream: (options?: ChatRequestOptions) => Promise<void>
  clearError: () => void

  setMessages: (
    messages: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])
  ) => void

  addToolOutput: <TOOL extends keyof UITools>(options:
    | { state?: "output-available"; tool: TOOL; toolCallId: string; output: unknown }
    | { state: "output-error"; tool: TOOL; toolCallId: string; errorText: string }
  ) => Promise<void>

  addToolApprovalResponse: (options: {
    id: string
    approved: boolean
    reason?: string
  }) => void | Promise<void>

  /** @deprecated Use addToolOutput */
  addToolResult: typeof addToolOutput
}
```

**UIMessage part types (from `ai@5.0.133`):**

```typescript
interface UIMessage {
  id: string
  role: "system" | "user" | "assistant"
  parts: UIMessagePart[]
  metadata?: unknown
}

type UIMessagePart =
  | TextUIPart          // { type: "text"; text: string; state?: "streaming" | "done" }
  | ReasoningUIPart     // { type: "reasoning"; text: string; state?: "streaming" | "done" }
  | ToolUIPart          // { type: `tool-${name}`; toolCallId; state; input; output?; errorText? }
  | SourceUrlUIPart     // { type: "source-url"; sourceId; url; title? }
  | SourceDocumentUIPart// { type: "source-document"; sourceId; mediaType; title }
  | FileUIPart          // { type: "file"; mediaType; filename?; url }
  | StepStartUIPart     // { type: "step-start" }

// Tool part states: "input-streaming" | "input-available" | "output-available" | "output-error"
```

**Key: the transport converts durable stream chunks → `UIMessageChunk` format.** The AI SDK's `Chat` class handles materializing `UIMessageChunk` → `UIMessage.parts[]`. We don't need to do materialization ourselves — the AI SDK does it.

### 4. Separate `useChatPresence` Hook

Presence is a separate concern from messages, with its own hook.

**Identity is server-derived, not client-provided.** The client only passes `sessionId` — the streams service resolves user identity (userId, name, avatarUrl) from the authenticated session (cookie/Bearer token). This prevents spoofing. The `deviceId` is assigned server-side on first connection and returned to the client.

```typescript
function useChatPresence(options: UseChatPresenceOptions): UseChatPresenceReturn

interface UseChatPresenceOptions {
  sessionId: string
  // proxyUrl + authToken inherited from the DurableChatTransport / shared connection context
}

interface UseChatPresenceReturn {
  // Who's here
  participants: ChatPresence[]           // all connected users
  activeParticipants: ChatPresence[]     // status !== "idle"

  // My presence (identity is server-derived, only status/draft is client-controlled)
  updateStatus: (status: "active" | "idle" | "typing") => void
  updateDraft: (text: string, cursorPosition?: number) => void

  // Other users' drafts
  drafts: Array<{ userId: string; name: string; text: string }>
}
```

**Server-side presence flow:**
1. Client connects with auth token → `POST /v1/sessions/:id/login`
2. Server validates token, resolves `{ userId, name, avatarUrl }` from auth session
3. Server assigns `deviceId` (or reuses existing for this user+device combo)
4. Presence event written to stream with server-derived identity
5. Client receives its own `deviceId` back in the login response

Both hooks share the same underlying connection when used together (keyed by sessionId).

### 5. Agent Lifecycle — Desktop-Hosted

The Mastra agent runs in the desktop app's main process with access to the user's local filesystem, credentials, and tools. It starts when a session needs it and stops when all clients disconnect.

**Lifecycle:**
```
Session created (from any client)
  → No agent running yet
  → First message sent
    → Desktop sees message via stream subscription
    → Desktop starts Mastra agent for this session
    → Agent streams chunks to durable session
    → All clients receive chunks via SSE
  → All clients disconnect
    → Desktop detects via presence (0 active participants)
    → Grace period (60s) to allow reconnection
    → Agent shut down, session paused
  → Client reconnects
    → Messages replayed from durable stream cursor
    → Next message triggers agent restart (with session resume)
```

**Desktop as agent host:**
- The desktop that owns the working directory hosts the agent
- If the host desktop disconnects, the session enters "paused" state
- Other clients see a "Host disconnected — waiting for reconnection" indicator
- When the host reconnects, the agent can resume via `claudeSessionId`

**Which desktop hosts?** The one that created the session (it sets `cwd` and registers as host). The `hostDeviceId` is stored in session metadata.

### 6. Any Client Can Submit Messages

All clients interact through the same streams API. The agent doesn't care who sent the message.

```
Web client:      POST /v1/sessions/:id/messages { content }  ← userId from auth
Mobile client:   POST /v1/sessions/:id/messages { content }  ← userId from auth
MCP client:      POST /v1/sessions/:id/messages { content }  ← userId from API key
Desktop client:  POST /v1/sessions/:id/messages { content }  ← userId from auth
```

The server resolves `userId` from the authenticated request — clients never self-identify.

**Message triggers agent:** When a user message is written to the durable stream, the desktop (subscribed to the stream) detects it and starts/resumes the agent with the full conversation context.

**Concurrent messages:** If the agent is mid-generation and another message arrives:
- The message is appended to the stream immediately (visible to all clients)
- The current generation completes
- The agent picks up the new message on the next turn (natural multi-turn behavior)
- If the user wants to interrupt: `POST /v1/sessions/:id/stop` → desktop aborts agent → writes stop chunk

### 7. Session Start/Resume From Anywhere

Sessions are identified by ID and can be created or resumed from any client.

**Create:**
```
PUT /v1/sessions/:id
Body: { hostDeviceId?, cwd?, title? }
```

**Resume:** Any client connects to an existing session's stream and gets full message history from the durable stream cursor.

**Session identity:**
```typescript
interface SessionMetadata {
  id: string
  organizationId: string
  title: string
  hostDeviceId: string       // desktop that runs the agent
  cwd: string                // working directory on the host
  claudeSessionId?: string   // for SDK session resume
  createdAt: Date
  lastActivityAt: Date
}
```

**Session discovery:** Sessions are listed via tRPC (backed by Postgres) so any client can browse and resume. The durable stream is the source of truth for message content; Postgres stores session metadata for listing/search.

---

## Open Design Decisions

### Tool Approvals

When the agent needs permission (e.g. file write, bash exec), who can approve?

**Proposed:** Any connected client can approve or deny. The approval request is written to the durable stream, so all clients see it. First response wins.

**Rationale:** In a multiplayer context, whoever is paying attention should be able to act. The approval chunk includes full context (tool name, args, description) so any client can make an informed decision.

**Escape hatch:** Permission mode is set per-session. `bypassPermissions` mode (for trusted contexts) skips approval entirely.

### Stop Generation

**Proposed:** Any connected client can stop. `POST /v1/sessions/:id/stop` writes a stop signal to the stream. The desktop (subscribed to the stream) sees the stop signal and aborts the local agent.

### Agent Context Window

The agent accumulates context across the session. On restart (after all clients disconnect and reconnect), it resumes from the stored `claudeSessionId` if within the SDK's session TTL (24h). If expired, it starts fresh but has the full message history from the durable stream to re-establish context.

### Session Forking

Fork a session at any message boundary to create a branch. This is already stubbed in the streams API (`POST /v1/sessions/:id/fork`) but needs implementation. Deferred — not core v1.

---

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           ANY CLIENT                                    │
│                                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Desktop   │  │ Web App   │  │ Mobile    │  │ MCP      │              │
│  │ (Electron)│  │ (Next.js) │  │ (Expo)    │  │ Client   │              │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘  └─────┬────┘              │
│        │              │              │              │                    │
│        └──────────────┴──────────────┴──────────────┘                   │
│                              │                                          │
│                    ┌─────────▼──────────┐                              │
│                    │ useChat()           │ Actual AI SDK hook           │
│                    │ useChatPresence()   │ Presence + drafts           │
│                    └─────────┬──────────┘                              │
│                              │                                          │
│              ┌───────────────┼───────────────┐                         │
│              │ DurableChatTransport           │                         │
│              │  implements ChatTransport      │                         │
│              │  - sendMessages → POST proxy   │                         │
│              │  - reconnectToStream → SSE     │                         │
│              │  - returns UIMessageChunk      │                         │
│              └───────────────┬───────────────┘                         │
└──────────────────────────────┼──────────────────────────────────────────┘
                               │ HTTP (REST + SSE)
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    STREAMS SERVICE (apps/streams)                        │
│                    Pure durable streams layer                            │
│                                                                         │
│  POST /v1/sessions/:id/messages    ← any client sends message          │
│  POST /v1/sessions/:id/chunks      ← desktop writes agent chunks       │
│  POST /v1/sessions/:id/stop        ← any client stops generation       │
│  POST /v1/sessions/:id/approvals   ← any client approves tool use      │
│  POST /v1/sessions/:id/login       ← presence: join                    │
│  POST /v1/sessions/:id/logout      ← presence: leave                   │
│  PUT  /v1/sessions/:id             ← create/get session                │
│  GET  /v1/stream/sessions/:id      ← SSE stream (chunks + presence)    │
│                                                                         │
│  ┌────────────────────────────────────────────┐                        │
│  │ Durable Stream (append-only log)            │                        │
│  │  - Chunks: message content (text, tools)    │                        │
│  │  - Presence: who's connected, drafts        │                        │
│  │  - Cursor-based replay for reconnection     │                        │
│  └────────────────────────────────────────────┘                        │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │
              The desktop is ALSO a client — it subscribes
              to the stream to detect new user messages
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    DESKTOP — AGENT HOST                                  │
│                                                                         │
│  Stream subscription (detects new user messages)                        │
│       │                                                                 │
│       ▼                                                                 │
│  Mastra Agent (packages/agent)                                          │
│    - Runs locally with filesystem access                                │
│    - Uses @mastra/core Agent with Anthropic provider                    │
│    - Tools: file ops, bash, web search, etc.                            │
│    - Permission requests → written to stream → any client approves      │
│       │                                                                 │
│       ▼                                                                 │
│  agent.stream(messages)                                                 │
│    → toAISdkStream(stream, { from: "agent" })                          │
│      → UIMessageStreamPart[] (native AI SDK format)                    │
│        → POST /v1/sessions/:id/chunks                                  │
│          → Durable stream stores + relays to all clients               │
│          → AI SDK Chat class materializes → UIMessage[]                │
└──────────────────────────────────────────────────────────────────────────┘
```

## Streaming Pipeline: Mastra → AI SDK → Durable Stream

The key insight: `@mastra/ai-sdk` (already installed as `^1.0.4`) provides `toAISdkStream()` which converts Mastra agent output directly to `UIMessageStreamPart` — the native format the AI SDK's `Chat` class consumes. This eliminates custom materialization.

```
Mastra agent.stream(messages)
  → MastraModelOutput (Mastra's internal stream format)
    → toAISdkStream(stream, { from: "agent" })
      → AsyncIterable<UIMessageStreamPart>
        → Write each part to durable stream via POST /chunks
          → Durable stream stores + SSE broadcasts
            → DurableChatTransport reads as ReadableStream<UIMessageChunk>
              → AI SDK Chat class materializes → UIMessage[] (built-in)
```

**What this eliminates:**
- `sdk-to-ai-chunks.ts` — no manual SDK event conversion needed
- `packages/durable-session/src/materialize.ts` — AI SDK handles materialization
- TanStack AI `StreamProcessor` on the client — AI SDK's `Chat` class does this

**What the durable stream stores:** `UIMessageStreamPart` events directly. Same format in from the agent, same format out to clients. The stream is just a relay + persistence layer.

**Desktop agent host writes chunks like:**
```typescript
import { toAISdkStream } from "@mastra/ai-sdk"

const mastraStream = await superagent.stream(messages, { requestContext })
for await (const part of toAISdkStream(mastraStream, { from: "agent" })) {
  await fetch(`${proxyUrl}/v1/sessions/${sessionId}/chunks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ part }),  // UIMessageStreamPart, already AI SDK native
  })
}
```

**`toAISdkStream` options:**
```typescript
toAISdkStream(stream, {
  from: "agent",
  sendStart: true,        // include start events
  sendFinish: true,       // include finish events
  sendReasoning: true,    // include extended thinking
  sendSources: true,      // include source citations
})
```

## Message Flow

```
1. User sends message from ANY client
   → POST /v1/sessions/:id/messages { content }
   → Server resolves userId from auth
   → Proxy writes user message event to durable stream
   → All clients receive event via SSE → AI SDK Chat updates messages

2. Desktop detects new user message (via stream subscription)
   → Starts/resumes Mastra agent with full message history
   → agent.stream(messages, { requestContext: { cwd, modelId } })

3. Agent streams response
   → toAISdkStream(stream, { from: "agent" }) → UIMessageStreamPart[]
   → POST /v1/sessions/:id/chunks (batched)
   → Proxy writes parts to durable stream
   → All clients receive via SSE → AI SDK Chat materializes → streaming UI

4. Agent needs tool approval
   → Tool part with approval state written to stream
   → All clients see it → any client can approve/deny
   → POST /v1/sessions/:id/approvals/:id { approved }
   → Desktop receives approval → resumes agent

5. Generation complete
   → toAISdkStream emits finish event
   → Written to stream → all clients see status: "ready"
```

## Presence Flow

```
1. Client connects
   → POST /v1/sessions/:id/login (auth token in header)
   → Server resolves { userId, name, avatarUrl } from auth session
   → Presence event written to durable stream with server-derived identity
   → All clients see new participant via useChatPresence()

2. User starts typing
   → useChatPresence().updateDraft("Hello wor", 9)
   → Debounced (300ms) → presence update in stream
   → Other clients see "Alice is typing: Hello wor..."

3. User sends message
   → Draft cleared automatically
   → Presence status → "active" (not "typing")

4. Client disconnects
   → POST /v1/sessions/:id/logout (or heartbeat timeout)
   → Presence event: status "offline"
   → If last client: start 60s grace period before agent shutdown
```

## TanStack DB: Fast Reload via Local Persistence + Offset Resumption

Without optimization, every page reload replays the entire durable stream from offset `-1`. For a long conversation, that's slow. TanStack DB + durable stream offsets solve this.

### The Problem

```
Page reload
  → DurableChatTransport.reconnectToStream()
    → GET /v1/stream/sessions/:id?offset=-1  (start from beginning)
      → Replay ALL historical events
        → AI SDK Chat re-materializes entire conversation
          → UI finally renders (slow for long sessions)
```

### The Solution: Two Layers

**Layer 1: Offset-based resumption (durable streams)**

The durable stream tracks a monotonic offset. Clients save the last offset they processed. On reconnect, they resume from that offset instead of replaying everything.

```
First load:    offset=-1  → replay all events → save offset=4827 to localStorage
Page reload:   offset=4827 → only new events since last visit
Tab switch:    offset=4827 → catch up incrementally
```

The offset is just a string saved to `localStorage`:
```typescript
localStorage.setItem(`chat:offset:${sessionId}`, lastOffset)
```

**Layer 2: TanStack DB as reactive local cache (presence + derived state)**

TanStack DB provides reactive collections synced from the durable stream. For **presence** and **session metadata** (not messages — AI SDK handles those), TanStack DB collections give us:

- **Reactive derived queries**: "who's typing", "active participants", "drafts" update in <1ms via differential dataflow
- **Optimistic mutations**: presence updates (typing status, drafts) apply instantly to local state, then sync to server
- **Incremental recomputation**: when a presence event arrives, only affected derived queries recompute — not the full collection

```
Durable Stream (presence events)
  → @durable-streams/state StreamDB
    → TanStack DB Collection<PresenceRow> (synced)
      → Derived: activeParticipants (live query, sub-ms updates)
      → Derived: typingUsers (live query)
      → Derived: drafts (live query)
```

### How Messages Work (AI SDK, not TanStack DB)

Messages use a different path — AI SDK's `Chat` class manages message state:

```
First load:
  1. Read cached UIMessage[] from IndexedDB → pass to useChat({ messages: cached })
  2. UI renders instantly from cache
  3. DurableChatTransport.reconnectToStream() from saved offset
  4. Any new events since cache → AI SDK applies incrementally
  5. Save updated messages + offset to IndexedDB

Subsequent loads:
  1. Cache hit → instant render
  2. Resume from offset → only delta
  3. Typical reload: 0 events to catch up (nothing changed)
```

```typescript
// Pseudocode for the reload optimization
const cached = await indexedDB.get(`chat:messages:${sessionId}`)
const savedOffset = localStorage.getItem(`chat:offset:${sessionId}`)

const chat = useChat({
  id: sessionId,
  messages: cached?.messages,  // instant render from cache
  transport: new DurableChatTransport({
    proxyUrl,
    authToken,
    resumeOffset: savedOffset,  // only fetch delta
  }),
})

// After each stream update, persist
useEffect(() => {
  indexedDB.put(`chat:messages:${sessionId}`, chat.messages)
  localStorage.setItem(`chat:offset:${sessionId}`, transport.lastOffset)
}, [chat.messages])
```

### Future: TanStack DB Native Persistence

TanStack DB has persistence [planned post-v1](https://github.com/TanStack/db/issues/865). When available, the presence layer upgrades automatically:

```
Today (manual):     Stream → TanStack DB (in-memory) → custom IndexedDB save/load
Future (built-in):  Stream → TanStack DB (auto-persisted to IndexedDB)
                    On reload: hydrate from IndexedDB, resume stream from offset
```

For now, the manual approach (cache messages in IndexedDB, save offset in localStorage) is simple and effective. TanStack DB handles presence reactivity; AI SDK handles message state.

### Summary

| Concern | Technology | Persistence | Reload Strategy |
|---------|-----------|-------------|-----------------|
| Messages | AI SDK `Chat` class | IndexedDB (manual cache) | Hydrate from cache, resume from offset |
| Presence | TanStack DB collections | None needed (ephemeral) | Reconnect, get current state |
| Drafts | TanStack DB via presence | None needed (ephemeral) | Reconnect, get current state |
| Stream position | Durable stream offset | localStorage | Resume from saved offset |

---

## What Already Exists

| Component                   | Status   | Location                                                 |
| --------------------------- | -------- | -------------------------------------------------------- |
| Durable stream server       | Done     | `apps/streams/`                                          |
| Session protocol (proxy)    | Done     | `apps/streams/src/protocol.ts`                           |
| Stream API routes           | Done     | `apps/streams/src/routes/`                               |
| Durable session client      | Done     | `packages/durable-session/`                              |
| Presence collection         | Done     | `packages/durable-session/src/collections/presence.ts`   |
| Mastra agent (superagent)   | Done     | `packages/agent/src/superagent.ts`                       |
| `@mastra/ai-sdk`            | Done     | `packages/agent/package.json` (`^1.0.4`)                 |
| `toAISdkStream`             | Done     | Provided by `@mastra/ai-sdk` — converts agent stream    |
| `ai` package                | Done     | `packages/ui/package.json` (`^5.0.133`)                  |
| Agent executor              | Done     | `packages/agent/src/agent-executor.ts`                   |
| Session store (resume)      | Done     | `packages/agent/src/session-store.ts`                    |
| Desktop chat UI (current)   | Done     | `apps/desktop/.../ChatInterface/`                        |
| Desktop tRPC router         | Done     | `apps/desktop/src/lib/trpc/routers/ai-chat/`             |
| Chunk materialization       | Obsolete | `packages/durable-session/src/materialize.ts` — replaced by AI SDK `Chat` class |
| SDK → StreamChunk converter | Obsolete | `packages/agent/src/sdk-to-ai-chunks.ts` — replaced by `toAISdkStream` |
| `useDurableChat` hook       | Obsolete | `packages/durable-session/src/react/use-durable-chat.ts` — replaced by AI SDK `useChat` + `DurableChatTransport` |

## What Needs to Be Built

| Component                      | Description                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `DurableChatTransport`         | `ChatTransport<UIMessage>` impl — bridges AI SDK `useChat` to durable streams proxy  |
| Agent stream writer            | Desktop loops `toAISdkStream()` → POSTs `UIMessageStreamPart` to proxy `/chunks`     |
| Proxy chunk format update      | Update streams proxy to store/relay `UIMessageStreamPart` (not TanStack AI chunks)   |
| `useChatPresence` hook         | Presence + drafts, server-derived identity                                           |
| Presence schema extension      | Add `draft` and `cursorPosition` fields to presence                                  |
| Server-side presence auth      | Resolve userId/name/avatar from auth token on `/login`, not from client payload       |
| Desktop stream subscription    | Desktop subscribes to stream to detect new user messages                              |
| Agent lifecycle manager        | Start/stop Mastra agent based on connected clients + messages                        |
| Cross-client stop              | Desktop listens for stop signal from stream, aborts `agent.stream()`                 |
| Cross-client approvals         | Approval responses routed from stream to desktop agent                               |
| Session metadata (Postgres)    | Session listing, search, metadata for resume-from-anywhere                           |
| Install `@ai-sdk/react`       | Add to consuming apps (desktop, web, mobile) for `useChat` hook                      |
| Web chat UI                    | `apps/web` consuming `useChat` + `useChatPresence`                                   |
| Mobile chat UI                 | `apps/mobile` consuming same hooks                                                   |
| Remove obsolete code           | Delete `materialize.ts`, `sdk-to-ai-chunks.ts`, `useDurableChat` once migrated       |
