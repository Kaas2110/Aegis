import type {FilterBookmaker,Filters} from '../types';

const BOOKMAKER_IDS=new Set(['none','bovada','fonbet','liga_stavok','pari','betboom','x1stavka','olimp']);

/** Retired/unknown values must not look like "none" while requesting a different source. */
export function normalizeBookmaker(value:unknown):FilterBookmaker {
  return typeof value==='string' && BOOKMAKER_IDS.has(value) ? value as FilterBookmaker : 'none';
}

export function restoreFilters(raw:string|null,defaults:Filters):Filters {
  try {
    const parsed:unknown=raw ? JSON.parse(raw) : null;
    if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))return {...defaults};
    const stored=parsed as Partial<Filters>;
    return {...defaults,...stored,bookmaker:normalizeBookmaker(stored.bookmaker)};
  } catch {return {...defaults};}
}
