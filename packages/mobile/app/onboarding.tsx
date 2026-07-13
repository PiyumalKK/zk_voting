import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import QRCode from "react-native-qrcode-svg";
import { AnimatedResult, FadeIn, GlassCard, GradientButton } from "../src/components/ui";
import { getBiometricCapability } from "../src/services/keystore";
import { createIdentity, getAddress, hasIdentity } from "../src/services/keystore";
import { colors, styles } from "../src/theme";

export default function Onboarding() {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState(false);
  const [biometricOk, setBiometricOk] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      const cap = await getBiometricCapability();
      setBiometricOk(cap.supported);
      if (await hasIdentity()) setAddress(await getAddress());
    })();
  }, []);

  const handleCreate = async () => {
    setBusy(true);
    try {
      const addr = await createIdentity();
      setAddress(addr);
    } catch (e: any) {
      Alert.alert("Setup failed", e?.message ?? "Could not create your identity");
    } finally {
      setBusy(false);
    }
  };

  const copyAddress = async () => {
    if (address) {
      await Clipboard.setStringAsync(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!address) {
    return (
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} style={styles.screen}>
        <View style={{ flex: 1, justifyContent: "center" }}>
          <FadeIn>
            <Text style={{ fontSize: 48, textAlign: "center", marginBottom: 16 }}>🔐</Text>
            <Text style={[styles.title, { textAlign: "center" }]}>Welcome to SL Vote</Text>
            <Text style={[styles.subtitle, { textAlign: "center" }]}>
              Let&apos;s set up your secure voting identity. Your private voting key is safely created inside your phone.
            </Text>
          </FadeIn>

          <FadeIn delay={100}>
            <GlassCard>
              <Text style={styles.cardTitle}>What happens</Text>
              <View style={{ gap: 12, marginTop: 4 }}>
                <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                  <Text style={{ fontSize: 20 }}>🔑</Text>
                  <Text style={styles.cardText}>
                    A secure voting key is created and locked on your phone
                  </Text>
                </View>
                <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                  <Text style={{ fontSize: 20 }}>👆</Text>
                  <Text style={styles.cardText}>
                    It&apos;s locked behind your fingerprint / Face / passcode
                  </Text>
                </View>
                <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                  <Text style={{ fontSize: 20 }}>📱</Text>
                  <Text style={styles.cardText}>
                    Show your screen to the GN officer to get registered
                  </Text>
                </View>
              </View>
            </GlassCard>
          </FadeIn>

          {!biometricOk && (
            <FadeIn delay={150}>
              <GlassCard glow glowColor={colors.warning}>
                <Text style={[styles.cardText, { color: colors.warning }]}>
                  ⚠️ No biometric/passcode is enrolled on this device. For real elections, set up a
                  screen lock first.
                </Text>
              </GlassCard>
            </FadeIn>
          )}

          <FadeIn delay={200}>
            <GradientButton
              title="Create my voting identity"
              icon="🔑"
              loading={busy}
              disabled={busy}
              onPress={handleCreate}
            />
          </FadeIn>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1 }} style={styles.screen}>
      <FadeIn>
        <Text style={styles.title}>Your voting address</Text>
        <Text style={styles.subtitle}>
          Show this QR code to the GN officer to complete your registration.
        </Text>
      </FadeIn>

      <FadeIn delay={100}>
        <GlassCard glow style={{ alignItems: "center" }}>
          <View
            style={{
              backgroundColor: "#fff",
              padding: 20,
              borderRadius: 16,
              marginBottom: 16,
            }}
          >
            <QRCode value={JSON.stringify({ address })} size={200} />
          </View>
          <Text style={[styles.mono, { textAlign: "center", marginBottom: 12 }]}>{address}</Text>
          <TouchableOpacity
            style={[
              styles.buttonOutline,
              copied && { borderColor: colors.success, backgroundColor: colors.success + "10" },
            ]}
            onPress={copyAddress}
          >
            <Text
              style={[
                styles.buttonOutlineText,
                copied && { color: colors.success },
              ]}
            >
              {copied ? "✓ Copied!" : "📋 Copy address"}
            </Text>
          </TouchableOpacity>
        </GlassCard>
      </FadeIn>

      <FadeIn delay={200}>
        <GradientButton
          title="Done"
          icon="✅"
          onPress={() => router.replace("/")}
        />
      </FadeIn>
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}
