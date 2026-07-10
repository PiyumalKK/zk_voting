import { useCallback, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, DivisionState } from "../src/services/api";
import {
  getAddress,
  getSelectedDivision,
  hasIdentity,
  hasRegisteredLocally,
  hasVoted,
  setSelectedDivision,
} from "../src/services/keystore";
import { colors, styles } from "../src/theme";

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [address, setAddress] = useState<string | null>(null);
  const [allDivisions, setAllDivisions] = useState<DivisionState[]>([]);
  const [division, setDivision] = useState<DivisionState | null>(null);
  const [registeredLocal, setRegisteredLocal] = useState(false);
  const [voted, setVoted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!(await hasIdentity())) {
        router.replace("/onboarding");
        return;
      }
      const addr = await getAddress();
      setAddress(addr);
      setRegisteredLocal(await hasRegisteredLocally());

      const election = await api.getElection();
      setAllDivisions(election.divisions);

      // Use the voter's chosen division; default to the first if none chosen yet.
      const chosen = await getSelectedDivision();
      const div =
        election.divisions.find(d => d.votingContract.toLowerCase() === chosen?.toLowerCase()) ??
        election.divisions[0] ??
        null;
      setDivision(div);
      if (div) setVoted(await hasVoted(div.votingContract));
    } catch (e: any) {
      setError(e?.message ?? "Could not reach the election service");
    } finally {
      setLoading(false);
    }
  }, []);

  const pickDivision = async (div: DivisionState) => {
    await setSelectedDivision(div.votingContract);
    setDivision(div);
    setVoted(await hasVoted(div.votingContract));
  };

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={[styles.cardText, { marginTop: 12 }]}>Loading election…</Text>
      </View>
    );
  }

  const phase = division?.phase ?? 0;
  const canRegister = phase === 1 && !registeredLocal;
  const canVote = phase === 2 && registeredLocal && !voted;

  return (
    <ScrollView
      style={styles.screen}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={colors.primary} />}
    >
      <Text style={styles.title}>🇱🇰 SL Vote</Text>
      <Text style={styles.subtitle}>Your anonymous ballot, secured by your phone.</Text>

      {error && (
        <View style={[styles.card, { borderColor: colors.danger }]}>
          <Text style={[styles.cardText, { color: colors.danger }]}>⚠️ {error}</Text>
        </View>
      )}

      {/* Identity card */}
      <View style={styles.card}>
        <Text style={styles.label}>Your voting address</Text>
        <Text style={styles.mono}>{address}</Text>
        <TouchableOpacity style={styles.buttonOutline} onPress={() => router.push("/onboarding")}>
          <Text style={styles.buttonOutlineText}>Show QR for GN officer</Text>
        </TouchableOpacity>
      </View>

      {/* Division picker — the voter chooses their division */}
      <View style={styles.card}>
        <Text style={styles.label}>Your division</Text>
        <Text style={[styles.cardText, { marginBottom: 10 }]}>
          Pick the division your GN officer registered you in. Registering in the wrong division will be rejected.
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {allDivisions.map(d => {
            const active = division?.votingContract === d.votingContract;
            return (
              <TouchableOpacity
                key={d.votingContract}
                onPress={() => pickDivision(d)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: active ? colors.primary : colors.cardBorder,
                  backgroundColor: active ? "#1E3A5F" : "transparent",
                }}
              >
                <Text style={{ color: colors.text, fontWeight: active ? "700" : "500" }}>
                  {active ? "🔵 " : ""}
                  {d.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Election status */}
      {division && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{division.name}</Text>
          <Text style={styles.cardText}>{division.question}</Text>
          <View
            style={[
              styles.badge,
              { backgroundColor: phase === 2 ? colors.success : phase === 1 ? colors.primary : "#33415588" },
            ]}
          >
            <Text style={[styles.badgeText, { color: "#fff" }]}>{division.phaseLabel} phase</Text>
          </View>
        </View>
      )}

      {/* Registration status */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Registration</Text>
        <Text style={styles.cardText}>
          {registeredLocal
            ? "✅ You have registered your commitment on this device."
            : "You have not registered yet. Register during the Registration phase."}
        </Text>
        <TouchableOpacity
          style={[styles.button, !canRegister && styles.buttonDisabled]}
          disabled={!canRegister}
          onPress={() => router.push("/register")}
        >
          <Text style={styles.buttonText}>{registeredLocal ? "Already registered" : "Register to vote"}</Text>
        </TouchableOpacity>
      </View>

      {/* Vote */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Vote</Text>
        <Text style={styles.cardText}>
          {voted
            ? "✅ Your vote has been cast anonymously."
            : phase === 2
              ? "Voting is open. Cast your anonymous ballot."
              : "Voting has not opened yet."}
        </Text>
        <TouchableOpacity
          style={[styles.button, !canVote && styles.buttonDisabled]}
          disabled={!canVote}
          onPress={() => router.push("/vote")}
        >
          <Text style={styles.buttonText}>{voted ? "Vote cast" : "Cast your vote"}</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.buttonOutline} onPress={() => router.push("/settings")}>
        <Text style={styles.buttonOutlineText}>Settings</Text>
      </TouchableOpacity>
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}
