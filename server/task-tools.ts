import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { efforts, priorities } from "../shared/task.ts";
import { isCalendarDate } from "./date.ts";

const titleSchema = z.string().trim().min(1).max(200);
const dueDateSchema = z.string().refine(isCalendarDate);
const listTasksArguments = z.strictObject({ dueDate: dueDateSchema.optional() });
const createTaskArguments = z.strictObject({
  title: titleSchema,
  priority: z.enum(priorities).optional(),
  effort: z.enum(efforts).optional(),
  dueDate: dueDateSchema.nullable().optional(),
  parentId: z.string().min(1).nullable().optional(),
  estimatedMinutes: z.number().int().positive().nullable().optional(),
});
const updateTaskArguments = z
  .strictObject({
    id: z.string().min(1),
    title: titleSchema.optional(),
    done: z.boolean().optional(),
    priority: z.enum(priorities).optional(),
    effort: z.enum(efforts).optional(),
    dueDate: dueDateSchema.nullable().optional(),
    parentId: z.string().min(1).nullable().optional(),
    estimatedMinutes: z.number().int().positive().nullable().optional(),
  })
  .refine(
    ({ title, done, priority, effort, dueDate, parentId, estimatedMinutes }) =>
      title !== undefined ||
      done !== undefined ||
      priority !== undefined ||
      effort !== undefined ||
      dueDate !== undefined ||
      parentId !== undefined ||
      estimatedMinutes !== undefined,
  );
const deleteTaskArguments = z.strictObject({ id: z.string().min(1) });

export const taskTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "listTasks",
      description:
        "按创建顺序查询任务，包括真实 ID、标题、完成状态、优先级、工作量、截止日期和 parentId。不传 dueDate 时查询全部；传入时只查询该日到期任务。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          dueDate: {
            type: "string",
            format: "date",
            description: "可选的截止日期过滤，必须是 YYYY-MM-DD。",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "createTask",
      description:
        "创建一条新的未完成任务。必须把用户为该任务给出的标题、优先级、工作量、截止日期、预计耗时和父任务合并到这一次调用中，不得创建后再用 updateTask 补充。用户明确给出小时数的预计耗时应换算为整数分钟。parentId 用于创建一层子任务，且必须来自本轮 listTasks。仅在用户明确要求创建时使用。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "任务标题；首尾空白会被去除。",
          },
          priority: {
            type: "string",
            enum: priorities,
            description: "可选优先级：low（低）、medium（中）、high（高）。",
          },
          effort: {
            type: "string",
            enum: efforts,
            description: "可选工作量：small（小）、medium（中）、large（大）。",
          },
          dueDate: {
            type: ["string", "null"],
            format: "date",
            description: "可选截止日期 YYYY-MM-DD；null 表示无截止日期。",
          },
          parentId: {
            type: ["string", "null"],
            description: "可选父任务 ID；只能使用本轮 listTasks 返回的顶级任务 ID。",
          },
          estimatedMinutes: {
            type: ["integer", "null"],
            minimum: 1,
            description: "可选预计耗时（正整数分钟）；null 表示未知。不得由工作量等级擅自换算。",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "updateTask",
      description:
        "使用任务的真实 ID 修改属性或父任务关系。同一句话要求修改同一任务的多个属性时，必须把全部修改合并到这一次调用中。调用前应先查询任务；parentId 也必须来自本轮查询。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", description: "从 listTasks 返回结果中取得的任务 ID。" },
          title: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "可选的新标题；首尾空白会被去除。",
          },
          done: { type: "boolean", description: "可选的完成状态。" },
          priority: {
            type: "string",
            enum: priorities,
            description: "可选优先级：low、medium、high。",
          },
          effort: {
            type: "string",
            enum: efforts,
            description: "可选工作量：small、medium、large。",
          },
          dueDate: {
            type: ["string", "null"],
            format: "date",
            description: "可选截止日期 YYYY-MM-DD；null 用于清除截止日期。",
          },
          parentId: {
            type: ["string", "null"],
            description: "可选父任务 ID；null 表示移为顶级任务。",
          },
          estimatedMinutes: {
            type: ["integer", "null"],
            minimum: 1,
            description: "可选预计耗时（正整数分钟）；null 表示清除预计耗时。",
          },
        },
        anyOf: [
          { required: ["title"] },
          { required: ["done"] },
          { required: ["priority"] },
          { required: ["effort"] },
          { required: ["dueDate"] },
          { required: ["parentId"] },
          { required: ["estimatedMinutes"] },
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deleteTask",
      description: "使用任务的真实 ID 删除任务。调用前应先查询任务以确定目标。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", description: "从 listTasks 返回结果中取得的任务 ID。" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "proposeSubtaskPlan",
      description:
        "为本轮已查询到的真实顶级父任务提交一个只读的结构化子任务方案 A。此工具只保存建议，不创建任务；每次拆解请求必须使用它，最多10项。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["parentId", "planName", "items"],
        properties: {
          parentId: { type: "string", description: "本轮 listTasks 返回的真实顶级父任务 ID。" },
          planName: { type: "string", minLength: 1, maxLength: 100 },
          items: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["number", "title", "priority", "effort", "dueDate"],
              properties: {
                number: { type: "integer", minimum: 1, maximum: 10 },
                title: { type: "string", minLength: 1, maxLength: 200 },
                priority: { type: "string", enum: priorities },
                effort: { type: "string", enum: efforts },
                dueDate: { type: ["string", "null"], format: "date" },
                estimatedMinutes: {
                  type: ["integer", "null"],
                  minimum: 1,
                  description: "可选预计耗时（分钟）；未知时使用 null 或省略。",
                },
              },
            },
          },
        },
      },
    },
  },
];

type ToolName = "listTasks" | "createTask" | "updateTask" | "deleteTask";

export interface ToolResult {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

export type TaskToolExecutor = (name: string, rawArguments: string) => Promise<ToolResult>;

export function validateTaskToolCall(name: string, rawArguments: string): ToolResult {
  try {
    const parsedArguments: unknown = JSON.parse(rawArguments || "{}");
    const request = buildRequest(name, parsedArguments);
    return request.ok ? { ok: true } : request.result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `工具参数不合法：${message}` };
  }
}

function configuredTaskApiBaseUrl(): string {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT 必须是 1 至 65535 之间的整数。");
  }
  return `http://127.0.0.1:${port}`;
}

export function createTaskToolExecutor(
  baseUrl: string | (() => string) = configuredTaskApiBaseUrl,
  timeoutMs = 5_000,
): TaskToolExecutor {
  return async (name, rawArguments) => {
    try {
      const parsedArguments: unknown = JSON.parse(rawArguments || "{}");
      const request = buildRequest(name, parsedArguments);
      if (!request.ok) return request.result;

      const root = typeof baseUrl === "function" ? baseUrl() : baseUrl;
      const response = await fetch(`${root}${request.path}`, {
        method: request.method,
        headers: request.body === undefined ? undefined : { "Content-Type": "application/json" },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const data = response.status === 204 ? undefined : await readResponse(response);
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: extractError(data) ?? `任务 API 返回 HTTP ${response.status}。`,
        };
      }
      return { ok: true, status: response.status, ...(data === undefined ? {} : { data }) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `工具执行失败：${message}` };
    }
  };
}

const executeTaskTool = createTaskToolExecutor();
export { executeTaskTool };

function buildRequest(
  name: string,
  input: unknown,
):
  | { ok: true; method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown }
  | { ok: false; result: ToolResult } {
  const invalid = (error: z.ZodError) => ({
    ok: false as const,
    result: { ok: false, error: `工具参数不合法：${z.prettifyError(error)}` },
  });

  switch (name as ToolName) {
    case "listTasks": {
      const parsed = listTasksArguments.safeParse(input);
      return parsed.success
        ? {
            ok: true,
            method: "GET",
            path: parsed.data.dueDate
              ? `/api/tasks?dueDate=${encodeURIComponent(parsed.data.dueDate)}`
              : "/api/tasks",
          }
        : invalid(parsed.error);
    }
    case "createTask": {
      const parsed = createTaskArguments.safeParse(input);
      return parsed.success
        ? { ok: true, method: "POST", path: "/api/tasks", body: parsed.data }
        : invalid(parsed.error);
    }
    case "updateTask": {
      const parsed = updateTaskArguments.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      const { id, ...changes } = parsed.data;
      return {
        ok: true,
        method: "PATCH",
        path: `/api/tasks/${encodeURIComponent(id)}`,
        body: changes,
      };
    }
    case "deleteTask": {
      const parsed = deleteTaskArguments.safeParse(input);
      return parsed.success
        ? {
            ok: true,
            method: "DELETE",
            path: `/api/tasks/${encodeURIComponent(parsed.data.id)}`,
          }
        : invalid(parsed.error);
    }
    default:
      return { ok: false, result: { ok: false, error: `未知工具：${name}` } };
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`任务 API 返回了无效的 JSON（HTTP ${response.status}）。`);
  }
}

function extractError(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("error" in data)) return undefined;
  return typeof data.error === "string" ? data.error : undefined;
}
