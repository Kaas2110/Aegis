export type ParsedMarketPrediction =
  | {task_type:'classification';raw_prob:number;calibrated_prob:number}
  | {task_type:'regression'|'quantile';mean:number;std:number};

/** A quantile is a point, whereas a distribution requires measured dispersion. */
export function parseMarketPredictionPayload(data: unknown): ParsedMarketPrediction | null {
  if (!data || typeof data !== 'object') return null;
  const d=data as Record<string,unknown>;
  const finite=(v:unknown):v is number => typeof v==='number' && Number.isFinite(v);
  if (d.task_type==='quantile') {
    // std is deliberately unused for quantiles. They are never treated as a distribution.
    return finite(d.mean) ? {task_type:'quantile',mean:d.mean,std:0} : null;
  }
  if (d.task_type==='regression') {
    return finite(d.mean) && finite(d.std) && d.std>0 ? {task_type:'regression',mean:d.mean,std:d.std} : null;
  }
  if (!finite(d.calibrated_prob) || d.calibrated_prob<0 || d.calibrated_prob>1) return null;
  return {task_type:'classification',raw_prob:finite(d.raw_prob)?d.raw_prob:d.calibrated_prob,calibrated_prob:d.calibrated_prob};
}
