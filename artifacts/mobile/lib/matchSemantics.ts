/** A list card always represents the whole BO series; details represent one map. */
export function selectSeriesMarket<T extends {type:string}>(markets: readonly T[]): T | undefined {
  return markets.find(m=>m.type === 'match_winner');
}
export function selectMapMarket<T extends {type:string}>(markets: readonly T[]): T | undefined {
  return markets.find(m=>m.type === 'map_winner');
}
