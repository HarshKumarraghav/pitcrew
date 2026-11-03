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
  totalPages: number;
}

/** What GET /tasks returns: a page plus the number of the next page (null on the last page). */
export interface TaskPage<T> extends Page<T> {
  nextPage: number | null;
}
