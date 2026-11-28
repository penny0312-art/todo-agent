export const priorities = ["low", "medium", "high"] as const;
export const efforts = ["small", "medium", "large"] as const;

export type Priority = (typeof priorities)[number];
export type Effort = (typeof efforts)[number];

export interface Task {
  id: string;
  title: string;
  done: boolean;
  priority: Priority;
  effort: Effort;
  dueDate: string | null;
  parentId: string | null;
  estimatedMinutes: number | null;
  createdAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

export const priorityLabels: Record<Priority, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

export const effortLabels: Record<Effort, string> = {
  small: "小",
  medium: "中",
  large: "大",
};
