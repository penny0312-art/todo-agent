import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { efforts, priorities, type Effort, type Priority, type Task } from "../shared/task.ts";
import { isCalendarDate } from "./date.ts";

const storedTask = z.looseObject({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  priority: z.enum(priorities).default("medium"),
  effort: z.enum(efforts).default("medium"),
  dueDate: z.string().refine(isCalendarDate).nullable().default(null),
  parentId: z.string().nullable().default(null),
  estimatedMinutes: z.number().int().positive().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }).nullable().default(null),
  completedAt: z.string().datetime({ offset: true }).nullable().default(null),
  updatedAt: z.string().datetime({ offset: true }).nullable().default(null),
});
const taskList = z.array(storedTask);
const batchSubtask = z.strictObject({
  title: z.string().trim().min(1).max(200),
  priority: z.enum(priorities),
  effort: z.enum(efforts),
  dueDate: z.string().refine(isCalendarDate).nullable(),
  estimatedMinutes: z.number().int().positive().nullable().default(null),
});
export type StoredTask = z.infer<typeof storedTask> & Task;
export type BatchSubtaskInput = z.infer<typeof batchSubtask>;
export type TaskChanges = Partial<
  Pick<Task, "title" | "done" | "priority" | "effort" | "dueDate" | "parentId" | "estimatedMinutes">
>;

interface TaskOptions {
  priority?: Priority;
  effort?: Effort;
  dueDate?: string | null;
  parentId?: string | null;
  estimatedMinutes?: number | null;
}

export type TaskRuleCode =
  | "PARENT_NOT_FOUND"
  | "SELF_PARENT"
  | "NESTED_SUBTASK"
  | "PARENT_HAS_CHILDREN"
  | "PARENT_COMPLETED"
  | "UNFINISHED_CHILDREN"
  | "DUPLICATE_SUBTASK";

export class TaskRuleError extends Error {
  readonly code: TaskRuleCode;

  constructor(code: TaskRuleCode, message: string) {
    super(message);
    this.code = code;
    this.name = "TaskRuleError";
  }
}

export interface TaskStore {
  list(): StoredTask[];
  create(title: string, options?: TaskOptions): StoredTask;
  createSubtasks(parentId: string, items: BatchSubtaskInput[]): StoredTask[];
  update(id: string, changes: TaskChanges): StoredTask | undefined;
  remove(id: string): boolean;
}

export function createJsonTaskStore(
  filename: string,
  now: () => Date = () => new Date(),
): TaskStore {
  const timestamp = () => now().toISOString();
  function list(): StoredTask[] {
    if (!existsSync(filename)) return [];
    return taskList.parse(JSON.parse(readFileSync(filename, "utf8")));
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: StoredTask[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  function validateParent(
    tasks: StoredTask[],
    taskId: string | undefined,
    parentId: string,
  ): StoredTask {
    if (taskId === parentId) throw new TaskRuleError("SELF_PARENT", "任务不能成为自己的父任务。");
    const parent = tasks.find((task) => task.id === parentId);
    if (!parent) throw new TaskRuleError("PARENT_NOT_FOUND", "找不到指定的父任务。");
    if (parent.parentId !== null) {
      throw new TaskRuleError("NESTED_SUBTASK", "只支持一层子任务，子任务不能继续包含子任务。");
    }
    if (parent.done) {
      throw new TaskRuleError(
        "PARENT_COMPLETED",
        "已完成的父任务不能新增或迁入子任务，请先将父任务改为未完成。",
      );
    }
    return parent;
  }

  return {
    list,

    create(title, options = {}) {
      const tasks = list();
      if (options.parentId) validateParent(tasks, undefined, options.parentId);
      const createdAt = timestamp();
      const task: StoredTask = {
        id: randomUUID(),
        title,
        done: false,
        priority: options.priority ?? "medium",
        effort: options.effort ?? "medium",
        dueDate: options.dueDate ?? null,
        parentId: options.parentId ?? null,
        estimatedMinutes: options.estimatedMinutes ?? null,
        createdAt,
        completedAt: null,
        updatedAt: createdAt,
      };
      save([...tasks, task]);
      return task;
    },

    createSubtasks(parentId, inputItems) {
      const items = z.array(batchSubtask).min(1).max(10).parse(inputItems);
      const tasks = list();
      validateParent(tasks, undefined, parentId);
      const normalizedTitles = new Set<string>();
      const existingTitles = new Set(
        tasks
          .filter((task) => task.parentId === parentId)
          .map((task) => task.title.toLocaleLowerCase("zh-CN")),
      );
      for (const item of items) {
        const normalized = item.title.toLocaleLowerCase("zh-CN");
        if (normalizedTitles.has(normalized)) {
          throw new TaskRuleError("DUPLICATE_SUBTASK", `批量方案中存在重复子任务“${item.title}”。`);
        }
        if (existingTitles.has(normalized)) {
          throw new TaskRuleError("DUPLICATE_SUBTASK", `父任务下已存在同名子任务“${item.title}”。`);
        }
        normalizedTitles.add(normalized);
      }
      const createdAt = timestamp();
      const created = items.map<StoredTask>((item) => ({
        id: randomUUID(),
        title: item.title,
        done: false,
        priority: item.priority,
        effort: item.effort,
        dueDate: item.dueDate,
        parentId,
        estimatedMinutes: item.estimatedMinutes,
        createdAt,
        completedAt: null,
        updatedAt: createdAt,
      }));
      save([...tasks, ...created]);
      return created;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      if (changes.parentId !== undefined && changes.parentId !== null) {
        validateParent(tasks, id, changes.parentId);
        if (tasks.some((item) => item.parentId === id)) {
          throw new TaskRuleError(
            "PARENT_HAS_CHILDREN",
            "已有子任务的父任务不能再变成其他任务的子任务。",
          );
        }
      }

      const nextParentId = changes.parentId === undefined ? task.parentId : changes.parentId;
      const nextDone = changes.done ?? task.done;
      if (!nextDone && nextParentId) {
        const parent = tasks.find((item) => item.id === nextParentId);
        if (parent?.done) {
          throw new TaskRuleError(
            "PARENT_COMPLETED",
            "已完成父任务下的子任务不能重新设为未完成，请先重新打开父任务。",
          );
        }
      }
      if (changes.done === true && task.parentId === null) {
        const unfinished = tasks.filter((item) => item.parentId === id && !item.done);
        if (unfinished.length > 0) {
          throw new TaskRuleError(
            "UNFINISHED_CHILDREN",
            `父任务还有 ${unfinished.length} 个未完成子任务，不能标记为完成。`,
          );
        }
      }

      const wasDone = task.done;
      const updatedAt = timestamp();
      Object.assign(task, changes);
      if (changes.done === true && !wasDone) task.completedAt = updatedAt;
      if (changes.done === false) task.completedAt = null;
      task.updatedAt = updatedAt;
      save(tasks);
      return task;
    },

    remove(id) {
      const tasks = list();
      if (tasks.some((task) => task.parentId === id)) {
        throw new TaskRuleError(
          "PARENT_HAS_CHILDREN",
          "父任务仍有子任务，不能直接删除，请先处理或删除子任务。",
        );
      }
      const remaining = tasks.filter((task) => task.id !== id);
      if (remaining.length === tasks.length) return false;

      save(remaining);
      return true;
    },
  };
}
