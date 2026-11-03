export type TaskStatus = "todo" | "doing" | "done";

export interface Task {
  id: number;
  title: string;
  slug: string;
  status: TaskStatus;
  createdAt: string;
}

export interface NewTaskInput {
  title: string;
  status?: TaskStatus;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
