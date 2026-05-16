import assert from "node:assert/strict";
import test from "node:test";
import type { MessageRouter } from "../daemon/router/message-router.js";
import type { HiBossDatabase } from "../daemon/db/database.js";
import type { Envelope, EnvelopeStatus } from "../envelope/types.js";
import { BackgroundExecutor } from "./background-executor.js";

function createEnvelope(id: string): Envelope {
  return {
    id,
    from: "agent:nex",
    to: "agent:background",
    fromBoss: false,
    content: {
      text: `run ${id}`,
    },
    status: "pending",
    createdAt: Date.now(),
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeDb {
  readonly statusUpdates: Array<{ id: string; status: EnvelopeStatus }> = [];

  constructor(private readonly metadata?: Record<string, unknown>) {}

  updateEnvelopeStatus(id: string, status: EnvelopeStatus): void {
    this.statusUpdates.push({ id, status });
  }

  getAgentByNameCaseInsensitive(name: string): {
    name: string;
    provider: "codex";
    workspace: string;
    model?: string;
    reasoningEffort?: "low";
    metadata?: Record<string, unknown>;
  } | null {
    if (name.toLowerCase() !== "nex") return null;
    return {
      name: "nex",
      provider: "codex",
      workspace: "/tmp/workspace",
      model: "gpt-test",
      reasoningEffort: "low",
      metadata: this.metadata,
    };
  }
}

class FakeRouter {
  readonly routed: Envelope[] = [];

  async routeEnvelope(input: Omit<Envelope, "id" | "status" | "createdAt">): Promise<void> {
    this.routed.push({
      id: `feedback-${this.routed.length + 1}`,
      status: "pending",
      createdAt: Date.now(),
      ...input,
    });
  }
}

test("BackgroundExecutor tracks queued and running counts per sender agent", async () => {
  const first = createDeferred<{ finalText: string }>();
  const second = createDeferred<{ finalText: string }>();
  const calls: string[] = [];
  const db = new FakeDb();
  const router = new FakeRouter();
  const executor = new BackgroundExecutor(
    {
      db: db as unknown as HiBossDatabase,
      router: router as unknown as MessageRouter,
    },
    {
      maxConcurrent: 1,
      runPrompt: async ({ prompt }) => {
        calls.push(prompt);
        if (calls.length === 1) return first.promise;
        return second.promise;
      },
    }
  );

  executor.enqueue(createEnvelope("bg-1"));
  executor.enqueue(createEnvelope("bg-2"));

  await waitFor(() => calls.length === 1, "first background prompt start");
  assert.deepEqual(executor.getSenderAgentSnapshot("nex"), {
    state: "active",
    queuedCount: 1,
    runningCount: 1,
    openCount: 2,
  });

  first.resolve({ finalText: "done 1" });
  await waitFor(() => calls.length === 2, "second background prompt start");
  assert.deepEqual(executor.getSenderAgentSnapshot("nex"), {
    state: "active",
    queuedCount: 0,
    runningCount: 1,
    openCount: 1,
  });

  second.resolve({ finalText: "done 2" });
  await waitFor(() => router.routed.length === 2, "background feedback delivery");
  assert.deepEqual(executor.getSenderAgentSnapshot("nex"), {
    state: "idle",
    queuedCount: 0,
    runningCount: 0,
    openCount: 0,
  });

  assert.deepEqual(db.statusUpdates, [
    { id: "bg-1", status: "done" },
    { id: "bg-2", status: "done" },
  ]);
});

test("BackgroundExecutor enforces sender execution lane background limit", async () => {
  const first = createDeferred<{ finalText: string }>();
  const second = createDeferred<{ finalText: string }>();
  const calls: string[] = [];
  const db = new FakeDb({
    role: "speaker",
    executionLane: {
      id: "lane-a",
      backgroundMaxConcurrent: 1,
    },
  });
  const router = new FakeRouter();
  const executor = new BackgroundExecutor(
    {
      db: db as unknown as HiBossDatabase,
      router: router as unknown as MessageRouter,
    },
    {
      maxConcurrent: 2,
      runPrompt: async ({ prompt }) => {
        calls.push(prompt);
        if (calls.length === 1) return first.promise;
        return second.promise;
      },
    }
  );

  executor.enqueue(createEnvelope("bg-lane-1"));
  executor.enqueue(createEnvelope("bg-lane-2"));

  await waitFor(() => calls.length === 1, "first lane-limited background prompt start");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  assert.deepEqual(executor.getSenderAgentSnapshot("nex"), {
    state: "active",
    queuedCount: 1,
    runningCount: 1,
    openCount: 2,
  });

  first.resolve({ finalText: "done 1" });
  await waitFor(() => calls.length === 2, "second lane-limited background prompt start");
  second.resolve({ finalText: "done 2" });
  await waitFor(() => router.routed.length === 2, "lane-limited feedback delivery");
});
