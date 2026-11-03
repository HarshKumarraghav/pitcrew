import { test } from "node:test";
import assert from "node:assert/strict";
import { renderArgv, runJob, type JobSpec } from "../src/backend/jobs.ts";

test("placeholders stay single argv entries (no injection)", () => {
  const argv = renderArgv(["gen", "--prompt", "{prompt}", "--out={out}"], {
    prompt: 'cat"; rm -rf ~ #',
    out: "/tmp/x.png",
  });
  assert.deepEqual(argv, ["gen", "--prompt", 'cat"; rm -rf ~ #', "--out=/tmp/x.png"]);
});

test("missing placeholder values are an error", () => {
  assert.throws(() => renderArgv(["{nope}"], {}), /missing value/);
});

const echoJob: JobSpec = {
  kind: "job",
  endpoint: "speech",
  command: ["node", "-e", "require('fs').writeFileSync(process.argv[1], 'audio:' + process.argv[2])", "{out}", "{input}"],
  memoryGiB: 0.1,
  outputExt: "wav",
};

test("runs a job and returns its output file", async () => {
  const r = await runJob(echoJob, { input: "hello world" });
  assert.equal(r.data.toString(), "audio:hello world");
  assert.ok(r.ms >= 0);
});

test("a failing job surfaces its stderr", async () => {
  const bad: JobSpec = { ...echoJob, command: ["node", "-e", "console.error('boom'); process.exit(3)"] };
  await assert.rejects(runJob(bad, {}), /exited with 3: boom/);
});

test("abort kills the job", async () => {
  const slow: JobSpec = { ...echoJob, command: ["node", "-e", "setTimeout(() => {}, 30000)"] };
  const ac = new AbortController();
  const p = runJob(slow, {}, ac.signal);
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  await assert.rejects(p, /aborted/);
  assert.ok(Date.now() - t0 < 5000);
});
