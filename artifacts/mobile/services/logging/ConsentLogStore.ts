export interface LogStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const UPLOAD_QUEUE_KEY = '@dea_log_upload_queue';

/** Serializes log writes and prevents old async work from surviving revocation. */
export class ConsentLogStore {
  private enabled = false;
  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private upload: AbortController | null = null;
  private pendingRevocation = false;

  constructor(private readonly storage: LogStorage) {}
  isEnabled(): boolean { return this.enabled; }
  private current(epoch: number): boolean { return this.enabled && this.epoch === epoch; }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(()=>{});
    return next;
  }

  setConsent(enabled: boolean): Promise<void> {
    this.epoch++;
    const epoch = this.epoch;
    if (enabled === true) {
      if (!this.pendingRevocation) {this.enabled=true;return Promise.resolve();}
      // A failed clear must not cause revoked events to be sent after opt-in.
      this.enabled=false;
      return this.serial(async()=>{
        await this.storage.removeItem(UPLOAD_QUEUE_KEY);
        if (this.epoch===epoch) {this.pendingRevocation=false;this.enabled=true;}
      });
    }
    this.enabled=false;
    this.pendingRevocation=true;
    this.upload?.abort();
    return this.serial(async()=>{
      await this.storage.removeItem(UPLOAD_QUEUE_KEY);
      if (this.epoch===epoch) this.pendingRevocation=false;
    });
  }

  async guarded(operation: (current: () => boolean) => Promise<void>): Promise<void> {
    if (!this.enabled) return;
    const epoch = this.epoch;
    await this.serial(async()=>{
      if (this.current(epoch)) await operation(()=>this.current(epoch));
    });
  }

  async append(key: string, entry: unknown, uploadPayload?: unknown): Promise<void> {
    await this.guarded(async current=>{
      const raw = await this.storage.getItem(key);
      if (!current()) return;
      const stored = raw ? JSON.parse(raw) : [];
      const entries = Array.isArray(stored) ? stored : [];
      entries.push(entry);
      await this.storage.setItem(key, JSON.stringify(entries.slice(-500)));
      if (!current() || uploadPayload === undefined) return;
      const pending = await this.storage.getItem(UPLOAD_QUEUE_KEY);
      if (!current()) return;
      const parsed = pending ? JSON.parse(pending) : [];
      const queue = Array.isArray(parsed) ? parsed : [];
      queue.push(uploadPayload);
      await this.storage.setItem(UPLOAD_QUEUE_KEY, JSON.stringify(queue.slice(-1000)));
    });
  }

  async flush(send: (events: unknown[], signal: AbortSignal) => Promise<void>): Promise<void> {
    if (!this.enabled || this.upload) return;
    const epoch = this.epoch;
    const controller = new AbortController();
    this.upload = controller;
    let batch: unknown[] = [];
    try {
      await this.serial(async()=>{
        if (!this.current(epoch)) return;
        const raw = await this.storage.getItem(UPLOAD_QUEUE_KEY);
        if (!this.current(epoch)) return;
        const parsed = raw ? JSON.parse(raw) : [];
        const queue = Array.isArray(parsed) ? parsed : [];
        batch = queue.slice(0,50);
        if (batch.length) await this.storage.setItem(UPLOAD_QUEUE_KEY,JSON.stringify(queue.slice(50)));
      });
      if (batch.length && this.current(epoch) && !controller.signal.aborted) await send(batch,controller.signal);
    } catch {
      // A failed request may retry only under the same still-active consent.
      if (batch.length) await this.serial(async()=>{
        if (!this.current(epoch)) return;
        const raw = await this.storage.getItem(UPLOAD_QUEUE_KEY);
        if (!this.current(epoch)) return;
        const parsed = raw ? JSON.parse(raw) : [];
        const pending = Array.isArray(parsed) ? parsed : [];
        await this.storage.setItem(UPLOAD_QUEUE_KEY,JSON.stringify([...batch,...pending].slice(0,1000)));
      });
    } finally {
      if (this.upload === controller) this.upload = null;
    }
  }
}
