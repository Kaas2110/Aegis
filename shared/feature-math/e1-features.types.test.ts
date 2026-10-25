/** Compile-only compatibility check; no DB imports, fit or provider calls. */
import type * as Shared from './e1-features.mjs';
import type * as Legacy from './fixtures/e1-features.pr11.oracle';
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true>=T;
export type ValueExportsMatch=Assert<Equal<typeof Shared,typeof Legacy>>;
export type RosterTypesMatch=Assert<Equal<Shared.TeamRostersMap,Legacy.TeamRostersMap>>;
export type PoolTypesMatch=Assert<Equal<Shared.TeamHeroPoolMap,Legacy.TeamHeroPoolMap>>;
export type BenchmarkTypesMatch=Assert<Equal<Shared.HeroBenchmarksMap,Legacy.HeroBenchmarksMap>>;
export type ItemTypesMatch=Assert<Equal<Shared.HeroItemPopularityMap,Legacy.HeroItemPopularityMap>>;
export type TotalsTypesMatch=Assert<Equal<Shared.PlayerTotalsMap,Legacy.PlayerTotalsMap>>;
export type CountsTypesMatch=Assert<Equal<Shared.PlayerCountsMap,Legacy.PlayerCountsMap>>;
export type WinLossTypesMatch=Assert<Equal<Shared.PlayerWlProMap,Legacy.PlayerWlProMap>>;
