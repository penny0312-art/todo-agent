import type { Effort, Priority, Task } from "../shared/task.ts";

export interface PlanEvaluation {
  scopeLabel: string;
  tasks: Task[];
  overdueTasks: Task[];
  counts: {
    tasks: number;
    todayDue: number;
    overdue: number;
    priority: Record<Priority, number>;
    effort: Record<Effort, number>;
  };
  knownMinutes: number;
  unknownMinutes: number;
  availableMinutes: number | null;
  loadRatio: number | null;
  duplicateTitles: string[];
  dueDateConflicts: string[];
  workloadConcentrated: boolean;
}

const priorities: Priority[] = ["high", "medium", "low"];
const efforts: Effort[] = ["large", "medium", "small"];

export function leafWorkItems(tasks: Task[], candidates = tasks): Task[] {
  const parentIds = new Set(tasks.map((task) => task.parentId).filter((id): id is string => !!id));
  return candidates.filter((task) => !parentIds.has(task.id));
}

export function evaluateTodayPlan(
  tasks: Task[],
  today: string,
  options: { availableMinutes?: number; selectedIds?: string[] } = {},
): PlanEvaluation {
  const unfinished = tasks.filter((task) => !task.done);
  const selected = options.selectedIds?.length
    ? unfinished.filter((task) => options.selectedIds!.includes(task.id))
    : unfinished.filter((task) => task.dueDate === today);
  const scope = leafWorkItems(tasks, selected);
  const overdueTasks = leafWorkItems(
    tasks,
    unfinished.filter((task) => task.dueDate !== null && task.dueDate < today),
  );
  const knownMinutes = scope.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0);
  const unknownMinutes = scope.filter((task) => task.estimatedMinutes === null).length;
  const availableMinutes = options.availableMinutes ?? null;
  const loadRatio =
    availableMinutes && unknownMinutes === 0 ? knownMinutes / availableMinutes : null;
  const normalizedTitles = new Map<string, string[]>();
  for (const task of scope) {
    const key = task.title.trim().toLocaleLowerCase("zh-CN");
    normalizedTitles.set(key, [...(normalizedTitles.get(key) ?? []), task.title]);
  }
  const children = new Map(tasks.map((task) => [task.id, task]));
  const selectedIds = new Set(selected.map((task) => task.id));
  const dueDateConflicts = tasks
    .filter(
      (task) =>
        task.parentId &&
        task.dueDate &&
        (selectedIds.has(task.id) || selectedIds.has(task.parentId)),
    )
    .flatMap((task) => {
      const parent = children.get(task.parentId!);
      return parent?.dueDate && task.dueDate! > parent.dueDate
        ? [
            `子任务“${task.title}”截止于 ${task.dueDate}，晚于父任务“${parent.title}”的 ${parent.dueDate}`,
          ]
        : [];
    });
  const distribution = <T extends Priority | Effort>(values: T[], key: "priority" | "effort") =>
    Object.fromEntries(
      values.map((value) => [value, scope.filter((task) => task[key] === value).length]),
    );
  const effort = distribution(efforts, "effort") as Record<Effort, number>;
  return {
    scopeLabel: options.selectedIds?.length
      ? "用户明确指定且仍未完成的真实任务"
      : `截止 ${today} 的未完成任务`,
    tasks: scope,
    overdueTasks,
    counts: {
      tasks: scope.length,
      todayDue: scope.filter((task) => task.dueDate === today).length,
      overdue: overdueTasks.length,
      priority: distribution(priorities, "priority") as Record<Priority, number>,
      effort,
    },
    knownMinutes,
    unknownMinutes,
    availableMinutes,
    loadRatio,
    duplicateTitles: [...normalizedTitles.values()]
      .filter((titles) => titles.length > 1)
      .map((titles) => titles[0]!),
    dueDateConflicts,
    workloadConcentrated: scope.length >= 2 && effort.large / scope.length >= 0.5,
  };
}

export function formatPlanEvaluation(value: PlanEvaluation): string {
  const time =
    value.availableMinutes === null
      ? `已知预计耗时 ${value.knownMinutes} 分钟；未提供今日可用时间，无法计算时间负荷率。`
      : value.unknownMinutes > 0
        ? `已知预计耗时 ${value.knownMinutes} 分钟，另有 ${value.unknownMinutes} 项耗时未知；可用 ${value.availableMinutes} 分钟，无法准确判断全部计划能否完成。`
        : `预计 ${value.knownMinutes} 分钟 / 可用 ${value.availableMinutes} 分钟，负荷率 ${Math.round((value.loadRatio ?? 0) * 100)}%${(value.loadRatio ?? 0) > 1 ? "，已超出可用时间" : (value.loadRatio ?? 0) >= 0.8 ? "，缓冲时间偏少" : "，时间负荷留有余量"}。`;
  return `## 今日计划客观评估\n\n**评估范围：**${value.scopeLabel}；未擅自纳入其他未完成任务。\n\n- 待评估任务：${value.counts.tasks} 项（今日到期 ${value.counts.todayDue} 项）\n- 优先级：高 ${value.counts.priority.high} / 中 ${value.counts.priority.medium} / 低 ${value.counts.priority.low}\n- 工作量：大 ${value.counts.effort.large} / 中 ${value.counts.effort.medium} / 小 ${value.counts.effort.small}\n- 逾期未完成：${value.counts.overdue} 项（单独提醒，未自动计入今日计划）\n- 时间负荷：${time}\n- 数据完整性：${value.unknownMinutes} 项缺少预计耗时\n\n**程序发现：**${[
    value.workloadConcentrated ? "大工作量任务较集中" : "未发现明显的大工作量集中",
    value.duplicateTitles.length
      ? `重复标题：${value.duplicateTitles.join("、")}`
      : "未发现重复标题",
    value.dueDateConflicts.length ? value.dueDateConflicts.join("；") : "未发现父子截止日期冲突",
  ].join("；")}。`;
}
