export type TaskStatus = "todo" | "doing" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: number;
  title: string;
  slug: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: string;
}

export interface NewTaskInput {
  title: string;
  status?: TaskStatus;
  priority?: TaskPriority;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
