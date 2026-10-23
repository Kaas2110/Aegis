import {
  mkdir,
  open,
  rename,
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { evidenceHash, stableJson } from "./predictionEvidence";

/** One API writer. Acknowledged only AFTER the idempotent database transaction. */
export class JournalOutbox {
  readonly directory: string;
  constructor(stateDir: string) {
    if (!isAbsolute(stateDir))
      throw new Error("absolute_journal_state_dir_required");
    this.directory = join(stateDir, "prediction-journal-outbox");
  }
  async enqueue(batch: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const serialized = stableJson(batch),
      id = evidenceHash(batch);
    const temporary = join(this.directory, id + "." + randomUUID() + ".tmp");
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(this.directory, id + ".json"));
  }
  async drain(
    consume: (batch: unknown) => Promise<void>,
    limit = 20,
  ): Promise<number> {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory))
      .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
      .sort()
      .slice(0, limit);
    let completed = 0;
    for (const name of names) {
      const path = join(this.directory, name);
      const data: unknown = JSON.parse(await readFile(path, "utf8"));
      if (evidenceHash(data) + ".json" !== name)
        throw new Error("journal_outbox_hash_mismatch");
      await consume(data);
      await unlink(path); // Path is confined by the strict filename pattern above.
      completed++;
    }
    return completed;
  }
}
