import assert from "node:assert/strict";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatCompletion, ChatCompletionMessage } from "openai/resources/chat/completions";
import type { Task } from "../shared/task.ts";
import { runAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import { recommendTasks } from "./recommend.ts";
import { createJsonTaskStore, TaskRuleError } from "./task-store.ts";

function completion(message: ChatCompletionMessage): ChatCompletion {
  return {
    id: "subtask-mock",
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

function task(overrides: Partial<Task> & Pick<Task, "id" | "title">): Task {
  const value = {
    done: false,
    priority: "medium" as const,
    effort: "medium" as const,
    dueDate: null,
    parentId: null,
    ...overrides,
  };
  return {
    ...value,
    estimatedMinutes: value.estimatedMinutes ?? null,
    createdAt: value.createdAt ?? null,
    completedAt: value.completedAt ?? null,
    updatedAt: value.updatedAt ?? null,
  };
}

async function startApi(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-subtasks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const tasks = createJsonTaskStore(filename);
  const app = createApp({ tasks, reply: async () => "unused" });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }
  return { filename, tasks, request };
}

test("旧任务迁移时 parentId 默认为 null", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-parent-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  await writeFile(filename, JSON.stringify([{ id: "old", title: "旧任务", done: false }]));
  assert.equal(createJsonTaskStore(filename).list()[0]?.parentId, null);
});

test("子任务支持创建、查询、修改、删除和持久化", async (t) => {
  const { filename, request } = await startApi(t);
  const parent = await request("POST", "/api/tasks", { title: "准备面试" });
  const child = await request("POST", "/api/tasks", {
    title: "复习数据结构",
    parentId: parent.body.id,
    priority: "high",
    effort: "large",
    dueDate: "2026-11-28",
  });
  assert.equal(child.status, 201);
  assert.equal(child.body.parentId, parent.body.id);

  const updated = await request("PATCH", `/api/tasks/${child.body.id}`, {
    effort: "small",
    done: true,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.done, true);
  assert.equal(updated.body.effort, "small");
  assert.equal((await request("GET", "/api/tasks")).body.length, 2);

  const restarted = createJsonTaskStore(filename).list();
  assert.equal(restarted.find((item) => item.id === child.body.id)?.parentId, parent.body.id);
  assert.equal((await request("DELETE", `/api/tasks/${child.body.id}`)).status, 204);
  assert.equal((await request("DELETE", `/api/tasks/${parent.body.id}`)).status, 204);
});

test("拒绝不存在父任务、孙任务、自引用和循环关系", () => {
  const filename = join(tmpdir(), `todo-agent-rules-${crypto.randomUUID()}.json`);
  const store = createJsonTaskStore(filename);
  assert.throws(() => store.create("孤儿", { parentId: "missing" }), TaskRuleError);

  const first = store.create("父任务一");
  const child = store.create("子任务", { parentId: first.id });
  assert.throws(() => store.create("孙任务", { parentId: child.id }), /只支持一层子任务/);
  assert.throws(() => store.update(first.id, { parentId: first.id }), /自己的父任务/);

  const cycleA = store.create("循环一");
  const cycleB = store.create("循环二");
  store.update(cycleA.id, { parentId: cycleB.id });
  assert.throws(() => store.update(cycleB.id, { parentId: cycleA.id }), /只支持一层子任务/);
  rmSync(filename, { force: true });
});

test("父任务完成和删除受子任务状态约束", async (t) => {
  const { request } = await startApi(t);
  const parent = await request("POST", "/api/tasks", { title: "发布项目" });
  const child = await request("POST", "/api/tasks", {
    title: "运行测试",
    parentId: parent.body.id,
  });

  const prematureDone = await request("PATCH", `/api/tasks/${parent.body.id}`, { done: true });
  assert.equal(prematureDone.status, 409);
  assert.match(prematureDone.body.error, /未完成子任务/);
  assert.equal((await request("DELETE", `/api/tasks/${parent.body.id}`)).status, 409);

  assert.equal((await request("PATCH", `/api/tasks/${child.body.id}`, { done: true })).status, 200);
  const afterChildDone = await request("GET", "/api/tasks");
  assert.equal(afterChildDone.body.find((task: Task) => task.id === parent.body.id)?.done, false);
  assert.equal(
    (await request("PATCH", `/api/tasks/${parent.body.id}`, { done: true })).status,
    200,
  );
  const reopenChild = await request("PATCH", `/api/tasks/${child.body.id}`, { done: false });
  assert.equal(reopenChild.status, 409);
  assert.match(reopenChild.body.error, /先重新打开父任务/);

  const addToDoneParent = await request("POST", "/api/tasks", {
    title: "补充文档",
    parentId: parent.body.id,
  });
  assert.equal(addToDoneParent.status, 409);
  assert.equal(
    (await request("PATCH", `/api/tasks/${parent.body.id}`, { done: false })).status,
    200,
  );
  assert.equal(
    (await request("PATCH", `/api/tasks/${child.body.id}`, { done: false })).status,
    200,
  );
});

test("同名父子任务保持独立 ID 和父子关系", () => {
  const filename = join(tmpdir(), `todo-agent-same-name-${crypto.randomUUID()}.json`);
  const store = createJsonTaskStore(filename);
  const parent = store.create("复习");
  const child = store.create("复习", { parentId: parent.id });
  assert.notEqual(parent.id, child.id);
  assert.equal(store.list().find((item) => item.id === child.id)?.parentId, parent.id);
  rmSync(filename, { force: true });
});

test("创建子任务要求 parentId 来自本轮查询且当前消息明确标题", async () => {
  let calls = 0;
  const executed: string[] = [];
  const answer = await runAgent(
    [{ role: "user", content: "给准备 Python 面试创建子任务：复习数据结构" }],
    {
      async createCompletion() {
        calls += 1;
        if (calls === 1) return tool("find-parent", "listTasks", "{}");
        if (calls === 2) {
          return tool("create-child", "createTask", '{"title":"复习数据结构","parentId":"parent"}');
        }
        return text("已创建子任务");
      },
      async executeTool(name) {
        executed.push(name);
        return name === "listTasks"
          ? {
              ok: true,
              status: 200,
              data: [task({ id: "parent", title: "准备 Python 面试" })],
            }
          : {
              ok: true,
              status: 201,
              data: task({
                id: "child",
                title: "复习数据结构",
                parentId: "parent",
              }),
            };
      },
    },
  );
  assert.deepEqual(executed, ["listTasks", "createTask"]);
  assert.equal(answer, "已创建子任务");
});

test("虚构 parentId 和仅按历史序号确认都不能创建子任务", async () => {
  for (const scenario of [
    {
      user: "给准备 Python 面试创建子任务：复习数据结构",
      arguments: '{"title":"复习数据结构","parentId":"invented"}',
      expected: /真实的顶级父任务/,
    },
    {
      user: "确认创建第一个子任务",
      arguments: '{"title":"复习数据结构","parentId":"parent"}',
      expected: /当前消息必须明确写出父任务标题和.*子任务标题/,
    },
  ]) {
    let calls = 0;
    const executed: string[] = [];
    const answer = await runAgent([{ role: "user", content: scenario.user }], {
      async createCompletion() {
        calls += 1;
        if (calls === 1) return tool("list", "listTasks", "{}");
        if (calls === 2) return tool("unsafe-create", "createTask", scenario.arguments);
        return text("已创建");
      },
      async executeTool(name) {
        executed.push(name);
        return {
          ok: true,
          status: 200,
          data: [task({ id: "parent", title: "准备 Python 面试" })],
        };
      },
    });
    assert.deepEqual(executed, ["listTasks"]);
    assert.match(answer, scenario.expected);
  }
});

test("AI 拆解只读：查询真实父任务后返回建议但不写入", async () => {
  let calls = 0;
  const executed: string[] = [];
  let staged = 0;
  const answer = await runAgent(
    [{ role: "user", content: "帮我把准备 Python 面试这个任务拆解一下" }],
    {
      async createCompletion() {
        calls += 1;
        return calls === 1
          ? tool("find", "listTasks", "{}")
          : tool(
              "plan",
              "proposeSubtaskPlan",
              JSON.stringify({
                parentId: "parent",
                planName: "面试准备方案",
                items: [
                  {
                    number: 1,
                    title: "复习 Python 基础",
                    priority: "high",
                    effort: "medium",
                    dueDate: null,
                  },
                  {
                    number: 2,
                    title: "练习算法题",
                    priority: "high",
                    effort: "large",
                    dueDate: null,
                  },
                ],
              }),
            );
      },
      async executeTool(name) {
        executed.push(name);
        return {
          ok: true,
          status: 200,
          data: [task({ id: "parent", title: "准备 Python 面试" })],
        };
      },
      stagePlan(parent, proposal) {
        staged += 1;
        assert.equal(parent.id, "parent");
        assert.equal(proposal.items.length, 2);
        return "结构化方案 A 已保存，尚未创建子任务。";
      },
    },
  );
  assert.deepEqual(executed, ["listTasks"]);
  assert.equal(staged, 1);
  assert.match(answer, /尚未创建/);
});

test("AI 拆解无工具依据的虚假创建声明会被拦截", async () => {
  let calls = 0;
  const executed: string[] = [];
  const answer = await runAgent([{ role: "user", content: "把准备面试拆解一下" }], {
    async createCompletion() {
      calls += 1;
      return calls === 1 ? tool("find", "listTasks", "{}") : text("已创建两个子任务。");
    },
    async executeTool(name) {
      executed.push(name);
      return { ok: true, status: 200, data: [task({ id: "parent", title: "准备面试" })] };
    },
  });
  assert.deepEqual(executed, ["listTasks"]);
  assert.match(answer, /未创建任何子任务/);
});

test("AI 拆解阶段模型擅自调用 createTask 会被拒绝", async () => {
  let calls = 0;
  const executed: string[] = [];
  const answer = await runAgent([{ role: "user", content: "把准备面试拆解一下" }], {
    async createCompletion() {
      calls += 1;
      if (calls === 1) return tool("find", "listTasks", "{}");
      if (calls === 2)
        return tool("unauthorized", "createTask", '{"title":"复习基础","parentId":"parent"}');
      return text("已创建");
    },
    async executeTool(name) {
      executed.push(name);
      return { ok: true, status: 200, data: [task({ id: "parent", title: "准备面试" })] };
    },
  });
  assert.deepEqual(executed, ["listTasks"]);
  assert.match(answer, /没有授权.*拒绝执行/);
});

test("推荐排序确定、可解释、稳定且不修改任务", () => {
  const tasks = [
    task({ id: "parent", title: "项目", priority: "high", effort: "large" }),
    task({
      id: "child",
      title: "项目第一步",
      parentId: "parent",
      priority: "low",
      effort: "small",
    }),
    task({
      id: "overdue",
      title: "逾期任务",
      dueDate: "2026-11-26",
      priority: "low",
      effort: "large",
    }),
    task({
      id: "today-high",
      title: "今天高优先",
      dueDate: "2026-11-27",
      priority: "high",
      effort: "large",
    }),
    task({
      id: "today-small",
      title: "今天小任务",
      dueDate: "2026-11-27",
      priority: "medium",
      effort: "small",
    }),
    task({ id: "high-small", title: "高优先小任务", priority: "high", effort: "small" }),
    task({ id: "done", title: "已完成", done: true, dueDate: "2026-11-20" }),
  ];
  const before = structuredClone(tasks);
  const ranked = recommendTasks(tasks, "2026-11-27");
  assert.deepEqual(
    ranked.map(({ task: item }) => item.id),
    ["overdue", "today-high", "today-small", "high-small", "child"],
  );
  assert.equal(
    ranked.some(({ task: item }) => item.id === "parent"),
    false,
  );
  assert.equal(ranked.find(({ task: item }) => item.id === "child")?.parentTitle, "项目");
  assert.deepEqual(tasks, before);
});

test("智能推荐只查询真实数据并使用程序排序结果", async () => {
  let calls = 0;
  const executed: string[] = [];
  const answer = await runAgent([{ role: "user", content: "我今天应该先做什么？" }], {
    now: () => new Date("2026-11-27T04:00:00.000Z"),
    async createCompletion() {
      calls += 1;
      return calls === 1 ? tool("recommend-list", "listTasks", "{}") : text("先做虚构任务");
    },
    async executeTool(name) {
      executed.push(name);
      return {
        ok: true,
        status: 200,
        data: [
          task({ id: "later", title: "以后任务", priority: "high", effort: "small" }),
          task({ id: "overdue", title: "逾期真实任务", dueDate: "2026-11-26", priority: "low" }),
        ],
      };
    },
  });
  assert.deepEqual(executed, ["listTasks"]);
  assert.match(answer, /1\. 逾期真实任务/);
  assert.match(answer, /依据：已逾期/);
  assert.doesNotMatch(answer, /虚构任务/);
});

test("任务清单展示父子树和完成进度", async () => {
  let calls = 0;
  const answer = await runAgent([{ role: "user", content: "看看任务清单" }], {
    async createCompletion() {
      calls += 1;
      return calls === 1 ? tool("list-tree", "listTasks", "{}") : text("ignored");
    },
    async executeTool() {
      return {
        ok: true,
        status: 200,
        data: [
          task({ id: "parent", title: "准备面试" }),
          task({ id: "one", title: "复习基础", parentId: "parent", done: true }),
          task({ id: "two", title: "模拟面试", parentId: "parent" }),
        ],
      };
    },
  });
  assert.match(answer, /准备面试 · 子任务 1\/2/);
  assert.match(answer, /↳ ✓ 复习基础/);
  assert.match(answer, /↳ ○ 模拟面试/);
});
