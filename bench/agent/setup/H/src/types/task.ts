export type TaskStatus = "todo" | "doing" | "done";

export interface Task {
  id: number;
  title: string;
  slug: string;
  status: TaskStatus;
  createdAt: string;
  /** Optional due date as an ISO-8601 string, e.g. "2026-03-01T12:00:00.000Z". */
  dueDate?: string;
}

export interface NewTaskInput {
  title: string;
  status?: TaskStatus;
  dueDate?: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
