import { createHash } from "node:crypto";

/** Canonical JSON for reproducible fingerprints, never including credentials. */
export function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non_finite_evidence");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (typeof value === "object" && value) {
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([k, v]) => JSON.stringify(k) + ":" + stableJson(v))
        .join(",") +
      "}"
    );
  }
  throw new Error("unsupported_evidence_value");
}

export function evidenceHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export interface PredictionEvidence {
  modelHash: string;
  featureSchemaHash: string;
  featureNames: string[];
  featureVector: number[];
}

export function predictionEvidence(
  modelHash: string,
  names: string[],
  vector: number[],
): PredictionEvidence {
  if (
    !/^[0-9a-f]{64}$/.test(modelHash) ||
    names.length !== vector.length ||
    names.some((n) => typeof n !== "string") ||
    vector.some((v) => !Number.isFinite(v))
  ) {
    throw new Error("invalid_prediction_evidence");
  }
  return {
    modelHash,
    featureSchemaHash: evidenceHash({
      names,
      version: "ordered-inference-vector-v1",
    }),
    featureNames: [...names],
    featureVector: [...vector],
  };
}
