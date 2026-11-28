import { z } from "zod";
import { efforts, priorities, type Task } from "../shared/task.ts";
import { isCalendarDate } from "./date.ts";

const planItemSchema = z.strictObject({
  number: z.number().int().min(1).max(10),
  title: z.string().trim().min(1).max(200),
  priority: z.enum(priorities),
  effort: z.enum(efforts),
  dueDate: z.string().refine(isCalendarDate).nullable(),
  estimatedMinutes: z.number().int().positive().nullable().default(null),
});

export const subtaskPlanArgumentsSchema = z
  .strictObject({
    parentId: z.string().min(1),
    planName: z.string().trim().min(1).max(100),
    items: z.array(planItemSchema).min(1).max(10),
  })
  .superRefine(({ items }, context) => {
    const numbers = new Set<number>();
    const titles = new Set<string>();
    for (const item of items) {
      if (numbers.has(item.number)) {
        context.addIssue({ code: "custom", message: `子任务编号 ${item.number} 重复。` });
      }
      const normalizedTitle = item.title.toLocaleLowerCase("zh-CN");
      if (titles.has(normalizedTitle)) {
        context.addIssue({ code: "custom", message: `子任务标题“${item.title}”重复。` });
      }
      numbers.add(item.number);
      titles.add(normalizedTitle);
    }
  });

export type SubtaskPlanArguments = z.infer<typeof subtaskPlanArgumentsSchema>;
export type SubtaskPlanItem = SubtaskPlanArguments["items"][number];

export interface StoredSubtaskPlan extends SubtaskPlanArguments {
  planId: "A";
  parentName: string;
  parentSnapshot: Task;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  selectedNumbers: number[];
  createdItems: Record<number, { taskId: string; createdAt: number }>;
}

export interface SubtaskPlanStore {
  stage(sessionId: string, parent: Task, proposal: SubtaskPlanArguments): StoredSubtaskPlan;
  get(sessionId: string): StoredSubtaskPlan | undefined;
  select(sessionId: string, selectedNumbers: number[]): StoredSubtaskPlan | undefined;
  markCreated(
    sessionId: string,
    created: Array<{ number: number; taskId: string }>,
  ): StoredSubtaskPlan | undefined;
  reconcile(sessionId: string, tasks: Task[]): StoredSubtaskPlan | undefined;
  invalidate(sessionId: string): boolean;
  inspect(sessionId: string): PlanState;
}

export type PlanState =
  | { status: "active"; plan: StoredSubtaskPlan }
  | { status: "missing" | "expired" };

export function createSubtaskPlanStore(
  now: () => number = Date.now,
  ttlMs = 30 * 60_000,
): SubtaskPlanStore {
  const plans = new Map<string, StoredSubtaskPlan>();

  function inspect(sessionId: string): PlanState {
    const plan = plans.get(sessionId);
    if (!plan) return { status: "missing" };
    if (plan.expiresAt <= now()) {
      plans.delete(sessionId);
      return { status: "expired" };
    }
    return { status: "active", plan };
  }

  function get(sessionId: string) {
    const state = inspect(sessionId);
    return state.status === "active" ? state.plan : undefined;
  }

  return {
    stage(sessionId, parent, proposal) {
      const validated = subtaskPlanArgumentsSchema.parse(proposal);
      const createdAt = now();
      const plan: StoredSubtaskPlan = {
        ...validated,
        planId: "A",
        parentName: parent.title,
        parentSnapshot: { ...parent },
        sessionId,
        createdAt,
        expiresAt: createdAt + ttlMs,
        selectedNumbers: [],
        createdItems: {},
      };
      plans.set(sessionId, plan);
      return plan;
    },
    get,
    select(sessionId, selectedNumbers) {
      const plan = get(sessionId);
      if (!plan) return undefined;
      const selectedPlan = { ...plan, selectedNumbers: [...selectedNumbers] };
      plans.set(sessionId, selectedPlan);
      return selectedPlan;
    },
    markCreated(sessionId, created) {
      const plan = get(sessionId);
      if (!plan) return undefined;
      const validNumbers = new Set(plan.items.map((item) => item.number));
      if (created.some((item) => !validNumbers.has(item.number))) return undefined;
      const createdAt = now();
      const createdItems = { ...plan.createdItems };
      for (const item of created) {
        createdItems[item.number] = { taskId: item.taskId, createdAt };
      }
      const updated = { ...plan, createdItems };
      plans.set(sessionId, updated);
      return updated;
    },
    reconcile(sessionId, tasks) {
      const plan = get(sessionId);
      if (!plan) return undefined;
      const createdItems = Object.fromEntries(
        Object.entries(plan.createdItems).filter(([number, record]) => {
          const item = plan.items.find((candidate) => candidate.number === Number(number));
          const task = tasks.find((candidate) => candidate.id === record.taskId);
          return Boolean(
            item && task && task.parentId === plan.parentId && task.title === item.title,
          );
        }),
      ) as StoredSubtaskPlan["createdItems"];
      if (Object.keys(createdItems).length === Object.keys(plan.createdItems).length) return plan;
      const updated = { ...plan, createdItems };
      plans.set(sessionId, updated);
      return updated;
    },
    invalidate(sessionId) {
      return plans.delete(sessionId);
    },
    inspect,
  };
}
