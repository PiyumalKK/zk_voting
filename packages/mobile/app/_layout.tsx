import "react-native-get-random-values";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { isNativeProverAvailable, registerNativeProver } from "../src/services/nativeProver";
import { ProverWebView } from "../src/services/webviewProver";

// Prefer the native on-device prover when a custom dev build provides it;
// otherwise fall back to the WebView prover (works in Expo Go, reuses the web
// app's proven bb.js pipeline).
const useNativeProver = isNativeProverAvailable();
if (useNativeProver) {
  registerNativeProver();
}

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      {!useNativeProver && <ProverWebView />}
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#0F1B2D" },
          headerTintColor: "#fff",
          headerTitleStyle: { fontWeight: "700" },
          contentStyle: { backgroundColor: "#0F1B2D" },
        }}
      >
        <Stack.Screen name="index" options={{ title: "SL Vote" }} />
        <Stack.Screen name="onboarding" options={{ title: "Set up your identity" }} />
        <Stack.Screen name="register" options={{ title: "Register to vote" }} />
        <Stack.Screen name="vote" options={{ title: "Cast your vote" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>
    </>
  );
}
