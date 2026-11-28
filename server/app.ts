import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { chatRequestSchema, type ChatMessage } from "../shared/chat.ts";
import type { Task } from "../shared/task.ts";
import {
  createPendingConfirmationStore,
  type ConfirmationProposal,
  type PendingConfirmation,
  type PendingConfirmationStore,
} from "./confirmation.ts";
import { TaskRuleError, type TaskStore } from "./task-store.ts";
import {
  createSubtaskPlanStore,
  subtaskPlanArgumentsSchema,
  type StoredSubtaskPlan,
  type SubtaskPlanArguments,
  type SubtaskPlanStore,
} from "./subtask-plans.ts";
import { executeTaskTool, type TaskToolExecutor, validateTaskToolCall } from "./task-tools.ts";
import { taskRouter } from "./tasks.ts";

interface ReplyContext {
  stageConfirmation(proposal: ConfirmationProposal): string;
  stagePlan(parent: Task, proposal: SubtaskPlanArguments): string;
}

interface AppDependencies {
  reply(messages: ChatMessage[], context: ReplyContext): Promise<string>;
  tasks: TaskStore;
  executeTool?: TaskToolExecutor;
  confirmations?: PendingConfirmationStore;
  plans?: SubtaskPlanStore;
}

export function createApp({
  reply,
  tasks,
  executeTool = executeTaskTool,
  confirmations = createPendingConfirmationStore(),
  plans = createSubtaskPlanStore(),
}: AppDependencies) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/api/chat", async (req, res) => {
    const input = chatRequestSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供对话记录，并以用户消息结尾。" });
    }
    const sessionId = sessionForRequest(req.headers.cookie, (cookie) =>
      res.appendHeader("Set-Cookie", cookie),
    );
    const userText = input.data.messages.at(-1)!.content;

    const confirmationState = confirmations.inspect(sessionId);
    const inspectedPlanState = plans.inspect(sessionId);
    if (inspectedPlanState.status === "expired") {
      confirmations.invalidate(sessionId);
      return res.json({
        reply: "原结构化子任务方案已过期，未执行任何任务变更。请重新生成方案。",
      });
    }
    const activePending =
      confirmationState.status === "active" ? confirmationState.pending : undefined;
    const activePlan =
      inspectedPlanState.status === "active" ? plans.reconcile(sessionId, tasks.list()) : undefined;
    const pendingExpired = confirmationState.status === "expired";

    if (isConfirmation(userText)) {
      if (!activePending) {
        return res.json({
          reply: pendingExpired
            ? activePlan
              ? "之前的待确认操作已过期，未执行任务变更；原结构化方案仍然有效。请重新选择要创建的子任务。"
              : "之前的待确认操作已过期，未执行任何任务变更。请重新提出完整要求。"
            : activePlan
              ? "当前没有可确认的待执行操作。原结构化方案仍然有效，请先选择方案 A、剩余任务或具体编号。"
              : "当前没有可确认的待执行操作，没有修改任务。",
        });
      }
      const claim = confirmations.claim(sessionId);
      if (claim.status === "expired") {
        return res.json({
          reply: activePlan
            ? "待确认操作已过期，未执行任何任务变更；原方案仍有效，请重新选择。"
            : "待确认操作已过期，未执行任何任务变更。请重新提出完整要求。",
        });
      }
      if (claim.status !== "claimed") {
        return res.json({ reply: "当前没有可确认的待执行操作，没有修改任务。" });
      }
      return res.json({
        reply: await executeConfirmed(claim.pending, executeTool, tasks, plans),
      });
    }
    if (isPlanAbandonment(userText)) {
      const cancelled = confirmations.cancel(sessionId);
      const planCancelled = plans.invalidate(sessionId);
      return res.json({
        reply:
          cancelled || planCancelled
            ? "已放弃原结构化方案和待确认操作，没有修改任务。"
            : "当前没有可放弃的方案。",
      });
    }
    if (isCancellation(userText)) {
      const cancelled = confirmations.cancel(sessionId);
      if (cancelled) {
        return res.json({
          reply: activePlan
            ? "已取消当前待确认操作，没有修改任务；原结构化方案仍然保留，可以重新选择条目。"
            : "已取消当前待确认操作，没有修改任务。",
        });
      }
      if (activePlan) {
        plans.invalidate(sessionId);
        return res.json({ reply: "已取消尚未选择的结构化方案，没有修改任务。" });
      }
      return res.json({ reply: "当前没有待取消的操作。" });
    }

    if (activePlan) {
      const selection = parsePlanSelection(userText, activePlan, pendingPlanNumbers(activePending));
      if (selection.handled) {
        if (selection.error || !selection.numbers) {
          return res.json({
            reply: `${selection.error ?? "请选择至少一条有效子任务。"}${workflowPreservedText(activePlan, activePending)}`,
          });
        }
        const alreadyCreated = selection.numbers.filter(
          (number) => activePlan.createdItems[number] !== undefined,
        );
        const numbersToCreate = selection.numbers.filter(
          (number) => activePlan.createdItems[number] === undefined,
        );
        if (numbersToCreate.length === 0) {
          return res.json({
            reply: `你选择的第 ${alreadyCreated.join("、")} 项已经创建且仍存在，没有建立新的待确认操作。${workflowPreservedText(activePlan, activePending)}`,
          });
        }
        const selectedPlan = plans.select(sessionId, numbersToCreate)!;
        const selectedItems = selectedPlan.items.filter((item) =>
          selectedPlan.selectedNumbers.includes(item.number),
        );
        const pending = confirmations.stage(
          sessionId,
          {
            operation: "createSubtasksBatch",
            rawArguments: JSON.stringify({
              parentId: selectedPlan.parentId,
              items: selectedItems,
            }),
            parameters: {
              planId: selectedPlan.planId,
              planCreatedAt: selectedPlan.createdAt,
              parentId: selectedPlan.parentId,
              items: selectedItems,
            },
            expectedTasks: [selectedPlan.parentSnapshot],
          },
          selectedPlan.expiresAt,
        );
        const skipped = alreadyCreated.length
          ? `第 ${alreadyCreated.join("、")} 项已经创建且仍存在，本次不会重复创建。\n\n`
          : "";
        return res.json({ reply: skipped + formatConfirmation(pending) });
      }
    }

    if (
      activePending &&
      !looksLikeReadOnlyTaskQuery(userText) &&
      !looksLikeReadOnlyAnalysis(userText)
    ) {
      if (isUnsupportedPlanModification(userText)) {
        return res.json({
          reply: `当前暂不支持在确认前修改任务属性。${workflowPreservedText(activePlan, activePending)}`,
        });
      }
      if (looksLikeNewTaskRequest(userText)) {
        return res.json({
          reply:
            `你还有一个尚未确认的${activePlan ? "子任务创建选择" : "任务操作"}。` +
            `如需切换到新的任务请求，请先回复“取消创建”或“取消操作”，然后重新发送新请求；${activePlan ? "原结构化方案会继续保留，" : ""}当前确认参数暂时保持不变，尚未执行任务变更。`,
        });
      }
      return res.json({
        reply: `暂时无法识别你的操作。${workflowPreservedText(activePlan, activePending)}`,
      });
    }

    if (activePlan && looksLikePlanSelectionRequest(userText)) {
      return res.json({
        reply: `没有可靠识别你要选择的方案条目。${workflowPreservedText(activePlan, undefined)}`,
      });
    }

    const answer = await reply(input.data.messages, {
      stageConfirmation(proposal) {
        const pending = confirmations.stage(sessionId, proposal);
        return formatConfirmation(pending);
      },
      stagePlan(parent, proposal) {
        const plan = plans.stage(sessionId, parent, proposal);
        return formatPlan(plan);
      },
    });
    const stagedState = confirmations.inspect(sessionId);
    if (looksLikeUnbackedConfirmationPrompt(answer) && stagedState.status !== "active") {
      return res.json({
        reply: activePlan
          ? "模型没有建立可执行的服务端确认状态，因此没有修改任务。原结构化方案仍然有效，请按稳定编号重新选择要创建的条目。"
          : "模型没有建立可执行的服务端确认状态，因此没有修改任务。请重新明确提出操作要求。",
      });
    }
    res.json({ reply: answer });
  });

  app.use("/api/tasks", taskRouter(tasks));
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在。" }));
  app.use(handleApiError);

  app.use(express.static(resolve("public")));
  app.get("/assets/chat.js", (_req, res) => res.sendFile(resolve("dist/chat.js")));
  return app;
}

const confirmationCommands = new Set([
  "确认创建",
  "确定创建",
  "确认",
  "确定",
  "确认执行",
  "确定执行",
  "确认修改",
  "确认删除",
  "确认创建吧",
  "确定创建吧",
  "确认吧",
  "确定吧",
  "确认执行吧",
  "确定执行吧",
  "是确认",
  "是，确认",
  "是的确认",
  "是的，确认",
  "就按这个方案创建吧",
  "按照这个方案执行",
  "可以创建了",
  "同意创建",
]);
const cancellationCommands = new Set([
  "取消",
  "取消操作",
  "取消创建",
  "不创建了",
  "先别创建",
  "先不创建",
  "不执行了",
  "放弃这个方案",
  "放弃当前方案",
  "不确认",
  "算了",
  "不要执行",
  "都不要",
  "一个都不要",
]);

function normalizeControlCommand(content: string) {
  return content
    .trim()
    .replace(/\s+/gu, "")
    .replace(/[，,。.！!？?~～]+$/gu, "");
}

function isConfirmation(content: string) {
  return confirmationCommands.has(normalizeControlCommand(content));
}

function isCancellation(content: string) {
  return cancellationCommands.has(normalizeControlCommand(content));
}

function isPlanAbandonment(content: string) {
  const command = normalizeControlCommand(content);
  return command === "放弃这个方案" || command === "放弃当前方案";
}

function sessionForRequest(cookieHeader: string | undefined, setCookie: (cookie: string) => void) {
  const existing = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("todo_session="))
    ?.slice("todo_session=".length);
  if (existing && /^[0-9a-f-]{36}$/iu.test(existing)) return existing;
  const sessionId = randomUUID();
  setCookie(`todo_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`);
  return sessionId;
}

const priorityText = { low: "低", medium: "中", high: "高" } as const;
const effortText = { small: "小", medium: "中", large: "大" } as const;

function formatPlan(plan: StoredSubtaskPlan): string {
  return `已为父任务“${plan.parentName}”生成可执行的结构化方案 A：${plan.planName}\n\n${plan.items
    .map(
      (item) =>
        `${item.number}. ${item.title}\n   优先级：${priorityText[item.priority]} · 工作量：${effortText[item.effort]} · 截止：${item.dueDate ?? "无"} · 预计：${item.estimatedMinutes ? `${item.estimatedMinutes} 分钟` : "未知"}`,
    )
    .join(
      "\n",
    )}\n\n当前仅保存方案，尚未创建任何子任务。你可以回复“A”或“全部创建”，也可以回复“只创建第1、3项”或“第2项不要，其他都创建”。选择后我会展示最终清单，再由你确认创建。`;
}

type PlanSelection = { handled: boolean; numbers?: number[]; error?: string };

function parsePlanSelection(
  content: string,
  plan: StoredSubtaskPlan,
  currentNumbers: number[] = plan.selectedNumbers,
): PlanSelection {
  const text = normalizeControlCommand(content);
  if (looksLikeIndependentNonPlanMutation(text)) return { handled: false };
  if (/^(?:B|方案B)$/iu.test(text)) {
    return { handled: true, error: "当前只有可执行方案 A，请选择 A 或方案中的具体编号。" };
  }
  const allNumbers = plan.items.map((item) => item.number);
  const remainingNumbers = allNumbers.filter((number) => plan.createdItems[number] === undefined);
  if (/^(?:剩下|其余).*(?:还没有创建|未创建|没创建).*(?:全部|都)?创建/u.test(text)) {
    return remainingNumbers.length > 0
      ? { handled: true, numbers: remainingNumbers }
      : { handled: true, error: "当前方案中的所有条目都已经创建且仍然存在。" };
  }
  if (/^(?:A|方案A|选择方案A|全部|全选|全部创建)$/iu.test(text)) {
    return { handled: true, numbers: allNumbers };
  }
  if (isUnsupportedPlanModification(text)) return { handled: false };
  if (/方案(?!A)/iu.test(text)) {
    return { handled: true, error: "不存在该方案，当前可选择方案 A。" };
  }
  const looksLikeSelection = looksLikePlanSelectionRequest(text);
  if (!looksLikeSelection) return { handled: false };

  const onlyCreateAt = text.lastIndexOf("只创建");
  const numberSource = onlyCreateAt >= 0 ? text.slice(onlyCreateAt) : text;
  const requested = [
    ...new Set([...numberSource.matchAll(/\d+/gu)].map((match) => Number(match[0]))),
  ];
  if (requested.length === 0) {
    return { handled: true, error: "没有识别到子任务编号，请使用“只创建第1、3项”等格式。" };
  }
  const invalid = requested.filter((number) => !allNumbers.includes(number));
  if (invalid.length > 0) {
    return {
      handled: true,
      error: `方案 A 中不存在第 ${invalid.join("、")} 项，当前方案共有 ${allNumbers.length} 项。`,
    };
  }
  const excludeFromAll = /(?:不要|不创建).*(?:其他|其余).*(?:创建|加)/u.test(text);
  const removeFromCurrent =
    !excludeFromAll && /(?:不要了|移除|去掉)/u.test(text) && onlyCreateAt < 0;
  const additive =
    !removeFromCurrent &&
    onlyCreateAt < 0 &&
    /(?:还有|也|追加|加进去|再给我创建|再创建)/u.test(text);
  const selected = excludeFromAll
    ? allNumbers.filter((number) => !requested.includes(number))
    : removeFromCurrent
      ? currentNumbers.filter((number) => !requested.includes(number))
      : additive
        ? [...new Set([...currentNumbers, ...requested])]
        : requested;
  if (selected.length === 0) {
    return { handled: true, error: "选择结果为空；请重新选择，或回复“取消创建”。" };
  }
  return { handled: true, numbers: selected };
}

function pendingPlanNumbers(pending: PendingConfirmation | undefined) {
  if (pending?.operation !== "createSubtasksBatch") return [];
  const items = pending.parameters.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) =>
    typeof item === "object" && item !== null && "number" in item && typeof item.number === "number"
      ? [item.number]
      : [],
  );
}

function workflowPreservedText(
  plan: StoredSubtaskPlan | undefined,
  pending: PendingConfirmation | undefined,
) {
  if (pending?.operation === "createSubtasksBatch") {
    const items = pending.parameters.items;
    const count = Array.isArray(items) ? items.length : plan?.selectedNumbers.length;
    return `之前选择的 ${count ?? 0} 条子任务仍然保留，目前尚未创建。你可以回复“确认创建”、重新选择子任务或回复“取消”。`;
  }
  if (pending) {
    return "之前的待确认操作仍然保留，目前尚未执行。你可以回复“确认执行”或“取消”。";
  }
  return "原结构化方案仍然保留，目前尚未创建子任务。你可以重新选择，或回复“取消”。";
}

function isUnsupportedPlanModification(content: string) {
  const text = normalizeControlCommand(content);
  return (
    /(?:修改|改成|调整|设为|设置).*(?:优先级|工作量|截止日期|日期)/u.test(text) ||
    /(?:优先级|工作量|截止日期|日期).*(?:修改|改成|调整|设为|设置)/u.test(text)
  );
}

function looksLikePlanSelectionRequest(content: string) {
  const text = normalizeControlCommand(content);
  if (looksLikeIndependentNonPlanMutation(text)) return false;
  return (
    /(?:第\d+(?:项|条|个任务)|(?:里的|里面的)[\d、,，]+|只创建|选择方案|全选|全部创建|剩下|其余|追加|加进去)/u.test(
      text,
    ) || /[\d、,，]+(?:项|条).*(?:创建|加入|加)/u.test(text)
  );
}

function looksLikeIndependentNonPlanMutation(content: string) {
  return /^(?:请|帮我|麻烦)?(?:把|将|给我)?.{0,60}(?:删除|删掉|移除|修改|更新|标记为|设为已完成)/u.test(
    content,
  );
}

function looksLikeUnbackedConfirmationPrompt(content: string) {
  return /(?:(?:是否|要不要|请问是否|请)(?:需要|要)?(?:确认|确定)(?:创建|执行|修改|删除)|(?:确认|确定)(?:创建|执行|修改|删除)(?:吗|呢|吧)[？?]?|(?:回复|输入|回答)[“"']?(?:确认|确定)(?:创建|执行|修改|删除)?)/u.test(
    content,
  );
}

function looksLikeNewTaskRequest(content: string) {
  const text = normalizeControlCommand(content);
  return /(?:帮我|请|我要|我想).*(?:创建|添加|记录|删除|修改|完成|查询|查看|任务|待办|清单)|(?:创建|添加|记录|删除|修改|完成|查询|查看).*(?:任务|待办|清单)/u.test(
    text,
  );
}

function looksLikeReadOnlyTaskQuery(content: string) {
  const text = normalizeControlCommand(content);
  return (
    /(?:查看|查询|看看|列出|有哪些|还有什么|清单)/u.test(text) &&
    /(?:任务|待办|清单|到期|完成|没做)/u.test(text) &&
    !/(?:创建|添加|记录|删除|修改|更新|(?:把|将|标记|设为).*(?:完成|已完成))/u.test(text)
  );
}

function looksLikeReadOnlyAnalysis(content: string) {
  const text = normalizeControlCommand(content);
  return /(?:今天|今日).*(?:计划|任务|安排).*(?:合理|太多|做完|完成|检查|逻辑)|(?:本周|上周|这周).*(?:复盘|总结|完成情况|完成得怎么样|建议)|(?:复盘|总结).*(?:本周|上周|这周)/u.test(
    text,
  );
}

function formatConfirmation(pending: PendingConfirmation): string {
  const input = pending.parameters;
  if (pending.operation === "createSubtasksBatch") {
    const items = input.items as SubtaskPlanArguments["items"];
    const parent = pending.expectedTasks[0];
    return `你选择了父任务“${parent?.title ?? String(input.parentId)}”下的 ${items.length} 条子任务：\n\n${items
      .map(
        (item) =>
          `${item.number}. ${item.title}\n   优先级：${priorityText[item.priority]} · 工作量：${effortText[item.effort]} · 截止：${item.dueDate ?? "无"} · 预计：${item.estimatedMinutes ? `${item.estimatedMinutes} 分钟` : "未知"}`,
      )
      .join("\n")}\n\n是否确认创建以上 ${items.length} 条子任务？请回复“确认创建”或“取消”。`;
  }
  if (pending.operation === "createTask") {
    return `我理解你想创建以下任务：\n\n- 名称：${String(input.title)}\n- 截止日期：${input.dueDate ?? "无"}\n- 优先级：${priorityText[(input.priority as keyof typeof priorityText) ?? "medium"] ?? "中"}\n- 工作量：${effortText[(input.effort as keyof typeof effortText) ?? "medium"] ?? "中"}\n\n是否确认创建？请回复“确认创建”或“取消”。`;
  }
  const target = pending.expectedTasks.find((task) => task.id === input.id);
  if (pending.operation === "deleteTask") {
    return `我理解你想删除任务“${target?.title ?? String(input.id)}”。\n\n是否确认删除？请回复“确认删除”或“取消”。`;
  }
  const changes = Object.entries(input)
    .filter(([key]) => key !== "id")
    .map(([key, value]) => `- ${key}：${String(value)}`)
    .join("\n");
  return `我理解你想修改任务“${target?.title ?? String(input.id)}”：\n\n${changes}\n\n是否确认修改？请回复“确认修改”或“取消”。`;
}

function comparableTask(task: Task) {
  return {
    id: task.id,
    title: task.title,
    done: task.done,
    priority: task.priority,
    effort: task.effort,
    dueDate: task.dueDate,
    parentId: task.parentId,
    estimatedMinutes: task.estimatedMinutes,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
  };
}

async function executeConfirmed(
  pending: PendingConfirmation,
  executeTool: TaskToolExecutor,
  tasks: TaskStore,
  plans: SubtaskPlanStore,
): Promise<string> {
  if (pending.operation === "createSubtasksBatch") {
    const parsed = subtaskPlanArgumentsSchema.safeParse({
      parentId: pending.parameters.parentId,
      planName: "confirmed",
      items: pending.parameters.items,
    });
    if (!parsed.success) {
      return `批量方案参数已经失效，未创建任何子任务：${z.prettifyError(parsed.error)}`;
    }
    const planState = plans.inspect(pending.sessionId);
    if (planState.status !== "active") {
      return "原结构化方案已失效或过期，未创建任何子任务。请重新生成方案。";
    }
    const plan = plans.reconcile(pending.sessionId, tasks.list());
    if (
      !plan ||
      pending.parameters.planId !== plan.planId ||
      pending.parameters.planCreatedAt !== plan.createdAt ||
      parsed.data.parentId !== plan.parentId ||
      parsed.data.items.some((item) => {
        const original = plan.items.find((candidate) => candidate.number === item.number);
        return !original || JSON.stringify(original) !== JSON.stringify(item);
      })
    ) {
      return "待确认内容与服务端原始方案不一致，未创建任何子任务。";
    }
    const previouslyCreated = parsed.data.items.filter(
      (item) => plan.createdItems[item.number] !== undefined,
    );
    if (previouslyCreated.length > 0) {
      return `第 ${previouslyCreated.map((item) => item.number).join("、")} 项已经创建且仍存在，未重复执行本批操作。请重新选择。`;
    }
    const parent = pending.expectedTasks[0];
    if (!parent || parent.id !== parsed.data.parentId) {
      return "批量方案的父任务不一致，未创建任何子任务。";
    }
    const stateError = await verifyExpectedTasks(pending, executeTool);
    if (stateError) {
      plans.invalidate(pending.sessionId);
      return stateError;
    }
    try {
      const created = tasks.createSubtasks(
        parsed.data.parentId,
        parsed.data.items.map(({ title, priority, effort, dueDate, estimatedMinutes }) => ({
          title,
          priority,
          effort,
          dueDate,
          estimatedMinutes,
        })),
      );
      plans.markCreated(
        pending.sessionId,
        parsed.data.items.map((item, index) => ({
          number: item.number,
          taskId: created[index]!.id,
        })),
      );
      return `已成功创建 ${created.length} 条子任务：${created.map((task) => `“${task.title}”`).join("、")}。`;
    } catch (error) {
      if (error instanceof TaskRuleError || error instanceof z.ZodError) {
        return `批量创建没有执行：${error.message}`;
      }
      return "批量创建结果不确定。请先查询清单，不要重复确认。";
    }
  }
  const validation = validateTaskToolCall(pending.operation, pending.rawArguments);
  if (!validation.ok) {
    return `待确认参数已经失效，未执行任务变更：${validation.error ?? "参数不合法"}`;
  }
  const stateError = await verifyExpectedTasks(pending, executeTool);
  if (stateError) return stateError;

  const result = await executeTool(pending.operation, pending.rawArguments);
  if (!result.ok) {
    return result.status === undefined
      ? `无法确认待办操作是否生效：${result.error ?? "工具结果不确定"}。请先查询清单，不要重复确认。`
      : `待办操作没有成功：${result.error ?? `HTTP ${result.status}`}。`;
  }
  const target = pending.expectedTasks.find((task) => task.id === pending.parameters.id);
  if (pending.operation === "createTask") {
    return `已创建任务“${String(pending.parameters.title)}”。`;
  }
  if (pending.operation === "deleteTask") {
    return `已删除任务“${target?.title ?? String(pending.parameters.id)}”。`;
  }
  return `已修改任务“${target?.title ?? String(pending.parameters.id)}”。`;
}

async function verifyExpectedTasks(
  pending: PendingConfirmation,
  executeTool: TaskToolExecutor,
): Promise<string | undefined> {
  if (pending.expectedTasks.length === 0) return undefined;
  const listed = await executeTool("listTasks", "{}");
  if (!listed.ok || !Array.isArray(listed.data)) {
    return `确认前无法重新取得真实任务状态，未执行任务变更：${listed.error ?? "查询失败"}`;
  }
  for (const expected of pending.expectedTasks) {
    const current = listed.data.find(
      (item): item is Task =>
        typeof item === "object" && item !== null && "id" in item && item.id === expected.id,
    );
    if (
      !current ||
      JSON.stringify(comparableTask(current)) !== JSON.stringify(comparableTask(expected))
    ) {
      return `任务“${expected.title}”的状态已变化或已被删除，原确认已失效，请重新提出要求。`;
    }
  }
  return undefined;
}

const handleApiError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "请求需要使用有效的 JSON。" });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "对话太长，请刷新后开始新的对话。" });
  }
  console.error(error);
  res.status(500).json({ error: "服务暂时无法处理请求，请稍后重试。" });
};
