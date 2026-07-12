# Future Tasks — SL Vote ZK Voting System

> Prioritized list of improvements to make the system fully production-ready.
> Check items off as they're completed.

---

## 🔴 Critical (before any real deployment)

- [ ] **Real SMS OTP provider** — replace mock with Firebase Auth / Twilio (plug into existing `OtpProvider` interface in `services/otp/otpService.ts`)
- [ ] **Hashed-NIC registry** — prevent double-registration without linking NIC↔address (store `poseidon(NIC)` on-chain)
- [ ] **ERC-4337 paymaster / relayer** — sponsor burner wallet gas (replaces the dev faucet)
- [ ] **Deploy to a real chain** — L2 or permissioned chain (Polygon, Arbitrum, custom) with proper trusted-setup ceremony for the Noir circuit SRS
- [ ] **Third-party contract audit** — security review of Voting.sol + ElectionRegistry.sol

---

## 🟠 Important (production quality)

- [x] **Remove voting from web** — ✅ Done. `/voting` now shows "Download the App" page; nav link renamed to "Download App"; home CTA updated. Admin/GN/results/audit untouched.
- [x] **Improve mobile UI** — ✅ Done. New premium dark design system (theme.ts), 6 reusable components (GradientButton, GlassCard, StatusBadge, StepIndicator, AnimatedResult, FadeIn), all screens redesigned with glassmorphism, animations, step progress, journey tracker.
- [ ] **iOS Face ID / Touch ID fix** — current `expo-local-authentication` throws an error on iPhone; needs correct `NSFaceIDUsageDescription` in Info.plist, proper `expo-dev-client` build (not Expo Go which lacks entitlements), and testing biometric fallback to device passcode
- [ ] **In-app PIN** — custom 6-digit PIN verified by hardware (chip-level lockout after 3 wrong), not just device passcode
- [ ] **Root/jailbreak detection** — refuse to run on compromised devices (SafetyNet / App Attest)
- [ ] **Phone number linked to OTP** — store phone number at onboarding, auto-fill for OTP step (not re-type every time)
- [ ] **Admin page: remove MetaMask dependency** — server-side relay for admin transactions (eliminates nonce issues)
- [ ] **Landing page** — full production landing: "Download SL Vote" with Play Store / App Store links, live national results, election info
- [ ] **Observer audit page** — re-verify all proofs independently, download events CSV, check tally integrity
- [ ] **Session/2FA for admin web console** — beyond just wallet ownership
- [ ] **iOS App Store + Android Play Store submission** — proper app signing, store listing, review compliance

---

## 🟡 Nice to have (polish)

- [ ] **Division auto-detection** — GN scans voter's address + NIC, system auto-suggests which division they belong to
- [ ] **Push notifications** — FCM: "Registration opens tomorrow", "Voting starts now", "Results are in"
- [ ] **Offline mode** — queue the register/vote tx locally if no network, send when reconnected
- [ ] **Multi-language** — Sinhala, Tamil, English support in the mobile app
- [ ] **Accessibility** — screen reader support, high contrast, large text
- [ ] **CI/CD** — GitHub Actions: contract tests, type-check, lint, Expo EAS build on push
- [ ] **Monitoring** — observability for the API (error rates, OTP delivery success, proof gen times)
- [x] **Voter receipt** — ✅ Done. Voters can verify their vote on-chain via nullifier hash (Verify My Vote screen + `/api/verify-vote` endpoint + `isNullifierUsed()` contract function)
- [ ] **Rate limiting** — edge gateway (Cloudflare/Vercel) rate limits on API + OTP to prevent abuse
- [ ] **Secrets management** — move OTP signing key, admin key (if relay) to a vault (not env vars)

---

## 🟣 Hard / Research-intensive

> These require significant effort, external tooling integration, or native platform expertise.

- [ ] **Native ZK prover** — replace WebView bb.js with Swoir (iOS) + noir_android (Android) for speed + offline proving. Requires `expo prebuild` + custom dev build, SRS bundling (~50 MB), platform-specific native modules (Swift + Kotlin), and keccak-Honk transcript alignment with the Solidity verifier. Reference: [madztheo/noir-react-native-starter](https://github.com/madztheo/noir-react-native-starter)
- [ ] **Homomorphic / encrypted tallying** — current design reveals vote choice per-ballot (only voter identity is anonymous). True ballot secrecy (nobody knows individual votes until tally) requires homomorphic encryption or threshold decryption — a fundamental circuit redesign
- [ ] **Trusted setup ceremony** — the current SRS is Aztec's dev reference string. A real election needs a multi-party computation (MPC) ceremony to generate an SRS that no single party can subvert. Coordinate with Aztec's community or run a custom ceremony
- [ ] **Custom L2 / permissioned chain** — deploying on a public L2 works but is costly at scale (160 divisions × thousands of voters). A purpose-built permissioned chain (Hyperledger Besu, OP Stack rollup, or Polygon CDK) with sponsored gas and controlled validator set is the production target
- [ ] **Formal verification of the Noir circuit** — mathematically prove the circuit correctly enforces: membership, nullifier uniqueness, and vote-range constraint. Tools: Noir's own verification framework or external Z3/Lean provers

---

## ✅ Completed

- [x] Smart contracts: multi-division Voting + ElectionRegistry + GN access control
- [x] Web admin: division-aware (per-division + all-at-once phase control)
- [x] Web GN portal: live on-chain auth, voter roll, QR scanner
- [x] Web results: national + per-division live dashboard
- [x] Mobile app: hardware keystore, biometric, division selector, register, OTP + vote
- [x] WebView ZK prover (reuses web bb.js pipeline, keccak Honk)
- [x] API layer: /api/election, /api/merkle-path, /api/otp/*, /api/faucet, /prover
- [x] Dev faucet for burner gas
- [x] 49 contract tests passing
- [x] Full end-to-end demo: register → OTP → biometric → ZK proof → anonymous vote → live results
- [x] Remove voting from web — `/voting` → "Download the App" page; nav & CTA updated
- [x] Mobile UI overhaul — premium dark design system, 6 reusable components, all screens redesigned
- [x] Vote verification — `isNullifierUsed()` view function, `/api/verify-vote` endpoint, "Verify My Vote" mobile screen
- [x] Vote confirmation step — added confirmation dialog before casting irreversible vote
