import type { Match, Prediction, MarketType } from '@/types';

export interface ModelFeatures {
  teamRatingElo: number;
  recentFormLast5: number;
  recentFormLast10: number;
  tournamentTier: number;
  matchImportance: number;
  headToHeadHistory: number;
  sidePreferenceRadiant: number;
  boFormat: 1 | 3 | 5;
  hasStandin: boolean;
  hasRosterChange: boolean;
  daysSinceLastMatch: number;
  bookmakerOpeningOdds: number;
  draftRadiantSynergy?: number;
  draftDireSynergy?: number;
  draftRadiantCounter?: number;
  scalingScore?: number;
  earlyGameScore?: number;
  lateGameScore?: number;
  gameTimeSec?: number;
  killDiff?: number;
  netWorthDiff?: number;
  xpDiff?: number;
  towersLost?: number;
  roshanControl?: number;
  buybackAdvantage?: number;
  netWorthSwingLast5?: number;
}

export interface ModelPredictionResult {
  rawProbability: number;
  calibratedProbability: number;
  confidence: number;
  modelVersion: string;
  featureSnapshotId: string;
  calibrationMethod: 'none' | 'isotonic' | 'platt' | 'temperature_scaling';
  features: ModelFeatures;
  explanationFactors: { factor: string; impact: number; description: string }[];
}

export interface ModelProvider {
  modelVersion: string;

  getPrematchPrediction(match: Match, marketType: MarketType): Promise<ModelPredictionResult>;
  getDraftAdjustedPrediction(match: Match, marketType: MarketType): Promise<ModelPredictionResult>;
  getLivePrediction(match: Match, marketType: MarketType): Promise<ModelPredictionResult>;
  getMarketEdge(modelProbability: number, marketFairProbability: number): number;
  getExpectedValue(modelProbability: number, decimalOdds: number): number;
  getModelExplanation(result: ModelPredictionResult): string;
}
