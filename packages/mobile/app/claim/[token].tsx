import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { api } from "../../src/services/api";
import { AnimatedResult, FadeIn, GlassCard, GradientButton } from "../../src/components/ui";
import { createIdentity, getAddress, hasIdentity } from "../../src/services/keystore";
import { colors, styles } from "../../src/theme";

/**
 * Reached via the SMS claim link (`slvote://claim/<token>`) sent by
 * `POST /api/voter-roll/bulk` — the self-service replacement for a citizen
 * physically visiting a GN officer. The app's `scheme` is already `"slvote"`
 * (`app.json`), so this route is reachable with no extra linking config.
 *
 * This screen does exactly what a GN officer's `reserveNicHash` + `addVoters`
 * would do, triggered by the token instead of an officer's session — it does
 * NOT touch the on-device registration flow (`register.tsx`), which still
 * runs afterwards, unchanged, generating the actual anonymous commitment.
 */

type Status = "checking-identity" | "creating-identity" | "enrolling" | "done" | "error";

export default function Claim() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const [status, setStatus] = useState<Status>("checking-identity");
  const [divisionName, setDivisionName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enrol = async (address: string) => {
    setStatus("enrolling");
    try {
      const result = await api.selfEnrol(token, address);
      if (!result.ok) throw new Error(result.error ?? "Enrolment failed");
      setDivisionName(result.divisionName ?? null);
      setStatus("done");
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStatus("error");
    }
  };

  useEffect(() => {
    (async () => {
      if (!token) {
        setError("This link is missing its enrolment code.");
        setStatus("error");
        return;
      }
      if (await hasIdentity()) {
        const address = await getAddress();
        if (address) {
          await enrol(address);
          return;
        }
      }
      setStatus("creating-identity");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleCreateIdentity = async () => {
    try {
      const address = await createIdentity();
      await enrol(address);
    } catch (e: any) {
      setError(e?.message ?? "Could not create your identity");
      setStatus("error");
    }
  };

  if (status === "checking-identity" || status === "enrolling") {
    return (
      <View style={styles.center}>
        <Text style={styles.subtitle}>{status === "checking-identity" ? "Checking your device…" : "Enrolling you to vote…"}</Text>
      </View>
    );
  }

  if (status === "creating-identity") {
    return (
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} style={styles.screen}>
        <View style={{ flex: 1, justifyContent: "center" }}>
          <FadeIn>
            <Text style={{ fontSize: 48, textAlign: "center", marginBottom: 16 }}>🔐</Text>
            <Text style={[styles.title, { textAlign: "center" }]}>Finish setting up SL Vote</Text>
            <Text style={[styles.subtitle, { textAlign: "center" }]}>
              You&apos;ve been invited to register to vote. First, a private voting key is created and locked on
              this phone — it never leaves this device.
            </Text>
          </FadeIn>
          <FadeIn delay={150}>
            <GradientButton title="Create my voting identity" icon="🔑" onPress={handleCreateIdentity} />
          </FadeIn>
        </View>
      </ScrollView>
    );
  }

  if (status === "done") {
    return (
      <View style={styles.center}>
        <AnimatedResult
          icon="🎉"
          title={`You're enrolled${divisionName ? ` in ${divisionName}` : ""}!`}
          subtitle="You can now register to vote from the home screen — that step generates your anonymous ballot commitment."
          color={colors.success}
        />
        <GradientButton
          title="Go to Register"
          onPress={() => router.replace("/register")}
          style={{ width: "100%", marginTop: 16 }}
        />
      </View>
    );
  }

  return (
    <View style={styles.center}>
      <GlassCard glow glowColor={colors.warning}>
        <Text style={styles.cardTitle}>⚠️ Couldn&apos;t complete enrolment</Text>
        <Text style={[styles.cardText, { marginTop: 8 }]}>{error}</Text>
      </GlassCard>
      <GradientButton title="Back to home" onPress={() => router.replace("/")} style={{ width: "100%", marginTop: 16 }} />
    </View>
  );
}
