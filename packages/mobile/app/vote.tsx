import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { router } from "expo-router";
import { api, DivisionState } from "../src/services/api";
import { newBurnerAccount, submitVote } from "../src/services/chain";
import { deriveFromSecrets } from "../src/services/crypto";
import { authenticate, getSelectedDivision, getVoterSecrets, markVoted } from "../src/services/keystore";
import { generateVoteCallData } from "../src/services/zkproof";
import { colors, styles } from "../src/theme";

type Stage = "otp-phone" | "otp-code" | "select" | "submitting" | "done";

export default function Vote() {
  const [division, setDivision] = useState<DivisionState | null>(null);
  const [stage, setStage] = useState<Stage>("otp-phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState<number | null>(null);
  const [step, setStep] = useState("");
  const [devHint, setDevHint] = useState<string | null>(null);

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

  const sendCode = async () => {
    setBusy(true);
    try {
      const res = await api.sendOtp(phone);
      // Dev mode: auto-fill the code so no need to read the server console.
      if (res.devCode) {
        setCode(res.devCode);
        setDevHint(`Dev mode — code auto-filled: ${res.devCode}`);
      } else {
        setDevHint(res.devHint ?? null);
      }
      setStage("otp-code");
    } catch (e: any) {
      Alert.alert("Could not send code", e?.message ?? "Try again");
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    setBusy(true);
    try {
      const res = await api.verifyOtp(phone, code);
      if (!res.verified) throw new Error(res.error ?? "Incorrect code");
      const ok = await authenticate("Authenticate to vote");
      if (!ok) throw new Error("Authentication cancelled");
      setStage("select");
    } catch (e: any) {
      Alert.alert("Verification failed", e?.message ?? "Try again");
    } finally {
      setBusy(false);
    }
  };

  const castVote = async () => {
    if (!division || candidate === null) return;
    setStage("submitting");
    try {
      setStep("Unlocking your secrets…");
      const secrets = await getVoterSecrets();
      if (!secrets) throw new Error("No registration found on this device");

      const { commitment } = deriveFromSecrets(secrets.nullifier, secrets.secret);

      setStep("Fetching your Merkle path…");
      const path = await api.getMerklePath(division.votingContract, commitment);

      setStep("Generating zero-knowledge proof…");
      const callData = await generateVoteCallData({
        nullifier: secrets.nullifier,
        secret: secrets.secret,
        circuitIndex: path.circuitIndex,
        siblings: path.siblings,
        root: path.root,
        candidateIndex: candidate,
        depth: path.depth,
      });

      // Fresh burner wallet keeps the vote unlinkable. Fund it for gas (local demo).
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
        <Text style={{ fontSize: 46 }}>🗳️</Text>
        <Text style={styles.title}>Vote cast!</Text>
        <Text style={styles.subtitle}>
          Your ballot was submitted anonymously. No one — not even the election authority — can link it to you.
        </Text>
        <TouchableOpacity style={styles.button} onPress={() => router.replace("/")}>
          <Text style={styles.buttonText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen}>
      <Text style={styles.title}>Cast your vote</Text>

      {/* OTP: phone */}
      {stage === "otp-phone" && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Step 1 — Verify your phone</Text>
          <Text style={[styles.cardText, { marginBottom: 12 }]}>
            We&apos;ll send a one-time code to confirm it&apos;s really you voting.
          </Text>
          <Text style={styles.label}>Phone number</Text>
          <TextInput
            style={styles.input}
            placeholder="07XXXXXXXX"
            placeholderTextColor={colors.muted}
            keyboardType="phone-pad"
            value={phone}
            onChangeText={setPhone}
          />
          <TouchableOpacity style={[styles.button, busy && styles.buttonDisabled]} disabled={busy} onPress={sendCode}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Send code</Text>}
          </TouchableOpacity>
        </View>
      )}

      {/* OTP: code */}
      {stage === "otp-code" && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Step 2 — Enter the code</Text>
          {devHint && <Text style={[styles.cardText, { color: colors.warning }]}>{devHint}</Text>}
          <Text style={[styles.label, { marginTop: 8 }]}>6-digit code</Text>
          <TextInput
            style={styles.input}
            placeholder="000000"
            placeholderTextColor={colors.muted}
            keyboardType="number-pad"
            maxLength={6}
            value={code}
            onChangeText={setCode}
          />
          <TouchableOpacity style={[styles.button, busy && styles.buttonDisabled]} disabled={busy} onPress={verifyCode}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Verify &amp; continue</Text>}
          </TouchableOpacity>
        </View>
      )}

      {/* Select candidate */}
      {stage === "select" && division && (
        <>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{division.name}</Text>
            <Text style={styles.cardText}>{division.question}</Text>
          </View>
          {division.candidates.map((name, idx) => (
            <TouchableOpacity
              key={name}
              style={[
                styles.card,
                candidate === idx && { borderColor: colors.primary, backgroundColor: "#1E3A5F" },
              ]}
              onPress={() => setCandidate(idx)}
            >
              <Text style={[styles.cardTitle, { marginBottom: 0 }]}>
                {candidate === idx ? "🔵 " : "⚪ "}
                {name}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={[styles.button, candidate === null && styles.buttonDisabled]}
            disabled={candidate === null}
            onPress={castVote}
          >
            <Text style={styles.buttonText}>Cast anonymous vote</Text>
          </TouchableOpacity>
        </>
      )}

      {/* Submitting */}
      {stage === "submitting" && (
        <View style={[styles.card, { alignItems: "center", paddingVertical: 30 }]}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.cardText, { marginTop: 16, textAlign: "center" }]}>{step}</Text>
        </View>
      )}
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}
