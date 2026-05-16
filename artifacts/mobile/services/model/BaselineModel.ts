import type { Match, Prediction, MarketType } from '@/types';
import type { ModelProvider, ModelFeatures, ModelPredictionResult } from './types';
import { logTechnicalEvent, logPredictionAudit } from '@/services/logging/EventLogger';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function formToScore(form: ('W' | 'L')[]): number {
  const last5 = form.slice(-5);
  const wins = last5.filter(r => r === 'W').length;
  return wins / 5;
}

export class BaselineModel implements ModelProvider {
  readonly modelVersion = 'baseline_v1.0.0';

  getMarketEdge(modelProbability: number, marketFairProbability: number): number {
    return modelProbability - marketFairProbability;
  }

  getExpectedValue(modelProbability: number, decimalOdds: number): number {
    return modelProbability * (decimalOdds - 1) - (1 - modelProbability);
  }

  getModelExplanation(result: ModelPredictionResult): string {
    const top = result.explanationFactors[0];
    return top ? `${top.factor}: ${top.description}` : 'Нет объяснения';
  }

  private buildPrematchFeatures(match: Match): ModelFeatures {
    const t1 = match.team1;
    const t2 = match.team2;
    return {
      teamRatingElo: t1.eloRating - t2.eloRating,
      recentFormLast5: formToScore(t1.recentForm) - formToScore(t2.recentForm),
      recentFormLast10: 0,
      tournamentTier: match.tournamentTier,
      matchImportance: match.tournamentTier === 1 ? 1.0 : match.tournamentTier === 2 ? 0.7 : 0.4,
      headToHeadHistory: 0,
      sidePreferenceRadiant: 0.03,
      boFormat: match.format === 'BO1' ? 1 : match.format === 'BO3' ? 3 : 5,
      hasStandin: false,
      hasRosterChange: false,
      daysSinceLastMatch: 3,
      bookmakerOpeningOdds: 1.80,
    };
  }

  private buildLiveFeatures(match: Match): ModelFeatures {
    const base = this.buildPrematchFeatures(match);
    const snap = match.liveSnapshot;
    if (!snap) return base;
    return {
      ...base,
      gameTimeSec: snap.gameTimeSeconds,
      killDiff: snap.radiantKills - snap.direKills,
      netWorthDiff: snap.netWorthRadiant - snap.netWorthDire,
      // xp/buybacks/aegis сейчас от OpenDota приходят null (источник не отдаёт);
      // в фолбэк-модели интерпретируем null как «нет преимущества» (0).
      xpDiff: (snap.xpRadiant ?? 0) - (snap.xpDire ?? 0),
      // towers: 11 башен на сторону по полному набору (3 эшелона × 3 линии + 2 трона).
      // Раньше тут был hardcoded `7 - snap.towersDire` от старой эры; с реальным
      // декодом из building_state значение может быть до 11 → выставляем clamp.
      towersLost: Math.max(0, Math.min(11, 11 - snap.towersDire)),
      roshanControl: snap.aegisHolder === 'radiant' ? 1 : snap.aegisHolder === 'dire' ? -1 : 0,
      buybackAdvantage: (snap.buybacksAvailableRadiant ?? 0) - (snap.buybacksAvailableDire ?? 0),
      // T0 mini-fix (2026-05-16): убран хардкод 8200 (унаследован из старой
      // 7-башенной эры). У нас нет истории netWorthDiff в одном snapshot'е —
      // нужно либо хранить rolling 5 minutes на клиенте, либо тянуть с сервера.
      // Пока — 0 (нет данных). TODO: считать на сервере из последних 5
      // live_snapshots и слать как `snap.netWorthSwingLast5` (см. ml-feature-audit.md).
      netWorthSwingLast5: 0,
    };
  }

  private computePrematchProb(features: ModelFeatures, _marketType: MarketType): number {
    const eloWeight = 0.35;
    const formWeight = 0.25;
    const sideWeight = 0.10;
    const openingOddsWeight = 0.30;

    const eloContrib = clamp((features.teamRatingElo / 200), -0.3, 0.3) * eloWeight;
    const formContrib = features.recentFormLast5 * formWeight;
    const sideContrib = features.sidePreferenceRadiant * sideWeight;
    const oddsImplied = clamp(1 / features.bookmakerOpeningOdds, 0.2, 0.85) * openingOddsWeight;

    const raw = 0.5 + eloContrib + formContrib + sideContrib - openingOddsWeight * 0.5 + oddsImplied;
    return clamp(raw, 0.05, 0.95);
  }

  private computeLiveProb(features: ModelFeatures, marketType: MarketType): number {
    const prematch = this.computePrematchProb(features, marketType);
    if (!features.gameTimeSec) return prematch;

    const progressFactor = Math.min(features.gameTimeSec / 3600, 1.0);
    const nwWeight = 0.30 * progressFactor;
    const killWeight = 0.15 * progressFactor;
    const buybackWeight = 0.20 * progressFactor;
    const roshanWeight = 0.10 * progressFactor;

    const nwContrib = clamp((features.netWorthDiff ?? 0) / 50000, -0.5, 0.5) * nwWeight;
    const killContrib = clamp((features.killDiff ?? 0) / 20, -0.3, 0.3) * killWeight;
    const buybackContrib = clamp((features.buybackAdvantage ?? 0) / 5, -0.25, 0.25) * buybackWeight;
    const roshanContrib = (features.roshanControl ?? 0) * 0.05 * roshanWeight;

    const livePart = nwContrib + killContrib + buybackContrib + roshanContrib;
    const blendedRaw = prematch * (1 - progressFactor * 0.7) + (0.5 + livePart) * (progressFactor * 0.7);
    return clamp(blendedRaw, 0.02, 0.98);
  }

  private computeConfidence(features: ModelFeatures, freshnessScore: number, qualityScore: number): number {
    const freshnessContrib = freshnessScore * 25;
    const qualityContrib = qualityScore * 20;
    const sampleSize = 0.72 * 20;
    const stabilitiy = 0.85 * 20;
    const hasDraft = features.draftRadiantSynergy ? 15 : 5;
    const total = freshnessContrib + qualityContrib + sampleSize + stabilitiy + hasDraft;
    return Math.round(clamp(total, 20, 99));
  }

  async getPrematchPrediction(match: Match, marketType: MarketType): Promise<ModelPredictionResult> {
    const start = Date.now();
    const features = this.buildPrematchFeatures(match);
    const rawProb = this.computePrematchProb(features, marketType);
    const calibrated = rawProb * 0.98;
    const confidence = this.computeConfidence(features, 0.90, 0.85);
    const featureSnapshotId = 'feat_' + generateId();

    const result: ModelPredictionResult = {
      rawProbability: rawProb,
      calibratedProbability: calibrated,
      confidence,
      modelVersion: this.modelVersion,
      featureSnapshotId,
      calibrationMethod: 'none',
      features,
      explanationFactors: [
        { factor: 'ELO Rating', impact: features.teamRatingElo / 400, description: `ELO разница: ${features.teamRatingElo > 0 ? '+' : ''}${features.teamRatingElo}` },
        { factor: 'Recent Form', impact: features.recentFormLast5, description: `Форма команд: ${features.recentFormLast5 > 0 ? 'преимущество Team1' : 'преимущество Team2'}` },
        { factor: 'Side Preference', impact: 0.03, description: 'Radiant имеет небольшое историческое преимущество' },
      ],
    };

    await logTechnicalEvent('model_inference', 'prematch_prediction', {
      matchId: match.id, marketType, latencyMs: Date.now() - start, modelVersion: this.modelVersion,
    });

    return result;
  }

  async getDraftAdjustedPrediction(match: Match, marketType: MarketType): Promise<ModelPredictionResult> {
    const features = { ...this.buildPrematchFeatures(match) };
    if (match.draft) {
      features.draftRadiantSynergy = match.draft.radiantSynergy;
      features.draftDireSynergy = match.draft.direSynergy;
      features.draftRadiantCounter = match.draft.radiantCounter;
      features.scalingScore = match.draft.radiantScalingScore - match.draft.direScalingScore;
      features.earlyGameScore = match.draft.radiantEarlyGameScore - match.draft.direEarlyGameScore;
    }
    const rawProb = clamp(this.computePrematchProb(features, marketType) + (features.scalingScore ?? 0) * 0.08, 0.05, 0.95);
    const confidence = this.computeConfidence(features, 0.92, 0.88);
    return {
      rawProbability: rawProb,
      calibratedProbability: rawProb * 0.98,
      confidence,
      modelVersion: this.modelVersion,
      featureSnapshotId: 'feat_' + generateId(),
      calibrationMethod: 'none',
      features,
      explanationFactors: [
        { factor: 'Draft Synergy', impact: (match.draft?.radiantSynergy ?? 0) - (match.draft?.direSynergy ?? 0), description: 'Синергия героев пиков' },
        { factor: 'Draft Scaling', impact: features.scalingScore ?? 0, description: 'Преимущество в поздней игре по составу' },
        { factor: 'Counter Picks', impact: features.draftRadiantCounter ?? 0, description: 'Эффективность контрпиков' },
      ],
    };
  }

  async getLivePrediction(match: Match, marketType: MarketType): Promise<ModelPredictionResult> {
    const start = Date.now();
    const features = this.buildLiveFeatures(match);
    const snap = match.liveSnapshot;
    const freshnessScore = snap ? Math.max(0, 1 - snap.snapshotAge / 120) : 0.5;
    const rawProb = this.computeLiveProb(features, marketType);
    const calibrated = rawProb * 0.98;
    const confidence = this.computeConfidence(features, freshnessScore, 0.88);
    const featureSnapshotId = 'feat_' + generateId();

    const result: ModelPredictionResult = {
      rawProbability: rawProb,
      calibratedProbability: calibrated,
      confidence,
      modelVersion: this.modelVersion,
      featureSnapshotId,
      calibrationMethod: 'none',
      features,
      explanationFactors: [
        { factor: 'Net Worth', impact: clamp((features.netWorthDiff ?? 0) / 50000, -0.5, 0.5), description: `Разница gold: ${features.netWorthDiff ?? 0 > 0 ? '+' : ''}${features.netWorthDiff ?? 0}` },
        { factor: 'Kill Diff', impact: clamp((features.killDiff ?? 0) / 20, -0.3, 0.3), description: `Разница убийств: ${features.killDiff ?? 0}` },
        { factor: 'Buyback Status', impact: (features.buybackAdvantage ?? 0) * 0.04, description: `Байбэк преимущество: ${features.buybackAdvantage ?? 0}` },
        { factor: 'Roshan', impact: (features.roshanControl ?? 0) * 0.05, description: features.roshanControl === 1 ? 'Radiant имеет Aegis' : features.roshanControl === -1 ? 'Dire имеет Aegis' : 'Roshan свободен' },
      ],
    };

    await logTechnicalEvent('model_inference', 'live_prediction', {
      matchId: match.id, marketType, latencyMs: Date.now() - start,
      gameTimeSec: features.gameTimeSec, netWorthDiff: features.netWorthDiff,
    });

    await logPredictionAudit({
      predictionId: 'pred_' + generateId(),
      matchId: match.id,
      marketType,
      sourceSnapshotId: snap?.snapshotId ?? 'unknown',
      featureSnapshotId,
      modelVersion: this.modelVersion,
      rawProbability: rawProb,
      calibratedProbability: calibrated,
      marketProbability: 0,
      edge: 0,
      ev: 0,
      confidence,
      inputFeaturesJson: features as unknown as Record<string, unknown>,
      explanationJson: { topFactors: result.explanationFactors },
    });

    return result;
  }
}

export const baselineModel = new BaselineModel();
