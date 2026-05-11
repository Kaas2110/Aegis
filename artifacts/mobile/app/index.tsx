import { Redirect } from 'expo-router';
import { useApp } from '@/context/AppContext';

export default function Root() {
  const { isOnboarded, isAgeConfirmed } = useApp();

  if (!isAgeConfirmed || !isOnboarded) {
    return <Redirect href="/onboarding" />;
  }

  return <Redirect href="/(tabs)" />;
}
