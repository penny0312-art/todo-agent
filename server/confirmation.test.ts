import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatCompletion, ChatCompletionMessage } from "openai/resources/chat/completions";
import { runAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import { createPendingConfirmationStore, type ConfirmationProposal } from "./confirmation.ts";
import { createJsonTaskStore, TaskRuleError, type TaskStore } from "./task-store.ts";
import type { TaskToolExecutor } from "./task-tools.ts";

function completion(message: ChatCompletionMessage): ChatCompletion {
  return {
    id: "confirmation-mock",
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

function text(content: string) {
  return completion({ role: "assistant", content, refusal: null });
}

function tool(id: string, name: string, argumentsJson: string) {
  return completion({
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: argumentsJson } }],
  });
}

function storeExecutor(tasks: TaskStore): TaskToolExecutor {
  return async (name, rawArguments) => {
    const input = JSON.parse(rawArguments || "{}") as Record<string, unknown>;
    if (name === "listTasks") return { ok: true, status: 200, data: tasks.list() };
    if (name === "createTask") {
      const { title, ...options } = input;
      return {
        ok: true,
        status: 201,
        data: tasks.create(String(title), options as Parameters<TaskStore["create"]>[1]),
      };
    }
    if (name === "updateTask") {
      const { id, ...changes } = input;
      try {
        const updated = tasks.update(String(id), changes);
        return updated
          ? { ok: true, status: 200, data: updated }
          : { ok: false, status: 404, error: "找不到这条任务。" };
      } catch (error) {
        if (error instanceof TaskRuleError) {
          return { ok: false, status: 409, error: error.message };
        }
        throw error;
      }
    }
    if (name === "deleteTask") {
      return tasks.remove(String(input.id))
        ? { ok: true, status: 204 }
        : { ok: false, status: 404, error: "找不到这条任务。" };
    }
    return { ok: false, error: `未知工具：${name}` };
  };
}

async function startConfirmationApi(
  t: TestContext,
  reply: Parameters<typeof createApp>[0]["reply"],
  options: {
    now?: () => number;
    ttlMs?: number;
    executor?: (tasks: TaskStore) => TaskToolExecutor;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-confirm-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = createJsonTaskStore(join(directory, "tasks.json"));
  const confirmations = createPendingConfirmationStore(options.now, options.ttlMs);
  const app = createApp({
    reply,
    tasks,
    confirmations,
    executeTool: options.executor?.(tasks) ?? storeExecutor(tasks),
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  async function chat(content: string, cookie?: string) {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ messages: [{ role: "user", content }] }),
    });
    return {
      body: (await response.json()) as { reply: string },
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  return { tasks, chat };
}

const createProposal = (title: string): ConfirmationProposal => ({
  operation: "createTask",
  rawArguments: JSON.stringify({ title }),
  parameters: { title },
  expectedTasks: [],
});

test("未知本地意图允许模型提出结构化待确认操作", async () => {
  let calls = 0;
  let proposal: ConfirmationProposal | undefined;
  const answer = await runAgent(
    [{ role: "user", content: "给我添加一个我今天晚上要和闺蜜逛街的任务" }],
    {
      now: () => new Date("2026-11-28T04:00:00.000Z"),
      async createCompletion() {
        calls += 1;
        return calls === 1
          ? tool("propose", "createTask", '{"title":"和闺蜜逛街","dueDate":"2026-11-28"}')
          : text("不应继续调用模型");
      },
      async executeTool() {
        throw new Error("确认前不应执行工具");
      },
      stageConfirmation(candidate) {
        proposal = candidate;
        return "请确认创建";
      },
    },
  );
  assert.equal(answer, "请确认创建");
  assert.equal(calls, 1);
  assert.deepEqual(proposal?.parameters, {
    title: "和闺蜜逛街",
    dueDate: "2026-11-28",
  });
});

test("真实失败案例中的删除背景、记录一下和给我添加得到正确决策", async () => {
  const milk = {
    id: "milk",
    title: "买牛奶",
    done: true,
    priority: "medium" as const,
    effort: "medium" as const,
    dueDate: null,
    parentId: null,
    estimatedMinutes: null,
    createdAt: null,
    completedAt: null,
    updatedAt: null,
  };
  let deleteCalls = 0;
  const deleteTools: string[] = [];
  let deleteProposal: ConfirmationProposal | undefined;
  const deleteAnswer = await runAgent(
    [{ role: "user", content: "已经买完牛奶了，帮我删除一下这个任务" }],
    {
      async createCompletion() {
        deleteCalls += 1;
        if (deleteCalls === 1) return tool("list", "listTasks", "{}");
        return tool("delete", "deleteTask", '{"id":"milk"}');
      },
      async executeTool(name) {
        deleteTools.push(name);
        return { ok: true, status: 200, data: [milk] };
      },
      stageConfirmation(proposal) {
        deleteProposal = proposal;
        return "请确认删除";
      },
    },
  );
  assert.equal(deleteAnswer, "请确认删除");
  assert.deepEqual(deleteTools, ["listTasks"]);
  assert.equal(deleteProposal?.operation, "deleteTask");
  assert.deepEqual(deleteProposal?.expectedTasks, [milk]);

  let createCalls = 0;
  const createAnswer = await runAgent(
    [{ role: "user", content: "帮我记录一下我要准备面试，高优先级，工作量大" }],
    {
      async createCompletion() {
        createCalls += 1;
        return createCalls === 1
          ? tool("create", "createTask", '{"title":"准备面试","priority":"high","effort":"large"}')
          : text("已创建准备面试");
      },
      async executeTool(name, rawArguments) {
        assert.equal(name, "createTask");
        assert.deepEqual(JSON.parse(rawArguments), {
          title: "准备面试",
          priority: "high",
          effort: "large",
        });
        return { ok: true, status: 201, data: { ...milk, id: "interview", title: "准备面试" } };
      },
    },
  );
  assert.equal(createAnswer, "已创建准备面试");
});

test("其他泛化表达可直接执行、进入确认或要求澄清日期", async () => {
  for (const scenario of [
    {
      content: "帮我把明天要去超市购物这件事加入清单",
      arguments: '{"title":"去超市购物","dueDate":"2026-11-29"}',
    },
  ]) {
    let calls = 0;
    let executions = 0;
    await runAgent([{ role: "user", content: scenario.content }], {
      now: () => new Date("2026-11-28T04:00:00.000Z"),
      async createCompletion() {
        calls += 1;
        return calls === 1 ? tool("create", "createTask", scenario.arguments) : text("已创建");
      },
      async executeTool() {
        executions += 1;
        return { ok: true, status: 201, data: { id: "new", title: "去超市购物", done: false } };
      },
    });
    assert.equal(executions, 1);
  }

  let weekendCalls = 0;
  const weekend = await runAgent([{ role: "user", content: "我想记个待办，周末去图书馆" }], {
    async createCompletion() {
      weekendCalls += 1;
      return weekendCalls === 1
        ? tool("guess", "createTask", '{"title":"去图书馆","dueDate":"2026-11-29"}')
        : text("请提供具体日期");
    },
    async executeTool() {
      throw new Error("歧义日期不应执行");
    },
    stageConfirmation() {
      throw new Error("歧义日期不应进入确认以绕过日期校验");
    },
  });
  assert.match(weekend, /相对日期存在歧义.*具体日期/s);

  for (const scenario of [
    {
      content: "牛奶已经买过了，这个任务不用留着了。",
      operation: "deleteTask" as const,
      arguments: '{"id":"milk"}',
    },
    {
      content: "把准备面试的优先级调整成最高。",
      operation: "updateTask" as const,
      arguments: '{"id":"interview","priority":"high"}',
    },
  ]) {
    const target = {
      id: scenario.operation === "deleteTask" ? "milk" : "interview",
      title: scenario.operation === "deleteTask" ? "买牛奶" : "准备面试",
      done: false,
      priority: "medium" as const,
      effort: "medium" as const,
      dueDate: null,
      parentId: null,
    };
    let calls = 0;
    let proposal: ConfirmationProposal | undefined;
    const answer = await runAgent([{ role: "user", content: scenario.content }], {
      async createCompletion() {
        calls += 1;
        return calls === 1
          ? tool("list", "listTasks", "{}")
          : tool("mutate", scenario.operation, scenario.arguments);
      },
      async executeTool(name) {
        assert.equal(name, "listTasks");
        return { ok: true, status: 200, data: [target] };
      },
      stageConfirmation(candidate) {
        proposal = candidate;
        return "请确认";
      },
    });
    assert.equal(answer, "请确认");
    assert.equal(proposal?.operation, scenario.operation);
  }
});

test("确认前不写入，确认后只执行既定参数且重复确认不重复执行", async (t) => {
  const { tasks, chat } = await startConfirmationApi(t, async (_messages, context) =>
    context.stageConfirmation(createProposal("和闺蜜逛街")),
  );
  const staged = await chat("给我添加一个逛街任务");
  assert.match(staged.body.reply, /是否确认创建/);
  assert.deepEqual(tasks.list(), []);

  const confirmed = await chat("确认创建", staged.cookie);
  assert.match(confirmed.body.reply, /已创建任务/);
  assert.deepEqual(
    tasks.list().map((task) => task.title),
    ["和闺蜜逛街"],
  );

  const duplicate = await chat("确认创建", staged.cookie);
  assert.match(duplicate.body.reply, /没有可确认/);
  assert.equal(tasks.list().length, 1);
});

test("取消、跨会话和过期确认均不执行", async (t) => {
  let clock = 1_000;
  const { tasks, chat } = await startConfirmationApi(
    t,
    async (_messages, context) => context.stageConfirmation(createProposal("待确认任务")),
    { now: () => clock, ttlMs: 100 },
  );

  const cancelledStage = await chat("创建任务");
  assert.match((await chat("取消", cancelledStage.cookie)).body.reply, /已取消/);
  assert.equal(tasks.list().length, 0);

  const crossStage = await chat("创建任务");
  assert.match((await chat("确认创建")).body.reply, /没有可确认/);
  assert.equal(tasks.list().length, 0);

  clock += 101;
  assert.match((await chat("确认创建", crossStage.cookie)).body.reply, /已过期/);
  assert.equal(tasks.list().length, 0);
});

test("待确认阶段的异常输入不会调用模型，原操作仍可确认", async (t) => {
  let modelCalls = 0;
  const { tasks, chat } = await startConfirmationApi(t, async (_messages, context) => {
    modelCalls += 1;
    if (modelCalls > 1) throw new Error("待确认阶段不应再次调用模型");
    return context.stageConfirmation(createProposal("保留的任务"));
  });
  const staged = await chat("创建任务");
  for (const content of ["确定创键", "随便聊聊", "我还没确定"]) {
    assert.match((await chat(content, staged.cookie)).body.reply, /仍然保留/);
  }
  assert.equal(modelCalls, 1);
  assert.equal(tasks.list().length, 0);
  assert.match((await chat("确定创建", staged.cookie)).body.reply, /已创建任务/);
  assert.equal(modelCalls, 1);
  assert.deepEqual(
    tasks.list().map((task) => task.title),
    ["保留的任务"],
  );
});

test("执行结果不确定时不会恢复确认或自动重试", async (t) => {
  let mutationCalls = 0;
  const { tasks, chat } = await startConfirmationApi(
    t,
    async (_messages, context) => context.stageConfirmation(createProposal("结果不确定任务")),
    {
      executor: () => async (name) => {
        if (name === "createTask") mutationCalls += 1;
        return { ok: false, error: "连接在响应前断开" };
      },
    },
  );
  const staged = await chat("创建任务");
  assert.match((await chat("确定创建", staged.cookie)).body.reply, /无法确认.*先查询/s);
  assert.equal(mutationCalls, 1);
  assert.equal(tasks.list().length, 0);
  assert.match((await chat("确定创建", staged.cookie)).body.reply, /没有可确认/);
  assert.equal(mutationCalls, 1);
});

test("新要求不会静默替换旧确认，并发确认最多执行一次", async (t) => {
  const { tasks, chat } = await startConfirmationApi(t, async (messages, context) => {
    const title = messages.at(-1)?.content.includes("第二") ? "第二个任务" : "第一个任务";
    return context.stageConfirmation(createProposal(title));
  });
  const first = await chat("创建第一个任务");
  const conflict = await chat("创建第二个任务", first.cookie);
  assert.match(conflict.body.reply, /尚未确认.*保持不变/s);
  const firstConfirmed = await chat("确认创建", first.cookie);
  assert.match(firstConfirmed.body.reply, /已创建任务“第一个任务”/);

  const second = await chat("创建第二个任务", first.cookie);
  const results = await Promise.all([
    chat("确认创建", second.cookie ?? first.cookie),
    chat("确认创建", second.cookie ?? first.cookie),
  ]);
  assert.equal(results.filter((result) => /已创建任务/.test(result.body.reply)).length, 1);
  assert.deepEqual(
    tasks.list().map((task) => task.title),
    ["第一个任务", "第二个任务"],
  );
});

test("确认期间目标状态变化会使原操作失效", async (t) => {
  let expectedTask: ReturnType<TaskStore["create"]>;
  const { tasks, chat } = await startConfirmationApi(t, async (_messages, context) => {
    expectedTask ??= tasks.create("买牛奶");
    return context.stageConfirmation({
      operation: "deleteTask",
      rawArguments: JSON.stringify({ id: expectedTask.id }),
      parameters: { id: expectedTask.id },
      expectedTasks: [expectedTask],
    });
  });
  const staged = await chat("删除买牛奶");
  tasks.update(expectedTask!.id, { done: true });
  const confirmed = await chat("确认删除", staged.cookie);
  assert.match(confirmed.body.reply, /状态已变化.*重新提出/s);
  assert.equal(tasks.list().length, 1);
});

test("用户确认不能绕过父子任务业务约束", async (t) => {
  let parentId = "";
  const { tasks, chat } = await startConfirmationApi(t, async (_messages, context) => {
    const parent = tasks.list().find((task) => task.id === parentId)!;
    return context.stageConfirmation({
      operation: "updateTask",
      rawArguments: JSON.stringify({ id: parent.id, done: true }),
      parameters: { id: parent.id, done: true },
      expectedTasks: [parent],
    });
  });
  const parent = tasks.create("父任务");
  parentId = parent.id;
  tasks.create("未完成子任务", { parentId });
  const staged = await chat("完成父任务");
  const confirmed = await chat("确认修改", staged.cookie);
  assert.match(confirmed.body.reply, /没有成功.*未完成子任务/s);
  assert.equal(tasks.list().find((task) => task.id === parentId)?.done, false);
});

test("明确禁止和非法参数不能进入确认流程", async () => {
  for (const scenario of [
    { content: "不要帮我删除买牛奶这个任务", arguments: '{"id":"milk"}' },
    { content: "给我创建一个任务", arguments: '{"title":""}' },
  ]) {
    let staged = 0;
    let calls = 0;
    const answer = await runAgent([{ role: "user", content: scenario.content }], {
      async createCompletion() {
        calls += 1;
        return calls === 1
          ? tool(
              "unsafe",
              scenario.content.includes("删除") ? "deleteTask" : "createTask",
              scenario.arguments,
            )
          : text("已执行");
      },
      async executeTool() {
        throw new Error("不应执行");
      },
      stageConfirmation() {
        staged += 1;
        return "不应确认";
      },
    });
    assert.equal(staged, 0);
    assert.match(answer, /拒绝|参数不合法|没有执行/);
  }
});

test("普通聊天中模型擅自创建只能形成待确认提案，不能直接执行", async () => {
  let executed = 0;
  let staged = 0;
  const answer = await runAgent([{ role: "user", content: "今天天气不错" }], {
    async createCompletion() {
      return tool("unwanted", "createTask", '{"title":"模型擅自创建"}');
    },
    async executeTool() {
      executed += 1;
      return { ok: true, status: 201 };
    },
    stageConfirmation() {
      staged += 1;
      return "是否确认创建模型擅自提出的任务？";
    },
  });
  assert.equal(executed, 0);
  assert.equal(staged, 1);
  assert.match(answer, /确认/);
});
