import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createApp } from "./app.ts";
import { createPendingConfirmationStore } from "./confirmation.ts";
import { createJsonTaskStore, TaskRuleError, type TaskStore } from "./task-store.ts";
import { createSubtaskPlanStore, subtaskPlanArgumentsSchema } from "./subtask-plans.ts";
import type { TaskToolExecutor } from "./task-tools.ts";

function makePlanItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `备考步骤${index + 1}`,
    priority: index < 2 ? ("high" as const) : ("medium" as const),
    effort: index % 2 === 0 ? ("small" as const) : ("medium" as const),
    dueDate: null,
    estimatedMinutes: null,
  }));
}

const planItems = makePlanItems(6);

function listExecutor(tasks: TaskStore): TaskToolExecutor {
  return async (name) =>
    name === "listTasks"
      ? { ok: true, status: 200, data: tasks.list() }
      : { ok: false, error: `测试中不应调用 ${name}` };
}

async function startPlanApi(
  t: TestContext,
  options: {
    now?: () => number;
    ttlMs?: number;
    confirmationTtlMs?: number;
    planTtlMs?: number;
    items?: typeof planItems;
    replyOverride?: Parameters<typeof createApp>[0]["reply"];
    unhandledReply?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-batch-plan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = createJsonTaskStore(join(directory, "tasks.json"));
  const parent = tasks.create("准备考六级");
  const confirmations = createPendingConfirmationStore(
    options.now,
    options.confirmationTtlMs ?? options.ttlMs,
  );
  const plans = createSubtaskPlanStore(options.now, options.planTtlMs ?? options.ttlMs);
  let replyCalls = 0;
  const app = createApp({
    tasks,
    confirmations,
    plans,
    executeTool: listExecutor(tasks),
    reply: async (messages, context) => {
      replyCalls += 1;
      if (options.replyOverride) return options.replyOverride(messages, context);
      const content = messages.at(-1)!.content;
      if (!/拆解|计划/u.test(content)) {
        return options.unhandledReply ?? "当前没有可选择的方案。";
      }
      return context.stagePlan(parent, {
        parentId: parent.id,
        planName: "六级备考计划",
        items: options.items ?? planItems,
      });
    },
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
  return { tasks, parent, chat, confirmations, plans, getReplyCalls: () => replyCalls };
}

test("生成方案和选择整个方案均不写入，确认后原子创建全部子任务", async (t) => {
  const { tasks, parent, chat } = await startPlanApi(t);
  const planned = await chat("帮我制定六级备考拆解计划");
  assert.match(planned.body.reply, /结构化方案 A/);
  assert.equal(tasks.list().filter((task) => task.parentId === parent.id).length, 0);

  const selected = await chat("A", planned.cookie);
  assert.match(selected.body.reply, /6 条子任务/);
  assert.equal(tasks.list().filter((task) => task.parentId === parent.id).length, 0);

  const confirmed = await chat("确认创建", planned.cookie);
  assert.match(confirmed.body.reply, /成功创建 6 条/);
  assert.equal(tasks.list().filter((task) => task.parentId === parent.id).length, 6);

  const repeated = await chat("确认创建", planned.cookie);
  assert.match(repeated.body.reply, /没有可确认/);
  assert.equal(tasks.list().filter((task) => task.parentId === parent.id).length, 6);
});

test("只创建第1、3、5项且未选中项保持未创建", async (t) => {
  const { tasks, parent, chat } = await startPlanApi(t);
  const planned = await chat("拆解六级备考");
  const selected = await chat("选择方案A的第1、3、5项", planned.cookie);
  assert.match(selected.body.reply, /3 条子任务/);
  assert.equal(tasks.list().length, 1);
  await chat("确认创建", planned.cookie);
  assert.deepEqual(
    tasks
      .list()
      .filter((task) => task.parentId === parent.id)
      .map((task) => task.title),
    ["备考步骤1", "备考步骤3", "备考步骤5"],
  );
});

test("排除第2项、全选和修改选择均使用服务端原方案", async (t) => {
  const { tasks, parent, chat } = await startPlanApi(t);
  const planned = await chat("制定计划");
  const excluded = await chat("第2项不要，其他都创建", planned.cookie);
  assert.match(excluded.body.reply, /5 条子任务/);

  await chat("全选", planned.cookie);
  const modified = await chat("只创建第1、3项", planned.cookie);
  assert.match(modified.body.reply, /2 条子任务/);
  await chat("确认创建", planned.cookie);
  assert.deepEqual(
    tasks
      .list()
      .filter((task) => task.parentId === parent.id)
      .map((task) => task.title),
    ["备考步骤1", "备考步骤3"],
  );
});

test("非法编号、空选择和不存在方案不会进入确认", async (t) => {
  const { tasks, chat } = await startPlanApi(t);
  const planned = await chat("制定计划");
  assert.match((await chat("只创建第9项", planned.cookie)).body.reply, /不存在第 9 项/);
  assert.match(
    (await chat("第1、2、3、4、5、6项不要，其他都创建", planned.cookie)).body.reply,
    /选择结果为空/,
  );
  assert.match((await chat("B", planned.cookie)).body.reply, /只有可执行方案 A/);
  assert.equal(tasks.list().length, 1);
});

test("取消、过期和跨会话方案均不能创建", async (t) => {
  let clock = 1_000;
  const { tasks, chat } = await startPlanApi(t, { now: () => clock, ttlMs: 100 });
  const cancelled = await chat("制定计划");
  assert.match((await chat("取消创建", cancelled.cookie)).body.reply, /已取消/);

  const cross = await chat("制定计划");
  assert.match((await chat("A")).body.reply, /当前没有可选择的方案/);

  clock += 101;
  assert.match((await chat("A", cross.cookie)).body.reply, /原结构化.*已过期/);
  assert.equal(tasks.list().length, 1);
});

test("明确确认表达均由程序直接执行且不再次调用模型", async (t) => {
  const commands = [
    "确认创建",
    "确定创建",
    "确认",
    "确定",
    "确认执行",
    "确定执行",
    "就按这个方案创建吧",
    "按照这个方案执行",
    "可以创建了",
    "同意创建",
    "  确定创建！  ",
  ];
  for (const command of commands) {
    await t.test(command.trim(), async (child) => {
      const { tasks, parent, chat, getReplyCalls } = await startPlanApi(child);
      const planned = await chat("制定计划");
      await chat("只创建第1项", planned.cookie);
      const callsBeforeConfirm = getReplyCalls();
      const confirmed = await chat(command, planned.cookie);
      assert.match(confirmed.body.reply, /成功创建 1 条/);
      assert.equal(getReplyCalls(), callsBeforeConfirm);
      assert.equal(tasks.list().filter((task) => task.parentId === parent.id).length, 1);
    });
  }
});

test("异常、错别字和不支持修改保留原选择，随后确定创建可恢复执行", async (t) => {
  const { tasks, parent, chat, confirmations, plans, getReplyCalls } = await startPlanApi(t);
  const planned = await chat("制定计划");
  await chat("A", planned.cookie);
  const pendingBefore = confirmations.peek(planned.cookie!.split("=")[1])!;
  const planBefore = plans.get(planned.cookie!.split("=")[1])!;
  const modelCalls = getReplyCalls();

  for (const content of ["确定创键", "不确认创建", "先不要创建", "我还没确定", "嗯嗯"]) {
    const response = await chat(content, planned.cookie);
    assert.match(response.body.reply, /仍然保留|保持不变/);
    assert.equal(tasks.list().length, 1);
  }
  const unsupported = await chat("把第2项优先级调整为高", planned.cookie);
  assert.match(unsupported.body.reply, /暂不支持.*仍然保留/s);
  const illegalNumber = await chat("只创建第9项", planned.cookie);
  assert.match(illegalNumber.body.reply, /不存在第 9 项.*仍然保留/s);
  assert.equal(getReplyCalls(), modelCalls);

  const sessionId = planned.cookie!.split("=")[1];
  const pendingAfter = confirmations.peek(sessionId)!;
  const planAfter = plans.get(sessionId)!;
  assert.equal(pendingAfter.id, pendingBefore.id);
  assert.equal(pendingAfter.expiresAt, pendingBefore.expiresAt);
  assert.deepEqual(pendingAfter.parameters, pendingBefore.parameters);
  assert.equal(planAfter.expiresAt, planBefore.expiresAt);
  assert.deepEqual(planAfter.selectedNumbers, [1, 2, 3, 4, 5, 6]);

  const confirmed = await chat("确定创建", planned.cookie);
  assert.match(confirmed.body.reply, /成功创建 6 条/);
  assert.equal(tasks.list().filter((task) => task.parentId === parent.id).length, 6);
  assert.equal(getReplyCalls(), modelCalls);

  const repeated = await chat("确定创建", planned.cookie);
  assert.match(repeated.body.reply, /没有可确认/);
  assert.equal(tasks.list().filter((task) => task.parentId === parent.id).length, 6);
  assert.equal(getReplyCalls(), modelCalls);
});

test("非法方案、编号和空选择不会覆盖原确认参数", async (t) => {
  const { tasks, parent, chat, confirmations } = await startPlanApi(t);
  const planned = await chat("制定计划");
  await chat("只创建第1、3、5项", planned.cookie);
  const sessionId = planned.cookie!.split("=")[1];
  const original = confirmations.peek(sessionId)!;

  for (const content of ["B", "只创建第9项", "第1、2、3、4、5、6项不要，其他都创建"]) {
    const response = await chat(content, planned.cookie);
    assert.match(response.body.reply, /仍然保留/);
    assert.equal(confirmations.peek(sessionId)?.id, original.id);
    assert.deepEqual(confirmations.peek(sessionId)?.parameters, original.parameters);
  }

  await chat("确定执行", planned.cookie);
  assert.deepEqual(
    tasks
      .list()
      .filter((task) => task.parentId === parent.id)
      .map((task) => task.title),
    ["备考步骤1", "备考步骤3", "备考步骤5"],
  );
});

test("异常输入不延长有效期，过期后不能恢复确认", async (t) => {
  let clock = 1_000;
  const { tasks, chat, confirmations } = await startPlanApi(t, {
    now: () => clock,
    ttlMs: 100,
  });
  const planned = await chat("制定计划");
  await chat("A", planned.cookie);
  const sessionId = planned.cookie!.split("=")[1];
  const expiresAt = confirmations.peek(sessionId)!.expiresAt;
  clock += 50;
  assert.match((await chat("确定创键", planned.cookie)).body.reply, /仍然保留/);
  assert.equal(confirmations.peek(sessionId)?.expiresAt, expiresAt);
  clock += 51;
  assert.match((await chat("确定创建", planned.cookie)).body.reply, /原结构化.*已过期/);
  assert.equal(tasks.list().length, 1);
});

test("等待确认时的新任务请求不会静默丢弃原方案", async (t) => {
  const { tasks, parent, chat, getReplyCalls } = await startPlanApi(t);
  const planned = await chat("制定计划");
  await chat("只创建第1项", planned.cookie);
  const modelCalls = getReplyCalls();
  const conflict = await chat("帮我记录取快递", planned.cookie);
  assert.match(conflict.body.reply, /尚未确认.*取消创建.*保持不变/s);
  assert.equal(getReplyCalls(), modelCalls);
  assert.equal(tasks.list().length, 1);

  await chat("确定创建", planned.cookie);
  assert.equal(tasks.list().filter((task) => task.parentId === parent.id).length, 1);
  assert.equal(
    tasks.list().some((task) => task.title === "取快递"),
    false,
  );
});

test("八项原方案支持分批创建并记录真实任务 ID", async (t) => {
  const { tasks, parent, chat, plans } = await startPlanApi(t, { items: makePlanItems(8) });
  const planned = await chat("制定八项六级计划");
  const sessionId = planned.cookie!.split("=")[1];

  await chat("只创建第1、3条", planned.cookie);
  assert.match((await chat("确认创建", planned.cookie)).body.reply, /成功创建 2 条/);
  const firstBatch = tasks.list().filter((task) => task.parentId === parent.id);
  assert.deepEqual(
    firstBatch.map((task) => task.title),
    ["备考步骤1", "备考步骤3"],
  );
  const recorded = plans.get(sessionId)!;
  assert.equal(recorded.createdItems[1]?.taskId, firstBatch[0]?.id);
  assert.equal(recorded.createdItems[3]?.taskId, firstBatch[1]?.id);

  const secondSelection = await chat("六级任务里的7、8再给我创建一下吧", planned.cookie);
  assert.match(secondSelection.body.reply, /2 条子任务/);
  assert.match(secondSelection.body.reply, /7\. 备考步骤7/);
  assert.match(secondSelection.body.reply, /8\. 备考步骤8/);
  assert.equal(tasks.list().filter((task) => task.parentId === parent.id).length, 2);

  assert.match((await chat("确认创建", planned.cookie)).body.reply, /成功创建 2 条/);
  assert.deepEqual(
    tasks
      .list()
      .filter((task) => task.parentId === parent.id)
      .map((task) => task.title),
    ["备考步骤1", "备考步骤3", "备考步骤7", "备考步骤8"],
  );
  const finalPlan = plans.get(sessionId)!;
  for (const number of [1, 3, 7, 8]) {
    const taskId = finalPlan.createdItems[number]?.taskId;
    assert.equal(
      tasks.list().some((task) => task.id === taskId),
      true,
    );
  }
  assert.match(
    (await chat("只创建第1、3条", planned.cookie)).body.reply,
    /已经创建.*没有建立新的待确认/s,
  );
  assert.equal(tasks.list().filter((task) => task.parentId === parent.id).length, 4);
});

test("待确认选择可以追加、排除，非法追加不会覆盖旧参数", async (t) => {
  const { tasks, parent, chat, confirmations } = await startPlanApi(t, {
    items: makePlanItems(8),
  });
  const planned = await chat("制定八项计划");
  const sessionId = planned.cookie!.split("=")[1];
  await chat("只创建第7条", planned.cookie);

  const added = await chat("还有第8个任务", planned.cookie);
  assert.match(added.body.reply, /2 条子任务/);
  assert.match(added.body.reply, /7\. 备考步骤7/);
  assert.match(added.body.reply, /8\. 备考步骤8/);

  await chat("只创建第7条", planned.cookie);
  assert.match((await chat("第8条也给我创建了", planned.cookie)).body.reply, /2 条子任务/);
  await chat("只创建第7条", planned.cookie);
  assert.match((await chat("把第8条也加进去", planned.cookie)).body.reply, /2 条子任务/);
  const pendingId = confirmations.peek(sessionId)!.id;

  assert.match(
    (await chat("还有第9个任务", planned.cookie)).body.reply,
    /不存在第 9 项.*仍然保留/s,
  );
  assert.equal(confirmations.peek(sessionId)?.id, pendingId);

  const replaced = await chat("第7条不要了，只创建第8条", planned.cookie);
  assert.match(replaced.body.reply, /1 条子任务/);
  assert.doesNotMatch(replaced.body.reply, /7\. 备考步骤7/);
  assert.match(replaced.body.reply, /8\. 备考步骤8/);
  await chat("确认创建", planned.cookie);
  assert.deepEqual(
    tasks
      .list()
      .filter((task) => task.parentId === parent.id)
      .map((task) => task.title),
    ["备考步骤8"],
  );
});

test("可以一次选择方案中所有尚未创建的条目", async (t) => {
  const { tasks, parent, chat } = await startPlanApi(t, { items: makePlanItems(8) });
  const planned = await chat("制定八项计划");
  await chat("只创建第1、3条", planned.cookie);
  await chat("确认创建", planned.cookie);

  const remaining = await chat("剩下还没有创建的任务全部创建", planned.cookie);
  assert.match(remaining.body.reply, /6 条子任务/);
  assert.doesNotMatch(remaining.body.reply, /1\. 备考步骤1/);
  assert.doesNotMatch(remaining.body.reply, /3\. 备考步骤3/);
  assert.equal(tasks.list().filter((task) => task.parentId === parent.id).length, 2);
  await chat("确认创建", planned.cookie);
  assert.equal(tasks.list().filter((task) => task.parentId === parent.id).length, 8);
});

test("确认过期后原方案仍可重新选择", async (t) => {
  let clock = 1_000;
  const { tasks, parent, chat, plans } = await startPlanApi(t, {
    now: () => clock,
    confirmationTtlMs: 100,
    planTtlMs: 1_000,
    items: makePlanItems(8),
  });
  const planned = await chat("制定八项计划");
  const sessionId = planned.cookie!.split("=")[1];
  await chat("只创建第7条", planned.cookie);
  clock += 101;
  assert.match(
    (await chat("确认创建", planned.cookie)).body.reply,
    /待确认操作已过期.*原结构化方案仍然有效/s,
  );
  assert.equal(plans.inspect(sessionId).status, "active");

  assert.match((await chat("把第8条也加进去", planned.cookie)).body.reply, /1 条子任务/);
  await chat("确定创建", planned.cookie);
  assert.deepEqual(
    tasks
      .list()
      .filter((task) => task.parentId === parent.id)
      .map((task) => task.title),
    ["备考步骤8"],
  );
});

test("取消待确认操作不会删除原始方案，明确放弃才删除", async (t) => {
  const { tasks, parent, chat, plans, confirmations } = await startPlanApi(t, {
    items: makePlanItems(8),
  });
  const planned = await chat("制定八项计划");
  const sessionId = planned.cookie!.split("=")[1];
  await chat("只创建第7条", planned.cookie);
  assert.match((await chat("取消创建", planned.cookie)).body.reply, /原结构化方案仍然保留/);
  assert.equal(confirmations.inspect(sessionId).status, "missing");
  assert.equal(plans.inspect(sessionId).status, "active");
  assert.equal(tasks.list().length, 1);

  await chat("只创建第8条", planned.cookie);
  await chat("确认创建", planned.cookie);
  assert.deepEqual(
    tasks
      .list()
      .filter((task) => task.parentId === parent.id)
      .map((task) => task.title),
    ["备考步骤8"],
  );

  assert.match((await chat("放弃这个方案", planned.cookie)).body.reply, /已放弃原结构化方案/);
  assert.equal(plans.inspect(sessionId).status, "missing");
});

test("模型未建立 PendingConfirmation 时不能输出虚假确认邀请", async (t) => {
  const { tasks, chat, confirmations } = await startPlanApi(t, {
    items: makePlanItems(8),
    unhandledReply: "第8条是备考步骤8，优先级中。确认创建吗？回复“确认创建”即可。",
  });
  const planned = await chat("制定八项计划");
  const response = await chat("介绍一下后续安排", planned.cookie);
  assert.match(response.body.reply, /没有建立可执行的服务端确认状态.*没有修改任务/s);
  const sessionId = planned.cookie!.split("=")[1];
  assert.equal(confirmations.inspect(sessionId).status, "missing");
  assert.equal(tasks.list().length, 1);
  assert.match((await chat("确认创建", planned.cookie)).body.reply, /没有可确认/);
});

test("方案创建记录会与真实任务存储重新核对", async (t) => {
  const { tasks, parent, chat, plans } = await startPlanApi(t, { items: makePlanItems(8) });
  const planned = await chat("制定八项计划");
  const sessionId = planned.cookie!.split("=")[1];
  await chat("只创建第1条", planned.cookie);
  await chat("确认创建", planned.cookie);
  const originalTask = tasks.list().find((task) => task.parentId === parent.id)!;
  assert.equal(plans.get(sessionId)?.createdItems[1]?.taskId, originalTask.id);

  tasks.remove(originalTask.id);
  const selectedAgain = await chat("第1条再给我创建一下吧", planned.cookie);
  assert.match(selectedAgain.body.reply, /1 条子任务/);
  await chat("确认创建", planned.cookie);
  const recreated = tasks.list().find((task) => task.parentId === parent.id)!;
  assert.notEqual(recreated.id, originalTask.id);
  assert.equal(plans.get(sessionId)?.createdItems[1]?.taskId, recreated.id);
});

test("同一完整聊天历史可在规划、查询和普通 CRUD 之间连续切换", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-continuous-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = createJsonTaskStore(join(directory, "tasks.json"));
  const confirmations = createPendingConfirmationStore();
  const plans = createSubtaskPlanStore();
  let parentId = "";
  let largestHistory = 0;
  const app = createApp({
    tasks,
    confirmations,
    plans,
    executeTool: listExecutor(tasks),
    async reply(messages, context) {
      largestHistory = Math.max(largestHistory, messages.length);
      const content = messages.at(-1)!.content;
      if (content === "创建准备考六级") {
        const parent = tasks.create("准备考六级");
        parentId = parent.id;
        return "已创建准备考六级";
      }
      if (/制定八项计划/u.test(content)) {
        const parent = tasks.list().find((task) => task.id === parentId)!;
        return context.stagePlan(parent, {
          parentId,
          planName: "八项六级计划",
          items: makePlanItems(8),
        });
      }
      if (/查询任务清单/u.test(content)) return `当前共有 ${tasks.list().length} 条任务。`;
      if (/删除.*备考步骤1/u.test(content)) {
        const target = tasks
          .list()
          .find((task) => task.parentId === parentId && task.title === "备考步骤1");
        assert.ok(target);
        tasks.remove(target.id);
        return "已删除备考步骤1";
      }
      if (/记一下买牛奶/u.test(content)) {
        tasks.create("买牛奶");
        return "已创建买牛奶";
      }
      if (/买牛奶.*优先级/u.test(content)) {
        const milk = tasks.list().find((task) => task.title === "买牛奶")!;
        tasks.update(milk.id, { priority: "high" });
        return "已将买牛奶优先级设为高";
      }
      if (/删除买牛奶/u.test(content)) {
        const milk = tasks.list().find((task) => task.title === "买牛奶")!;
        tasks.remove(milk.id);
        return "已删除买牛奶";
      }
      return "未处理";
    },
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const history: ChatMessage[] = [];
  let cookie: string | undefined;
  async function send(content: string) {
    const messages: ChatMessage[] = [...history, { role: "user", content }];
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ messages }),
    });
    cookie ??= response.headers.get("set-cookie")?.split(";")[0];
    const body = (await response.json()) as { reply: string };
    history.push({ role: "user", content }, { role: "assistant", content: body.reply });
    return body.reply;
  }

  await send("创建准备考六级");
  await send("制定八项计划");
  await send("只创建第1、3项");
  assert.equal(confirmations.inspect(cookie!.split("=")[1]).status, "active");
  await send("确认创建");
  assert.deepEqual(
    tasks
      .list()
      .filter((task) => task.parentId === parentId)
      .map((task) => task.title),
    ["备考步骤1", "备考步骤3"],
  );

  await send("查询任务清单");
  await send("删除准备考六级中的备考步骤1任务");
  await send("帮我记一下买牛奶");
  assert.equal(
    tasks.list().some((task) => task.title === "买牛奶"),
    true,
  );
  await send("把买牛奶的优先级设为高");
  assert.equal(tasks.list().find((task) => task.title === "买牛奶")?.priority, "high");
  await send("删除买牛奶");
  assert.equal(
    tasks.list().some((task) => task.title === "买牛奶"),
    false,
  );

  await send("六级任务里的7、8再给我创建一下吧");
  const sessionId = cookie!.split("=")[1];
  const pendingBeforeQuery = confirmations.peek(sessionId)!;
  await send("查询任务清单");
  assert.equal(confirmations.peek(sessionId)?.id, pendingBeforeQuery.id);
  await send("还有第9个任务");
  assert.equal(confirmations.peek(sessionId)?.id, pendingBeforeQuery.id);
  await send("确认创建");

  assert.deepEqual(
    tasks
      .list()
      .filter((task) => task.parentId === parentId)
      .map((task) => task.title),
    ["备考步骤3", "备考步骤7", "备考步骤8"],
  );
  assert.equal(plans.inspect(sessionId).status, "active");
  assert.equal(largestHistory >= 15, true);
});

test("父任务状态变化后批量确认失效", async (t) => {
  const { tasks, parent, chat } = await startPlanApi(t);
  const planned = await chat("制定计划");
  await chat("只创建第1、3、5项", planned.cookie);
  tasks.update(parent.id, { title: "准备考六级（已调整）" });
  const confirmed = await chat("确认创建", planned.cookie);
  assert.match(confirmed.body.reply, /状态已变化.*重新提出/s);
  assert.equal(tasks.list().filter((task) => task.parentId === parent.id).length, 0);
});

test("批量执行发现已有同名子任务时准确报告且整批不写入", async (t) => {
  const { tasks, parent, chat } = await startPlanApi(t);
  const planned = await chat("制定计划");
  tasks.create("备考步骤3", { parentId: parent.id });
  // 目标快照只绑定父任务；新增同名子任务由原子批量校验在执行时发现。
  await chat("只创建第1、3、5项", planned.cookie);
  const confirmed = await chat("确认创建", planned.cookie);
  assert.match(confirmed.body.reply, /批量创建没有执行.*已存在同名子任务/s);
  assert.deepEqual(
    tasks
      .list()
      .filter((task) => task.parentId === parent.id)
      .map((task) => task.title),
    ["备考步骤3"],
  );
});

test("方案结构拒绝非法字段、重复项和超过10条", () => {
  const base = { parentId: "parent", planName: "计划" };
  assert.equal(
    subtaskPlanArgumentsSchema.safeParse({
      ...base,
      items: Array.from({ length: 11 }, (_, index) => ({
        ...planItems[0],
        number: index + 1,
        title: `任务${index}`,
      })),
    }).success,
    false,
  );
  assert.equal(
    subtaskPlanArgumentsSchema.safeParse({
      ...base,
      items: [planItems[0], { ...planItems[0], number: 2 }],
    }).success,
    false,
  );
  assert.equal(
    subtaskPlanArgumentsSchema.safeParse({
      ...base,
      items: [{ ...planItems[0], priority: "urgent" }],
    }).success,
    false,
  );
});

test("原子批量创建遇到已有同名子任务时整批不写入", () => {
  const filename = join(tmpdir(), `todo-agent-atomic-${randomUUID()}.json`);
  const tasks = createJsonTaskStore(filename);
  const parent = tasks.create("父任务");
  tasks.create("备考步骤3", { parentId: parent.id });
  assert.throws(
    () =>
      tasks.createSubtasks(
        parent.id,
        [planItems[0], planItems[2]].map(
          ({ title, priority, effort, dueDate, estimatedMinutes }) => ({
            title,
            priority,
            effort,
            dueDate,
            estimatedMinutes,
          }),
        ),
      ),
    (error) => error instanceof TaskRuleError && error.code === "DUPLICATE_SUBTASK",
  );
  assert.deepEqual(
    tasks
      .list()
      .filter((task) => task.parentId === parent.id)
      .map((task) => task.title),
    ["备考步骤3"],
  );
  rmSync(filename, { force: true });
});
