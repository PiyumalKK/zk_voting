import { useEffect, useState } from "react";
import { Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { router } from "expo-router";
import { getAddress, wipeIdentity } from "../src/services/keystore";
import { colors, styles } from "../src/theme";

export default function Settings() {
  const [address, setAddress] = useState<string | null>(null);

  useEffect(() => {
    (async () => setAddress(await getAddress()))();
  }, []);

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
      <Text style={styles.title}>Settings</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Your voting address</Text>
        <Text style={styles.mono}>{address}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>About</Text>
        <Text style={styles.cardText}>
          SL Vote — anonymous, verifiable voting. Your key lives in your phone&apos;s secure hardware and never leaves
          the device. Votes are cast through zero-knowledge proofs.
        </Text>
      </View>

      <TouchableOpacity style={[styles.buttonOutline, { borderColor: colors.danger }]} onPress={confirmWipe}>
        <Text style={[styles.buttonOutlineText, { color: colors.danger }]}>Erase identity from this device</Text>
      </TouchableOpacity>
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}
