/**
 * Hi-Boss daemon - manages agents, messages, and platform integrations.
 */

import * as path from "path";
import { HiBossDatabase } from "./db/database.js";
import { IpcServer } from "./ipc/server.js";
import { MessageRouter } from "./router/message-router.js";
import { ChannelBridge } from "./bridges/channel-bridge.js";
import { AgentExecutor, createAgentExecutor, type AgentRunStatusReporterFactory } from "../agent/executor.js";
import type { Agent } from "../agent/types.js";
import { EnvelopeScheduler } from "./scheduler/envelope-scheduler.js";
import { CronScheduler } from "./scheduler/cron-scheduler.js";
import { MemoryService, MemoryStore } from "./memory/index.js";
import type { RpcMethodRegistry } from "./ipc/types.js";
import { RPC_ERRORS } from "./ipc/types.js";
import type { ChatAdapter } from "../adapters/types.js";
import { TelegramAdapter } from "../adapters/telegram.adapter.js";
import { TELEGRAM_MAX_TEXT_CHARS } from "../adapters/telegram/shared.js";
import { DEFAULT_AGENT_PERMISSION_LEVEL } from "../shared/defaults.js";
import { getHiBossPaths } from "../shared/hiboss-paths.js";
import {
  DEFAULT_PERMISSION_POLICY,
  type PermissionLevel,
  type PermissionPolicyV1,
  getRequiredPermissionLevel,
  isAtLeastPermissionLevel,
  parsePermissionPolicyV1OrDefault,
} from "../shared/permissions.js";
import { errorMessage, logEvent, setDaemonLogTimeZone } from "../shared/daemon-log.js";
import { getEnvelopeSourceFromEnvelope } from "../envelope/source.js";
import { PidLock, isDaemonRunning, isSocketAcceptingConnections } from "./pid-lock.js";
import type { DaemonContext, Principal } from "./rpc/context.js";
import { rpcError } from "./rpc/context.js";
import {
  createDaemonHandlers,
  createReactionHandlers,
  createCronHandlers,
  createMemoryHandlers,
  createEnvelopeHandlers,
  createSetupHandlers,
  createAgentHandlers,
  createAgentSetHandler,
  createAgentDeleteHandler,
} from "./rpc/index.js";
import { createChannelCommandHandler } from "./channel-commands.js";
import { getTelegramStatusMessageEnabled } from "./telegram-status-config.js";

// Re-export for CLI and external use
export { isDaemonRunning, isSocketAcceptingConnections };

/**
 * Hi-Boss daemon configuration.
 */
export interface DaemonConfig {
  /**
   * Hi-Boss root directory (user-facing).
   *
   * Default: `~/hiboss` (override via `HIBOSS_DIR`).
   */
  dataDir: string;
  /**
   * Internal daemon directory (hidden).
   *
   * Default: `{{dataDir}}/.daemon`.
   */
  daemonDir: string;
  boss?: {
    telegram?: string;
  };
}

/**
 * Default configuration paths.
 */
export function getDefaultConfig(): DaemonConfig {
  const paths = getHiBossPaths();
  return {
    dataDir: paths.rootDir,
    daemonDir: paths.daemonDir,
  };
}

/**
 * Get socket path for IPC client.
 */
export function getSocketPath(config: DaemonConfig = getDefaultConfig()): string {
  return path.join(config.daemonDir, "daemon.sock");
}

const TELEGRAM_STATUS_MESSAGE_MIN_INTERVAL_MS = 1000;
const TELEGRAM_STATUS_MESSAGE_MIN_SECTION_CHARS = 64;
const TELEGRAM_STATUS_MESSAGE_TOOL_MAX_CHARS = 240;

function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(-maxChars);
  return `...${text.slice(-(maxChars - 3))}`;
}

function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function redactSensitiveText(text: string): string {
  return text.replace(
    /(token|api[_-]?key|secret|password|passcode|authorization|bearer)\s*[:=]\s*([^\s]+)/gi,
    (_match, key) => `${key}: ***`
  );
}

function isNoContentPlaceholder(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed === "(no content)" || trimmed === "[no content]" || trimmed === "no content";
}

type StatusSection = {
  text: string;
  open: string;
  close: string;
  weight?: number;
  maxChars?: number;
};

function allocateSectionBudgets(sections: StatusSection[], available: number): number[] {
  if (sections.length === 0) return [];
  if (available <= 0) return sections.map(() => 1);

  const weights = sections.map((section) => section.weight ?? 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let budgets = weights.map((weight) => Math.max(1, Math.floor((available * weight) / totalWeight)));

  let used = budgets.reduce((sum, budget) => sum + budget, 0);
  let remainder = available - used;
  let index = 0;
  while (remainder > 0) {
    budgets[index % budgets.length] += 1;
    remainder -= 1;
    index += 1;
  }

  let overflow = 0;
  for (let i = 0; i < sections.length; i += 1) {
    const cap = sections[i].maxChars;
    if (typeof cap === "number" && cap > 0 && budgets[i] > cap) {
      overflow += budgets[i] - cap;
      budgets[i] = cap;
    }
  }

  if (overflow > 0) {
    const eligible = sections
      .map((section, idx) => {
        const cap = section.maxChars;
        if (typeof cap === "number" && cap > 0 && budgets[idx] >= cap) return null;
        return idx;
      })
      .filter((idx): idx is number => idx !== null);
    let idx = 0;
    while (overflow > 0 && eligible.length > 0) {
      const target = eligible[idx % eligible.length];
      const cap = sections[target].maxChars;
      if (typeof cap === "number" && cap > 0 && budgets[target] >= cap) {
        idx += 1;
        continue;
      }
      budgets[target] += 1;
      overflow -= 1;
      idx += 1;
    }
  }

  return budgets;
}

function renderTelegramRunStatusText(thinking: string, assistant: string, tool: string): string {
  const thinkingRaw = thinking.trim();
  const assistantRaw = assistant.trim();
  const toolRaw = tool.trim();
  const thinkingClean = thinkingRaw && !isNoContentPlaceholder(thinkingRaw) ? thinkingRaw : "";
  const assistantClean = assistantRaw && !isNoContentPlaceholder(assistantRaw) ? assistantRaw : "";
  const toolClean = toolRaw && !isNoContentPlaceholder(toolRaw) ? toolRaw : "";
  if (!thinkingClean && !assistantClean && !toolClean) return "";

  const sections: StatusSection[] = [];
  if (thinkingClean) {
    sections.push({ text: thinkingClean, open: "<i>", close: "</i>", weight: 3 });
  }
  if (assistantClean) {
    sections.push({ text: assistantClean, open: "<b>", close: "</b>", weight: 3 });
  }
  if (toolClean) {
    sections.push({
      text: toolClean,
      open: "<code>",
      close: "</code>",
      weight: 1,
      maxChars: TELEGRAM_STATUS_MESSAGE_TOOL_MAX_CHARS,
    });
  }

  const separator = sections.length > 1 ? "\n\n" : "";
  const maxTotal = TELEGRAM_MAX_TEXT_CHARS;
  const overhead =
    sections.reduce((sum, section) => sum + section.open.length + section.close.length, 0) +
    (sections.length > 1 ? separator.length * (sections.length - 1) : 0);
  const available = Math.max(0, maxTotal - overhead);

  if (sections.length === 1) {
    let budget = Math.max(1, available);
    let rendered = "";
    for (let i = 0; i < 3; i++) {
      const part = escapeTelegramHtml(truncateTail(sections[0].text, budget));
      rendered = `${sections[0].open}${part}${sections[0].close}`;
      if (rendered.length <= maxTotal) return rendered;
      const excess = rendered.length - maxTotal;
      budget = Math.max(1, budget - excess);
    }
    return rendered;
  }

  let budgets = allocateSectionBudgets(sections, available);
  let rendered = "";
  for (let i = 0; i < 3; i++) {
    const parts = sections.map((section, idx) => escapeTelegramHtml(truncateTail(section.text, budgets[idx])));
    rendered = parts
      .map((part, idx) => `${sections[idx].open}${part}${sections[idx].close}`)
      .join(separator);

    if (rendered.length <= maxTotal) {
      return rendered;
    }

    const excess = rendered.length - maxTotal;
    const reduceEach = Math.ceil(excess / sections.length);
    budgets = budgets.map((budget) => Math.max(1, budget - reduceEach));
  }

  return rendered;
}

function getRuntimeMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const text = (message as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

type ToolStatus = {
  name?: string;
  callId?: string;
  detail?: string;
  state: "running" | "done" | "error";
};

const TOOL_DETAIL_HINT_KEYS = ["command", "cmd", "query", "code", "sql", "url", "path", "text", "input", "prompt"];
const TOOL_DETAIL_EVENT_KEYS = ["input", "arguments", "args", "toolInput", "parameters", "payload", "command", "code", "query"];

function getEventString(event: Record<string, unknown>, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" ? value : undefined;
}

function extractToolName(event: Record<string, unknown>): string | undefined {
  return (
    getEventString(event, "toolName") ??
    getEventString(event, "tool_name") ??
    getEventString(event, "name") ??
    getEventString(event, "tool")
  );
}

function extractToolCallId(event: Record<string, unknown>): string | undefined {
  return getEventString(event, "callId") ?? getEventString(event, "toolCallId") ?? getEventString(event, "id");
}

function summarizeToolValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of TOOL_DETAIL_HINT_KEYS) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return `${key}=${candidate}`;
      }
    }
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

function extractToolDetail(event: Record<string, unknown>): string | undefined {
  for (const key of TOOL_DETAIL_EVENT_KEYS) {
    if (!(key in event)) continue;
    const summary = summarizeToolValue(event[key]);
    if (summary) return summary;
  }
  return undefined;
}

function normalizeToolDetail(detail: string): string {
  const redacted = redactSensitiveText(detail);
  const collapsed = collapseWhitespace(redacted);
  return truncateHead(collapsed, TELEGRAM_STATUS_MESSAGE_TOOL_MAX_CHARS);
}

function formatToolStatus(status: ToolStatus | null): string {
  if (!status) return "";
  const name = status.name?.trim();
  const label = name ? `tool ${name}` : "tool";
  const stateLabel = status.state === "running" ? "running" : status.state === "error" ? "error" : "done";
  const detail = status.detail ? `: ${status.detail}` : "";
  return `${label} (${stateLabel})${detail}`;
}

/**
 * Hi-Boss daemon - manages agents, messages, and platform integrations.
 */
export class Daemon {
  private db: HiBossDatabase;
  private ipc: IpcServer;
  private router: MessageRouter;
  private bridge: ChannelBridge;
  private executor: AgentExecutor;
  private scheduler: EnvelopeScheduler;
  private cronScheduler: CronScheduler | null = null;
  private memoryService: MemoryService | null = null;
  private memoryStore: MemoryStore | null = null;
  private adapters: Map<string, ChatAdapter> = new Map(); // token -> adapter
  private running = false;
  private startTimeMs: number | null = null;
  private pidLock: PidLock;
  private defaultPermissionPolicy: PermissionPolicyV1 = DEFAULT_PERMISSION_POLICY;
  private createRunStatusReporter: AgentRunStatusReporterFactory = ({ agent, envelopes }) => {
    const latestTelegramEnvelope = [...envelopes]
      .reverse()
      .find((envelope) => {
        const md = envelope.metadata;
        if (!md || typeof md !== "object") return false;
        const meta = md as Record<string, unknown>;
        return meta.platform === "telegram";
      });

    if (!latestTelegramEnvelope) return undefined;

    const metadata = latestTelegramEnvelope.metadata as Record<string, unknown>;
    const chat = metadata.chat as { id?: unknown } | undefined;
    const chatId = typeof chat?.id === "string" ? chat.id : "";
    if (!chatId) return undefined;

    const binding = this.db.getAgentBindingByType(agent.name, "telegram");
    if (!binding) return undefined;

    const adapter = this.adapters.get(binding.adapterToken);
    if (!adapter || !(adapter instanceof TelegramAdapter)) return undefined;

    if (!getTelegramStatusMessageEnabled(this.db, chatId)) return undefined;

    const status = adapter.createStatusMessage(chatId, {
      minIntervalMs: TELEGRAM_STATUS_MESSAGE_MIN_INTERVAL_MS,
      maxChars: TELEGRAM_MAX_TEXT_CHARS,
      parseMode: "HTML",
    });

    let thinkingText = "";
    let assistantText = "";
    let toolStatus: ToolStatus | null = null;

    const updateStatus = (): void => {
      const text = renderTelegramRunStatusText(thinkingText, assistantText, formatToolStatus(toolStatus));
      if (!text) return;
      status.update(text);
    };

    const typing = adapter.createTypingIndicator(chatId);
    typing.start();

    const handleEvent = (event: { type?: string; [key: string]: unknown }): void => {
      switch (event.type) {
        case "run.started": {
          const text = renderTelegramRunStatusText(thinkingText, assistantText, formatToolStatus(toolStatus));
          if (text) {
            status.start(text);
          }
          break;
        }
        case "assistant.delta": {
          if (typeof event.textDelta === "string" && event.textDelta) {
            assistantText += event.textDelta;
            updateStatus();
          }
          break;
        }
        case "assistant.message": {
          const messageText = getRuntimeMessageText((event as { message?: unknown }).message);
          if (messageText) {
            assistantText = messageText;
            updateStatus();
          }
          break;
        }
        case "assistant.reasoning.delta": {
          if (typeof event.textDelta === "string" && event.textDelta) {
            thinkingText += event.textDelta;
            updateStatus();
          }
          break;
        }
        case "assistant.reasoning.message": {
          const messageText = getRuntimeMessageText((event as { message?: unknown }).message);
          if (messageText) {
            thinkingText = messageText;
            updateStatus();
          }
          break;
        }
        case "tool.call": {
          const toolEvent = event as Record<string, unknown>;
          const toolName = extractToolName(toolEvent);
          const detail = extractToolDetail(toolEvent);
          toolStatus = {
            name: toolName,
            callId: extractToolCallId(toolEvent),
            detail: detail ? normalizeToolDetail(detail) : undefined,
            state: "running",
          };
          updateStatus();
          break;
        }
        case "tool.result": {
          const toolEvent = event as Record<string, unknown>;
          const callId = extractToolCallId(toolEvent);
          if (!toolStatus || !callId || toolStatus.callId === callId) {
            toolStatus = {
              name: toolStatus?.name ?? extractToolName(toolEvent),
              callId: toolStatus?.callId ?? callId,
              detail: toolStatus?.detail,
              state: "done",
            };
            updateStatus();
          }
          break;
        }
        case "tool.error": {
          const toolEvent = event as Record<string, unknown>;
          toolStatus = {
            name: toolStatus?.name ?? extractToolName(toolEvent),
            callId: toolStatus?.callId ?? extractToolCallId(toolEvent),
            detail: toolStatus?.detail,
            state: "error",
          };
          updateStatus();
          break;
        }
        case "run.completed": {
          if (typeof event.finalText === "string" && event.finalText) {
            assistantText = event.finalText;
          }
          break;
        }
        default:
          break;
      }
    };

    return {
      onEvent: handleEvent,
      finish: () => {
        typing.stop();
        void status.delete();
      },
    };
  };

  constructor(private config: DaemonConfig = getDefaultConfig()) {
    const dbPath = path.join(config.daemonDir, "hiboss.db");
    const socketPath = path.join(config.daemonDir, "daemon.sock");

    this.pidLock = new PidLock({ daemonDir: config.daemonDir });

    this.db = new HiBossDatabase(dbPath);
    this.ipc = new IpcServer(socketPath);
    this.router = new MessageRouter(this.db, {
      onEnvelopeDone: (envelope) => this.cronScheduler?.onEnvelopeDone(envelope),
    });
    this.bridge = new ChannelBridge(this.router, this.db, config);
    this.executor = createAgentExecutor({
      db: this.db,
      hibossDir: config.dataDir,
      onEnvelopesDone: (envelopeIds) => this.cronScheduler?.onEnvelopesDone(envelopeIds),
      createRunStatusReporter: this.createRunStatusReporter,
    });
    this.scheduler = new EnvelopeScheduler(this.db, this.router, this.executor);
    this.cronScheduler = new CronScheduler(this.db, this.scheduler);

    this.registerRpcMethods();
  }

  private getPermissionPolicy(): PermissionPolicyV1 {
    const raw = this.db.getConfig("permission_policy");
    return parsePermissionPolicyV1OrDefault(raw, this.defaultPermissionPolicy);
  }

  // (reserved for future Telegram UX helpers)

  private getAgentPermissionLevel(agent: Agent): PermissionLevel {
    return agent.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL;
  }

  private resolvePrincipal(token: string): Principal {
    if (this.db.verifyBossToken(token)) {
      return { kind: "boss", level: "boss" };
    }

    const agent = this.db.findAgentByToken(token);
    if (!agent) {
      rpcError(RPC_ERRORS.UNAUTHORIZED, "Invalid token");
    }

    return { kind: "agent", level: this.getAgentPermissionLevel(agent), agent };
  }

  private assertOperationAllowed(operation: string, principal: { level: PermissionLevel }): void {
    const policy = this.getPermissionPolicy();
    const required = getRequiredPermissionLevel(policy, operation);
    if (!isAtLeastPermissionLevel(principal.level, required)) {
      rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
    }
  }

  private getMemoryDisabledMessage(): string {
    const lastError = (this.db.getConfig("memory_model_last_error") ?? "").trim();
    const suffix = lastError ? `: ${lastError}` : "";
    return `Memory is disabled${suffix}. Ask boss for help. Fix with: hiboss memory setup --default OR hiboss memory setup --model-path <path>`;
  }

  private writeMemoryConfigToDb(memory: {
    enabled: boolean;
    mode: "default" | "local";
    modelPath: string;
    modelUri: string;
    dims: number;
    lastError: string;
  }): void {
    this.db.setConfig("memory_enabled", memory.enabled ? "true" : "false");
    this.db.setConfig("memory_model_source", memory.mode);
    this.db.setConfig("memory_model_uri", memory.modelUri ?? "");
    this.db.setConfig("memory_model_path", memory.modelPath ?? "");
    this.db.setConfig("memory_model_dims", String(memory.dims ?? 0));
    this.db.setConfig("memory_model_last_error", memory.lastError ?? "");
  }

  private disableMemoryWithError(message: string): void {
    this.db.setConfig("memory_enabled", "false");
    this.db.setConfig("memory_model_last_error", message);
    this.db.setConfig("memory_model_dims", "0");
  }

  private async ensureMemoryService(): Promise<MemoryService> {
    if (this.memoryService) return this.memoryService;
    const enabled = this.db.getConfig("memory_enabled") === "true";
    if (!enabled) {
      rpcError(RPC_ERRORS.INTERNAL_ERROR, this.getMemoryDisabledMessage());
    }
    const modelPath = (this.db.getConfig("memory_model_path") ?? "").trim();
    if (!modelPath) {
      this.disableMemoryWithError("Missing memory model path");
      rpcError(RPC_ERRORS.INTERNAL_ERROR, this.getMemoryDisabledMessage());
    }

    try {
      const daemonMode = (process.env.HIBOSS_DAEMON_MODE ?? "").trim().toLowerCase();
      const examplesMode = daemonMode === "examples";
      const dims = Number((this.db.getConfig("memory_model_dims") ?? "").trim() || "0");
      this.memoryService = await MemoryService.create({
        daemonDir: this.config.daemonDir,
        modelPath,
        mode: examplesMode ? "examples" : "default",
        dims: examplesMode ? dims : undefined,
      });
      return this.memoryService;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.disableMemoryWithError(message);
      rpcError(RPC_ERRORS.INTERNAL_ERROR, this.getMemoryDisabledMessage());
    }
  }

  private async ensureMemoryStore(): Promise<MemoryStore> {
    const enabled = this.db.getConfig("memory_enabled") === "true";
    if (!enabled) {
      rpcError(RPC_ERRORS.INTERNAL_ERROR, this.getMemoryDisabledMessage());
    }
    if (this.memoryStore) return this.memoryStore;
    const modelPath = (this.db.getConfig("memory_model_path") ?? "").trim();
    if (!modelPath) {
      this.disableMemoryWithError("Missing memory model path");
      rpcError(RPC_ERRORS.INTERNAL_ERROR, this.getMemoryDisabledMessage());
    }

    try {
      this.memoryStore = await MemoryStore.create({ daemonDir: this.config.daemonDir });
      return this.memoryStore;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.disableMemoryWithError(message);
      rpcError(RPC_ERRORS.INTERNAL_ERROR, this.getMemoryDisabledMessage());
    }
  }

  /**
   * Create the DaemonContext for RPC handlers.
   */
  private createContext(): DaemonContext {
    // Important: `running`/`startTimeMs` must reflect live daemon state (daemon.status depends on it).
    const daemon = this;
    return {
      db: this.db,
      router: this.router,
      executor: this.executor,
      scheduler: this.scheduler,
      cronScheduler: this.cronScheduler,
      adapters: this.adapters,
      config: this.config,
      get running() {
        return daemon.running;
      },
      get startTimeMs() {
        return daemon.startTimeMs;
      },
      resolvePrincipal: (token) => this.resolvePrincipal(token),
      assertOperationAllowed: (op, principal) => this.assertOperationAllowed(op, principal),
      getPermissionPolicy: () => this.getPermissionPolicy(),
      ensureMemoryService: () => this.ensureMemoryService(),
      ensureMemoryStore: () => this.ensureMemoryStore(),
      getMemoryDisabledMessage: () => this.getMemoryDisabledMessage(),
      writeMemoryConfigToDb: (m) => this.writeMemoryConfigToDb(m),
      closeMemoryService: async () => { await this.memoryService?.close().catch(() => undefined); this.memoryService = null; },
      closeMemoryStore: async () => { await this.memoryStore?.close().catch(() => undefined); this.memoryStore = null; },
      createAdapterForBinding: (type, token) => this.createAdapterForBinding(type, token),
      removeAdapter: (token) => this.removeAdapter(token),
      registerAgentHandler: (name) => this.registerSingleAgentHandler(name),
    };
  }

  /**
   * Start the daemon.
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Daemon is already running");
    }

    // Acquire flock-based PID lock (single-instance enforcement).
    await this.pidLock.acquire();

    try {
      // Start IPC server
      await this.ipc.start();

      // Mark as running early so stop() can clean up partial startups.
      this.running = true;
      this.startTimeMs = Date.now();

      // All displayed timestamps (including daemon logs) use the boss timezone.
      setDaemonLogTimeZone(this.db.getBossTimezone());

      const daemonMode = (process.env.HIBOSS_DAEMON_MODE ?? "").trim().toLowerCase();
      const examplesMode = daemonMode === "examples";
      if (examplesMode) {
        // IPC-only daemon for generating deterministic docs (no schedulers/adapters/auto-execution).
        logEvent("info", "daemon-started", { "data-dir": this.config.dataDir, "adapters-count": 0, mode: "examples" });
        return;
      }

      // Set up command handler for /new etc.
      this.setupCommandHandler();

      // Load bindings and create adapters
      await this.loadBindings();

      // Register agent handlers for auto-execution
      await this.registerAgentExecutionHandlers();

      // Start all loaded adapters
      for (const adapter of this.adapters.values()) {
        await adapter.start();
      }

      // Cron: skip missed runs before any startup delivery/turn triggers.
      this.cronScheduler?.reconcileAllSchedules({ skipMisfires: true });

      // Start scheduler after adapters/handlers are ready
      this.scheduler.start();

      // Process any pending envelopes from before restart
      await this.processPendingEnvelopes();
    } catch (err) {
      // Best-effort cleanup to avoid leaving stale pid/socket files.
      await this.stop().catch(() => {});
      await this.pidLock.release();
      this.running = false;
      throw err;
    }

    logEvent("info", "daemon-started", {
      "data-dir": this.config.dataDir,
      "adapters-count": this.adapters.size,
    });
  }

  /**
   * Set up command handler for adapter commands.
   */
  private setupCommandHandler(): void {
    this.bridge.setCommandHandler(createChannelCommandHandler({ db: this.db, executor: this.executor }));
  }

  /**
   * Register handlers for all agents to trigger execution on new envelopes.
   */
  private async registerAgentExecutionHandlers(): Promise<void> {
    const agents = this.db.listAgents();

    for (const agent of agents) {
      this.registerSingleAgentHandler(agent.name);
    }
  }

  /**
   * Register a single agent handler for auto-execution.
   */
  private registerSingleAgentHandler(agentName: string): void {
    this.router.registerAgentHandler(agentName, async (envelope) => {
      const currentAgent = this.db.getAgentByName(agentName);
      if (!currentAgent) {
        logEvent("error", "agent-not-found", { "agent-name": agentName });
        return;
      }

      // Non-blocking: trigger agent run
      this.executor.checkAndRun(currentAgent, this.db, {
        kind: "envelope",
        source: getEnvelopeSourceFromEnvelope(envelope),
        envelopeId: envelope.id,
      }).catch((err) => {
        logEvent("error", "agent-check-and-run-failed", {
          "agent-name": agentName,
          error: errorMessage(err),
        });
      });
    });
  }

  /**
   * Process any pending envelopes that existed before daemon restart.
   */
  private async processPendingEnvelopes(): Promise<void> {
    const agents = this.db.listAgents();

    for (const agent of agents) {
      const pending = this.db.getPendingEnvelopesForAgent(agent.name, 1);
      if (pending.length > 0) {
        this.executor.checkAndRun(agent, this.db, { kind: "daemon-startup" }).catch((err) => {
          logEvent("error", "agent-check-and-run-failed", {
            "agent-name": agent.name,
            error: errorMessage(err),
          });
        });
      }
    }
  }

  /**
   * Load bindings from database and create adapters.
   */
  private async loadBindings(): Promise<void> {
    const bindings = this.db.listBindings();

    for (const binding of bindings) {
      await this.createAdapterForBinding(binding.adapterType, binding.adapterToken);
    }
  }

  /**
   * Create an adapter for a binding.
   */
  private async createAdapterForBinding(
    adapterType: string,
    adapterToken: string
  ): Promise<ChatAdapter | null> {
    // Check if adapter already exists
    if (this.adapters.has(adapterToken)) {
      return this.adapters.get(adapterToken)!;
    }

    let adapter: ChatAdapter;

    switch (adapterType) {
      case "telegram":
        adapter = new TelegramAdapter(adapterToken);
        break;
      default:
        logEvent("error", "adapter-unknown-type", { "adapter-type": adapterType });
        return null;
    }

    this.adapters.set(adapterToken, adapter);
    this.bridge.connect(adapter, adapterToken);

    if (this.running) {
      await adapter.start();
    }

    return adapter;
  }

  /**
   * Remove an adapter.
   */
  private async removeAdapter(adapterToken: string): Promise<void> {
    const adapter = this.adapters.get(adapterToken);
    if (adapter) {
      await adapter.stop();
      this.adapters.delete(adapterToken);
    }
  }

  /**
   * Stop the daemon.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    // Stop scheduler first (prevents new work while shutting down)
    this.scheduler.stop();

    // Stop all adapters
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }

    // Close agent executor
    await this.executor.closeAll();

    // Stop IPC server
    await this.ipc.stop();

    // Close semantic memory service
    await this.memoryService?.close().catch(() => undefined);
    this.memoryService = null;

    // Close semantic memory store (non-embedding operations)
    await this.memoryStore?.close().catch(() => undefined);
    this.memoryStore = null;

    // Close database
    this.db.close();

    // Release flock-based PID lock
    await this.pidLock.release();

    this.running = false;
    logEvent("info", "daemon-stopped");
  }

  /**
   * Check if daemon is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Register all RPC methods using extracted handlers.
   */
  private registerRpcMethods(): void {
    const ctx = this.createContext();

    const methods: RpcMethodRegistry = {
      ...createEnvelopeHandlers(ctx),
      ...createReactionHandlers(ctx),
      ...createCronHandlers(ctx),
      ...createMemoryHandlers(ctx),
      ...createAgentHandlers(ctx),
      ...createAgentSetHandler(ctx),
      ...createAgentDeleteHandler(ctx),
      ...createDaemonHandlers(ctx),
      ...createSetupHandlers(ctx),
    };

    this.ipc.registerMethods(methods);
  }
}
