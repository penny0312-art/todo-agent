import type { Task } from "../shared/task.ts";

export interface TaskRecommendation {
  task: Task;
  reasons: string[];
  parentTitle?: string;
}

const priorityRank = { high: 0, medium: 1, low: 2 } as const;
const effortRank = { small: 0, medium: 1, large: 2 } as const;

export function recommendTasks(tasks: Task[], today: string): TaskRecommendation[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const unfinishedChildren = new Set(
    tasks.filter((task) => !task.done && task.parentId !== null).map((task) => task.parentId!),
  );
  const candidates = tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => !task.done)
    .filter(({ task }) => task.parentId !== null || !unfinishedChildren.has(task.id));

  const dueRank = (task: Task) => {
    if (task.dueDate && task.dueDate < today) return 0;
    if (task.dueDate === today) return 1;
    return 2;
  };

  candidates.sort((left, right) => {
    const leftTask = left.task;
    const rightTask = right.task;
    return (
      dueRank(leftTask) - dueRank(rightTask) ||
      priorityRank[leftTask.priority] - priorityRank[rightTask.priority] ||
      effortRank[leftTask.effort] - effortRank[rightTask.effort] ||
      (leftTask.dueDate ?? "9999-12-31").localeCompare(rightTask.dueDate ?? "9999-12-31") ||
      left.index - right.index
    );
  });

  return candidates.map(({ task }) => {
    const reasons: string[] = [];
    if (task.dueDate && task.dueDate < today) reasons.push(`已逾期（${task.dueDate}）`);
    else if (task.dueDate === today) reasons.push("今天到期");
    else if (task.dueDate) reasons.push(`截止 ${task.dueDate}`);
    else reasons.push("无截止日期");
    reasons.push(
      `${task.priority === "high" ? "高" : task.priority === "medium" ? "中" : "低"}优先级`,
    );
    reasons.push(
      `工作量${task.effort === "small" ? "小" : task.effort === "medium" ? "中" : "大"}`,
    );
    const parent = task.parentId ? byId.get(task.parentId) : undefined;
    return { task, reasons, ...(parent ? { parentTitle: parent.title } : {}) };
  });
}
