import "react-native-get-random-values";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { isNativeProverAvailable, registerNativeProver } from "../src/services/nativeProver";
import { ProverWebView } from "../src/services/webviewProver";
import { colors } from "../src/theme";

// Prefer the native on-device prover when a custom dev build provides it;
// otherwise fall back to the WebView prover (works in Expo Go, reuses the web
// app's proven bb.js pipeline).
const useNativeProver = isNativeProverAvailable();
if (useNativeProver) {
  registerNativeProver();
}

const headerBg = colors.bg;
const headerTint = colors.text;

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      {!useNativeProver && <ProverWebView />}
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: headerBg },
          headerTintColor: headerTint,
          headerTitleStyle: { fontWeight: "700", fontSize: 17 },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: "slide_from_right",
        }}
      >
        <Stack.Screen name="index" options={{ title: "🇱🇰 SL Vote" }} />
        <Stack.Screen name="onboarding" options={{ title: "Set up identity" }} />
        <Stack.Screen name="claim/[token]" options={{ title: "Complete your enrolment" }} />
        <Stack.Screen name="register" options={{ title: "Register to vote" }} />
        <Stack.Screen name="vote" options={{ title: "Cast your vote" }} />
        <Stack.Screen name="verify" options={{ title: "Verify my vote" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>
    </>
  );
}
