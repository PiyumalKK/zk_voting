import { useEffect, useState } from "react";
import { Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { FadeIn, GlassCard, GradientButton } from "../src/components/ui";
import { getAddress, wipeIdentity } from "../src/services/keystore";
import { colors, styles } from "../src/theme";

export default function Settings() {
  const [address, setAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => setAddress(await getAddress()))();
  }, []);

  const copyAddress = async () => {
    if (address) {
      await Clipboard.setStringAsync(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const confirmWipe = () => {
    Alert.alert(
      "Erase voting identity?",
      "This permanently deletes your key and registration from this device. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Erase",
          style: "destructive",
          onPress: async () => {
            await wipeIdentity();
            router.replace("/onboarding");
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={styles.screen}>
      <FadeIn>
        <Text style={styles.title}>Settings</Text>
      </FadeIn>

      {/* Identity */}
      <FadeIn delay={50}>
        <Text style={styles.sectionTitle}>Identity</Text>
        <GlassCard>
          <Text style={styles.label}>Your voting address</Text>
          <Text style={[styles.mono, { marginTop: 4, marginBottom: 12 }]}>{address}</Text>
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
          <TouchableOpacity
            style={[styles.buttonOutline, { marginTop: 8 }]}
            onPress={() => router.push("/onboarding")}
          >
            <Text style={styles.buttonOutlineText}>📱 Show QR code</Text>
          </TouchableOpacity>
        </GlassCard>
      </FadeIn>

      {/* About */}
      <FadeIn delay={100}>
        <Text style={styles.sectionTitle}>About</Text>
        <GlassCard>
          <Text style={[styles.cardTitle, { marginBottom: 8 }]}>🇱🇰 SL Vote</Text>
          <Text style={styles.cardText}>
            Anonymous, verifiable voting for Sri Lanka. Your key lives in your phone&apos;s secure
            hardware and never leaves the device. Votes are cast through zero-knowledge proofs.
          </Text>
          <View style={[styles.divider, { marginVertical: 16 }]} />
          <View style={{ gap: 6 }}>
            <View style={styles.rowBetween}>
              <Text style={[styles.cardText, { opacity: 0.6 }]}>Project</Text>
              <Text style={styles.cardText}>Privacy-Preserving E-Voting</Text>
            </View>
            <View style={styles.rowBetween}>
              <Text style={[styles.cardText, { opacity: 0.6 }]}>Institution</Text>
              <Text style={styles.cardText}>University of Ruhuna</Text>
            </View>
            <View style={styles.rowBetween}>
              <Text style={[styles.cardText, { opacity: 0.6 }]}>Tech</Text>
              <Text style={styles.cardText}>Noir ZK + Solidity + React Native</Text>
            </View>
          </View>
        </GlassCard>
      </FadeIn>

      {/* Danger Zone */}
      <FadeIn delay={150}>
        <Text style={[styles.sectionTitle, { color: colors.danger }]}>Danger zone</Text>
        <GlassCard glow glowColor={colors.danger}>
          <Text style={styles.cardTitle}>🗑️ Erase identity</Text>
          <Text style={[styles.cardText, { marginBottom: 12 }]}>
            Permanently delete your private key, commitment secrets, and all local data from this
            device. You will not be able to recover your voting identity.
          </Text>
          <TouchableOpacity style={styles.buttonDanger} onPress={confirmWipe}>
            <Text style={[styles.buttonOutlineText, { color: colors.danger }]}>
              ⚠️ Erase identity from this device
            </Text>
          </TouchableOpacity>
        </GlassCard>
      </FadeIn>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}
