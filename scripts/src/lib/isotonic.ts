/**
 * Pool Adjacent Violators (PAV) — изотоническая регрессия для калибровки
 * вероятностей классификатора. После обучения LR/GBM «сырая» вероятность
 * 0.7 не означает «70% случаев positive». Изокалибровка строит монотонную
 * функцию rawProb → calibratedProb по holdout-выборке так, что внутри
 * полученных бинов средний label действительно равен calibratedProb.
 *
 * Эффект: Brier score падает, log-loss падает. Accuracy не меняется
 * (порог 0.5 в монотонном маппинге двигает только локально), но
 * вероятности становятся честными — критично для расчёта edge vs odds.
 *
 * Применение: применяем калибровку поверх прематч-модели на инференсе.
 * Хранится в `model_versions.metadata.calibration` как массив бинов.
 */

export interface CalibrationBin {
  /** Нижняя граница raw-вероятности (включительно). */
  minProb: number;
  /** Верхняя граница raw-вероятности (включительно). */
  maxProb: number;
  /** Калиброванная вероятность для всех raw в [minProb, maxProb]. */
  calibratedProb: number;
}

export interface CalibrationModel {
  bins: CalibrationBin[];
  /**
   * Если true — калибровка не построена (нет данных или один класс),
   * `applyCalibration` возвращает rawProb без изменений.
   */
  identity?: boolean;
  /** Сколько samples ушло в фит. */
  sampleSize: number;
}

interface Block {
  sumLabel: number;
  count: number;
  minProb: number;
  maxProb: number;
}

/**
 * Минимальный размер выборки для осмысленной калибровки. Меньше — велик
 * шанс получить мусорные бины (особенно если внутри один класс).
 * Не блокирует обучение модели — просто отключает калибровку для этого
 * бакета.
 */
const MIN_CALIB_SAMPLES = 20;

/**
 * Фитит изотоническую регрессию через PAV.
 *
 * Возвращает identity-калибровку (без изменений) когда:
 *   - меньше MIN_CALIB_SAMPLES точек;
 *   - все метки одного класса (single-class) — PAV в этом случае схлопывает
 *     всё в константу 0 или 1, что разрушает probability output на инференсе.
 */
export function fitIsotonic(samples: { prob: number; label: number }[]): CalibrationModel {
  const n = samples.length;
  if (n < MIN_CALIB_SAMPLES) {
    return { bins: [], identity: true, sampleSize: n };
  }

  // Single-class guard: если все labels 0 или все 1 — калибровка
  // дегенерирует в константу. Явно отказываемся.
  let positives = 0;
  for (const s of samples) if (s.label === 1) positives++;
  if (positives === 0 || positives === n) {
    return { bins: [], identity: true, sampleSize: n };
  }

  // 1. Сортируем по probability
  const sorted = [...samples].sort((a, b) => a.prob - b.prob);

  // 2. Каждая точка — собственный блок
  const blocks: Block[] = sorted.map(s => ({
    sumLabel: s.label,
    count: 1,
    minProb: s.prob,
    maxProb: s.prob,
  }));

  // 3. PAV: проходим слева направо, объединяя нарушителей монотонности.
  //    Если левый блок имеет средний label > правого — сливаем (нарушение
  //    isotonic). После слияния возвращаемся на шаг назад, потому что
  //    новое среднее может стать > предыдущего блока.
  let i = 0;
  while (i < blocks.length - 1) {
    const left = blocks[i];
    const right = blocks[i + 1];
    if (left.sumLabel / left.count > right.sumLabel / right.count) {
      blocks[i] = {
        sumLabel: left.sumLabel + right.sumLabel,
        count: left.count + right.count,
        minProb: left.minProb,
        maxProb: right.maxProb,
      };
      blocks.splice(i + 1, 1);
      if (i > 0) i--;
    } else {
      i++;
    }
  }

  return {
    bins: blocks.map(b => ({
      minProb: b.minProb,
      maxProb: b.maxProb,
      calibratedProb: b.sumLabel / b.count,
    })),
    sampleSize: n,
  };
}

/**
 * Применяет калибровку к raw-вероятности.
 * Вне диапазона бинов — экстраполяция через константу крайнего бина
 * (стандартная практика для PAV).
 * Между бинами — линейная интерполяция между соседними калиброванными
 * значениями для гладкости.
 */
export function applyCalibration(rawProb: number, model: CalibrationModel | null | undefined): number {
  if (!model || model.identity || model.bins.length === 0) return rawProb;

  const bins = model.bins;
  // Ниже самого левого бина → клампим к нему
  if (rawProb <= bins[0].maxProb) return bins[0].calibratedProb;
  // Выше самого правого
  if (rawProb >= bins[bins.length - 1].minProb) return bins[bins.length - 1].calibratedProb;

  // Внутри какого-то бина
  for (const b of bins) {
    if (rawProb >= b.minProb && rawProb <= b.maxProb) return b.calibratedProb;
  }

  // В разрыве между бинами — линейная интерполяция
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
