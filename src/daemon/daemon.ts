import * as path from "path";
import { HiBossDatabase } from "./db/database.js";
import { IpcServer } from "./ipc/server.js";
import { MessageRouter } from "./router/message-router.js";
import { ChannelBridge } from "./bridges/channel-bridge.js";
import { AgentExecutor, createAgentExecutor } from "../agent/executor.js";
import { type BackgroundExecutor, createBackgroundExecutor } from "../agent/background-executor.js";
import type { Agent } from "../agent/types.js";
import { EnvelopeScheduler } from "./scheduler/envelope-scheduler.js";
import { CronScheduler } from "./scheduler/cron-scheduler.js";
import type { RpcMethodRegistry } from "./ipc/types.js";
import { RPC_ERRORS } from "./ipc/types.js";
import type { ChatAdapter } from "../adapters/types.js";
import { TelegramAdapter } from "../adapters/telegram.adapter.js";
import { WechatClawbotAdapter } from "../adapters/wechat-clawbot.adapter.js";
import { BACKGROUND_AGENT_NAME, DEFAULT_AGENT_PERMISSION_LEVEL } from "../shared/defaults.js";
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
import type { Envelope } from "../envelope/types.js";
import { PidLock, isDaemonRunning, isSocketAcceptingConnections } from "./pid-lock.js";
import type { DaemonContext, Principal } from "./rpc/context.js";
import { rpcError } from "./rpc/context.js";
import {
  createDaemonHandlers,
  createReactionHandlers,
  createCronHandlers,
  createEnvelopeHandlers,
  createSetupHandlers,
  createAgentHandlers,
  createAgentSetHandler,
  createAgentDeleteHandler,
} from "./rpc/index.js";
import { createChannelCommandHandler } from "./channel-commands.js";
import { buildMissingAgentRolesGuidance } from "../shared/agent-role.js";
import { createTelegramRunStatusReporter } from "./telegram-verbose.js";
import {
  getSpeakerBindingIntegrity,
  hasSpeakerBindingIntegrityViolations,
  toSpeakerBindingIntegrityView,
} from "../shared/speaker-binding-invariant.js";
import { parseStoredHttpIngressConfig } from "../http-bridge/config.js";
import { HttpIngressBridge } from "../http-bridge/http-ingress-bridge.js";
import { HTTP_INGRESS_CONFIG_KEY } from "../http-bridge/types.js";
import { EnvelopeRunDebouncer } from "./envelope-run-debounce.js";

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
  private backgroundExecutor: BackgroundExecutor;
  private scheduler: EnvelopeScheduler;
  private cronScheduler: CronScheduler | null = null;
  private httpIngress: HttpIngressBridge | null = null;
  private envelopeRunDebouncer = new EnvelopeRunDebouncer();
  private adapters: Map<string, ChatAdapter> = new Map(); // token -> adapter
  private createRunStatusReporter = ({ agent, envelopes }: { agent: Agent; envelopes: Envelope[] }) =>
    createTelegramRunStatusReporter({
      db: this.db,
      adapters: this.adapters,
      agent,
      envelopes,
    });
  private running = false;
  private startTimeMs: number | null = null;
  private pidLock: PidLock;
  private defaultPermissionPolicy: PermissionPolicyV1 = DEFAULT_PERMISSION_POLICY;

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
    this.backgroundExecutor = createBackgroundExecutor({ db: this.db, router: this.router });
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

  private createContext(): DaemonContext {
    // Important: `running`/`startTimeMs` must reflect live daemon state (daemon.status depends on it).
    const daemon = this;
    return {
      db: this.db,
      router: this.router,
      executor: this.executor,
      backgroundExecutor: this.backgroundExecutor,
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
      createAdapterForBinding: (type, token) => this.createAdapterForBinding(type, token),
      removeAdapter: (token) => this.removeAdapter(token),
      registerAgentHandler: (name) => this.registerSingleAgentHandler(name),
    };
  }

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

      const roleBackfill = this.db.backfillLegacyAgentRolesFromBindings();
      if (roleBackfill.updated > 0) {
        logEvent("info", "daemon-agent-role-backfill", {
          updated: roleBackfill.updated,
          speaker: roleBackfill.speaker,
          leader: roleBackfill.leader,
        });
      }

      const roleCounts = this.db.getAgentRoleCounts();
      const missingSpeaker = roleCounts.speaker < 1;
      const missingLeader = roleCounts.leader < 1;
      if (missingSpeaker || missingLeader) {
        const agentCount = this.db.listAgents().length;

        logEvent("error", "daemon-startup-blocked-roles", {
          "speaker-count": roleCounts.speaker,
          "leader-count": roleCounts.leader,
          "agent-count": agentCount,
        });

        const guidance = buildMissingAgentRolesGuidance({
          missingSpeaker,
          missingLeader,
        });

        throw new Error(guidance);
      }

      const integrity = getSpeakerBindingIntegrity({
        agents: this.db.listAgents(),
        bindings: this.db.listBindings(),
      });
      if (hasSpeakerBindingIntegrityViolations(integrity)) {
        const view = toSpeakerBindingIntegrityView(integrity);
        logEvent("error", "daemon-startup-blocked-speaker-bindings", {
          "speaker-without-bindings": view.speakerWithoutBindings.join(",") || undefined,
          "duplicate-speaker-binding-count": view.duplicateSpeakerBindings.length,
        });
        throw new Error(buildMissingAgentRolesGuidance({ missingSpeaker: false, missingLeader: false }));
      }

      // Set up command handler for /new etc.
      this.setupCommandHandler();

      // Load bindings and create adapters
      await this.loadBindings();

      // Register agent handlers for auto-execution
      await this.registerAgentExecutionHandlers();
      this.registerBackgroundAgentHandler();

      // Start all loaded adapters
      for (const adapter of this.adapters.values()) {
        await adapter.start();
      }

      this.httpIngress = this.createHttpIngressBridge();
      await this.httpIngress?.start();

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

  private setupCommandHandler(): void {
    this.bridge.setCommandHandler(
      createChannelCommandHandler({
        db: this.db,
        executor: this.executor,
        backgroundExecutor: this.backgroundExecutor,
      })
    );
  }

  private async registerAgentExecutionHandlers(): Promise<void> {
    const agents = this.db.listAgents();

    for (const agent of agents) {
      this.registerSingleAgentHandler(agent.name);
    }
  }

  private registerSingleAgentHandler(agentName: string): void {
    this.router.registerAgentHandler(agentName, async (envelope) => {
      this.envelopeRunDebouncer.schedule(agentName, {
        kind: "envelope",
        source: getEnvelopeSourceFromEnvelope(envelope),
        envelopeId: envelope.id,
      }, (task) => {
        const currentAgent = this.db.getAgentByName(task.agentName);
        if (!currentAgent) {
          logEvent("error", "agent-not-found", { "agent-name": task.agentName });
          return;
        }

        this.executor.checkAndRun(currentAgent, this.db, task.trigger).catch((err) => {
          logEvent("error", "agent-check-and-run-failed", {
            "agent-name": task.agentName,
            error: errorMessage(err),
          });
        });
      });
    });
  }

  private registerBackgroundAgentHandler(): void {
    this.router.registerAgentHandler(BACKGROUND_AGENT_NAME, async (envelope) => {
      this.backgroundExecutor.enqueue(envelope);
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
    // Check if adapter already exists
    if (this.adapters.has(adapterToken)) {
      return this.adapters.get(adapterToken)!;
    }

    let adapter: ChatAdapter;

    switch (adapterType) {
      case "telegram":
        adapter = new TelegramAdapter(adapterToken);
        break;
      case "wechat-clawbot":
        adapter = new WechatClawbotAdapter(adapterToken);
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

    // Stop scheduler first (prevents new work while shutting down)
    this.scheduler.stop();
    this.envelopeRunDebouncer.clear();

    await this.httpIngress?.stop();
    this.httpIngress = null;

    // Stop all adapters
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }

    // Close agent executor
    await this.executor.closeAll();

    // Stop IPC server
    await this.ipc.stop();

    // Close database
    this.db.close();

    // Release flock-based PID lock
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
      ...createAgentHandlers(ctx),
      ...createAgentSetHandler(ctx),
      ...createAgentDeleteHandler(ctx),
      ...createDaemonHandlers(ctx),
      ...createSetupHandlers(ctx),
    };

    this.ipc.registerMethods(methods);
  }

  private createHttpIngressBridge(): HttpIngressBridge | null {
    const raw = this.db.getConfig(HTTP_INGRESS_CONFIG_KEY);
    const config = parseStoredHttpIngressConfig(raw);
    if (!config || config.bridges.length === 0) {
      return null;
    }
    return new HttpIngressBridge(this.db, this.router, config);
  }
}
