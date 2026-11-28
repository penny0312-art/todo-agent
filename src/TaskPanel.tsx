import { useEffect, useState } from "react";
import { effortLabels, priorityLabels, type Task } from "../shared/task.ts";

interface TaskPanelProps {
  refreshKey: number;
}

function todayInShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function DueDate({ task, today }: { task: Task; today: string }) {
  if (!task.dueDate) return <span className="task-meta">无截止日期</span>;
  const state = task.done
    ? ""
    : task.dueDate < today
      ? "已过期"
      : task.dueDate === today
        ? "今天到期"
        : "";
  return (
    <span className={`task-meta ${state ? "due-warning" : ""}`}>
      {task.dueDate}
      {state && ` · ${state}`}
    </span>
  );
}

function TaskRow({
  task,
  tasks,
  today,
  nested = false,
}: {
  task: Task;
  tasks: Task[];
  today: string;
  nested?: boolean;
}) {
  const children = nested ? [] : tasks.filter((candidate) => candidate.parentId === task.id);
  const completed = children.filter((child) => child.done).length;
  return (
    <li className={task.done ? "task-done" : ""}>
      <strong>{task.title}</strong>
      {children.length > 0 && (
        <span className="subtask-progress">
          子任务 {completed}/{children.length}
        </span>
      )}
      <div className="task-badges">
        <span className={`priority priority-${task.priority}`}>
          {priorityLabels[task.priority]}优先级
        </span>
        <span className="task-meta">工作量：{effortLabels[task.effort]}</span>
        <span className="task-meta">
          {task.estimatedMinutes === null ? "预计耗时未知" : `预计耗时：${task.estimatedMinutes} 分钟`}
        </span>
        <DueDate task={task} today={today} />
      </div>
      {children.length > 0 && (
        <ul className="subtask-list">
          {children.map((child) => (
            <TaskRow key={child.id} task={child} tasks={tasks} today={today} nested />
          ))}
        </ul>
      )}
    </li>
  );
}

function TaskGroup({
  title,
  roots,
  tasks,
  today,
}: {
  title: string;
  roots: Task[];
  tasks: Task[];
  today: string;
}) {
  if (!roots.length) return null;
  return (
    <section className="task-group">
      <h3>
        {title} <span>{roots.length}</span>
      </h3>
      <ul>
        {roots.map((task) => (
          <TaskRow key={task.id} task={task} tasks={tasks} today={today} />
        ))}
      </ul>
    </section>
  );
}

export function TaskPanel({ refreshKey }: TaskPanelProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/tasks", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as Task[];
      })
      .then((data) => {
        setTasks(data);
        setError("");
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError("暂时无法加载任务清单");
      });
    return () => controller.abort();
  }, [refreshKey]);

  const today = todayInShanghai();
  const roots = tasks.filter(
    (task) => task.parentId === null || !tasks.some((candidate) => candidate.id === task.parentId),
  );
  const pending = roots.filter((task) => !task.done);
  const done = roots.filter((task) => task.done);
  const pendingCount = tasks.filter((task) => !task.done).length;

  return (
    <details className="task-panel" open>
      <summary>
        <span>任务清单</span>
        <small>{tasks.length ? `${pendingCount} 项待完成` : "空清单"}</small>
      </summary>
      <div className="task-panel-body">
        {error ? (
          <p className="task-panel-status">{error}</p>
        ) : tasks.length === 0 ? (
          <p className="task-panel-status">还没有任务，可以在下方对话中创建。</p>
        ) : (
          <>
            <TaskGroup title="未完成" roots={pending} tasks={tasks} today={today} />
            <TaskGroup title="已完成" roots={done} tasks={tasks} today={today} />
          </>
        )}
      </div>
    </details>
  );
}
