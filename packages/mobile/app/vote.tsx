import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { router } from "expo-router";
import { api, DivisionState } from "../src/services/api";
import {
  AnimatedResult,
  FadeIn,
  GlassCard,
  GradientButton,
  StepIndicator,
} from "../src/components/ui";
import { newBurnerAccount, submitVote } from "../src/services/chain";
import { deriveFromSecrets } from "../src/services/crypto";
import { authenticate, getSelectedDivision, getVoterSecrets, markVoted } from "../src/services/keystore";
import { generateVoteCallData } from "../src/services/zkproof";
import { colors, styles } from "../src/theme";

type Stage = "auth" | "select" | "confirm" | "submitting" | "done";

const STEPS = ["Authenticate", "Select", "Cast Vote"];

function stageToStep(stage: Stage): number {
  switch (stage) {
    case "auth": return 0;
    case "select":
    case "confirm": return 1;
    case "submitting":
    case "done": return 2;
  }
}

export default function Vote() {
  const [division, setDivision] = useState<DivisionState | null>(null);
  const [stage, setStage] = useState<Stage>("auth");
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState<number | null>(null);
  const [step, setStep] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const election = await api.getElection();
        const chosen = await getSelectedDivision();
        setDivision(
          election.divisions.find(d => d.votingContract.toLowerCase() === chosen?.toLowerCase()) ??
            election.divisions[0] ??
            null,
        );
      } catch {
        /* handled in UI */
      }
    })();
  }, []);

  const authenticateUser = async () => {
    setBusy(true);
    try {
      const ok = await authenticate("Authenticate to vote");
      if (!ok) throw new Error("Authentication cancelled");
      setStage("select");
    } catch (e: any) {
      Alert.alert("Authentication failed", e?.message ?? "Try again");
    } finally {
      setBusy(false);
    }
  };

  // Trigger auth automatically when the division loads
  useEffect(() => {
    if (stage === "auth" && division) {
      // Small delay so the user sees the "Waiting for device authentication" state
      const t = setTimeout(() => authenticateUser(), 300);
      return () => clearTimeout(t);
    }
  }, [stage, division]);

  const castVote = async () => {
    if (!division || candidate === null) return;
    setStage("submitting");
    try {
      setStep("Unlocking your secrets…");
      const secrets = await getVoterSecrets();
      if (!secrets) throw new Error("No registration found on this device");

      const { commitment } = deriveFromSecrets(secrets.nullifier, secrets.secret);

      setStep("Checking your registration…");
      const path = await api.getMerklePath(division.votingContract, commitment);

      setStep("Generating secure anonymous proof…");
      const callData = await generateVoteCallData({
        nullifier: secrets.nullifier,
        secret: secrets.secret,
        circuitIndex: path.circuitIndex,
        siblings: path.siblings,
        root: path.root,
        candidateIndex: candidate,
        depth: path.depth,
      });

      const burner = newBurnerAccount();
      setStep("Preparing anonymous wallet…");
      await api.fundBurner(burner.address).catch(() => {
        throw new Error("Could not fund the anonymous wallet (is the local faucet running?)");
      });

      setStep("Casting your anonymous ballot…");
      await submitVote(division.votingContract, callData, burner.privateKey);

      await markVoted(division.votingContract);
      setStage("done");
    } catch (e: any) {
      setStage("select");
      Alert.alert("Vote failed", e?.shortMessage ?? e?.message ?? "Please try again");
    }
  };

  if (stage === "done") {
    return (
      <View style={styles.center}>
        <AnimatedResult
          icon="🗳️"
          title="Vote cast!"
          subtitle="Your vote was submitted securely and anonymously. No one can see who you voted for."
          color={colors.success}
        />
        <GradientButton
          title="Done"
          variant="success"
          icon="✅"
          onPress={() => router.replace("/")}
          style={{ width: "100%", marginTop: 16 }}
        />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen}>
      <FadeIn>
        <Text style={styles.title}>Cast your vote</Text>
      </FadeIn>

      {/* Step indicator */}
      <FadeIn delay={50}>
        <StepIndicator steps={STEPS} currentStep={stageToStep(stage)} />
      </FadeIn>

      {/* Auth */}
      {stage === "auth" && (
        <FadeIn>
          <GlassCard style={{ alignItems: "center", paddingVertical: 40 }}>
            {busy ? (
              <>
                <ActivityIndicator size="large" color={colors.primary} />
                <Text style={[styles.cardText, { marginTop: 20, textAlign: "center", fontSize: 14 }]}>
                  Waiting for device authentication…
                </Text>
              </>
            ) : (
              <>
                <Text style={[styles.cardTitle, { textAlign: "center" }]}>🔒 Authentication Required</Text>
                <Text style={[styles.cardText, { marginTop: 8, textAlign: "center", marginBottom: 20 }]}>
                  Please authenticate to access your voting key.
                </Text>
                <GradientButton
                  title="Try Again"
                  icon="🔐"
                  onPress={authenticateUser}
                  style={{ width: "100%" }}
                />
              </>
            )}
          </GlassCard>
        </FadeIn>
      )}

      {/* Select candidate */}
      {(stage === "select" || stage === "confirm") && division && (
        <FadeIn>
          <GlassCard>
            <Text style={styles.cardTitle}>{division.name}</Text>
            <Text style={styles.cardText}>{division.question}</Text>
          </GlassCard>

          {division.candidates.map((name, idx) => {
            const selected = candidate === idx;
            return (
              <TouchableOpacity
                key={name}
                activeOpacity={0.7}
                onPress={() => {
                  setCandidate(idx);
                  setStage("select");
                }}
                style={[
                  styles.card,
                  selected && {
                    borderColor: colors.primary,
                    backgroundColor: colors.primary + "15",
                  },
                ]}
              >
                <View style={styles.row}>
                  <View
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 14,
                      borderWidth: 2,
                      borderColor: selected ? colors.primary : colors.cardBorder,
                      backgroundColor: selected ? colors.primary : "transparent",
                      alignItems: "center",
                      justifyContent: "center",
                      marginRight: 14,
                    }}
                  >
                    {selected && (
                      <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>✓</Text>
                    )}
                  </View>
                  <Text
                    style={{
                      fontSize: 16,
                      fontWeight: selected ? "700" : "500",
                      color: selected ? colors.text : colors.textSecondary,
                    }}
                  >
                    {name}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}

          {/* Confirm before casting */}
          {candidate !== null && stage === "select" && (
            <GradientButton
              title={`Vote for ${division.candidates[candidate]}`}
              variant="success"
              icon="🗳️"
              onPress={() => setStage("confirm")}
            />
          )}

          {stage === "confirm" && candidate !== null && (
            <FadeIn>
              <GlassCard glow glowColor={colors.warning}>
                <Text style={[styles.cardTitle, { textAlign: "center" }]}>⚠️ Confirm your vote</Text>
                <Text style={[styles.cardText, { textAlign: "center", marginTop: 8 }]}>
                  You&apos;re about to cast an anonymous vote for{" "}
                  <Text style={{ fontWeight: "700", color: colors.text }}>
                    {division.candidates[candidate]}
                  </Text>
                  . This action is irreversible.
                </Text>
                <GradientButton
                  title="Cast anonymous vote"
                  variant="success"
                  icon="🗳️"
                  onPress={castVote}
                  style={{ marginTop: 16 }}
                />
                <TouchableOpacity
                  style={[styles.buttonOutline, { marginTop: 8 }]}
                  onPress={() => setStage("select")}
                >
                  <Text style={styles.buttonOutlineText}>← Change selection</Text>
                </TouchableOpacity>
              </GlassCard>
            </FadeIn>
          )}
        </FadeIn>
      )}

      {/* Submitting */}
      {stage === "submitting" && (
        <FadeIn>
          <GlassCard style={{ alignItems: "center", paddingVertical: 40 }}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.cardText, { marginTop: 20, textAlign: "center", fontSize: 14 }]}>
              {step}
            </Text>
            <Text style={[styles.cardText, { marginTop: 8, fontSize: 11, opacity: 0.5 }]}>
              Please don&apos;t close the app
            </Text>
          </GlassCard>
        </FadeIn>
      )}
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}
