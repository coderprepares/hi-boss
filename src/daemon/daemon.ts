import * as path from "path";
import { HiBossDatabase } from "./db/database.js";
import { IpcServer } from "./ipc/server.js";
import { MessageRouter } from "./router/message-router.js";
import { ChannelBridge } from "./bridges/channel-bridge.js";
import { AgentExecutor, createAgentExecutor } from "../agent/executor.js";
import type { AgentRunStatusReporterFactory } from "../agent/executor.js";
import type { Agent } from "../agent/types.js";
import { EnvelopeScheduler } from "./scheduler/envelope-scheduler.js";
import { CronScheduler } from "./scheduler/cron-scheduler.js";
import { MemoryService, MemoryStore } from "./memory/index.js";
import type { RpcMethodRegistry } from "./ipc/types.js";
import { RPC_ERRORS } from "./ipc/types.js";
import type { ChatAdapter } from "../adapters/types.js";
import { TelegramAdapter } from "../adapters/telegram.adapter.js";
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
import { createTelegramRunStatusReporter } from "./telegram-verbose.js";

// Re-export for CLI and external use
export { isDaemonRunning, isSocketAcceptingConnections };

export interface DaemonConfig {
  dataDir: string;
  daemonDir: string;
  boss?: {
    telegram?: string;
  };
}

export function getDefaultConfig(): DaemonConfig {
  const paths = getHiBossPaths();
  return {
    dataDir: paths.rootDir,
    daemonDir: paths.daemonDir,
  };
}

export function getSocketPath(config: DaemonConfig = getDefaultConfig()): string {
  return path.join(config.daemonDir, "daemon.sock");
}

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
    return createTelegramRunStatusReporter({
      db: this.db,
      adapters: this.adapters,
      agent,
      envelopes,
    });
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

  private createContext(): DaemonContext {
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

  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Daemon is already running");
    }

    await this.pidLock.acquire();

    try {
      await this.ipc.start();
      this.running = true;
      this.startTimeMs = Date.now();
      setDaemonLogTimeZone(this.db.getBossTimezone());

      const daemonMode = (process.env.HIBOSS_DAEMON_MODE ?? "").trim().toLowerCase();
      const examplesMode = daemonMode === "examples";
      if (examplesMode) {
        logEvent("info", "daemon-started", { "data-dir": this.config.dataDir, "adapters-count": 0, mode: "examples" });
        return;
      }
      this.setupCommandHandler();
      await this.loadBindings();
      await this.registerAgentExecutionHandlers();
      for (const adapter of this.adapters.values()) {
        await adapter.start();
      }
      this.cronScheduler?.reconcileAllSchedules({ skipMisfires: true });
      this.scheduler.start();
      await this.processPendingEnvelopes();
    } catch (err) {
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

  private setupCommandHandler(): void {
    this.bridge.setCommandHandler(createChannelCommandHandler({ db: this.db, executor: this.executor }));
  }

  private async registerAgentExecutionHandlers(): Promise<void> {
    const agents = this.db.listAgents();

    for (const agent of agents) {
      this.registerSingleAgentHandler(agent.name);
    }
  }

  private registerSingleAgentHandler(agentName: string): void {
    this.router.registerAgentHandler(agentName, async (envelope) => {
      const currentAgent = this.db.getAgentByName(agentName);
      if (!currentAgent) {
        logEvent("error", "agent-not-found", { "agent-name": agentName });
        return;
      }

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

  private async loadBindings(): Promise<void> {
    const bindings = this.db.listBindings();

    for (const binding of bindings) {
      await this.createAdapterForBinding(binding.adapterType, binding.adapterToken);
    }
  }

  private async createAdapterForBinding(
    adapterType: string,
    adapterToken: string
  ): Promise<ChatAdapter | null> {
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

  private async removeAdapter(adapterToken: string): Promise<void> {
    const adapter = this.adapters.get(adapterToken);
    if (adapter) {
      await adapter.stop();
      this.adapters.delete(adapterToken);
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.scheduler.stop();
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
    await this.executor.closeAll();
    await this.ipc.stop();
    await this.memoryService?.close().catch(() => undefined);
    this.memoryService = null;
    await this.memoryStore?.close().catch(() => undefined);
    this.memoryStore = null;
    this.db.close();
    await this.pidLock.release();

    this.running = false;
    logEvent("info", "daemon-stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

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
