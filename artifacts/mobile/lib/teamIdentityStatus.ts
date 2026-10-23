export interface TeamIdentityStatus {
  status:'resolved'|'unresolved';
  method:string|null;
  reason:string;
  ratingAvailable:boolean;
}
export type TeamIdentityStatuses={team1:TeamIdentityStatus|null;team2:TeamIdentityStatus|null};

/** Display identity and feature availability separately; neither proves ML quality. */
export function teamIdentityMessages(name1:string,name2:string,evidence?:TeamIdentityStatuses):string[] {
  if(!evidence)return [];
  return ([['team1',name1],['team2',name2]] as const).flatMap(([key,name])=>{
    const item=evidence[key];if(!item)return [];
    if(item.status==='resolved')return !item.ratingAvailable
      ? [`${name}: команда найдена${item.method==='history_exact_name'?' в истории матчей':''}, рейтинг пока отсутствует.`]:[];
    const reasons:Record<string,string>={
      name_missing:'участник ещё не определён',
      name_not_found:'нет точного соответствия в данных OpenDota',
      name_ambiguous:'найдено несколько команд с таким именем',
      identity_source_unavailable:'каталог команд временно недоступен',
      invalid_provider_id:'источник передал некорректный ID команды',
      same_team_on_both_sides:'обе стороны сопоставились с одной командой',
    };
    return [`${name}: ${reasons[item.reason]??'сопоставление команды не подтверждено'}.`];
  });
}
