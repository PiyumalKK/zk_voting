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
import { loadVoterDivision } from "../src/services/division";
import {
  hasRegisteredLocally,
  isAuthCancellation,
  markVoted,
  unlockIdentity,
} from "../src/services/keystore";
import { generateVoteCallData } from "../src/services/zkproof";
import { colors, styles } from "../src/theme";

/**
 * There is no "auth" stage any more.
 *
 * The screen used to fire a biometric prompt on entry, unprompted, to unlock a
 * candidate list that is public data — so it protected nothing — and then the
 * gated reads inside `castVote` prompted again. The single prompt now sits on
 * the confirm tap, where the secrets are actually read and where the
 * irreversible thing happens: the fingerprint authorises the ballot, not the
 * screen.
 */
type Stage = "select" | "confirm" | "submitting" | "done";

const STEPS = ["Select", "Confirm", "Cast Vote"];

function stageToStep(stage: Stage): number {
  switch (stage) {
    case "select": return 0;
    case "confirm": return 1;
    case "submitting":
    case "done": return 2;
  }
}

export default function Vote() {
  const [division, setDivision] = useState<DivisionState | null>(null);
  const [stage, setStage] = useState<Stage>("select");
  const [candidate, setCandidate] = useState<number | null>(null);
  const [step, setStep] = useState("");

  useEffect(() => {
    (async () => {
      try {
        setDivision((await loadVoterDivision()).division);
      } catch {
        /* handled in UI */
      }
    })();
  }, []);

  const castVote = async () => {
    if (!division || candidate === null) return;
    setStage("submitting");
    try {
      // The secrets exist from onboarding onwards, so their presence no longer
      // proves anything. The confirmed-on-chain flag is the only honest answer
      // to "has this voter registered?".
      if (!(await hasRegisteredLocally())) {
        throw new Error("No registration found on this device");
      }

      setStep("Unlocking your secrets…");
      const identity = await unlockIdentity("Confirm to cast your vote");

      const { commitment } = deriveFromSecrets(identity.nullifier, identity.secret);

      setStep("Checking your registration…");
      const path = await api.getMerklePath(division.votingContract, commitment);

      setStep("Generating secure anonymous proof…");
      const callData = await generateVoteCallData({
        nullifier: identity.nullifier,
        secret: identity.secret,
        circuitIndex: path.circuitIndex,
        siblings: path.siblings,
        root: path.root,
        candidateIndex: candidate,
        depth: path.depth,
      });

      const burner = newBurnerAccount();
      setStep("Preparing anonymous wallet…");
      // Best-effort: on a zero-gas-price chain the burner needs no balance at
      // all, so a faucet that is down, disabled for this chain, or absent must
      // not stop a vote. If the wallet really cannot pay, the transaction below
      // says so precisely. See `api.tryFundBurner`.
      await api.tryFundBurner(burner.address);

      setStep("Casting your anonymous ballot…");
      await submitVote(division.votingContract, callData, burner.privateKey);

      await markVoted(division.votingContract);
      setStage("done");
    } catch (e: any) {
      // Back to the confirm card rather than the list: the selection is intact,
      // and a voter who dismissed the prompt by mistake is one tap from retrying.
      setStage("confirm");
      if (isAuthCancellation(e)) {
        Alert.alert("Vote not cast", "You did not confirm, so nothing was submitted.");
        return;
      }
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

      {/* The auth card used to occupy this space while the division loaded. */}
      {(stage === "select" || stage === "confirm") && !division && (
        <FadeIn>
          <GlassCard style={{ alignItems: "center", paddingVertical: 40 }}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.cardText, { marginTop: 20, textAlign: "center", fontSize: 14 }]}>
              Loading your ballot…
            </Text>
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
                <Text
                  style={[
                    styles.cardText,
                    { textAlign: "center", marginTop: 8, fontSize: 12, opacity: 0.7 },
                  ]}
                >
                  🔐 Your phone will ask for your fingerprint or Face ID to confirm.
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
