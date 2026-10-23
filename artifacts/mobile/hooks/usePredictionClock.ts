import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { nextExpiryDelay } from '../lib/marketExpiry';

/** Expiry must progress even if the network stops producing new snapshots. */
export function usePredictionClock(...expiresAt:Array<string|undefined>): number {
  const [now, setNow] = useState(Date.now());
  const expiryKey=expiresAt.filter(Boolean).join('|');
  useEffect(() => {
    let timer:ReturnType<typeof setTimeout>;
    const tick=()=>{
      const current=Date.now();setNow(current);
      clearTimeout(timer);
      timer=setTimeout(tick,nextExpiryDelay(expiryKey.split('|'),current));
    };
    tick();
    const subscription=AppState.addEventListener('change',state=>{if(state==='active')tick();});
    return () => {clearTimeout(timer);subscription.remove();};
  }, [expiryKey]);
  return now;
}
