import { randomUUID } from "node:crypto";
import type { Task } from "../shared/task.ts";

export type ConfirmableMutation =
  | "createTask"
  | "updateTask"
  | "deleteTask"
  | "createSubtasksBatch";

export interface ConfirmationProposal {
  operation: ConfirmableMutation;
  rawArguments: string;
  parameters: Record<string, unknown>;
  expectedTasks: Task[];
}

export interface PendingConfirmation extends ConfirmationProposal {
  id: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

export type ClaimResult =
  | { status: "claimed"; pending: PendingConfirmation }
  | { status: "missing" | "expired" };

export type ConfirmationState =
  | { status: "active"; pending: PendingConfirmation }
  | { status: "missing" | "expired" };

export interface PendingConfirmationStore {
  stage(sessionId: string, proposal: ConfirmationProposal, expiresAt?: number): PendingConfirmation;
  claim(sessionId: string): ClaimResult;
  cancel(sessionId: string): boolean;
  invalidate(sessionId: string): boolean;
  inspect(sessionId: string): ConfirmationState;
  peek(sessionId: string): PendingConfirmation | undefined;
}

export function createPendingConfirmationStore(
  now: () => number = Date.now,
  ttlMs = 5 * 60_000,
): PendingConfirmationStore {
  const pendingBySession = new Map<string, PendingConfirmation>();

  function inspect(sessionId: string): ConfirmationState {
    const pending = pendingBySession.get(sessionId);
    if (!pending) return { status: "missing" };
    if (pending.expiresAt <= now()) {
      pendingBySession.delete(sessionId);
      return { status: "expired" };
    }
    return { status: "active", pending };
  }

  return {
    stage(sessionId, proposal, requestedExpiresAt) {
      const createdAt = now();
      const pending: PendingConfirmation = {
        ...proposal,
        id: randomUUID(),
        sessionId,
        createdAt,
        expiresAt: Math.min(createdAt + ttlMs, requestedExpiresAt ?? Number.POSITIVE_INFINITY),
      };
      pendingBySession.set(sessionId, pending);
      return pending;
    },

    claim(sessionId) {
      const state = inspect(sessionId);
      if (state.status !== "active") return state;
      // 先删除再执行，保证并发或重复确认至多有一个请求取得执行权。
      pendingBySession.delete(sessionId);
      return { status: "claimed", pending: state.pending };
    },

    cancel(sessionId) {
      return pendingBySession.delete(sessionId);
    },

    invalidate(sessionId) {
      return pendingBySession.delete(sessionId);
    },

    inspect,

    peek(sessionId) {
      const state = inspect(sessionId);
      return state.status === "active" ? state.pending : undefined;
    },
  };
}
