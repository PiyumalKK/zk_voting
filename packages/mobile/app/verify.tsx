import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { router } from "expo-router";
import { toHex } from "viem";
import { AnimatedResult, FadeIn, GlassCard, GradientButton } from "../src/components/ui";
import { api, VerifyVoteResponse } from "../src/services/api";
import { deriveFromSecrets } from "../src/services/crypto";
import { authenticate, getSelectedDivision, getVoterSecrets } from "../src/services/keystore";
import { colors, styles } from "../src/theme";

type Status = "idle" | "checking" | "done" | "error";

export default function Verify() {
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<VerifyVoteResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [divisionName, setDivisionName] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const election = await api.getElection();
        const chosen = await getSelectedDivision();
        const div = election.divisions.find(
          d => d.votingContract.toLowerCase() === chosen?.toLowerCase(),
        );
        if (div) setDivisionName(div.name);
      } catch {
        /* non-critical */
      }
    })();
  }, []);

  const handleVerify = async () => {
    setStatus("checking");
    setResult(null);
    setErrorMsg("");
    try {
      const ok = await authenticate("Authenticate to verify your vote");
      if (!ok) {
        setStatus("idle");
        return;
      }

      const secrets = await getVoterSecrets();
      if (!secrets) {
        setErrorMsg(
          "No registration found on this device. You need to register before you can verify a vote.",
        );
        setStatus("error");
        return;
      }

      const division = await getSelectedDivision();
      if (!division) {
        setErrorMsg("No division selected. Go back to the home screen and pick your division.");
        setStatus("error");
        return;
      }

      const { nullifierHash } = deriveFromSecrets(secrets.nullifier, secrets.secret);
      const nhHex = toHex(BigInt(nullifierHash), { size: 32 });

      const res = await api.verifyVote(division, nhHex);
      setResult(res);
      setStatus("done");
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Could not verify your vote. Please try again.");
      setStatus("error");
    }
  };

  return (
    <ScrollView style={styles.screen}>
      <FadeIn>
        <Text style={styles.title}>Verify my vote</Text>
        <Text style={styles.subtitle}>
          Check if your vote was successfully counted, while keeping your identity completely hidden.
        </Text>
      </FadeIn>

      {divisionName ? (
        <FadeIn delay={50}>
          <GlassCard>
            <Text style={styles.label}>Division</Text>
            <Text style={styles.cardText}>{divisionName}</Text>
          </GlassCard>
        </FadeIn>
      ) : null}

      <FadeIn delay={100}>
        <GlassCard>
          <Text style={styles.cardTitle}>🔐 How it works</Text>
          <View style={{ gap: 12, marginTop: 8 }}>
            <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 18 }}>1️⃣</Text>
              <Text style={[styles.cardText, { flex: 1 }]}>
                Your phone generates a secure, anonymous receipt just for you
              </Text>
            </View>
            <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 18 }}>2️⃣</Text>
              <Text style={[styles.cardText, { flex: 1 }]}>
                We check the system to see if a vote matching your receipt was recorded
              </Text>
            </View>
            <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 18 }}>3️⃣</Text>
              <Text style={[styles.cardText, { flex: 1 }]}>
                Your identity and your vote remain completely secret
              </Text>
            </View>
          </View>
        </GlassCard>
      </FadeIn>

      {status === "idle" && (
        <FadeIn delay={150}>
          <GradientButton
            title="Verify now"
            icon="🔍"
            onPress={handleVerify}
          />
        </FadeIn>
      )}

      {status === "checking" && (
        <FadeIn>
          <GlassCard glow style={{ alignItems: "center", paddingVertical: 40 }}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.cardText, { marginTop: 20, textAlign: "center" }]}>
              Checking the blockchain…
            </Text>
          </GlassCard>
        </FadeIn>
      )}

      {status === "done" && result && (
        <FadeIn>
          {result.found ? (
            <GlassCard glow glowColor={colors.success}>
              <AnimatedResult
                icon="✅"
                title="Your vote was counted!"
                color={colors.success}
              />
              {/* result.candidate && (
                <View
                  style={{
                    backgroundColor: colors.success + "10",
                    borderRadius: 12,
                    padding: 16,
                    alignItems: "center",
                    marginTop: 8,
                  }}
                >
                  <Text style={styles.label}>Counted for</Text>
                  <Text
                    style={{
                      fontSize: 20,
                      fontWeight: "800",
                      color: colors.text,
                      marginTop: 4,
                    }}
                  >
                    {result.candidate}
                  </Text>
                </View>
              ) */}
              {result.blockNumber !== undefined && (
                <Text
                  style={[
                    styles.cardText,
                    { textAlign: "center", marginTop: 12, fontSize: 11, opacity: 0.6 },
                  ]}
                >
                  Confirmed in block #{result.blockNumber}
                </Text>
              )}
            </GlassCard>
          ) : (
            <GlassCard glow glowColor={colors.danger}>
              <AnimatedResult
                icon="❌"
                title="Vote not found"
                subtitle="Your anonymous receipt was not found in the system. This means your vote hasn't been submitted or wasn't accepted."
                color={colors.danger}
              />
            </GlassCard>
          )}

          <TouchableOpacity
            style={styles.buttonOutline}
            onPress={() => {
              setStatus("idle");
              setResult(null);
            }}
          >
            <Text style={styles.buttonOutlineText}>🔄 Check again</Text>
          </TouchableOpacity>
        </FadeIn>
      )}

      {status === "error" && (
        <FadeIn>
          <GlassCard glow glowColor={colors.danger}>
            <AnimatedResult
              icon="⚠️"
              title="Verification failed"
              subtitle={errorMsg}
              color={colors.danger}
            />
            <GradientButton
              title="Try again"
              variant="danger"
              onPress={() => setStatus("idle")}
              style={{ marginTop: 8 }}
            />
          </GlassCard>
        </FadeIn>
      )}

      <FadeIn delay={200}>
        <TouchableOpacity
          style={[styles.buttonOutline, { marginTop: 16 }]}
          onPress={() => router.back()}
        >
          <Text style={styles.buttonOutlineText}>← Back</Text>
        </TouchableOpacity>
      </FadeIn>
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}
