import { Redirect } from 'expo-router';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';

export default function Root() {
  const { isOnboarded, isAgeConfirmed } = useApp();
  const { isAuthenticated, isHydrating } = useAuth();

  // Возрастной gate + онбординг — всегда первым шагом.
  if (!isAgeConfirmed || !isOnboarded) {
    return <Redirect href="/onboarding" />;
  }

  // Ждём гидрации auth-токена из AsyncStorage чтобы не моргать /auth → /(tabs).
  if (isHydrating) return null;

  // Не залогинен → экран входа/регистрации.
  if (!isAuthenticated) {
    return <Redirect href="/auth" />;
  }

  return <Redirect href="/(tabs)" />;
}
