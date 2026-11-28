import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatCompletion, ChatCompletionMessage } from "openai/resources/chat/completions";
import { runAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import { addCalendarDays, isCalendarDate, localDate } from "./date.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { createTaskToolExecutor } from "./task-tools.ts";

function completion(message: ChatCompletionMessage): ChatCompletion {
  return {
    id: "extension-mock",
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

async function startApi(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-extensions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const tasks = createJsonTaskStore(filename);
  const app = createApp({ tasks, reply: async () => "unused" });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }
  return { filename, tasks, baseUrl, request };
}

test("Asia/Shanghai 日期边界及日历日期校验", () => {
  assert.equal(localDate(new Date("2026-11-26T15:59:59.000Z")), "2026-11-26");
  assert.equal(localDate(new Date("2026-11-26T16:00:00.000Z")), "2026-11-27");
  assert.equal(addCalendarDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addCalendarDays("2028-02-28", 2), "2028-03-01");
  assert.equal(isCalendarDate("2026-02-28"), true);
  assert.equal(isCalendarDate("2026-02-29"), false);
  assert.equal(isCalendarDate("2026-13-01"), false);
  assert.equal(isCalendarDate("26-1-1"), false);
});

test("旧任务数据读取时补充默认扩展字段且不丢失未知字段", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  await writeFile(
    filename,
    JSON.stringify([{ id: "legacy", title: "旧任务", done: false, note: "保留" }]),
  );
  const store = createJsonTaskStore(filename);
  assert.deepEqual(store.list(), [
    {
      id: "legacy",
      title: "旧任务",
      done: false,
      priority: "medium",
      effort: "medium",
      dueDate: null,
      parentId: null,
      estimatedMinutes: null,
      createdAt: null,
      completedAt: null,
      updatedAt: null,
      note: "保留",
    },
  ]);
  store.update("legacy", { priority: "high" });
  assert.equal(store.list()[0]?.note, "保留");
});

test("任务 API 创建、修改并按截止日期过滤扩展字段", async (t) => {
  const { request } = await startApi(t);
  const created = await request("POST", "/api/tasks", {
    title: "写论文",
    priority: "high",
    effort: "large",
    dueDate: "2026-11-27",
    parentId: null,
    estimatedMinutes: 180,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, {
    id: created.body.id,
    title: "写论文",
    done: false,
    priority: "high",
    effort: "large",
    dueDate: "2026-11-27",
    parentId: null,
    estimatedMinutes: 180,
    createdAt: created.body.createdAt,
    completedAt: null,
    updatedAt: created.body.updatedAt,
  });

  const updated = await request("PATCH", `/api/tasks/${created.body.id}`, {
    priority: "low",
    effort: "small",
    dueDate: "2026-11-28",
  });
  assert.equal(updated.body.priority, "low");
  assert.equal(updated.body.effort, "small");
  assert.equal(updated.body.dueDate, "2026-11-28");
  assert.equal(updated.body.createdAt, created.body.createdAt);
  assert.equal(typeof updated.body.updatedAt, "string");
  assert.deepEqual((await request("GET", "/api/tasks?dueDate=2026-11-27")).body, []);
  assert.deepEqual((await request("GET", "/api/tasks?dueDate=2026-11-28")).body, [updated.body]);

  const cleared = await request("PATCH", `/api/tasks/${created.body.id}`, { dueDate: null });
  assert.equal(cleared.body.dueDate, null);
});

test("任务 API 拒绝非法优先级、工作量、日期和未知字段", async (t) => {
  const { request } = await startApi(t);
  for (const body of [
    { title: "任务", priority: "urgent" },
    { title: "任务", effort: "huge" },
    { title: "任务", effort: 180 },
    { title: "任务", dueDate: "2026-02-29" },
    { title: "任务", estimatedMinutes: 0 },
    { title: "任务", estimatedMinutes: 1.5 },
    { title: "任务", reminderAt: "2026-11-27T09:00:00" },
  ]) {
    assert.equal((await request("POST", "/api/tasks", body)).status, 400);
  }
  assert.equal((await request("GET", "/api/tasks?dueDate=invalid")).status, 400);
});

test("工具执行器传递扩展字段并支持日期过滤", async (t) => {
  const { baseUrl } = await startApi(t);
  const execute = createTaskToolExecutor(baseUrl);
  const created = await execute(
    "createTask",
    JSON.stringify({
      title: "实验报告",
      priority: "high",
      effort: "large",
      dueDate: "2026-11-26",
      estimatedMinutes: 120,
    }),
  );
  assert.equal(created.ok, true);
  assert.equal((created.data as { estimatedMinutes: number }).estimatedMinutes, 120);
  const today = await execute("listTasks", JSON.stringify({ dueDate: "2026-11-26" }));
  assert.equal(Array.isArray(today.data) && today.data.length, 1);
  const invalid = await execute("updateTask", JSON.stringify({ id: "x", effort: 180 }));
  assert.equal(invalid.ok, false);
  assert.match(invalid.error ?? "", /工具参数不合法/);
});

test("Agent 用注入日期解析明天并校验模型工具参数", async () => {
  let calls = 0;
  let executedArguments = "";
  const answer = await runAgent([{ role: "user", content: "记一下明天要交实验报告" }], {
    now: () => new Date("2026-11-26T04:00:00.000Z"),
    async createCompletion(request) {
      calls += 1;
      assert.match(String(request.messages[0]?.content), /2026-11-26.*Asia\/Shanghai/s);
      return calls === 1
        ? tool(
            "create-tomorrow",
            "createTask",
            JSON.stringify({ title: "交实验报告", dueDate: "2026-11-27" }),
          )
        : text("已记录");
    },
    async executeTool(_name, rawArguments) {
      executedArguments = rawArguments;
      return {
        ok: true,
        status: 201,
        data: {
          id: "report",
          title: "交实验报告",
          done: false,
          priority: "medium",
          effort: "medium",
          dueDate: "2026-11-27",
        },
      };
    },
  });
  assert.equal(JSON.parse(executedArguments).dueDate, "2026-11-27");
  assert.equal(answer, "已记录");
});

test("Agent 拒绝模型猜错今天、明天、后天的日期", async () => {
  for (const [phrase, wrongDate] of [
    ["今天要交报告", "2026-11-27"],
    ["明天要交报告", "2026-11-26"],
    ["后天要交报告", "2026-11-27"],
  ] as const) {
    let calls = 0;
    let executions = 0;
    const answer = await runAgent([{ role: "user", content: `帮我记一下${phrase}` }], {
      now: () => new Date("2026-11-26T04:00:00.000Z"),
      async createCompletion() {
        calls += 1;
        return calls === 1
          ? tool(
              "wrong-date",
              "createTask",
              JSON.stringify({ title: "交报告", dueDate: wrongDate }),
            )
          : text("已记录");
      },
      async executeTool() {
        executions += 1;
        return { ok: true };
      },
    });
    assert.equal(executions, 0, phrase);
    assert.match(answer, /相对日期参数不正确/, phrase);
  }
});

test("Agent 修改优先级、工作量和相对截止日期时保留 ID 保护", async () => {
  let calls = 0;
  const executed: string[] = [];
  const answer = await runAgent(
    [
      {
        role: "user",
        content: "把写论文的优先级设为高，工作量设为大，截止日期改为后天",
      },
    ],
    {
      now: () => new Date("2026-11-26T04:00:00.000Z"),
      async createCompletion() {
        calls += 1;
        if (calls === 1) return tool("find-paper", "listTasks", "{}");
        if (calls === 2) {
          return tool(
            "update-paper",
            "updateTask",
            JSON.stringify({
              id: "paper",
              priority: "high",
              effort: "large",
              dueDate: "2026-11-28",
            }),
          );
        }
        return text("已更新写论文");
      },
      async executeTool(name, rawArguments) {
        executed.push(name);
        if (name === "listTasks") {
          return {
            ok: true,
            status: 200,
            data: [
              {
                id: "paper",
                title: "写论文",
                done: false,
                priority: "medium",
                effort: "medium",
                dueDate: null,
              },
            ],
          };
        }
        const changes = JSON.parse(rawArguments);
        assert.deepEqual(changes, {
          id: "paper",
          priority: "high",
          effort: "large",
          dueDate: "2026-11-28",
        });
        return {
          ok: true,
          status: 200,
          data: {
            id: "paper",
            title: "写论文",
            done: false,
            priority: "high",
            effort: "large",
            dueDate: "2026-11-28",
          },
        };
      },
    },
  );
  assert.deepEqual(executed, ["listTasks", "updateTask"]);
  assert.equal(answer, "已更新写论文");
});

test("数字工时不会被擅自换算为工作量等级", async () => {
  let calls = 0;
  const executed: string[] = [];
  const answer = await runAgent([{ role: "user", content: "把写论文的工作量设为3小时" }], {
    async createCompletion() {
      calls += 1;
      if (calls === 1) return tool("find", "listTasks", "{}");
      if (calls === 2)
        return tool("guess-effort", "updateTask", '{"id":"paper","effort":"medium"}');
      return text("已设置");
    },
    async executeTool(name) {
      executed.push(name);
      return {
        ok: true,
        status: 200,
        data: [
          {
            id: "paper",
            title: "写论文",
            done: false,
            priority: "medium",
            effort: "medium",
            dueDate: null,
          },
        ],
      };
    },
  });
  assert.deepEqual(executed, ["listTasks"]);
  assert.match(answer, /只支持小、中、大/);
});

test("Agent 今天到期查询必须使用注入日期并统一展示", async () => {
  let calls = 0;
  let argumentsJson = "";
  const answer = await runAgent([{ role: "user", content: "今天有哪些任务到期？" }], {
    now: () => new Date("2026-11-26T15:59:59.000Z"),
    async createCompletion() {
      calls += 1;
      return calls === 1
        ? tool("today-list", "listTasks", '{"dueDate":"2026-11-26"}')
        : text("模型自己的展示会被程序替换");
    },
    async executeTool(_name, rawArguments) {
      argumentsJson = rawArguments;
      return {
        ok: true,
        status: 200,
        data: [
          {
            id: "today",
            title: "交报告",
            done: false,
            priority: "high",
            effort: "large",
            dueDate: "2026-11-26",
          },
        ],
      };
    },
  });
  assert.deepEqual(JSON.parse(argumentsJson), { dueDate: "2026-11-26" });
  assert.match(answer, /今天到期 · 2026-11-26/);
  assert.match(answer, /优先级：高 · 工作量：大/);
  assert.doesNotMatch(answer, /模型自己的展示/);
});

test("Agent 清单展示分组并标记到期、过期和无截止日期", async () => {
  let calls = 0;
  const answer = await runAgent([{ role: "user", content: "看看我的任务清单" }], {
    now: () => new Date("2026-11-26T04:00:00.000Z"),
    async createCompletion() {
      calls += 1;
      return calls === 1 ? tool("all", "listTasks", "{}") : text("ignored");
    },
    async executeTool() {
      return {
        ok: true,
        status: 200,
        data: [
          {
            id: "a",
            title: "过期任务",
            done: false,
            priority: "high",
            effort: "large",
            dueDate: "2026-11-25",
          },
          {
            id: "b",
            title: "今天任务",
            done: false,
            priority: "medium",
            effort: "small",
            dueDate: "2026-11-26",
          },
          {
            id: "c",
            title: "完成任务",
            done: true,
            priority: "low",
            effort: "medium",
            dueDate: null,
          },
        ],
      };
    },
  });
  assert.match(answer, /未完成（2）/);
  assert.match(answer, /已完成（1）/);
  assert.match(answer, /2026-11-25 · 已过期/);
  assert.match(answer, /2026-11-26 · 今天到期/);
  assert.match(answer, /无截止日期/);
});

test("扩展字段在重新创建存储后保持不变", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-extension-persistence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const created = createJsonTaskStore(filename).create("长期任务", {
    priority: "high",
    effort: "large",
    dueDate: "2026-12-31",
  });
  const restarted = createJsonTaskStore(filename).list();
  assert.deepEqual(restarted, [created]);
});
