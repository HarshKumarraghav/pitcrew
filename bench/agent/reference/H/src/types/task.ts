export type TaskStatus = "todo" | "doing" | "done";

export interface Task {
  id: number;
  title: string;
  slug: string;
  status: TaskStatus;
  createdAt: string;
  /** Optional due time in milliseconds since the Unix epoch. */
  dueAt?: number;
}

export interface NewTaskInput {
  title: string;
  status?: TaskStatus;
  dueAt?: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
