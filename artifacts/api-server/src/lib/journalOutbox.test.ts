import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalOutbox } from "./journalOutbox";

test("database failure preserves exact output for a new process to replay", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "aegis-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const box = new JournalOutbox(dir),
    data = {
      version: 1,
      probability: 0.73,
      features: [1, 0, 300],
      modelHash: "old-model",
    };
  await box.enqueue(data);
  await assert.rejects(
    box.drain(async () => {
      throw new Error("database_down");
    }),
    /database_down/,
  );
  assert.equal(
    (await readdir(box.directory)).filter((n) => n.endsWith(".json")).length,
    1,
  );
  const recovered: unknown[] = [];
  assert.equal(
    await new JournalOutbox(dir).drain(async (row) => {
      recovered.push(row);
    }),
    1,
  );
  assert.deepEqual(recovered, [data]);
  assert.equal((await readdir(box.directory)).length, 0);
});
test("duplicate pending batch is idempotent and uncommitted partial files are ignored", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "aegis-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const box = new JournalOutbox(dir);
  await box.enqueue({ value: 1 });
  await box.enqueue({ value: 1 });
  await writeFile(join(box.directory, "partial.tmp"), "incomplete");
  let calls = 0;
  assert.equal(
    await box.drain(async () => {
      calls++;
    }),
    1,
  );
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(box.directory), ["partial.tmp"]);
});
test("corrupt queued data is retained and rejected, relative locations refused", async (t) => {
  assert.throws(() => new JournalOutbox("relative"), /absolute/);
  const dir = await mkdtemp(join(tmpdir(), "aegis-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const box = new JournalOutbox(dir);
  await box.enqueue({ value: 1 });
  const name = (await readdir(box.directory))[0];
  await writeFile(join(box.directory, name), '{"value":2}');
  await assert.rejects(
    box.drain(async () => {
      throw new Error("should_not_run");
    }),
    /hash_mismatch/,
  );
  assert.equal((await readdir(box.directory)).length, 1);
});
