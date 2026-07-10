import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import QRCode from "react-native-qrcode-svg";
import { getBiometricCapability } from "../src/services/keystore";
import { createIdentity, getAddress, hasIdentity } from "../src/services/keystore";
import { colors, styles } from "../src/theme";

export default function Onboarding() {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState(false);
  const [biometricOk, setBiometricOk] = useState(true);

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
      Alert.alert("Copied", "Address copied to clipboard");
    }
  };

  if (!address) {
    return (
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} style={styles.screen}>
        <View style={{ flex: 1, justifyContent: "center" }}>
          <Text style={styles.title}>Welcome 👋</Text>
          <Text style={styles.subtitle}>
            Let&apos;s set up your voting identity. A private key is generated inside your phone&apos;s secure
            hardware and never leaves the device.
          </Text>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>🔐 What happens</Text>
            <Text style={styles.cardText}>
              • A unique key is created in your device&apos;s secure chip{"\n"}• It&apos;s locked behind your
              fingerprint / Face / passcode{"\n"}• You&apos;ll show your address to the GN officer to enrol
            </Text>
          </View>

          {!biometricOk && (
            <View style={[styles.card, { borderColor: colors.warning }]}>
              <Text style={[styles.cardText, { color: colors.warning }]}>
                ⚠️ No biometric/passcode is enrolled on this device. For real elections, set up a screen lock first.
              </Text>
            </View>
          )}

          <TouchableOpacity style={[styles.button, busy && styles.buttonDisabled]} disabled={busy} onPress={handleCreate}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Create my voting identity</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1 }} style={styles.screen}>
      <Text style={styles.title}>Your voting address</Text>
      <Text style={styles.subtitle}>Show this QR to the GN officer so they can add you to the voter roll.</Text>

      <View style={[styles.card, { alignItems: "center" }]}>
        <View style={{ backgroundColor: "#fff", padding: 16, borderRadius: 12 }}>
          <QRCode value={JSON.stringify({ address })} size={200} />
        </View>
        <Text style={[styles.mono, { marginTop: 14, textAlign: "center" }]}>{address}</Text>
        <TouchableOpacity style={styles.buttonOutline} onPress={copyAddress}>
          <Text style={styles.buttonOutlineText}>Copy address</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.button} onPress={() => router.replace("/")}>
        <Text style={styles.buttonText}>Done</Text>
      </TouchableOpacity>
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}
