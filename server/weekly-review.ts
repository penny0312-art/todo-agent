import type { Effort, Priority, Task } from "../shared/task.ts";
import { addCalendarDays, localDate } from "./date.ts";
import { leafWorkItems } from "./plan-evaluator.ts";

export interface RateStat {
  completed: number;
  total: number;
}

export interface WeeklyReview {
  label: "本周" | "上周";
  start: string;
  end: string;
  cutoff: string;
  newTasks: number;
  completedThisPeriod: number;
  due: RateStat;
  overdueNow: number;
  byPriority: Record<Priority, RateStat>;
  byEffort: Record<Effort, RateStat>;
  dailyCompleted: Record<string, number>;
  unknownCreatedAt: number;
  unknownCompletedAt: number;
  knownEstimatedMinutes: number;
  unknownEstimatedMinutes: number;
  unfinishedFeatures: string[];
}

function weekRange(today: string, previous: boolean) {
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = addCalendarDays(today, mondayOffset - (previous ? 7 : 0));
  return { start, end: addCalendarDays(start, 6) };
}

function inRange(value: string | null, start: string, end: string) {
  return value !== null && value >= start && value <= end;
}

export function buildWeeklyReview(tasks: Task[], now: Date, previous = false): WeeklyReview {
  const today = localDate(now);
  const { start, end } = weekRange(today, previous);
  const cutoff = previous ? end : today < end ? today : end;
  const workItems = leafWorkItems(tasks);
  const timestampDate = (value: string | null) => (value ? localDate(new Date(value)) : null);
  const dueTasks = workItems.filter((task) => inRange(task.dueDate, start, end));
  const completedDate = (task: Task) => timestampDate(task.completedAt);
  const createdDate = (task: Task) => timestampDate(task.createdAt);
  const rate = <T extends Priority | Effort>(values: readonly T[], key: "priority" | "effort") =>
    Object.fromEntries(
      values.map((value) => {
        const group = dueTasks.filter((task) => task[key] === value);
        return [
          value,
          { completed: group.filter((task) => task.done).length, total: group.length },
        ];
      }),
    );
  const dailyCompleted: Record<string, number> = {};
  for (const task of workItems) {
    const date = completedDate(task);
    if (inRange(date, start, cutoff)) dailyCompleted[date!] = (dailyCompleted[date!] ?? 0) + 1;
  }
  const unfinished = dueTasks.filter((task) => !task.done);
  const high = unfinished.filter((task) => task.priority === "high").length;
  const large = unfinished.filter((task) => task.effort === "large").length;
  return {
    label: previous ? "上周" : "本周",
    start,
    end,
    cutoff,
    newTasks: workItems.filter((task) => inRange(createdDate(task), start, cutoff)).length,
    completedThisPeriod: workItems.filter((task) => inRange(completedDate(task), start, cutoff))
      .length,
    due: { completed: dueTasks.filter((task) => task.done).length, total: dueTasks.length },
    overdueNow: workItems.filter(
      (task) => !task.done && task.dueDate !== null && task.dueDate < today,
    ).length,
    byPriority: rate(["high", "medium", "low"] as const, "priority") as Record<Priority, RateStat>,
    byEffort: rate(["large", "medium", "small"] as const, "effort") as Record<Effort, RateStat>,
    dailyCompleted,
    unknownCreatedAt: workItems.filter((task) => task.createdAt === null).length,
    unknownCompletedAt: workItems.filter((task) => task.done && task.completedAt === null).length,
    knownEstimatedMinutes: dueTasks.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0),
    unknownEstimatedMinutes: dueTasks.filter((task) => task.estimatedMinutes === null).length,
    unfinishedFeatures: [
      high ? `${high} 项高优先级任务未完成` : "无高优先级到期任务遗留",
      large ? `${large} 项大工作量任务未完成` : "无大工作量到期任务遗留",
    ],
  };
}

function rateText(value: RateStat) {
  return value.total === 0
    ? "暂无统计数据（0/0）"
    : `${Math.round((value.completed / value.total) * 100)}%（${value.completed}/${value.total}）`;
}

export function formatWeeklyReview(value: WeeklyReview): string {
  const daily = Object.keys(value.dailyCompleted).length
    ? Object.entries(value.dailyCompleted)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => `${date}：${count} 项`)
        .join("；")
    : "暂无具有可靠完成时间的记录";
  return `## ${value.label}任务客观复盘\n\n**统计周期：**${value.start} 至 ${value.end}；当前统计截止 ${value.cutoff}（Asia/Shanghai，周一至周日）。\n\n- 本期新增：${value.newTasks} 项（仅统计具有可靠 createdAt 的现存任务）\n- 本期实际完成：${value.completedThisPeriod} 项（按 completedAt）\n- 本期到期任务当前完成率：${rateText(value.due)}\n- 当前逾期未完成：${value.overdueNow} 项\n- 优先级完成率：高 ${rateText(value.byPriority.high)}；中 ${rateText(value.byPriority.medium)}；低 ${rateText(value.byPriority.low)}\n- 工作量完成率：大 ${rateText(value.byEffort.large)}；中 ${rateText(value.byEffort.medium)}；小 ${rateText(value.byEffort.small)}\n- 每日实际完成：${daily}\n- 到期任务预计耗时：已知 ${value.knownEstimatedMinutes} 分钟，${value.unknownEstimatedMinutes} 项未知\n- 未完成任务特征：${value.unfinishedFeatures.join("；")}\n\n**数据限制：**${value.unknownCreatedAt} 项缺少创建时间，${value.unknownCompletedAt} 个已完成任务缺少完成时间；没有事件日志，无法恢复已删除任务、历史重开记录或过去任意时点状态。`;
}
