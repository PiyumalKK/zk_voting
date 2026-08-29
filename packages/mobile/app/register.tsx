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
import { loadVoterDivision } from "../src/services/division";
import {
  authenticate,
  getAddress,
  getPrivateKey,
  getVoterSecrets,
  hasRegisteredLocally,
  markRegistered,
  storeVoterSecrets,
} from "../src/services/keystore";
import { colors, styles } from "../src/theme";

type Status = "idle" | "working" | "done";

/**
 * The gas top-up is deliberately NOT one of these.
 *
 * `/api/faucet` is dev-only and refuses any chain outside `FAUCET_CHAIN_IDS`;
 * the custom chain prices gas at zero, so the top-up changes nothing there; and
 * `api.tryFundBurner` swallows its own failures by design. A progress step
 * whose outcome nothing reads is noise — and "Fund" in particular reads to a
 * voter as though registering costs money, which it never does. `vote.tsx`
 * hides the identical call under "Preparing anonymous wallet…" for the same
 * reason.
 */
const STEPS = ["Authenticate", "Commitment", "Submit"];

export default function Register() {
  const [division, setDivision] = useState<DivisionState | null>(null);
  const [notEnrolled, setNotEnrolled] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [currentStep, setCurrentStep] = useState(0);
  const [stepStatus, setStepStatus] = useState<"active" | "done" | "error">("active");
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  const [superseded, setSuperseded] = useState(false);
  const [nicRegistered, setNicRegistered] = useState(false);
  const [notEnrolledDevice, setNotEnrolledDevice] = useState(false);

  useEffect(() => {
    (async () => {
      setAlreadyRegistered(await hasRegisteredLocally());
      try {
        const {
          division: div,
          notEnrolled: none,
          deviceSuperseded,
          deviceEnrolled,
          device,
        } = await loadVoterDivision();
        setDivision(div);
        setNotEnrolled(none);
        setSuperseded(deviceSuperseded);
        setNotEnrolledDevice(!deviceEnrolled && !deviceSuperseded);
        setNicRegistered(Boolean(device?.nicRegistered));
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

      // Step 2: Submit on-chain, topping the wallet up on the way in.
      failedStep = "prepare wallet";
      setCurrentStep(2);
      const voterAddress = await getAddress();
      if (!voterAddress) throw new Error("No voting identity on this device");
      // Best-effort, as in `vote.tsx`: the custom chain charges no gas, so a
      // faucet failure must not be reported to the voter as a failed
      // registration. An unpayable transaction fails at submission with a
      // message that names the real cause.
      await api.tryFundBurner(voterAddress);

      failedStep = "submit registration";
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
      // Matches the exact label set above the failing call. This used to test
      // `startsWith("submitRegister")` against a `failedStep` of "submit
      // registration" — which never matched, so every failed registration
      // showed the raw chain error and none of the advice below.
      if (failedStep === "submit registration") {
        const isTimeout =
          lowerDetail.includes("timeout") ||
          lowerDetail.includes("took too long") ||
          lowerDetail.includes("network") ||
          lowerDetail.includes("econnrefused") ||
          lowerDetail.includes("fetch failed") ||
          lowerDetail.includes("econnreset");

        // `submitRegister` now decodes the contract's own reason for a revert
        // and throws it as the message — "this phone was replaced" reads very
        // differently from "ask your officer to add you", and the generic advice
        // would be actively wrong for it. Only fall back when the failure is
        // something we could not identify.
        const isExplained =
          lowerDetail.includes("no longer your registered device") ||
          lowerDetail.includes("already registered for this election") ||
          lowerDetail.includes("has not been enrolled") ||
          lowerDetail.includes("enrolment records were reset") ||
          lowerDetail.includes("registration is not open");

        if (isTimeout) {
          hint =
            "\n\nCould not connect to the network. Please check your internet connection and try again.";
        } else if (!isExplained) {
          hint =
            "\n\nWe couldn't verify your eligibility for this division. " +
            "Ask your GN officer to confirm they added this phone's voting address to the roll.";
        }
      }
      Alert.alert(`Registration failed (${failedStep})`, `${detail}${hint}`);
    }
  };

  // Checked before `alreadyRegistered`, because a replaced phone may well have
  // no local registration flag and would otherwise fall through to the form.
  //
  // The point of doing this here rather than at the revert is what it saves the
  // voter: a biometric prompt, a generated commitment written to the keystore,
  // and a transaction — all of it spent to arrive at a refusal the chain could
  // have told us about before they touched anything.
  if (superseded) {
    return (
      <View style={styles.center}>
        <AnimatedResult
          icon="📵"
          title="This phone has been replaced"
          subtitle={
            nicRegistered
              ? "Your GN officer issued you a replacement phone, and it has already registered. Use that phone to vote — this one cannot register."
              : "Your GN officer issued you a replacement phone. Registration has moved to it, and this phone can no longer take part. If you did not ask for a replacement, contact your GN officer."
          }
          color={colors.warning}
        />
        <GradientButton
          title="Back to home"
          onPress={() => router.replace("/")}
          style={{ width: "100%", marginTop: 16 }}
        />
      </View>
    );
  }

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

      {notEnrolledDevice && (
        <FadeIn delay={50}>
          <GlassCard glow glowColor={colors.warning}>
            <Text style={styles.cardTitle}>🪪 Enrolment not finished</Text>
            <Text style={[styles.cardText, { marginTop: 8 }]}>
              Your address is on the voter roll, but no GN officer has verified your NIC against this phone.
              Registration needs both, so it would be refused. Show your QR code to your officer to finish enrolling.
            </Text>
          </GlassCard>
        </FadeIn>
      )}

      {notEnrolled && (
        <FadeIn delay={50}>
          <GlassCard glow glowColor={colors.warning}>
            <Text style={styles.cardTitle}>⏳ Not enrolled yet</Text>
            <Text style={[styles.cardText, { marginTop: 8 }]}>
              Your voting address is not on any division&apos;s roll. Show your QR code to your GN
              officer first — your division is then set automatically.
            </Text>
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
            disabled={!division || division.phase !== 1 || notEnrolledDevice}
            onPress={handleRegister}
          />
        </FadeIn>
      )}
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}
