export type RequiredLiveWinnerFields = {
  gameTimeSec: number; radiantLead: number; radiantScore: number;
  direScore: number; buildingState: number;
};

/** A missing state is not a tied score, zero lead or eleven standing towers. */
export function hasRequiredLiveWinnerFields<T extends {
  gameTimeSec: number | null; radiantLead: number | null; radiantScore: number | null;
  direScore: number | null; buildingState: number | null;
}>(value: T): value is T & RequiredLiveWinnerFields {
  if (![value.gameTimeSec, value.radiantLead, value.radiantScore, value.direScore, value.buildingState]
      .every(v => typeof v === 'number' && Number.isSafeInteger(v))) return false;
  return value.gameTimeSec! >= 60 && value.radiantScore! >= 0 && value.direScore! >= 0
    && value.buildingState! >= 0;
}
