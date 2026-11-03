import type { Task } from "../types/task.ts";

/** Public JSON shape of a task: the stored fields plus its canonical URL. */
export function present(task: Task): Task & { url: string } {
  return { ...task, url: `/tasks/by-slug/${task.slug}` };
}
