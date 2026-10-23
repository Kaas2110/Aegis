export const DEFAULT_TRAINING_SEED = 42;

export function trainingSeed(args: string[] = process.argv.slice(2)): number {
  const index = args.indexOf('--seed');
  if (index < 0) return DEFAULT_TRAINING_SEED;
  const raw = args[index + 1];
  if (raw == null || !/^\d+$/.test(raw)) throw new Error('--seed requires an unsigned 32-bit integer');
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed > 0xffffffff) throw new Error('--seed requires an unsigned 32-bit integer');
  return seed;
}

/** Mulberry32: reproducible SGD ordering, not a security random source. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace<T>(values: T[], random: () => number): void {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
}
