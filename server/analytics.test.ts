import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatCompletion, ChatCompletionMessage } from "openai/resources/chat/completions";
import type { Task } from "../shared/task.ts";
import { runAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import { createPendingConfirmationStore } from "./confirmation.ts";
import { evaluateTodayPlan } from "./plan-evaluator.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { buildWeeklyReview } from "./weekly-review.ts";

function task(overrides: Partial<Task> & Pick<Task, "id" | "title">): Task {
  return {
    id: overrides.id,
    title: overrides.title,
    done: overrides.done ?? false,
    priority: overrides.priority ?? "medium",
    effort: overrides.effort ?? "medium",
    dueDate: overrides.dueDate ?? null,
    parentId: overrides.parentId ?? null,
    estimatedMinutes: overrides.estimatedMinutes ?? null,
    createdAt: overrides.createdAt ?? null,
    completedAt: overrides.completedAt ?? null,
    updatedAt: overrides.updatedAt ?? null,
  };
}

function completion(message: ChatCompletionMessage): ChatCompletion {
  return {
    id: "analytics-mock",
    object: "chat.completion",
    created: 0,
    model: "mock",
    choices: [
      {
        index: 0,
        finish_reason: message.tool_calls ? "tool_calls" : "stop",
        logprobs: null,
        message,
      },
    ],
  };
}

const text = (content: string) => completion({ role: "assistant", content, refusal: null });
const listTool = () =>
  completion({
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [
      { id: "list", type: "function", function: { name: "listTasks", arguments: "{}" } },
    ],
  });
const functionTool = (name: string, args: string) =>
  completion({
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [{ id: name, type: "function", function: { name, arguments: args } }],
  });

test("任务预计耗时和程序时间戳遵守创建、完成、修改及重新打开规则", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-time-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-11-23T01:00:00.000Z");
  const store = createJsonTaskStore(join(directory, "tasks.json"), () => now);
  const created = store.create("写报告", { estimatedMinutes: 90 });
  assert.equal(created.estimatedMinutes, 90);
  assert.equal(created.createdAt, now.toISOString());
  assert.equal(created.updatedAt, created.createdAt);
  assert.equal(created.completedAt, null);

  now = new Date("2026-11-24T02:00:00.000Z");
  const completed = store.update(created.id, { done: true })!;
  assert.equal(completed.completedAt, now.toISOString());
  const completionTime = completed.completedAt;
  now = new Date("2026-11-25T03:00:00.000Z");
  assert.equal(store.update(created.id, { priority: "high" })?.completedAt, completionTime);
  now = new Date("2026-11-26T04:00:00.000Z");
  const reopened = store.update(created.id, { done: false })!;
  assert.equal(reopened.completedAt, null);
  assert.equal(reopened.updatedAt, now.toISOString());
});

test("批量子任务记录统一创建时间，旧任务历史时间保持未知", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-time-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  await writeFile(filename, JSON.stringify([{ id: "old", title: "旧任务", done: false }]));
  const now = new Date("2026-11-28T04:00:00.000Z");
  const store = createJsonTaskStore(filename, () => now);
  assert.equal(store.list()[0]?.createdAt, null);
  assert.equal(store.list()[0]?.completedAt, null);
  const parent = store.create("父任务");
  const children = store.createSubtasks(parent.id, [
    { title: "子任务1", priority: "high", effort: "large", dueDate: null, estimatedMinutes: 60 },
    {
      title: "子任务2",
      priority: "medium",
      effort: "small",
      dueDate: null,
      estimatedMinutes: null,
    },
  ]);
  assert.equal(children[0]?.createdAt, now.toISOString());
  assert.equal(children[1]?.createdAt, children[0]?.createdAt);
  assert.deepEqual(
    children.map((item) => item.estimatedMinutes),
    [60, null],
  );
});

test("今日计划统计正确处理负荷、缺失耗时、工作量集中及父子去重", () => {
  const parent = task({
    id: "p",
    title: "父任务",
    dueDate: "2026-11-28",
    effort: "large",
    estimatedMinutes: 300,
  });
  const tasks = [
    parent,
    task({
      id: "c",
      title: "子任务",
      parentId: "p",
      dueDate: "2026-11-28",
      priority: "high",
      effort: "large",
      estimatedMinutes: 240,
    }),
    task({
      id: "a",
      title: "写报告",
      dueDate: "2026-11-28",
      priority: "high",
      effort: "large",
      estimatedMinutes: 180,
    }),
    task({
      id: "b",
      title: "写报告",
      dueDate: "2026-11-28",
      effort: "small",
      estimatedMinutes: null,
    }),
    task({ id: "late", title: "逾期任务", dueDate: "2026-11-27", estimatedMinutes: 30 }),
  ];
  const incomplete = evaluateTodayPlan(tasks, "2026-11-28", { availableMinutes: 360 });
  assert.equal(incomplete.counts.tasks, 3);
  assert.equal(incomplete.knownMinutes, 420);
  assert.equal(incomplete.unknownMinutes, 1);
  assert.equal(incomplete.loadRatio, null);
  assert.equal(incomplete.counts.overdue, 1);
  assert.equal(incomplete.workloadConcentrated, true);
  assert.deepEqual(incomplete.duplicateTitles, ["写报告"]);

  const complete = evaluateTodayPlan(
    tasks.filter((item) => item.id !== "b"),
    "2026-11-28",
    {
      availableMinutes: 360,
    },
  );
  assert.equal(complete.knownMinutes, 420);
  assert.ok((complete.loadRatio ?? 0) > 1);
  const reasonable = evaluateTodayPlan(
    [task({ id: "one", title: "小任务", dueDate: "2026-11-28", estimatedMinutes: 120 })],
    "2026-11-28",
    { availableMinutes: 360 },
  );
  assert.ok((reasonable.loadRatio ?? 1) < 0.8);
});

test("父子截止日期冲突和缺少可用时间会被明确记录", () => {
  const value = evaluateTodayPlan(
    [
      task({ id: "p", title: "父", dueDate: "2026-11-28" }),
      task({ id: "c", title: "子", parentId: "p", dueDate: "2026-11-29", estimatedMinutes: 30 }),
    ],
    "2026-11-28",
  );
  assert.equal(value.availableMinutes, null);
  assert.equal(value.loadRatio, null);
  assert.equal(value.dueDateConflicts.length, 1);
});

test("今日计划可限定用户明确指定的真实任务且忽略范围外截止冲突", () => {
  const tasks = [
    task({ id: "chosen", title: "指定任务", dueDate: "2026-12-01", estimatedMinutes: 45 }),
    task({ id: "p", title: "范围外父任务", dueDate: "2026-11-29" }),
    task({ id: "c", title: "范围外子任务", parentId: "p", dueDate: "2026-11-30" }),
  ];
  const value = evaluateTodayPlan(tasks, "2026-11-28", { selectedIds: ["chosen"] });
  assert.deepEqual(value.tasks.map((item) => item.id), ["chosen"]);
  assert.equal(value.scopeLabel, "用户明确指定且仍未完成的真实任务");
  assert.deepEqual(value.dueDateConflicts, []);
});

test("周复盘按上海时区周一到周日统计新增、完成、到期和零分母", () => {
  const tasks = [
    task({
      id: "a",
      title: "周一任务",
      dueDate: "2026-11-23",
      done: true,
      priority: "high",
      effort: "large",
      createdAt: "2026-11-22T16:30:00.000Z",
      completedAt: "2026-11-23T10:00:00.000Z",
      estimatedMinutes: 60,
    }),
    task({
      id: "b",
      title: "未完成",
      dueDate: "2026-11-28",
      priority: "high",
      effort: "large",
      createdAt: "2026-11-27T10:00:00.000Z",
    }),
    task({ id: "old", title: "旧数据", done: true, dueDate: "2026-11-25" }),
  ];
  const review = buildWeeklyReview(tasks, new Date("2026-11-28T04:00:00.000Z"));
  assert.equal(review.start, "2026-11-23");
  assert.equal(review.end, "2026-11-29");
  assert.equal(review.cutoff, "2026-11-28");
  assert.equal(review.newTasks, 2);
  assert.equal(review.completedThisPeriod, 1);
  assert.deepEqual(review.due, { completed: 2, total: 3 });
  assert.deepEqual(review.byPriority.low, { completed: 0, total: 0 });
  assert.equal(review.unknownCreatedAt, 1);
  assert.equal(review.unknownCompletedAt, 1);
  assert.equal(review.dailyCompleted["2026-11-23"], 1);

  const previous = buildWeeklyReview(tasks, new Date("2026-11-28T04:00:00.000Z"), true);
  assert.equal(previous.start, "2026-11-16");
  assert.equal(previous.end, "2026-11-22");
});

test("Agent 今日评估和周复盘只查询真实任务并保留程序统计", async () => {
  const tasks = [
    task({
      id: "a",
      title: "写报告",
      dueDate: "2026-11-28",
      priority: "high",
      effort: "large",
      estimatedMinutes: 300,
      createdAt: "2026-11-23T01:00:00.000Z",
    }),
  ];
  for (const request of ["我今天只有6个小时，这些任务能做完吗？", "帮我复盘一下本周任务"]) {
    let calls = 0;
    const tools: string[] = [];
    const before = structuredClone(tasks);
    const answer = await runAgent([{ role: "user", content: request }], {
      now: () => new Date("2026-11-28T04:00:00.000Z"),
      async createCompletion() {
        calls += 1;
        if (calls === 1) return listTool();
        if (calls === 2) return text("准备分析");
        return text("根据现有数据，建议先完成高优先级任务；依赖关系仅为可能推断。");
      },
      async executeTool(name) {
        tools.push(name);
        return { ok: true, status: 200, data: tasks };
      },
    });
    assert.deepEqual(tools, ["listTasks"]);
    assert.match(answer, /客观评估|客观复盘/);
    assert.match(answer, /语义分析与建议/);
    assert.deepEqual(tasks, before);
  }
});

test("Agent 可以通过自然语言设置正整数预计分钟数", async () => {
  const target = task({ id: "paper", title: "写论文" });
  let calls = 0;
  const executed: Array<[string, string]> = [];
  const answer = await runAgent([{ role: "user", content: "把写论文的预计耗时设置为90分钟" }], {
    async createCompletion() {
      calls += 1;
      if (calls === 1) return listTool();
      if (calls === 2) return functionTool("updateTask", '{"id":"paper","estimatedMinutes":90}');
      return text("已将写论文的预计耗时设置为90分钟。");
    },
    async executeTool(name, args) {
      executed.push([name, args]);
      return name === "listTasks"
        ? { ok: true, status: 200, data: [target] }
        : { ok: true, status: 200, data: { ...target, estimatedMinutes: 90 } };
    },
  });
  assert.deepEqual(executed.map(([name]) => name), ["listTasks", "updateTask"]);
  assert.deepEqual(JSON.parse(executed[1]![1]), { id: "paper", estimatedMinutes: 90 });
  assert.match(answer, /90分钟/);
});

test("只读分析不会破坏有效确认状态", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-analysis-confirm-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = createJsonTaskStore(join(directory, "tasks.json"));
  const confirmations = createPendingConfirmationStore();
  const app = createApp({
    tasks,
    confirmations,
    async reply(messages, context) {
      const content = messages.at(-1)!.content;
      if (content === "建立确认") {
        return context.stageConfirmation({
          operation: "createTask",
          rawArguments: '{"title":"待创建"}',
          parameters: { title: "待创建" },
          expectedTasks: [],
        });
      }
      return "只读分析完成";
    },
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const send = async (content: string, cookie?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ messages: [{ role: "user", content }] }),
    });
    return {
      body: (await response.json()) as { reply: string },
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };
  const staged = await send("建立确认");
  const sessionId = staged.cookie!.split("=")[1];
  const pending = confirmations.peek(sessionId)!;
  assert.equal(
    (await send("帮我看看今天的计划是否合理", staged.cookie)).body.reply,
    "只读分析完成",
  );
  assert.equal(confirmations.peek(sessionId)?.id, pending.id);
  assert.equal((await send("帮我复盘一下本周任务", staged.cookie)).body.reply, "只读分析完成");
  assert.equal(confirmations.peek(sessionId)?.id, pending.id);
  assert.equal(tasks.list().length, 0);
});
