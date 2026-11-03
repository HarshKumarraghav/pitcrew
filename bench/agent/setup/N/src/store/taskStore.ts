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
      slug: this.uniqueSlug(slugify(input.title)),
      status: input.status ?? "todo",
      createdAt: this.now().toISOString(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  /** First of `base`, `base-2`, `base-3`, ... that no current task uses. */
  private uniqueSlug(base: string): string {
    let slug = base;
    for (let n = 2; this.getAllTasks().some((t) => t.slug === slug); n++) slug = `${base}-${n}`;
    return slug;
  }

  findBySlug(slug: string): Task | undefined {
    return this.getAllTasks().find((t) => t.slug === slug);
  }

  get(id: number): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(status?: TaskStatus): Task[] {
    const all = [...this.tasks.values()];
    return status ? all.filter((t) => t.status === status) : all;
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
