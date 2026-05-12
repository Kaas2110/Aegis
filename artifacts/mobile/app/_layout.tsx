import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
// Cinzel — латинский фэнтези-серифный шрифт (для чисел, аббревиатур, английских надписей).
// Forum — кириллический серифный шрифт в стиле эпического фэнтези — для русских заголовков.
// Эта пара даёт «дотовский» вайб без необходимости лицензировать Reaver.
import { Cinzel_500Medium, Cinzel_700Bold } from "@expo-google-fonts/cinzel";
import { Forum_400Regular } from "@expo-google-fonts/forum";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Alert } from "react-native";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppProvider } from "@/context/AppContext";
import { initializeRevenueCat, SubscriptionProvider } from "@/lib/revenuecat";
import { FeatureFlagsProvider, FeatureFlagsSideEffects } from "@/lib/featureFlags";

SplashScreen.preventAutoHideAsync();

try {
  initializeRevenueCat();
} catch (err: any) {
  Alert.alert("RevenueCat Unavailable", err?.message ?? "Unknown error");
}

const queryClient = new QueryClient();

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="match/[id]" options={{ presentation: 'card' }} />
      <Stack.Screen name="market-compare/[id]" options={{ presentation: 'card' }} />
      <Stack.Screen name="admin" options={{ presentation: 'card' }} />
      <Stack.Screen name="glossary" options={{ presentation: 'card' }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Cinzel_500Medium,
    Cinzel_700Bold,
    Forum_400Regular,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <SubscriptionProvider>
            <FeatureFlagsProvider>
              <FeatureFlagsSideEffects />
              <GestureHandlerRootView style={{ flex: 1 }}>
                <KeyboardProvider>
                  <AppProvider>
                    <RootLayoutNav />
                  </AppProvider>
                </KeyboardProvider>
              </GestureHandlerRootView>
            </FeatureFlagsProvider>
          </SubscriptionProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
