# SL Vote — Native Voter App

React Native (Expo) app for **voters** in the ZK anonymous voting system. Officials
(Admin / GN / Observer) use the web app; voters use this.

## What it does

| Screen | Purpose |
|--------|---------|
| Onboarding | Generates a key **and** the ZK commitment secrets inside the phone's **secure hardware** (Keystore/Keychain), gated by biometric/passcode. Shows the address QR for the GN officer. |
| Register | **One biometric prompt** unlocks the identity, derives the ZK **commitment** from the stored secrets, submits `register()` on-chain. |
| Vote | Pick candidate → confirm with **one biometric prompt** → generate **ZK proof** → submit `vote()` from a fresh **burner wallet** (anonymous). |
| Settings | Show address, erase identity. |

Nothing sensitive (keys, nullifier, secret) ever leaves the device.

## Architecture

```
Onboarding → hardware Keystore key
Register   → poseidon commitment → register() [voter's key]
Vote       → biometric (at confirm) → merkle path (API) → ZK proof → vote() [burner wallet]
```

Backend it talks to (the Next.js web app):
- `GET /api/election` — live division state
- `GET /api/merkle-path?division=&commitment=` — inclusion proof siblings
- `POST /api/otp/send` · `POST /api/otp/verify` — phone verification

## Run (development)

```bash
cd packages/mobile
yarn install
npx expo start          # scan the QR with Expo Go, or run on a simulator
```

When testing on a **physical phone**, set your dev machine's LAN IP so the phone can
reach the API and RPC:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.50:3000 \
EXPO_PUBLIC_RPC_URL=http://192.168.1.50:8545 \
npx expo start
```

## Outstanding: on-device ZK prover

Proof generation uses Barretenberg (Honk — matching the `HonkVerifier` contract).
The witness inputs are built correctly in
[`src/services/zkproof.ts`](src/services/zkproof.ts) and the native integration is
wired in [`src/services/nativeProver.ts`](src/services/nativeProver.ts) (auto-enabled
at app start when the native module is present). To turn it on:

### Setup checklist (madztheo/noir-react-native-starter approach)

1. **Generate native projects** (leaves Expo Go behind):
   ```bash
   npx expo prebuild
   npx expo install expo-dev-client
   ```
2. **Add the native prover modules**:
   - iOS → add `Swoir`, `SwoirCore`, `Swoirenberg` (Swift Package Manager), then `npx pod-install`.
   - Android → add `noir_android` via Jitpack in `android/app/build.gradle`.
   - (Or use [zkmopro/mopro](https://github.com/zkmopro/mopro) `mopro-cli` for a React Native target.)
3. **Bundle the circuit** — copy the compiled Noir JSON to `assets/circuit.json`:
   ```bash
   cp ../circuits/target/circuits.json assets/circuit.json
   ```
4. **Bundle the SRS** (~50 MB chunk) into `ios/` and `android/app/src/main/res/raw/`
   (see the starter's `scripts/download-srs.sh`).
5. **Build the dev client**: `npx expo run:android` / `npx expo run:ios` (or EAS Build).

### Two compatibility gotchas (documented in `nativeProver.ts`)

- **Keccak flavour is mandatory** — the on-chain `HonkVerifier` only accepts the
  keccak transcript (the web app uses `generateProof(witness, { keccak: true })`).
  Build the native module with the keccak Honk variant.
- **Proof vs public inputs** — `vote()` wants the raw proof bytes (it rebuilds the
  4 public inputs on-chain). The native module returns `proofWithPublicInputs`, so
  `nativeProver.ts` strips the leading public-input words. Verify the offset on the
  first successful on-chain vote.

Until the native module is present (e.g. in Expo Go), the vote flow completes every
step except the final proof and surfaces a clear message.



## Security notes

- Key + secrets in `expo-secure-store` with `requireAuthentication` (hardware-backed),
  held as **one entry** (`slvote.identity`) rather than three. The OS prompts per
  protected item, so separate entries meant a separate fingerprint each. Released
  only through `keystore.unlockIdentity()` — the single gated read, one prompt per
  flow, carrying its own prompt message.
- Biometric via `expo-local-authentication`, used only where the store itself
  cannot be gated (Expo Go, or no fingerprint enrolled when the identity was made).
- Where the prompt sits: registering asks on **Register now**; voting asks on
  **Cast anonymous vote**, at the confirm step — the candidate list is public data
  and gating it protected nothing.
- Vote submitted from a throwaway burner wallet → `msg.sender` is unlinkable to the voter.
- In production, burner gas is sponsored by a relayer / ERC-4337 paymaster.
