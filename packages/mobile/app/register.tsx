import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { router } from "expo-router";
import { api, DivisionState } from "../src/services/api";
import { submitRegister } from "../src/services/chain";
import { deriveFromSecrets, generateCommitment } from "../src/services/crypto";
import {
  authenticate,
  getAddress,
  getPrivateKey,
  getSelectedDivision,
  getVoterSecrets,
  hasRegisteredLocally,
  markRegistered,
  storeVoterSecrets,
} from "../src/services/keystore";
import { colors, styles } from "../src/theme";

type Status = "idle" | "working" | "done";

export default function Register() {
  const [division, setDivision] = useState<DivisionState | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [step, setStep] = useState("");
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);

  useEffect(() => {
    (async () => {
      setAlreadyRegistered(await hasRegisteredLocally());
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

  const handleRegister = async () => {
    if (!division) return;
    setStatus("working");
    let failedStep = "start";
    try {
      failedStep = "authenticate";
      setStep("Confirming it's you…");
      const ok = await authenticate("Authenticate to register");
      if (!ok) throw new Error("Authentication cancelled");

      // Reuse secrets from a previous (failed) attempt so we don't create a second
      // commitment; otherwise generate fresh ones. Persist BEFORE the tx so a crash
      // never loses them.
      failedStep = "commitment";
      setStep("Preparing your private commitment…");
      const existing = await getVoterSecrets();
      let commitmentValue: string;
      if (existing) {
        commitmentValue = deriveFromSecrets(existing.nullifier, existing.secret).commitment;
      } else {
        const c = generateCommitment();
        await storeVoterSecrets(c.nullifier, c.secret);
        commitmentValue = c.commitment;
      }

      // The voter signs register() with their OWN key, which needs gas. On the local
      // chain, top it up from the dev faucet (production: sponsored by a paymaster).
      failedStep = "get-address";
      setStep("Preparing your wallet…");
      const voterAddress = await getAddress();
      if (!voterAddress) throw new Error("No voting identity on this device");

      failedStep = "fund (faucet)";
      await api.fundBurner(voterAddress);

      failedStep = "get-private-key";
      const pk = await getPrivateKey();

      failedStep = "submitRegister (chain)";
      setStep("Submitting registration on-chain…");
      await submitRegister(division.votingContract, commitmentValue, pk);

      // Only now is the voter truly registered.
      failedStep = "markRegistered";
      await markRegistered();
      setStatus("done");
    } catch (e: any) {
      setStatus("idle");
      const detail = e?.shortMessage ?? e?.message ?? String(e);
      const hint = failedStep.startsWith("submitRegister")
        ? "\n\nThis usually means your address is not allowlisted in this division. Make sure you picked the division your GN officer registered you in."
        : "";
      Alert.alert(`Registration failed (${failedStep})`, `${detail}${hint}`);
    }
  };

  if (alreadyRegistered) {
    return (
      <View style={styles.center}>
        <Text style={{ fontSize: 46 }}>✅</Text>
        <Text style={styles.title}>Already registered</Text>
        <Text style={styles.subtitle}>Your commitment is stored on this device. You can vote when voting opens.</Text>
        <TouchableOpacity style={styles.button} onPress={() => router.replace("/")}>
          <Text style={styles.buttonText}>Back to home</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (status === "done") {
    return (
      <View style={styles.center}>
        <Text style={{ fontSize: 46 }}>🎉</Text>
        <Text style={styles.title}>You&apos;re registered!</Text>
        <Text style={styles.subtitle}>
          Your commitment is now in the {division?.name} Merkle tree. Come back during the Voting phase to cast your
          anonymous ballot.
        </Text>
        <TouchableOpacity style={styles.button} onPress={() => router.replace("/")}>
          <Text style={styles.buttonText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen}>
      <Text style={styles.title}>Register to vote</Text>
      <Text style={styles.subtitle}>
        This creates a private commitment that proves you&apos;re eligible — without revealing who you voted for.
      </Text>

      {division ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{division.name}</Text>
          <Text style={styles.cardText}>{division.question}</Text>
          <View style={[styles.badge, { backgroundColor: division.phase === 1 ? colors.primary : colors.warning }]}>
            <Text style={[styles.badgeText, { color: "#fff" }]}>{division.phaseLabel} phase</Text>
          </View>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.cardText}>Loading election…</Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>🔒 What stays private</Text>
        <Text style={styles.cardText}>
          Your secret nullifier and secret are stored only on this phone, behind your biometric lock. Only the public
          commitment goes on-chain.
        </Text>
      </View>

      {status === "working" ? (
        <View style={[styles.button, styles.buttonDisabled, { flexDirection: "row", gap: 10 }]}>
          <ActivityIndicator color="#fff" />
          <Text style={styles.buttonText}>{step}</Text>
        </View>
      ) : (
        <TouchableOpacity
          style={[styles.button, division?.phase !== 1 && styles.buttonDisabled]}
          disabled={division?.phase !== 1}
          onPress={handleRegister}
        >
          <Text style={styles.buttonText}>Register now</Text>
        </TouchableOpacity>
      )}
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}
