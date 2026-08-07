import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { router } from "expo-router";
import { api, DivisionState } from "../src/services/api";
import {
  AnimatedResult,
  FadeIn,
  GlassCard,
  GradientButton,
  StatusBadge,
  StepIndicator,
} from "../src/components/ui";
import { submitRegister } from "../src/services/chain";
import { deriveFromSecrets, generateCommitment } from "../src/services/crypto";
import {
  authenticate,
  getAddress,
  getPrivateKey,
  getVoterSecrets,
  hasRegisteredLocally,
  markRegistered,
  resolveSelectedDivision,
  storeVoterSecrets,
} from "../src/services/keystore";
import { colors, styles } from "../src/theme";

type Status = "idle" | "working" | "done";

const STEPS = ["Authenticate", "Commitment", "Fund", "Submit"];

export default function Register() {
  const [division, setDivision] = useState<DivisionState | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [currentStep, setCurrentStep] = useState(0);
  const [stepStatus, setStepStatus] = useState<"active" | "done" | "error">("active");
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);

  useEffect(() => {
    (async () => {
      setAlreadyRegistered(await hasRegisteredLocally());
      try {
        const election = await api.getElection();
        setDivision(await resolveSelectedDivision(election.divisions));
      } catch {
        /* handled in UI */
      }
    })();
  }, []);

  const handleRegister = async () => {
    if (!division) return;
    setStatus("working");
    setCurrentStep(0);
    setStepStatus("active");
    let failedStep = "start";
    try {
      // Step 0: Authenticate
      failedStep = "authenticate";
      setCurrentStep(0);
      const ok = await authenticate("Authenticate to register");
      if (!ok) throw new Error("Authentication cancelled");

      // Step 1: Commitment
      failedStep = "prepare keys";
      setCurrentStep(1);
      const existing = await getVoterSecrets();
      let commitmentValue: string;
      if (existing) {
        commitmentValue = deriveFromSecrets(existing.nullifier, existing.secret).commitment;
      } else {
        const c = generateCommitment();
        await storeVoterSecrets(c.nullifier, c.secret);
        commitmentValue = c.commitment;
      }

      // Step 2: Fund
      failedStep = "fund wallet";
      setCurrentStep(2);
      const voterAddress = await getAddress();
      if (!voterAddress) throw new Error("No voting identity on this device");
      // Best-effort, as in `vote.tsx`: the custom chain charges no gas, so a
      // faucet failure must not be reported to the voter as a failed
      // registration. An unpayable transaction fails at submission with a
      // message that names the real cause.
      await api.tryFundBurner(voterAddress);

      // Step 3: Submit on-chain
      failedStep = "submit registration";
      setCurrentStep(3);
      const pk = await getPrivateKey();
      await submitRegister(division.votingContract, commitmentValue, pk);

      await markRegistered();
      setStepStatus("done");
      setStatus("done");
    } catch (e: any) {
      setStatus("idle");
      setStepStatus("error");
      const detail = e?.shortMessage ?? e?.message ?? String(e);
      const lowerDetail = detail.toLowerCase();

      let hint = "";
      if (failedStep.startsWith("submitRegister")) {
        const isTimeout =
          lowerDetail.includes("timeout") ||
          lowerDetail.includes("took too long") ||
          lowerDetail.includes("network") ||
          lowerDetail.includes("econnrefused") ||
          lowerDetail.includes("fetch failed") ||
          lowerDetail.includes("econnreset");

        if (isTimeout) {
          hint =
            "\n\nCould not connect to the network. Please check your internet connection and try again.";
        } else {
          hint =
            "\n\nWe couldn't verify your eligibility for this division. " +
            "Please make sure you selected the exact division your GN officer registered you for.";
        }
      }
      Alert.alert(`Registration failed (${failedStep})`, `${detail}${hint}`);
    }
  };

  if (alreadyRegistered) {
    return (
      <View style={styles.center}>
        <AnimatedResult
          icon="✅"
          title="Already registered"
          subtitle="Your secure registration is saved on your phone. You can vote when voting opens."
          color={colors.success}
        />
        <GradientButton
          title="Back to home"
          onPress={() => router.replace("/")}
          style={{ width: "100%", marginTop: 16 }}
        />
      </View>
    );
  }

  if (status === "done") {
    return (
      <View style={styles.center}>
        <AnimatedResult
          icon="🎉"
          title="You're registered!"
          subtitle={`Your registration is now secure in the ${division?.name} system. Come back during the Voting phase to cast your secret ballot.`}
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
        <Text style={styles.title}>Register to vote</Text>
        <Text style={styles.subtitle}>
          This creates a private record that proves you are allowed to vote, while keeping your choices completely secret.
        </Text>
      </FadeIn>

      {division && (
        <FadeIn delay={50}>
          <GlassCard glow={division.phase === 1}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>{division.name}</Text>
              <StatusBadge phase={division.phase} />
            </View>
            <Text style={[styles.cardText, { marginTop: 8 }]}>{division.question}</Text>
          </GlassCard>
        </FadeIn>
      )}

      {status === "working" && (
        <FadeIn>
          <GlassCard>
            <StepIndicator steps={STEPS} currentStep={currentStep} status={stepStatus} />
            <View style={{ alignItems: "center", paddingVertical: 16 }}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={[styles.cardText, { marginTop: 16, textAlign: "center" }]}>
                {STEPS[currentStep]}…
              </Text>
            </View>
          </GlassCard>
        </FadeIn>
      )}

      <FadeIn delay={100}>
        <GlassCard>
          <Text style={styles.cardTitle}>🔒 What stays private</Text>
          <Text style={styles.cardText}>
            Your secret voting keys are locked inside your phone. Only a public anonymous proof is sent to the blockchain, keeping your identity perfectly safe.
          </Text>
        </GlassCard>
      </FadeIn>

      {status === "idle" && (
        <FadeIn delay={150}>
          <GradientButton
            title="Register now"
            icon="📝"
            disabled={division?.phase !== 1}
            onPress={handleRegister}
          />
        </FadeIn>
      )}
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}
