import type { NewTaskInput, Task, TaskStatus } from "../types/task.ts";
import { slugify } from "../utils/slugify.ts";

/**
 * In-memory task store. This is the single source of truth for task state;
 * route handlers must go through it rather than keeping their own copies.
 */
export class TaskStore {
  private tasks = new Map<number, Task>();
  private nextId = 1;
  private now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  create(input: NewTaskInput): Task {
    const task: Task = {
      id: this.nextId++,
      title: input.title,
      slug: slugify(input.title),
      status: input.status ?? "todo",
      createdAt: this.now().toISOString(),
    };
    if (input.dueAt !== undefined) task.dueAt = input.dueAt;
    this.tasks.set(task.id, task);
    return task;
  }

  get(id: number): Task | undefined {
    return this.tasks.get(id);
  }

  /** All tasks, optionally filtered by status and/or "due strictly before" an epoch-ms time. */
  getAllTasks(status?: TaskStatus, dueBefore?: number): Task[] {
    let all = [...this.tasks.values()];
    if (status) all = all.filter((t) => t.status === status);
    if (dueBefore !== undefined) all = all.filter((t) => t.dueAt !== undefined && t.dueAt < dueBefore);
    return all;
  }

  /** Tasks that are not done and whose due date is before `now`. */
  overdue(now: Date = this.now()): Task[] {
    return this.getAllTasks().filter(
      (t) => t.status !== "done" && t.dueAt !== undefined && t.dueAt < now.getTime(),
    );
  }

  updateStatus(id: number, status: TaskStatus): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    task.status = status;
    return task;
  }

  remove(id: number): boolean {
    return this.tasks.delete(id);
  }
}
