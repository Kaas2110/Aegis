import type {BookmakerOdds} from '../types';

/** A valid model and a usable quote have independent lifetimes. */
export function freshBookmakerQuote(quote:BookmakerOdds,now=Date.now()):boolean {
  return !!quote.expiresAt && Number.isFinite(Date.parse(quote.expiresAt)) && Date.parse(quote.expiresAt)>now
    && Number.isFinite(quote.oddsTeam1) && quote.oddsTeam1>1
    && Number.isFinite(quote.oddsTeam2) && quote.oddsTeam2>1;
}

type QuotedMarket = {
  bestOdds:BookmakerOdds;
  allBookmakerOdds:BookmakerOdds[];
  prediction?:{edge:number|null;ev:number|null;marketFairProbability:number};
};

/** Remove expired prices/comparisons without changing a model probability or selecting another source. */
export function expireMarketQuotes<T extends QuotedMarket>(market:T,now=Date.now()):T {
  const allBookmakerOdds=market.allBookmakerOdds.filter(q=>freshBookmakerQuote(q,now));
  if(freshBookmakerQuote(market.bestOdds,now)) {
    return allBookmakerOdds.length===market.allBookmakerOdds.length ? market : {...market,allBookmakerOdds};
  }
  return {...market,allBookmakerOdds,bestOdds:{...market.bestOdds,
    oddsTeam1:0,oddsTeam2:0,impliedProbTeam1:0,impliedProbTeam2:0,fairProbTeam1:0,fairProbTeam2:0,freshness:0,
  },...(market.prediction ? {prediction:{...market.prediction,edge:null,ev:null,marketFairProbability:0}} : {})};
}

/** Wake at the next expiry, with the usual clock tick as a backstop. */
export function nextExpiryDelay(expiries:Array<string|undefined>,now=Date.now()):number {
  const remaining=expiries.map(at=>Date.parse(at??'')-now).filter(ms=>Number.isFinite(ms)&&ms>0);
  return Math.max(1,Math.min(15_000,...remaining));
}
