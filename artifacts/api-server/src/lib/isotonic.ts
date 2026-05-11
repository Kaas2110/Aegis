/**
 * Inference-side application of isotonic calibration.
 *
 * Зеркалит интерфейс из `scripts/src/lib/isotonic.ts`, но содержит только
 * `applyCalibration` — фит делается в трейн-скрипте. Дублирование оправдано:
 * 30 строк, нулевые runtime-зависимости, без необходимости в shared lib.
 *
 * Калибровка хранится в `model_versions.metadata.calibration` как:
 *   { bins: [{ minProb, maxProb, calibratedProb }, ...], identity?, sampleSize }
 */

export interface CalibrationBin {
  minProb: number;
  maxProb: number;
  calibratedProb: number;
}

export interface CalibrationModel {
  bins: CalibrationBin[];
  identity?: boolean;
  sampleSize?: number;
}

export function applyCalibration(rawProb: number, model: CalibrationModel | null | undefined): number {
  if (!model || model.identity || !Array.isArray(model.bins) || model.bins.length === 0) {
    return rawProb;
  }
  const bins = model.bins;
  if (rawProb <= bins[0].maxProb) return bins[0].calibratedProb;
  if (rawProb >= bins[bins.length - 1].minProb) return bins[bins.length - 1].calibratedProb;
  for (const b of bins) {
    if (rawProb >= b.minProb && rawProb <= b.maxProb) return b.calibratedProb;
  }
  for (let j = 0; j < bins.length - 1; j++) {
    const a = bins[j];
    const c = bins[j + 1];
    if (rawProb > a.maxProb && rawProb < c.minProb) {
      const span = c.minProb - a.maxProb;
      if (span <= 0) return (a.calibratedProb + c.calibratedProb) / 2;
      const t = (rawProb - a.maxProb) / span;
      return a.calibratedProb + t * (c.calibratedProb - a.calibratedProb);
    }
  }
  return rawProb;
}
