import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
} from "openai/resources/chat/completions";
import type { ChatMessage } from "../shared/chat.ts";
import { runAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import type { ConfirmationProposal } from "./confirmation.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { createTaskToolExecutor } from "./task-tools.ts";

function completion(message: ChatCompletionMessage): ChatCompletion {
  return {
    id: "mock-completion",
    object: "chat.completion",
    created: 0,
    model: "mock-model",
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

function text(content: string): ChatCompletion {
  return completion({ role: "assistant", content, refusal: null });
}

function tool(id: string, name: string, argumentsJson: string): ChatCompletion {
  return completion({
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: argumentsJson } }],
  });
}

function truncated(content: string): ChatCompletion {
  const response = text(content);
  response.choices[0]!.finish_reason = "length";
  return response;
}

async function startTaskApi(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-mock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = createJsonTaskStore(join(directory, "tasks.json"));
  const app = createApp({ tasks, reply: async () => "unused" });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { tasks, executeTool: createTaskToolExecutor(`http://127.0.0.1:${port}`) };
}

function scriptedAgent(
  executeTool: ReturnType<typeof createTaskToolExecutor>,
  responses: Array<
    ChatCompletion | ((request: ChatCompletionCreateParamsNonStreaming) => ChatCompletion)
  >,
) {
  let index = 0;
  return (messages: ChatMessage[]) =>
    runAgent(messages, {
      executeTool,
      async createCompletion(request, timeoutMs) {
        assert.equal(timeoutMs, 30_000);
        assert.equal(request.max_tokens, 800);
        assert.equal(request.tool_choice, "auto");
        assert.deepEqual("thinking" in request ? request.thinking : undefined, {
          type: "disabled",
        });
        assert.equal(request.tools?.length, 5);
        const next = responses[index++];
        assert.ok(next, "Mock 响应数量不足");
        return typeof next === "function" ? next(request) : next;
      },
    });
}

function toolData(request: ChatCompletionCreateParamsNonStreaming) {
  const message = request.messages.at(-1);
  assert.equal(message?.role, "tool");
  assert.ok(typeof message.content === "string");
  return JSON.parse(message.content);
}

test("Mock 模型完成 README 官方六步验收对话", async (t) => {
  const { tasks, executeTool } = await startTaskApi(t);
  const history: ChatMessage[] = [];

  async function converse(user: string, responses: Parameters<typeof scriptedAgent>[1]) {
    history.push({ role: "user", content: user });
    const answer = await scriptedAgent(executeTool, responses)(history);
    history.push({ role: "assistant", content: answer });
    return answer;
  }

  await converse("帮我记一下买牛奶。", [
    tool("create-milk", "createTask", JSON.stringify({ title: "买牛奶" })),
    text("已记录待办“买牛奶”。"),
  ]);
  await converse("再记一条取快递。", [
    tool("create-package", "createTask", JSON.stringify({ title: "取快递" })),
    text("已记录待办“取快递”。"),
  ]);
  const listed = await converse("我有哪些任务？", [
    tool("list-1", "listTasks", "{}"),
    (request) => {
      assert.equal(toolData(request).data.length, 2);
      return text("1. 买牛奶（未完成）\n2. 取快递（未完成）");
    },
  ]);
  assert.match(listed, /未完成（2）/);
  assert.match(listed, /买牛奶/);
  assert.match(listed, /取快递/);

  await converse("牛奶买好了。", [
    tool("find-milk", "listTasks", "{}"),
    (request) => {
      const milk = toolData(request).data.find(
        (item: { title: string }) => item.title === "买牛奶",
      );
      return tool("finish-milk", "updateTask", JSON.stringify({ id: milk.id, done: true }));
    },
    text("已将“买牛奶”标记为完成。"),
  ]);
  await converse("取快递这条删掉吧。", [
    tool("find-package", "listTasks", "{}"),
    (request) => {
      const parcel = toolData(request).data.find(
        (item: { title: string }) => item.title === "取快递",
      );
      return tool("delete-package", "deleteTask", JSON.stringify({ id: parcel.id }));
    },
    (request) => {
      const result = toolData(request);
      assert.deepEqual(result, { ok: true, status: 204 });
      return text("已删除“取快递”。");
    },
  ]);
  const finalList = await converse("再给我看看清单。", [
    tool("list-2", "listTasks", "{}"),
    (request) => {
      assert.deepEqual(toolData(request).data, tasks.list());
      return text("1. 买牛奶（已完成）");
    },
  ]);

  assert.match(finalList, /已完成（1）/);
  assert.match(finalList, /买牛奶/);
  assert.deepEqual(
    tasks.list().map(({ title, done }) => ({ title, done })),
    [{ title: "买牛奶", done: true }],
  );
});

test("工具执行器处理空列表、非法参数、未知工具和不存在任务", async (t) => {
  const { executeTool } = await startTaskApi(t);
  assert.deepEqual(await executeTool("listTasks", "{}"), { ok: true, status: 200, data: [] });

  const invalidJson = await executeTool("createTask", "not-json");
  assert.equal(invalidJson.ok, false);
  assert.match(invalidJson.error ?? "", /工具执行失败/);

  const invalidArguments = await executeTool("updateTask", JSON.stringify({ id: "x" }));
  assert.equal(invalidArguments.ok, false);
  assert.match(invalidArguments.error ?? "", /工具参数不合法/);

  assert.deepEqual(await executeTool("deleteTask", JSON.stringify({ id: "missing" })), {
    ok: false,
    status: 404,
    error: "找不到这条任务。",
  });
  assert.deepEqual(await executeTool("runCode", "{}"), {
    ok: false,
    error: "未知工具：runCode",
  });
});

test("同名任务时模型可先查询再要求确认，不执行修改", async (t) => {
  const { tasks, executeTool } = await startTaskApi(t);
  tasks.create("买牛奶");
  tasks.create("买牛奶");
  const answer = await scriptedAgent(executeTool, [
    tool("find-duplicates", "listTasks", "{}"),
    (request) => {
      assert.equal(toolData(request).data.length, 2);
      return text("有两条同名的“买牛奶”，请说明要修改哪一条。");
    },
  ])([{ role: "user", content: "牛奶买好了" }]);

  assert.match(answer, /两条同名/);
  assert.equal(
    tasks.list().every((item) => !item.done),
    true,
  );
});

test("保留多轮历史，正确关联 tool_call_id，并限制工具循环次数", async () => {
  const requests: ChatCompletionCreateParamsNonStreaming[] = [];
  const toolCallIds: string[] = [];
  let calls = 0;
  const answer = await runAgent(
    [
      { role: "user", content: "记一下买牛奶" },
      { role: "assistant", content: "已记录。" },
      { role: "user", content: "把它完成" },
    ],
    {
      async createCompletion(request) {
        requests.push(request);
        calls += 1;
        return tool(`call-${calls}`, "listTasks", "{}");
      },
      async executeTool(_name, _arguments) {
        return { ok: true, status: 200, data: [] };
      },
    },
  );

  for (const request of requests.slice(1)) {
    const last = request.messages.at(-1);
    assert.equal(last?.role, "tool");
    if (last?.role === "tool") toolCallIds.push(last.tool_call_id);
  }
  assert.deepEqual(toolCallIds, ["call-1", "call-2", "call-3", "call-4", "call-5"]);
  assert.equal(calls, 6);
  assert.match(answer, /步骤过多/);
  assert.deepEqual(requests[0]?.messages.slice(1, 4), [
    { role: "user", content: "记一下买牛奶" },
    { role: "assistant", content: "已记录。" },
    { role: "user", content: "把它完成" },
  ]);
});

test("模型 API 在工具执行前失败时明确说明没有任务操作", async () => {
  const answer = await runAgent([{ role: "user", content: "你好" }], {
    async createCompletion() {
      throw new Error("mock model unavailable");
    },
    async executeTool() {
      return { ok: true };
    },
  });
  assert.match(answer, /没有执行任何任务操作/);
});

test("工具成功后模型失败时提示先查询，避免重复操作", async () => {
  let calls = 0;
  const answer = await runAgent([{ role: "user", content: "记一下买牛奶" }], {
    async createCompletion() {
      calls += 1;
      if (calls === 1) return tool("created-before-failure", "createTask", '{"title":"买牛奶"}');
      throw new Error("mock model unavailable");
    },
    async executeTool() {
      return { ok: true, status: 201, data: { id: "real-id", title: "买牛奶", done: false } };
    },
  });
  assert.match(answer, /已经成功执行了 1 次操作/);
  assert.match(answer, /不要直接重试/);
});

test("模型未调用工具却声称操作成功时强制重新选择工具", async () => {
  let calls = 0;
  const executed: string[] = [];
  const answer = await runAgent([{ role: "user", content: "取快递这条删掉吧" }], {
    async createCompletion(request) {
      calls += 1;
      if (calls === 1) return text("已删除取快递");
      if (calls === 2) {
        assert.equal(request.messages.at(-1)?.role, "system");
        return tool("forced-list", "listTasks", "{}");
      }
      if (calls === 3) return tool("forced-delete", "deleteTask", '{"id":"real-id"}');
      return text("已删除取快递");
    },
    async executeTool(name) {
      executed.push(name);
      return name === "listTasks"
        ? { ok: true, status: 200, data: [{ id: "real-id", title: "取快递", done: false }] }
        : { ok: true, status: 204 };
    },
  });
  assert.deepEqual(executed, ["listTasks", "deleteTask"]);
  assert.equal(answer, "已删除取快递");
});

test("模型经提醒仍不调用工具时不会返回虚假成功", async () => {
  const answer = await runAgent([{ role: "user", content: "帮我记一下买牛奶" }], {
    async createCompletion() {
      return text("已记录买牛奶");
    },
    async executeTool() {
      throw new Error("不应执行");
    },
  });
  assert.match(answer, /本次没有执行任务变更/);
});

test("工具网络异常作为失败结果反馈给模型", async () => {
  const executeTool = createTaskToolExecutor("http://127.0.0.1:1", 100);
  const answer = await scriptedAgent(executeTool, [
    tool("network-error", "listTasks", "{}"),
    (request) => {
      const result = toolData(request);
      assert.equal(result.ok, false);
      assert.match(result.error, /工具执行失败/);
      return text("任务服务暂时不可用，请稍后重试。");
    },
  ])([{ role: "user", content: "列出任务" }]);
  assert.match(answer, /无法取得真实任务清单/);
});

test("重新创建任务存储后仍能读取之前保存的任务", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-persistence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  createJsonTaskStore(filename).create("服务重启后保留");

  const restartedStore = createJsonTaskStore(filename);
  assert.deepEqual(
    restartedStore.list().map(({ title, done }) => ({ title, done })),
    [{ title: "服务重启后保留", done: false }],
  );
});

test("变更工具失败后覆盖模型的虚假成功回复", async () => {
  let executions = 0;
  const answer = await runAgent([{ role: "user", content: "帮我记一下买牛奶" }], {
    async createCompletion(request) {
      return request.messages.at(-1)?.role === "tool"
        ? text("已经记下买牛奶")
        : tool("failed-create", "createTask", '{"title":"买牛奶"}');
    },
    async executeTool() {
      executions += 1;
      return { ok: false, status: 400, error: "标题无效" };
    },
  });
  assert.equal(executions, 1);
  assert.match(answer, /没有成功.*标题无效/s);
  assert.doesNotMatch(answer, /已经记下/);
});

test("当前清单查询没有调用工具时强制重新查询", async () => {
  let calls = 0;
  let executions = 0;
  const answer = await runAgent([{ role: "user", content: "再给我看看清单" }], {
    async createCompletion(request) {
      calls += 1;
      if (calls === 1) return text("根据之前对话，清单是空的");
      if (calls === 2) {
        assert.equal(request.messages.at(-1)?.role, "system");
        return tool("forced-query", "listTasks", "{}");
      }
      return text("真实清单有买牛奶");
    },
    async executeTool() {
      executions += 1;
      return {
        ok: true,
        status: 200,
        data: [{ id: "milk-id", title: "买牛奶", done: false }],
      };
    },
  });
  assert.equal(executions, 1);
  assert.match(answer, /未完成（1）/);
  assert.match(answer, /买牛奶/);
});

test("当前清单查询经提醒仍不调用工具时拒绝猜测", async () => {
  const answer = await runAgent([{ role: "user", content: "我有哪些任务？" }], {
    async createCompletion() {
      return text("你有一条虚构任务");
    },
    async executeTool() {
      throw new Error("不应执行");
    },
  });
  assert.match(answer, /无法确认当前清单/);
  assert.doesNotMatch(answer, /虚构任务/);
});

test("修改和删除只能使用本轮查询返回的真实 ID", async () => {
  let calls = 0;
  const executed: string[] = [];
  const answer = await runAgent([{ role: "user", content: "取快递这条删掉吧" }], {
    async createCompletion() {
      calls += 1;
      if (calls === 1) return tool("list-real", "listTasks", "{}");
      if (calls === 2) return tool("delete-fake", "deleteTask", '{"id":"invented-id"}');
      return text("已删除取快递");
    },
    async executeTool(name) {
      executed.push(name);
      return {
        ok: true,
        status: 200,
        data: [{ id: "real-id", title: "取快递", done: false }],
      };
    },
  });
  assert.deepEqual(executed, ["listTasks"]);
  assert.match(answer, /目标 ID 不在本轮真实任务查询结果/);
});

test("程序层拒绝模型对同名任务的擅自选择", async () => {
  let calls = 0;
  const executed: string[] = [];
  const answer = await runAgent([{ role: "user", content: "买牛奶这条删掉吧" }], {
    async createCompletion() {
      calls += 1;
      if (calls === 1) return tool("list-same", "listTasks", "{}");
      if (calls === 2) return tool("delete-one", "deleteTask", '{"id":"first"}');
      return text("已删除第一条");
    },
    async executeTool(name) {
      executed.push(name);
      return {
        ok: true,
        status: 200,
        data: [
          { id: "first", title: "买牛奶", done: false },
          { id: "second", title: "买牛奶", done: false },
        ],
      };
    },
  });
  assert.deepEqual(executed, ["listTasks"]);
  assert.match(answer, /2 条同名任务/);
});

test("用户用序号明确同名任务后允许操作对应查询 ID", async () => {
  let calls = 0;
  const executed: string[] = [];
  const answer = await runAgent([{ role: "user", content: "请删除第二条吧" }], {
    async createCompletion() {
      calls += 1;
      if (calls === 1) return tool("list-same", "listTasks", "{}");
      if (calls === 2) return tool("delete-second", "deleteTask", '{"id":"second"}');
      return text("已删除第二条买牛奶");
    },
    async executeTool(name) {
      executed.push(name);
      return name === "listTasks"
        ? {
            ok: true,
            status: 200,
            data: [
              { id: "first", title: "买牛奶", done: false },
              { id: "second", title: "买牛奶", done: false },
            ],
          }
        : { ok: true, status: 204 };
    },
  });
  assert.deepEqual(executed, ["listTasks", "deleteTask"]);
  assert.equal(answer, "已删除第二条买牛奶");
});

test("多任务下的模糊指代不能授权模型任意选择 ID", async () => {
  let calls = 0;
  const executed: string[] = [];
  const answer = await runAgent([{ role: "user", content: "把它删除掉吧" }], {
    async createCompletion() {
      calls += 1;
      if (calls === 1) return tool("list-many", "listTasks", "{}");
      if (calls === 2) return tool("delete-guessed", "deleteTask", '{"id":"a"}');
      return text("已删除");
    },
    async executeTool(name) {
      executed.push(name);
      return {
        ok: true,
        status: 200,
        data: [
          { id: "a", title: "买牛奶", done: false },
          { id: "b", title: "取快递", done: false },
        ],
      };
    },
  });
  assert.deepEqual(executed, ["listTasks"]);
  assert.match(answer, /指代可能对应多条任务/);
});

test("否定指令、教程问题和普通聊天不会授权模型变更", async () => {
  for (const content of [
    "不要删除取快递",
    "如何删除任务？",
    "改名功能怎么用？",
    "我把本地文件删除了",
  ]) {
    let executions = 0;
    let calls = 0;
    const answer = await runAgent([{ role: "user", content }], {
      async createCompletion() {
        calls += 1;
        return calls === 1
          ? tool("unauthorized", "deleteTask", '{"id":"anything"}')
          : text("已删除");
      },
      async executeTool() {
        executions += 1;
        return { ok: true, status: 204 };
      },
    });
    assert.equal(executions, 0, content);
    assert.match(answer, /拒绝执行|没有本轮成功查询/, content);
  }
});

test("否定查询、能力询问和任务管理建议不会触发清单查询", async () => {
  for (const content of ["不要查看清单", "你能查看任务清单吗？", "有哪些任务管理建议？"]) {
    let executions = 0;
    let calls = 0;
    const answer = await runAgent([{ role: "user", content }], {
      async createCompletion() {
        calls += 1;
        return calls === 1 ? tool("unwanted-list", "listTasks", "{}") : text("普通回答");
      },
      async executeTool() {
        executions += 1;
        return { ok: true, status: 200, data: [] };
      },
    });
    assert.equal(executions, 0, content);
    assert.match(answer, /拒绝模型擅自查询清单/, content);
  }
});

test("创建标题中的操作词只作为数据，不改变授权类型", async () => {
  const executed: string[] = [];
  let calls = 0;
  const answer = await runAgent([{ role: "user", content: "帮我记一下删除旧文件" }], {
    async createCompletion() {
      calls += 1;
      return calls === 1
        ? tool("create-data", "createTask", '{"title":"删除旧文件"}')
        : text("已记录删除旧文件");
    },
    async executeTool(name) {
      executed.push(name);
      return { ok: true, status: 201, data: { id: "new", title: "删除旧文件", done: false } };
    },
  });
  assert.deepEqual(executed, ["createTask"]);
  assert.equal(answer, "已记录删除旧文件");
});

test("创建标题中的否定句仍作为数据处理", async () => {
  let executions = 0;
  let calls = 0;
  const answer = await runAgent([{ role: "user", content: "帮我记一下不要删除旧文件" }], {
    async createCompletion() {
      calls += 1;
      return calls === 1
        ? tool("create-negated-title", "createTask", '{"title":"不要删除旧文件"}')
        : text("已记录");
    },
    async executeTool() {
      executions += 1;
      return {
        ok: true,
        status: 201,
        data: { id: "new", title: "不要删除旧文件", done: false },
      };
    },
  });
  assert.equal(executions, 1);
  assert.equal(answer, "已记录");
});

test("模型输出截断时不执行截断响应中的工具", async () => {
  let executions = 0;
  const cutOff = tool("cut-off", "createTask", '{"title":"买牛奶"}');
  cutOff.choices[0]!.finish_reason = "length";
  const answer = await runAgent([{ role: "user", content: "帮我记一下买牛奶" }], {
    async createCompletion() {
      return cutOff;
    },
    async executeTool() {
      executions += 1;
      return { ok: true };
    },
  });
  assert.equal(executions, 0);
  assert.match(answer, /回复被截断.*没有执行任务变更/s);
});

test("工具超时后不重试变更且不声称失败或成功", async () => {
  let calls = 0;
  let executions = 0;
  const answer = await runAgent([{ role: "user", content: "帮我记一下买牛奶" }], {
    async createCompletion() {
      calls += 1;
      return calls === 1
        ? tool("timeout-create", "createTask", '{"title":"买牛奶"}')
        : text("已经记下买牛奶");
    },
    async executeTool() {
      executions += 1;
      return { ok: false, error: "工具执行失败：请求超时" };
    },
  });
  assert.equal(executions, 1);
  assert.match(answer, /无法确认任务操作是否生效/);
  assert.match(answer, /不要直接重复操作/);
});

test("每轮最多执行一次变更并保留已成功事实", async () => {
  let calls = 0;
  let executions = 0;
  const doubleCreate = completion({
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [
      {
        id: "first",
        type: "function",
        function: { name: "createTask", arguments: '{"title":"一"}' },
      },
      {
        id: "second",
        type: "function",
        function: { name: "createTask", arguments: '{"title":"二"}' },
      },
    ],
  });
  const answer = await runAgent([{ role: "user", content: "帮我记一下任务一" }], {
    async createCompletion() {
      calls += 1;
      return calls === 1 ? doubleCreate : text("两条都创建成功");
    },
    async executeTool() {
      executions += 1;
      return { ok: true, status: 201, data: { id: "one", title: "一", done: false } };
    },
  });
  assert.equal(executions, 1);
  assert.match(answer, /已成功执行 1 次/);
  assert.match(answer, /最多执行一次/);
});

test("单个任务的多个创建属性通过一次 createTask 完整提交", async () => {
  let calls = 0;
  const executions: Array<[string, Record<string, unknown>]> = [];
  const argumentsJson = JSON.stringify({
    title: "论文写作",
    priority: "high",
    effort: "large",
    dueDate: "2026-11-28",
    estimatedMinutes: 240,
  });
  const answer = await runAgent(
    [
      {
        role: "user",
        content: "帮我创建一个今天到期的论文写作任务，高优先级，大工作量，预计需要4小时。",
      },
    ],
    {
      now: () => new Date("2026-11-28T04:00:00.000Z"),
      async createCompletion() {
        calls += 1;
        return calls === 1 ? tool("create", "createTask", argumentsJson) : text("已创建论文写作任务");
      },
      async executeTool(name, rawArguments) {
        executions.push([name, JSON.parse(rawArguments) as Record<string, unknown>]);
        return { ok: true, status: 201, data: { id: "paper", ...JSON.parse(rawArguments), done: false } };
      },
    },
  );
  assert.deepEqual(executions, [["createTask", JSON.parse(argumentsJson)]]);
  assert.match(answer, /已创建/);
});

test("同一任务的多个修改属性通过一次 updateTask 完整提交", async () => {
  let calls = 0;
  const executions: Array<[string, Record<string, unknown>]> = [];
  const current = {
    id: "interview",
    title: "面试准备",
    done: false,
    priority: "medium",
    effort: "medium",
    dueDate: "2026-11-28",
    parentId: null,
    estimatedMinutes: 60,
  };
  const answer = await runAgent(
    [{ role: "user", content: "将面试准备任务改为高优先级、大工作量、预计2小时。" }],
    {
      async createCompletion() {
        calls += 1;
        if (calls === 1) return tool("list", "listTasks", "{}");
        if (calls === 2)
          return tool(
            "update",
            "updateTask",
            '{"id":"interview","priority":"high","effort":"large","estimatedMinutes":120}',
          );
        return text("已更新面试准备任务");
      },
      async executeTool(name, rawArguments) {
        const parsed = JSON.parse(rawArguments) as Record<string, unknown>;
        executions.push([name, parsed]);
        return name === "listTasks"
          ? { ok: true, status: 200, data: [current] }
          : { ok: true, status: 200, data: { ...current, ...parsed } };
      },
    },
  );
  assert.deepEqual(executions.map(([name]) => name), ["listTasks", "updateTask"]);
  assert.deepEqual(executions[1]?.[1], {
    id: "interview",
    priority: "high",
    effort: "large",
    estimatedMinutes: 120,
  });
  assert.match(answer, /已更新/);
});

test("完整创建成功后的重复补充调用被拒绝且回复保留部分成功事实", async () => {
  let calls = 0;
  let executions = 0;
  const answer = await runAgent([{ role: "user", content: "创建论文写作，高优先级，大工作量" }], {
    async createCompletion() {
      calls += 1;
      if (calls > 1) return text("全部操作都失败了");
      return completion({
        role: "assistant",
        content: null,
        refusal: null,
        tool_calls: [
          {
            id: "create",
            type: "function",
            function: {
              name: "createTask",
              arguments: '{"title":"论文写作","priority":"high","effort":"large"}',
            },
          },
          {
            id: "redundant-update",
            type: "function",
            function: { name: "updateTask", arguments: '{"id":"invented","effort":"large"}' },
          },
        ],
      });
    },
    async executeTool() {
      executions += 1;
      return { ok: true, status: 201, data: { id: "paper", title: "论文写作", done: false } };
    },
  });
  assert.equal(executions, 1);
  assert.match(answer, /已成功执行 1 次/);
  assert.match(answer, /最多执行一次/);
  assert.doesNotMatch(answer, /本次没有执行|全部操作都失败/);
});

test("工具成功后最终模型回复截断时准确保留成功事实", async () => {
  let calls = 0;
  const answer = await runAgent([{ role: "user", content: "帮我记一下买牛奶" }], {
    async createCompletion() {
      calls += 1;
      return calls === 1
        ? tool("created", "createTask", '{"title":"买牛奶"}')
        : truncated("已经记下");
    },
    async executeTool() {
      return { ok: true, status: 201, data: { id: "milk", title: "买牛奶", done: false } };
    },
  });
  assert.match(answer, /已经成功执行了 1 次操作/);
  assert.match(answer, /回复被截断/);
});

test("工具结果不确定后模型失败时保留不确定事实", async () => {
  let calls = 0;
  const answer = await runAgent([{ role: "user", content: "帮我记一下买牛奶" }], {
    async createCompletion() {
      calls += 1;
      if (calls === 1) return tool("uncertain", "createTask", '{"title":"买牛奶"}');
      throw new Error("model unavailable");
    },
    async executeTool() {
      return { ok: false, error: "工具执行失败：请求超时" };
    },
  });
  assert.match(answer, /无法确认之前的任务操作是否生效/);
  assert.match(answer, /不要直接重复操作/);
});

test("模型选择了查询结果中的错误任务时仍拒绝执行", async () => {
  let calls = 0;
  const executed: string[] = [];
  const answer = await runAgent([{ role: "user", content: "取快递这条删掉吧" }], {
    async createCompletion() {
      calls += 1;
      if (calls === 1) return tool("list", "listTasks", "{}");
      if (calls === 2) return tool("wrong-target", "deleteTask", '{"id":"milk"}');
      return text("已删除取快递");
    },
    async executeTool(name) {
      executed.push(name);
      return {
        ok: true,
        status: 200,
        data: [
          { id: "milk", title: "买牛奶", done: false },
          { id: "parcel", title: "取快递", done: false },
        ],
      };
    },
  });
  assert.deepEqual(executed, ["listTasks"]);
  assert.match(answer, /与用户消息中明确提到的任务不一致/);
});

test("普通聊天中模型无工具依据的任务成功描述被拦截", async () => {
  const answer = await runAgent([{ role: "user", content: "你好" }], {
    async createCompletion() {
      return text("已删除你的任务");
    },
    async executeTool() {
      throw new Error("不应执行");
    },
  });
  assert.match(answer, /没有执行任务变更/);
  assert.doesNotMatch(answer, /已删除你的任务/);
});

test("查询失败后模型重新查询成功会清除旧失败状态", async () => {
  let calls = 0;
  let executions = 0;
  const answer = await runAgent([{ role: "user", content: "我有哪些任务？" }], {
    async createCompletion() {
      calls += 1;
      if (calls === 1) return tool("failed-list", "listTasks", "{}");
      if (calls === 2) return tool("retry-list", "listTasks", "{}");
      return text("当前清单为空");
    },
    async executeTool() {
      executions += 1;
      return executions === 1
        ? { ok: false, status: 500, error: "暂时失败" }
        : { ok: true, status: 200, data: [] };
    },
  });
  assert.equal(executions, 2);
  assert.equal(answer, "当前任务清单为空。");
});

test("真实验收发现的自然语言语义可通过授权保护", async () => {
  const listedTask = {
    id: "materials",
    title: "整理资料",
    done: false,
    priority: "medium",
    effort: "medium",
    dueDate: null,
    parentId: null,
    estimatedMinutes: null,
    createdAt: null,
    completedAt: null,
    updatedAt: null,
  };

  for (const user of ["把整理资料放进我的待办。", "明天得去交材料，帮我记着。"]) {
    let calls = 0;
    let executions = 0;
    const answer = await runAgent([{ role: "user", content: user }], {
      now: () => new Date("2026-11-27T04:00:00.000Z"),
      async createCompletion() {
        calls += 1;
        return calls === 1
          ? tool(
              "create",
              "createTask",
              user.includes("明天")
                ? '{"title":"测试任务","dueDate":"2026-11-28"}'
                : '{"title":"测试任务"}',
            )
          : text("已创建测试任务");
      },
      async executeTool(name) {
        assert.equal(name, "createTask");
        executions += 1;
        return { ok: true, status: 201, data: listedTask };
      },
    });
    assert.equal(executions, 1);
    assert.match(answer, /已创建/);
  }

  let updateCalls = 0;
  const updateTools: string[] = [];
  await runAgent([{ role: "user", content: "我已经把资料整理完了。" }], {
    async createCompletion() {
      updateCalls += 1;
      if (updateCalls === 1) return tool("list", "listTasks", "{}");
      if (updateCalls === 2) return tool("update", "updateTask", '{"id":"materials","done":true}');
      return text("已完成");
    },
    async executeTool(name) {
      updateTools.push(name);
      return name === "listTasks"
        ? { ok: true, status: 200, data: [listedTask] }
        : { ok: true, status: 200, data: { ...listedTask, done: true } };
    },
  });
  assert.deepEqual(updateTools, ["listTasks", "updateTask"]);

  let queryCalls = 0;
  const queryTools: string[] = [];
  const queryAnswer = await runAgent([{ role: "user", content: "清单里还有什么没做？" }], {
    async createCompletion() {
      queryCalls += 1;
      return queryCalls === 1 ? tool("list", "listTasks", "{}") : text("模型清单");
    },
    async executeTool(name) {
      queryTools.push(name);
      return { ok: true, status: 200, data: [listedTask] };
    },
  });
  assert.deepEqual(queryTools, ["listTasks"]);
  assert.match(queryAnswer, /整理资料/);
});

test("明确创建请求遇到模型虚假确认时会纠正并实际调用工具", async () => {
  let modelCalls = 0;
  let toolCalls = 0;
  const answer = await runAgent([{ role: "user", content: "帮我记一下买牛奶" }], {
    async createCompletion() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return text("任务名称：买牛奶。确认创建吗？回复“确认创建”即可。");
      }
      if (modelCalls === 2) return tool("create-milk", "createTask", '{"title":"买牛奶"}');
      return text("已创建任务“买牛奶”。");
    },
    async executeTool(name, rawArguments) {
      toolCalls += 1;
      assert.equal(name, "createTask");
      assert.deepEqual(JSON.parse(rawArguments), { title: "买牛奶" });
      return {
        ok: true,
        status: 201,
        data: { id: "milk", title: "买牛奶", done: false },
      };
    },
  });
  assert.equal(modelCalls, 3);
  assert.equal(toolCalls, 1);
  assert.match(answer, /已创建.*买牛奶/);
  assert.doesNotMatch(answer, /确认创建吗/);
});

test("未实现的批量删除会准确拒绝且不会调用模型或工具", async () => {
  for (const content of [
    "删除全部任务",
    "删除全部已完成任务",
    "删除准备面试，和闺蜜逛街，准备考六级，准备雅思这四项任务",
  ]) {
    let modelCalls = 0;
    let toolCalls = 0;
    const answer = await runAgent([{ role: "user", content }], {
      async createCompletion() {
        modelCalls += 1;
        return text("不应调用模型");
      },
      async executeTool() {
        toolCalls += 1;
        return { ok: true };
      },
    });
    assert.match(answer, /暂不支持受控批量删除.*没有删除任何任务/s);
    assert.equal(modelCalls, 0);
    assert.equal(toolCalls, 0);
  }
});

test("自然语言子任务删除不会被历史方案分支劫持", async () => {
  const parent = {
    id: "cet-parent",
    title: "准备考六级",
    done: false,
    priority: "medium" as const,
    effort: "medium" as const,
    dueDate: null,
    parentId: null,
    estimatedMinutes: null,
    createdAt: null,
    completedAt: null,
    updatedAt: null,
  };
  const child = {
    ...parent,
    id: "reading-child",
    title: "完成近五年真题阅读专项练习",
    parentId: parent.id,
  };
  let modelCalls = 0;
  const executed: string[] = [];
  let proposal: ConfirmationProposal | undefined;
  const answer = await runAgent(
    [{ role: "user", content: "删除准备考六级中的完成近五年真题阅读专项练习任务" }],
    {
      async createCompletion() {
        modelCalls += 1;
        if (modelCalls === 1) return text("确认删除吗？回复“确认删除”即可。");
        if (modelCalls === 2) return tool("list", "listTasks", "{}");
        return tool("delete", "deleteTask", '{"id":"reading-child"}');
      },
      async executeTool(name) {
        executed.push(name);
        return { ok: true, status: 200, data: [parent, child] };
      },
      stageConfirmation(candidate) {
        proposal = candidate;
        return "服务端已建立删除确认";
      },
    },
  );
  assert.equal(answer, "服务端已建立删除确认");
  assert.deepEqual(executed, ["listTasks"]);
  assert.equal(proposal?.operation, "deleteTask");
  assert.equal(proposal?.parameters.id, child.id);
  assert.deepEqual(proposal?.expectedTasks, [child]);
});
