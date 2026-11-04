import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Throwaway git worktrees, one per attempt. The user's checkout is never touched: attempts start
 * from a commit that captures the current state (`git stash create` when there are local edits).
 */

export function git(dir: string, args: string[], input?: string): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", input, maxBuffer: 256 << 20 });
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.status === 0 ? "" : r.stderr ?? "") };
}

/** Kept out of every diff: dependencies are linked in, not part of the change. */
export const EXCLUDE = [":(exclude)node_modules", ":(exclude).pitcrew"];

export interface Base {
  root: string;
  /** Commit attempts start from. */
  rev: string;
  /** True when `rev` is a snapshot of uncommitted edits rather than HEAD. */
  dirty: boolean;
  /** Untracked files the attempts will not see. */
  untracked: string[];
}

export function baseOf(repo: string): Base {
  const top = git(repo, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new Error(`${repo} is not a git repository`);
  const root = top.out.trim();
  if (!git(root, ["rev-parse", "--verify", "-q", "HEAD"]).ok) throw new Error("the repository has no commits yet");
  const snap = git(root, ["stash", "create"]).out.trim();
  const rev = snap || git(root, ["rev-parse", "HEAD"]).out.trim();
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]).out.split("\n").filter(Boolean);
  return { root, rev, dirty: Boolean(snap), untracked };
}

export interface Worktree {
  dir: string;
  /** Changes vs the base as a binary-safe patch (new files included). */
  patch(): string;
  /** Back to the base revision (tracked and untracked changes dropped). */
  reset(): void;
  remove(): void;
}

export function createWorktree(base: Base, label: string): Worktree {
  const dir = join(mkdtempSync(join(tmpdir(), "pitcrew-solve-")), label);
  const r = git(base.root, ["worktree", "add", "--detach", "-q", dir, base.rev]);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.out.trim()}`);
  // Dependencies are not in git; share the checkout's.
  const deps = join(base.root, "node_modules");
  if (existsSync(deps) && !existsSync(join(dir, "node_modules"))) symlinkSync(deps, join(dir, "node_modules"), "dir");
  return {
    dir,
    patch() {
      git(dir, ["add", "-A", "-N", "--", ".", ...EXCLUDE]);
      return git(dir, ["diff", "--binary", "--no-renames", base.rev, "--", ".", ...EXCLUDE]).out;
    },
    reset() {
      git(dir, ["reset", "-q", "--hard", base.rev]);
      git(dir, ["clean", "-fdq", "-e", "node_modules", "-e", ".pitcrew"]);
    },
    remove() {
      git(base.root, ["worktree", "remove", "--force", dir]);
      rmSync(join(dir, ".."), { recursive: true, force: true });
      git(base.root, ["worktree", "prune"]);
    },
  };
}

/** Apply a patch to the user's checkout. Refuses when it does not apply cleanly. */
export function applyPatch(root: string, patch: string, file: string): { ok: boolean; out: string } {
  writeFileSync(file, patch);
  const check = git(root, ["apply", "--check", "--whitespace=nowarn", file]);
  if (!check.ok) return check;
  return git(root, ["apply", "--whitespace=nowarn", file]);
}
