import { Router, type Response } from "express";
import { z } from "zod";
import { efforts, priorities } from "../shared/task.ts";
import { isCalendarDate } from "./date.ts";
import { TaskRuleError, type TaskStore } from "./task-store.ts";

const dueDateSchema = z.string().refine(isCalendarDate);
const listTaskSchema = z.strictObject({ dueDate: dueDateSchema.optional() });
const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  priority: z.enum(priorities).optional(),
  effort: z.enum(efforts).optional(),
  dueDate: dueDateSchema.nullable().optional(),
  parentId: z.string().min(1).nullable().optional(),
  estimatedMinutes: z.number().int().positive().nullable().optional(),
});
const updateTaskSchema = createTaskSchema
  .partial()
  .omit({ title: true })
  .extend({ title: z.string().trim().min(1).max(200).optional() })
  .extend({ done: z.boolean().optional() })
  .refine((changes) => Object.keys(changes).length > 0);

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore) {
  const router = Router();

  router.get("/", (req, res) => {
    const input = listTaskSchema.safeParse(req.query);
    if (!input.success)
      return res.status(400).json({ error: "dueDate 必须是有效的 YYYY-MM-DD 日期。" });
    const all = tasks.list();
    res.json(input.data.dueDate ? all.filter((task) => task.dueDate === input.data.dueDate) : all);
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({
        error: "请提供有效的标题、优先级、工作量、截止日期、父任务 ID 和预计分钟数。",
      });
    }
    const { title, ...options } = input.data;
    try {
      res.status(201).json(tasks.create(title, options));
    } catch (error) {
      return sendTaskRuleError(error, res);
    }
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({
        error:
          "请提供有效的 title、done、priority、effort、dueDate、parentId 或 estimatedMinutes 字段。",
      });
    }

    try {
      const updated = tasks.update(req.params.id, input.data);
      if (!updated) return res.status(404).json(taskNotFound);
      res.json(updated);
    } catch (error) {
      return sendTaskRuleError(error, res);
    }
  });

  router.delete("/:id", (req, res) => {
    try {
      if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
      res.sendStatus(204);
    } catch (error) {
      return sendTaskRuleError(error, res);
    }
  });

  return router;
}

function sendTaskRuleError(error: unknown, res: Response) {
  if (error instanceof TaskRuleError) {
    return res.status(409).json({ error: error.message, code: error.code });
  }
  throw error;
}
