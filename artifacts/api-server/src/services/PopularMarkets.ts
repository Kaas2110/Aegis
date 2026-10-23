import type { AnalyticsResult } from './AnalyticsEngine';

/** A view over supported predictions, never a second heuristic forecast. */
export function buildPopularMarkets(result: AnalyticsResult) {
  return result.predictions.map(pred => {
    const first = pred.probTeam1 >= pred.probTeam2;
    const total = pred.betType === 'total_kills' || pred.betType === 'total_duration';
    const probability = first ? pred.probTeam1 : pred.probTeam2;
    return {
      betType: pred.betType, labelRu: pred.labelRu,
      recommendation: total ? (first ? 'Больше' : 'Меньше') : (first ? result.team1Name : result.team2Name),
      probability, pPush: pred.pPush ?? 0, fairOdds: probability > 0 ? (1-(pred.pPush ?? 0)) / probability : null,
      confidence: pred.confidence, modelVersion: pred.modelVersion,
      provenance: pred.provenance, generatedAt: pred.generatedAt,
      rationale: pred.provenance?.source === 'derived' ? 'Расчёт из модельной вероятности; качество требует проверки' : 'Прогноз обученной модели; качество требует проверки',
    };
  });
}
