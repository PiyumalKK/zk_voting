import { useCallback, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, DivisionState } from "../src/services/api";
import {
  FadeIn,
  GlassCard,
  GradientButton,
  StatusBadge,
} from "../src/components/ui";
import {
  getAddress,
  hasIdentity,
  hasRegisteredLocally,
  hasVoted,
  resolveSelectedDivision,
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

      const div = await resolveSelectedDivision(election.divisions);
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
        <Text style={[styles.cardText, { marginTop: 16 }]}>Loading election…</Text>
      </View>
    );
  }

  const phase = division?.phase ?? 0;
  const canRegister = phase === 1 && !registeredLocal;
  const canVote = phase === 2 && registeredLocal && !voted;

  // Journey steps
  const journeySteps = [
    { key: "identity", icon: "🔑", label: "Identity", done: true },
    { key: "division", icon: "🏛️", label: "Division", done: !!division },
    { key: "register", icon: "📝", label: "Register", done: registeredLocal },
    { key: "vote", icon: "🗳️", label: "Vote", done: voted },
  ];

  return (
    <ScrollView
      style={styles.screen}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={colors.primary} />}
    >
      {/* Header */}
      <FadeIn>
        <Text style={styles.title}>🇱🇰 SL Vote</Text>
        <Text style={styles.subtitle}>Your anonymous ballot, secured by your phone.</Text>
      </FadeIn>

      {/* Error */}
      {error && (
        <FadeIn>
          <GlassCard glow glowColor={colors.danger}>
            <Text style={[styles.cardText, { color: colors.danger }]}>⚠️ {error}</Text>
            <TouchableOpacity onPress={load} style={{ marginTop: 8 }}>
              <Text style={{ color: colors.primary, fontWeight: "600", fontSize: 13 }}>
                Tap to retry
              </Text>
            </TouchableOpacity>
          </GlassCard>
        </FadeIn>
      )}

      {/* Journey Progress */}
      <FadeIn delay={50}>
        <GlassCard>
          <Text style={styles.label}>Your journey</Text>
          <View style={{ flexDirection: "row", marginTop: 12, gap: 4 }}>
            {journeySteps.map((step, i) => (
              <View key={step.key} style={{ flex: 1, alignItems: "center" }}>
                <View
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: step.done ? colors.success + "20" : colors.cardBorder + "40",
                    alignItems: "center",
                    justifyContent: "center",
                    marginBottom: 6,
                    borderWidth: 1.5,
                    borderColor: step.done ? colors.success + "50" : "transparent",
                  }}
                >
                  <Text style={{ fontSize: 16 }}>{step.done ? "✓" : step.icon}</Text>
                </View>
                <Text
                  style={{
                    fontSize: 10,
                    color: step.done ? colors.success : colors.muted,
                    fontWeight: step.done ? "600" : "400",
                  }}
                >
                  {step.label}
                </Text>
                {i < journeySteps.length - 1 && (
                  <View
                    style={{
                      position: "absolute",
                      top: 18,
                      left: "75%",
                      width: "50%",
                      height: 2,
                      backgroundColor: step.done ? colors.success + "30" : colors.cardBorder,
                    }}
                  />
                )}
              </View>
            ))}
          </View>
        </GlassCard>
      </FadeIn>

      {/* Identity Card */}
      <FadeIn delay={100}>
        <GlassCard>
          <Text style={styles.label}>Your voting address</Text>
          <Text style={[styles.mono, { marginTop: 4, marginBottom: 8 }]}>{address}</Text>
          <TouchableOpacity
            style={styles.buttonOutline}
            onPress={() => router.push("/onboarding")}
          >
            <Text style={styles.buttonOutlineText}>📱 Show QR for GN officer</Text>
          </TouchableOpacity>
        </GlassCard>
      </FadeIn>

      {/* Division Picker */}
      <FadeIn delay={150}>
        <GlassCard>
          <Text style={styles.label}>Your division</Text>
          <Text style={[styles.cardText, { marginBottom: 12 }]}>
            Pick the division your GN officer registered you in.
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {allDivisions.map(d => {
              const active = division?.votingContract === d.votingContract;
              return (
                <TouchableOpacity
                  key={d.votingContract}
                  onPress={() => pickDivision(d)}
                  activeOpacity={0.7}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 11,
                    borderRadius: 12,
                    borderWidth: 1.5,
                    borderColor: active ? colors.primary : colors.cardBorder,
                    backgroundColor: active ? colors.primary + "15" : "transparent",
                  }}
                >
                  <Text
                    style={{
                      color: active ? colors.primaryLight : colors.textSecondary,
                      fontWeight: active ? "700" : "500",
                      fontSize: 14,
                    }}
                  >
                    {active ? "● " : ""}
                    {d.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </GlassCard>
      </FadeIn>

      {/* Election Status */}
      {division && (
        <FadeIn delay={200}>
          <GlassCard glow={phase === 1 || phase === 2}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>{division.name}</Text>
              <StatusBadge phase={phase} />
            </View>
            <Text style={[styles.cardText, { marginTop: 8 }]}>{division.question}</Text>
            {division.registeredVoters > 0 && (
              <View style={[styles.row, { marginTop: 12, gap: 16 }]}>
                <View>
                  <Text style={{ fontSize: 20, fontWeight: "800", color: colors.text }}>
                    {division.registeredVoters}
                  </Text>
                  <Text style={styles.label}>Registered</Text>
                </View>
                <View>
                  <Text style={{ fontSize: 20, fontWeight: "800", color: colors.text }}>
                    {division.totalVotes}
                  </Text>
                  <Text style={styles.label}>Votes</Text>
                </View>
              </View>
            )}
          </GlassCard>
        </FadeIn>
      )}

      {/* Registration */}
      <FadeIn delay={250}>
        <GlassCard>
          <Text style={styles.cardTitle}>
            {registeredLocal ? "✅ Registered" : "📝 Registration"}
          </Text>
          <Text style={styles.cardText}>
            {registeredLocal
              ? "Your secure registration is saved on your phone."
              : "You are not registered yet. Please register during the Registration phase."}
          </Text>
          <GradientButton
            title={registeredLocal ? "Already registered" : "Register to vote"}
            icon={registeredLocal ? "✅" : "📝"}
            disabled={!canRegister}
            onPress={() => router.push("/register")}
            style={{ marginTop: 12 }}
          />
        </GlassCard>
      </FadeIn>

      {/* Vote */}
      <FadeIn delay={300}>
        <GlassCard glow={canVote} glowColor={colors.success}>
          <Text style={styles.cardTitle}>
            {voted ? "✅ Vote cast" : "🗳️ Vote"}
          </Text>
          <Text style={styles.cardText}>
            {voted
              ? "Your vote has been cast anonymously."
              : phase === 2
                ? "Voting is open. Cast your anonymous ballot."
                : "Voting has not opened yet."}
          </Text>
          <GradientButton
            title={voted ? "Vote cast" : "Cast your vote"}
            variant={canVote ? "success" : "primary"}
            icon={voted ? "✅" : "🗳️"}
            disabled={!canVote}
            onPress={() => router.push("/vote")}
            style={{ marginTop: 12 }}
          />
          {voted && (
            <TouchableOpacity
              style={[styles.buttonOutline, { marginTop: 8 }]}
              onPress={() => router.push("/verify")}
            >
              <Text style={styles.buttonOutlineText}>🔍 Verify my vote</Text>
            </TouchableOpacity>
          )}
        </GlassCard>
      </FadeIn>

      {/* Settings */}
      <FadeIn delay={350}>
        <TouchableOpacity style={styles.buttonOutline} onPress={() => router.push("/settings")}>
          <Text style={styles.buttonOutlineText}>⚙️ Settings</Text>
        </TouchableOpacity>
      </FadeIn>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}
