# 🇱🇰 Sri Lanka ZK Voting — Migration to Production

## From Prototype → Production-Ready Election System

This README documents the step-by-step migration from the current MetaMask-based prototype to a production-ready anonymous voting system designed for Sri Lankan elections.

---

## Architecture Decision

```
WEB APP (Next.js)              NATIVE MOBILE APP (React Native)
├── /admin — Election Authority     └── Voter Only
├── /gn — Grama Niladari                ├── Hardware Keystore
├── /audit — Public Observer             ├── Biometric (finger/face)
└── /results — Live Dashboard            ├── OTP Gate
                                         ├── PIN (chip-verified)
                                         ├── ZK Proof Generation
                                         └── Anonymous Burner Vote
```

---

## Sample Election Setup (3 Divisions)

| Division | Contract | Max Voters | GN Officer |
|---|---|---|---|
| Kaduwela | `Voting_Kaduwela.sol` | 131,072 | GN-Kaduwela |
| Colombo Central | `Voting_Colombo.sol` | 131,072 | GN-Colombo |
| Gampaha | `Voting_Gampaha.sol` | 131,072 | GN-Gampaha |

Each division gets its own contract + Merkle tree. National result = sum of all divisions.

---

## Project Structure (Target)

```
zk_voting/
├── packages/
│   ├── circuits/              # Noir ZK circuit (unchanged)
│   │   └── src/main.nr
│   │
│   ├── hardhat/               # Smart contracts
│   │   ├── contracts/
│   │   │   ├── Voting.sol            # Per-division voting contract
│   │   │   ├── Verifier.sol          # HonkVerifier (auto-generated)
│   │   │   ├── GNAccessControl.sol   # NEW: GN role management
│   │   │   └── ElectionRegistry.sol  # NEW: division → contract mapping
│   │   ├── deploy/
│   │   │   ├── 00_deploy_registry.ts
│   │   │   ├── 01_deploy_divisions.ts # Deploy 3 division contracts
│   │   │   └── 02_assign_gns.ts
│   │   └── test/
│   │
│   ├── nextjs/                # Web App (Admin + GN + Observer)
│   │   ├── app/
│   │   │   ├── page.tsx              # Landing: "Download SL Vote app"
│   │   │   ├── admin/
│   │   │   │   ├── page.tsx          # EC Dashboard
│   │   │   │   ├── elections/
│   │   │   │   │   └── page.tsx      # Create/manage elections
│   │   │   │   └── gn/
│   │   │   │       └── page.tsx      # Assign GN officers
│   │   │   ├── gn/
│   │   │   │   ├── page.tsx          # GN Dashboard
│   │   │   │   ├── register/
│   │   │   │   │   └── page.tsx      # QR scan + enroll voter
│   │   │   │   └── voters/
│   │   │   │       └── page.tsx      # View enrolled voters
│   │   │   ├── results/
│   │   │   │   └── page.tsx          # Live national results
│   │   │   └── audit/
│   │   │       └── page.tsx          # Observer: re-verify proofs
│   │   └── api/
│   │       ├── circuit/route.ts      # Serve Noir circuit JSON
│   │       ├── otp/
│   │       │   ├── send/route.ts     # Trigger Firebase SMS
│   │       │   └── verify/route.ts   # Validate OTP
│   │       └── merkle-path/
│   │           └── [leafIndex]/route.ts  # Return siblings
│   │
│   ├── mobile/                # NEW: React Native Voter App
│   │   ├── src/
│   │   │   ├── screens/
│   │   │   │   ├── Onboarding/      # NIC capture + key gen + PIN + bio
│   │   │   │   ├── ShowAddress/      # QR for GN to scan
│   │   │   │   ├── Register/        # Commitment registration
│   │   │   │   ├── Vote/            # OTP → bio → PIN → proof → vote
│   │   │   │   └── Verify/          # Check own vote
│   │   │   ├── services/
│   │   │   │   ├── keystore.ts      # Hardware key management
│   │   │   │   ├── biometric.ts     # Fingerprint/Face unlock
│   │   │   │   ├── otp.ts           # Firebase OTP
│   │   │   │   ├── blockchain.ts    # viem wallet + contract calls
│   │   │   │   ├── zkProof.ts       # WebView-based proof generation
│   │   │   │   └── merkleTree.ts    # Fetch path from API
│   │   │   ├── components/
│   │   │   │   ├── PinInput.tsx
│   │   │   │   ├── BiometricPrompt.tsx
│   │   │   │   ├── CandidateSelector.tsx
│   │   │   │   ├── ProofProgress.tsx
│   │   │   │   └── QRDisplay.tsx
│   │   │   └── utils/
│   │   │       ├── rootDetection.ts
│   │   │       └── secureWipe.ts
│   │   ├── android/
│   │   ├── ios/
│   │   └── package.json
│   │
│   └── blockchain/            # Custom Go blockchain (existing)
│
├── README.md                  # This file
└── package.json
```

---

## Implementation Steps

### Phase 1: Smart Contract Upgrades (Week 1)

#### Step 1.1: Add GN Access Control

```solidity
// contracts/GNAccessControl.sol
contract GNAccessControl is Ownable {
    mapping(address => uint256) public gnDivision;  // GN → division ID
    mapping(address => bool) public isGN;

    function assignGN(address gn, uint256 divisionId) external onlyOwner {
        isGN[gn] = true;
        gnDivision[gn] = divisionId;
        emit GNAssigned(gn, divisionId);
    }

    function revokeGN(address gn) external onlyOwner {
        isGN[gn] = false;
        emit GNRevoked(gn);
    }

    modifier onlyGNForDivision(uint256 divisionId) {
        require(isGN[msg.sender] && gnDivision[msg.sender] == divisionId, "Not GN for this division");
        _;
    }
}
```

#### Step 1.2: Add Election Registry

```solidity
// contracts/ElectionRegistry.sol
contract ElectionRegistry is Ownable {
    struct Division {
        string name;
        address votingContract;
        address gnOfficer;
    }

    mapping(uint256 => Division) public divisions;
    uint256 public divisionCount;

    function addDivision(string memory name, address votingContract, address gn) external onlyOwner {
        divisions[divisionCount] = Division(name, votingContract, gn);
        divisionCount++;
    }

    function getNationalResult(uint256 candidateIdx) external view returns (uint256 total) {
        for (uint256 i = 0; i < divisionCount; i++) {
            total += IVoting(divisions[i].votingContract).getVoteCount(candidateIdx);
        }
    }
}
```

#### Step 1.3: Modify Voting.sol for GN-based voter addition

```solidity
// Add to Voting.sol
address public gnOfficer;

modifier onlyGN() {
    require(msg.sender == gnOfficer || msg.sender == owner(), "Not authorized");
    _;
}

// Change addVoters to use onlyGN instead of onlyOwner
function addVoters(address[] calldata voters, bool[] calldata statuses)
    external onlyGN inPhase(Phase.Setup) { ... }

// Add voter phone hash for OTP binding (no plain phone number on-chain)
mapping(uint256 => mapping(address => bytes32)) private s_voterPhoneHash;

function addVoterWithPhone(address voter, bytes32 phoneHash)
    external onlyGN inPhase(Phase.Setup) {
    s_voters[s_electionId][voter] = true;
    s_voterPhoneHash[s_electionId][voter] = phoneHash;
    emit VoterAdded(voter);
}
```

#### Step 1.4: Deploy script for 3 divisions

```typescript
// deploy/01_deploy_divisions.ts
const divisions = [
    { name: "Kaduwela", gn: "0xGN_KADUWELA_ADDRESS" },
    { name: "Colombo Central", gn: "0xGN_COLOMBO_ADDRESS" },
    { name: "Gampaha", gn: "0xGN_GAMPAHA_ADDRESS" },
];

for (const div of divisions) {
    const voting = await deploy("Voting", {
        args: [deployer, verifierAddress, "Presidential Election 2027", candidates],
    });
    await registry.addDivision(div.name, voting.address, div.gn);
    await voting.setGN(div.gn);
}
```

---

### Phase 2: Web App — Admin & GN Portal (Week 2-3)

#### Step 2.1: Remove voter UI from web app

- Delete: `CreateCommitment.tsx`, `GenerateProof.tsx`, `VoteWithBurner*.tsx`
- Remove MetaMask/RainbowKit from voter pages
- Keep: `VotingStats.tsx` (for results display)
- Add landing page: "Download SL Vote app to vote"

#### Step 2.2: Build GN Registration Page (`/gn/register`)

**Key UX decision: GN SCANS QR from voter's phone (not types address)**

```tsx
// app/gn/register/page.tsx
"use client";
import { Html5Qrcode } from "html5-qrcode";

export default function GNRegisterPage() {
    const [voterAddress, setVoterAddress] = useState("");
    const [voterNIC, setVoterNIC] = useState("");
    const [voterPhone, setVoterPhone] = useState("");
    const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

    // Step 1: Enter NIC → verify against DB
    // Step 2: SCAN QR from voter's phone (contains address)
    // Step 3: Enter voter's phone number
    // Step 4: Confirm & submit addVoterWithPhone()

    const handleQRScan = (decodedText: string) => {
        // Voter's app displays QR with: { address: "0x..." }
        const { address } = JSON.parse(decodedText);
        setVoterAddress(address);
        setStep(3);
    };

    return (
        <div>
            {step === 1 && <NICVerification onVerified={() => setStep(2)} />}
            {step === 2 && <QRScanner onScan={handleQRScan} />}
            {step === 3 && <PhoneInput onSubmit={() => setStep(4)} />}
            {step === 4 && <ConfirmAndSubmit address={voterAddress} phone={voterPhone} />}
        </div>
    );
}
```

#### Step 2.3: Build Admin GN Management (`/admin/gn`)

```tsx
// Assign GN officers to divisions
// Admin selects division → enters GN wallet address → calls assignGN()
```

#### Step 2.4: Build Observer Audit Page (`/audit`)

```tsx
// Downloads all VoteCast events from all division contracts
// Re-verifies each proof with HonkVerifier
// Shows: total proofs, all valid ✓/✗, tally matches ✓/✗
```

#### Step 2.5: Build Results Dashboard (`/results`)

```tsx
// Reads getVoteCount() from all division contracts
// Aggregates national total
// Live updating (polls every 10s)
// Shows per-division + national breakdown
```

---

### Phase 3: React Native Voter App (Week 3-6)

#### Step 3.1: Project Setup

```bash
npx react-native init SLVote --template react-native-template-typescript
cd SLVote
yarn add react-native-keychain react-native-biometrics
yarn add @react-native-firebase/app @react-native-firebase/auth
yarn add react-native-webview
yarn add viem poseidon-lite @zk-kit/lean-imt
yarn add react-native-qrcode-svg  # Display QR for GN to scan
yarn add jail-monkey               # Root detection
yarn add react-native-otp-verify   # SMS auto-read
```

#### Step 3.2: Onboarding Screen (First Launch)

Production-quality onboarding with NIC capture:

```tsx
// screens/Onboarding/index.tsx
// Screen 1: Welcome + "Let's set up your voting identity"
// Screen 2: NIC number entry + validation (format check)
// Screen 3: Full name (as on NIC) — stored locally for display only
// Screen 4: Phone number entry (for OTP)
// Screen 5: Key generation (inside Keystore) + pick PIN
// Screen 6: Enable biometric
// Screen 7: "Setup complete! Show the QR to your GN officer."
```

```tsx
// services/keystore.ts
import * as Keychain from 'react-native-keychain';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export async function generateAndStoreKey(pin: string) {
    // Generate key
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    // Store in hardware Keystore
    await Keychain.setGenericPassword(
        'voter-private-key',
        privateKey,
        {
            accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE,
            accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
        }
    );

    return account.address;
}
```

#### Step 3.3: Show Address Screen (for GN enrollment)

```tsx
// screens/ShowAddress/index.tsx
import QRCode from 'react-native-qrcode-svg';

// Displays a QR code containing: { address: "0x7a3B...F2c1" }
// GN scans this with their web portal camera
// Large, clear QR — easy to scan from 30cm distance
<QRCode
    value={JSON.stringify({ address: voterAddress })}
    size={250}
    backgroundColor="white"
    color="black"
/>
```

#### Step 3.4: Register Screen (from home)

```tsx
// screens/Register/index.tsx
// 1. Biometric prompt → unlock Keystore
// 2. Generate nullifier + secret
// 3. Compute commitment = poseidon2(n, s)
// 4. Encrypt {nullifier, secret} → store in Keystore
// 5. Sign register(commitment) using hardware key
// 6. Send tx to blockchain
// 7. Save leaf index
// 8. Wipe RAM
```

#### Step 3.5: Vote Screen (Election Day)

```tsx
// screens/Vote/index.tsx

// GATE 1: OTP
const sendOTP = async () => {
    const confirmation = await auth().verifyPhoneNumber(phoneNumber);
    // SMS arrives → auto-read via react-native-otp-verify
};

// GATE 2: Biometric
const unlockBiometric = async () => {
    const result = await ReactNativeBiometrics.simplePrompt({
        promptMessage: 'Place finger to vote'
    });
    return result.success;
};

// GATE 3: PIN (verified by Keystore hardware)
const unlockKeystore = async () => {
    const credentials = await Keychain.getGenericPassword({
        authenticationPrompt: { title: 'Enter PIN to vote' }
    });
    return credentials; // hardware verifies PIN internally
};

// After all 3 gates pass:
// → Decrypt nullifier + secret
// → Select candidate
// → Generate ZK proof (WebView)
// → Burner wallet votes
```

#### Step 3.6: ZK Proof in WebView

```tsx
// services/zkProof.ts
import { WebView } from 'react-native-webview';

// Hidden WebView loads an HTML page that:
// 1. Imports bb.js + noir_js
// 2. Receives inputs via postMessage
// 3. Generates proof
// 4. Returns proof + publicInputs via postMessage

const PROOF_HTML = `
<!DOCTYPE html>
<html><body><script>
    // Load bb.js and noir_js from CDN or bundled
    window.addEventListener('message', async (event) => {
        const inputs = JSON.parse(event.data);
        const noir = new Noir(inputs.circuitData);
        const { witness } = await noir.execute(inputs.circuitInputs);
        const honk = new UltraHonkBackend(inputs.circuitData.bytecode);
        const { proof, publicInputs } = await honk.generateProof(witness, { keccak: true });
        window.ReactNativeWebView.postMessage(JSON.stringify({ proof: Array.from(proof), publicInputs }));
    });
</script></body></html>
`;
```

#### Step 3.7: Verify Screen

```tsx
// screens/Verify/index.tsx
// Shows saved receipt code (nullifierHash prefix)
// Searches VoteCast events on blockchain
// Displays: "Your vote: Candidate B ✓ — recorded correctly"
```

#### Step 3.8: Root Detection

```tsx
// App.tsx — check on every launch
import JailMonkey from 'jail-monkey';

if (JailMonkey.isJailBroken()) {
    // Show error screen: "This device is not secure. Cannot use voting app."
    // Do not proceed.
}
```

---

### Phase 4: API Routes for Mobile App (Week 2)

#### `/api/otp/send`
```typescript
// Triggers Firebase SMS to voter's registered phone
// Rate limited: 1 OTP per phone per 60 seconds
// Returns: { success: true, expiresIn: 300 }
```

#### `/api/otp/verify`
```typescript
// Validates OTP code
// Returns: JWT token (short-lived, 5 min)
// Mobile app uses JWT to authorize merkle-path request
```

#### `/api/merkle-path/[divisionId]/[leafIndex]`
```typescript
// Rebuilds tree for given division from NewLeaf events
// Returns: { siblings: [...], root: "0x...", depth: N }
// Requires valid JWT from OTP verification
```

#### `/api/election`
```typescript
// Returns: { phase, candidates, divisions, registrationDeadline, votingDeadline }
// Public — no auth needed
```

---

### Phase 5: Integration Testing (Week 7)

#### Test Flow

```
1. Admin deploys 3 division contracts (web /admin)
2. Admin assigns 3 GN officers (web /admin/gn)
3. Admin starts registration (web /admin)
4. Voter downloads app, onboards with NIC + PIN + biometric
5. Voter shows QR → GN scans → GN adds to voter roll (web /gn/register)
6. Voter registers commitment from home (mobile)
7. Admin starts voting (web /admin)
8. Voter at booth: OTP → biometric → PIN → select candidate → proof → burner vote (mobile)
9. Results appear live (web /results)
10. Observer audits all proofs (web /audit)
11. Voter verifies own vote (mobile)
```

#### Security Tests

```
- [ ] Try voting without OTP → fail
- [ ] Try wrong PIN 3 times → Keystore locks
- [ ] Try wrong biometric → rejected
- [ ] Try voting from rooted phone → app refuses
- [ ] Try double vote (same nullifier) → chain rejects
- [ ] Try stale proof (old root) → chain rejects
- [ ] Try GN adding voter to wrong division → contract rejects
- [ ] Try non-GN calling addVoters → contract rejects
```

---

### Phase 6: Polish & Deploy (Week 8)

- [ ] Mobile app Play Store submission
- [ ] Mobile app App Store submission (TestFlight first)
- [ ] Web app deploy to Vercel / EC server
- [ ] Custom blockchain node running
- [ ] 3 division contracts deployed
- [ ] Demo video recorded (full flow)
- [ ] Final report written

---

## UX Decisions (Production Quality)

| Interaction | Bad (prototype) | Good (production) |
|---|---|---|
| GN gets voter address | GN types 42-char hex | **GN scans QR from voter's phone** (1 second) |
| Voter onboarding | "Enter seed phrase" | **NIC + name + phone + PIN + biometric** (guided wizard) |
| OTP entry | User types 6 digits | **Auto-read from SMS** (react-native-otp-verify) |
| Candidate selection | Dropdown | **Large touch buttons with party symbols + colors** |
| Proof progress | No feedback | **Animated progress bar with step descriptions** |
| Vote confirmation | Text alert | **Full-screen success animation + receipt code** |
| Error messages | "InvalidRoot" | **"Your voting key is outdated. Re-register from home."** |

---

## What Problems This Solves

| Problem | Type | Solution |
|---|---|---|
| Helper votes for voter | Social | OTP + biometric (need YOUR phone + YOUR finger) |
| MetaMask too complex | UX | Native app (PIN + finger = like banking app) |
| Address typing errors | UX | QR scan (1 second, zero errors) |
| Credential theft | Technical | Hardware Keystore (key never extractable) |
| PIN brute-force | Technical | Chip lockout after 3 wrong attempts |
| Vote linked to identity | Technical | Burner wallet + ZK proof (mathematically anonymous) |
| Slow counting | Operational | Real-time on-chain tally |
| Counting fraud | Trust | Re-verifiable proofs (any observer can audit) |
| Phone lost | Recovery | Re-enroll at GN office with NIC |
| Rooted phone | Technical | Root detection → app refuses to run |

---

## Commands

```bash
# Smart contracts
cd packages/hardhat
yarn deploy --network localhost    # Deploy all contracts

# Web app
cd packages/nextjs
yarn dev                           # Start web app (admin/GN/observer)

# Mobile app
cd packages/mobile
npx react-native run-android       # Run on Android
npx react-native run-ios           # Run on iOS

# Tests
cd packages/hardhat
yarn test                          # Contract tests

cd packages/mobile
yarn test                          # Mobile unit tests
```

---

## Environment Variables

```env
# packages/nextjs/.env
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_RPC_URL=http://localhost:8545
FIREBASE_PROJECT_ID=sl-vote-xxxxx
FIREBASE_API_KEY=AIzaSy...
REGISTRY_CONTRACT_ADDRESS=0x...

# packages/mobile/.env
API_BASE_URL=https://sl-vote.lk/api
CHAIN_RPC_URL=http://localhost:8545
FIREBASE_PROJECT_ID=sl-vote-xxxxx
```

---

## Contributors

- Election Authority: manages elections via web portal
- Grama Niladari: enrolls voters via web portal (QR scan)
- Voter: votes via native mobile app (hardware-secured)
- Observer: audits via public web page

---

## License

MIT — Research prototype for FYP 2026/2027

---

## Changelog — What's Been Implemented

### Phase 1: Smart Contract Upgrades ✅ (Completed 2026-07-09)

#### Step 1.1: GN Access Control added to Voting.sol
- **File:** `contracts/Voting.sol`
- **Changes:**
  - Added `s_gnOfficer` public state variable
  - Added `setGNOfficer(address _gnOfficer)` — owner assigns GN
  - Added `onlyOwnerOrGN` modifier — both owner & GN can call protected functions
  - Modified `addVoters()` — now works in **Setup + Registration** phases (not just Setup)
  - Added `GNOfficerUpdated` event
- **Why:** GN can enroll voters during registration window without needing owner key

#### Step 1.2: ElectionRegistry.sol created
- **File:** `contracts/ElectionRegistry.sol`
- **Functions:**
  - `addDivision(name, votingContract, gnOfficer)` → registers a polling division
  - `updateDivision(id, votingContract, gnOfficer)` → update division config
  - `getDivisionCount()` / `getAllDivisions()` → read division info
  - `getNationalVoteCount(candidateIdx)` → sum one candidate across all divisions
  - `getNationalResults()` → sum ALL candidates across all divisions
  - `getDivisionResults(candidateIdx)` → per-division breakdown for one candidate
- **Why:** Maps 160 polling divisions to contracts; provides national result aggregation

#### Step 1.3: Multi-division deploy script
- **File:** `deploy/01_deploy_divisions.ts`
- **Deploys:**
  - 1 × ElectionRegistry
  - 3 × Voting contracts (Kaduwela, Colombo Central, Gampaha)
- **Config:**
  - Real SL candidates: "Anura Kumara Dissanayake (NPP)", "Sajith Premadasa (SJB)", "Ranil Wickremesinghe (UNP)"
  - GN officers: Hardhat accounts #1, #2, #3
  - Each division auto-registered in registry
- **Deployed addresses (localhost):**
  ```
  ElectionRegistry:  0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9
  Voting_Kaduwela:   0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
  Voting_Colombo:    0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6
  Voting_Gampaha:    0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e
  ```

#### Step 1.4: New tests for GN + Registry
- **File:** `test/GNAndRegistry.ts`
- **13 new tests covering:**
  - Owner can set GN officer
  - Non-owner cannot set GN
  - GN can add voters during Setup
  - GN can add voters during Registration (late enrollment)
  - Non-GN cannot add voters
  - GN cannot add voters during Voting phase
  - Owner still works (backwards compatible)
  - Registry: add, update, count, list divisions
  - National vote aggregation
- **Updated existing test:** "rejects addVoters outside Setup phase" → now tests Voting phase rejection
- **Total test suite: 49 tests passing, 0 failing**

---

### Phase 2: Web App (Admin + GN + Observer) ✅ (Completed 2026-07-09)

#### Step 2.1: Live on-chain division hook — single source of truth
- **File:** `hooks/useDivisions.ts`
- **What it does:**
  - Reads the division list from `ElectionRegistry.getAllDivisions()` (which divisions exist)
  - Enriches each with **live** `s_gnOfficer`, phase, tree size and root read directly from the Voting contract
  - Exposes `findDivisionForGN()` helper + `PHASE_LABELS`
  - Exposes `refetch()` so pages refresh after writes
- **Why:** Eliminates the config-drift bug class. The registry says *which* divisions exist; each Voting contract's `s_gnOfficer` is the authoritative GN (because `setGNOfficer` writes to the Voting contract, not a registry copy). No page relies on hardcoded addresses anymore.

#### Step 2.2: divisions.ts demoted to documented static fallback
- **File:** `utils/divisions.ts`
- **Changes:** Values synced to the live chain and clearly marked *fallback-only*; the hook is authoritative.

#### Step 2.3: GN portal + registration refactored to the hook
- **Files:** `app/gn/page.tsx`, `app/gn/register/page.tsx`
- **Changes:** Both now detect the GN's division from chain via `useDivisions()` instead of a private viem client with hardcoded addresses. Added loading + error states. Registration submits `addVoters` to the GN's own division contract via the connected wallet.

#### Step 2.4: Admin GN management reads/writes live divisions
- **File:** `app/voting/admin/page.tsx`
- **Changes:** `GNManagementSection` now sources divisions from `useDivisions()` (all registered divisions, live GN column), assigns GN via the connected wallet, and calls `refetch()` after a successful assignment. Removed its private hardcoded 3-division array.

#### Step 2.5: National + per-division results dashboard
- **File:** `app/results/page.tsx`
- **Changes:** Rewritten to aggregate a **national total** across every division plus an expandable **per-division breakdown** (votes, turnout, leading candidate, contract address). Reads candidates + vote counts live from each division contract. Loading + error + empty states.

#### Step 2.6: Voting page division context
- **File:** `app/voting/page.tsx`
- **Changes:** Added a `DivisionContextBanner` that resolves which registered division the web voter flow is bound to (the default scaffold `Voting` contract) and clarifies that real multi-division voting happens in the mobile app. The proof/Merkle pipeline was intentionally left untouched (deep re-threading through arbitrary division contracts is Phase 3 / native-app scope).

#### Validation
- `yarn check-types` (tsc `--noEmit`) passes clean across the entire `nextjs` package.

---

### Phase 2.5: Production API layer ✅ (Completed 2026-07-09)

Backend routes in the Next.js app that the mobile app (and integrators) consume. The
server holds **no secrets** — everything is public on-chain data or transient OTP state.

| Route | Purpose |
|-------|---------|
| `GET /api/circuit` | Serves the compiled Noir circuit JSON |
| `GET /api/election` | Division-aware live state + national aggregate (`?division=<addr>` to filter) |
| `GET /api/merkle-path?division=&commitment=` | Rebuilds the LeanIMT from `NewLeaf` events → siblings + circuit index + root |
| `POST /api/otp/send` · `POST /api/otp/verify` | Phone verification (pluggable provider: mock now, Firebase/Twilio later) → HMAC proof-of-phone token |
| `POST /api/faucet` | **Dev-only** (local chain guard): funds a burner wallet 0.05 ETH so it can pay vote() gas |
| `GET /prover` | Headless page that runs the exact `UltraHonkBackend`/`bb.js` pipeline; the mobile WebView drives it |

Key files: `services/otp/otpService.ts`, `app/api/*/route.ts`, `app/prover/page.tsx`.

---

### Phase 3: React Native Voter App ✅ (Scaffolded + running 2026-07-10)

**`packages/mobile`** — Expo + expo-router + TypeScript. Voter-only app: hardware key,
biometric/PIN, OTP, on-device ZK proof (via WebView), anonymous burner vote. **MetaMask removed.**

- **Keystore** (`src/services/keystore.ts`) — hardware-backed `expo-secure-store` + `expo-local-authentication`
- **Crypto** (`src/services/crypto.ts`) — poseidon commitment matching the circuit exactly
- **Chain** (`src/services/chain.ts`) — `register()` with the voter key, `vote()` from a fresh burner
- **API client** (`src/services/api.ts`), **ZK input builder** (`src/services/zkproof.ts`)
- **WebView prover** (`src/services/webviewProver.tsx`) — drives `/prover`; **reuses the proven bb.js keccak-Honk pipeline**, works in Expo Go
- **Native prover** (`src/services/nativeProver.ts`) — optional; wired for a future dev build with Swoir/noir_android
- **Screens** (`app/`) — onboarding (key + address QR), dashboard, register, vote (OTP→biometric→candidate→proof→burner), settings

Runs on **Expo SDK 54** (React 19 / RN 0.81). Bundles clean (verified HTTP 200).

---

## 🚀 How to Run Everything (local demo)

> Four processes: **Hardhat node**, **contract deploy**, **Next.js**, **Expo**.
> The phone and PC must be on the **same network** (a hotspot works).

### 0. Find your PC's LAN IP (needed so the phone can reach the PC)

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object IPAddress, InterfaceAlias
```

Use the Wi-Fi/hotspot address (e.g. `10.26.223.216`). Substitute it for `<LAN_IP>` below.

### 1. Start the Hardhat node — bind to all interfaces

```powershell
cd "zk_voting/packages/hardhat"
npx hardhat node --hostname 0.0.0.0 --network hardhat
```

> Both flags matter: `--network hardhat` (hardhat-deploy requirement) and `--hostname 0.0.0.0` (so the phone can reach the RPC). Leave this running.

### 2. Deploy contracts + export ABIs (new terminal)

```powershell
cd "zk_voting/packages/hardhat"
npx hardhat deploy --network localhost --export-all ../nextjs/contracts/deployedContracts.ts
```

Deterministic addresses (fresh chain): Registry `0xDc64…`, Kaduwela `0x5FC8d…`, Colombo `0x2279B…`, Gampaha `0xB7f8B…`. Kaduwela GN = account #0.
For a clean re-deploy: stop the node, `Remove-Item packages/hardhat/deployments/localhost -Recurse -Force`, restart the node, re-run deploy.

### 3. Start the Next.js web app — bind to IPv4 all interfaces (new terminal)

```powershell
cd "zk_voting/packages/nextjs"
npx next dev -H 0.0.0.0
```

> `-H 0.0.0.0` is required — the default binds IPv6 only and the phone (IPv4) times out.
> Web portals: `http://localhost:3000` (landing) · `/voting/admin` · `/gn` · `/results` · `/audit`.

### 4. Start the Expo mobile app (new terminal)

```powershell
cd "zk_voting/packages/mobile"
$env:REACT_NATIVE_PACKAGER_HOSTNAME="<LAN_IP>"
$env:EXPO_PUBLIC_API_URL="http://<LAN_IP>:3000"
$env:EXPO_PUBLIC_RPC_URL="http://<LAN_IP>:8545"
yarn expo start --clear
```

> Use `yarn expo` (local SDK 54 CLI), **not** `npx expo` (which may fetch the wrong version).
> Scan the QR with **Expo Go** (Android) or enter `exp://<LAN_IP>:8081` manually.

### 5. MetaMask (web admin/GN, on the PC)

- Network: **Localhost 8545**, Chain ID **31337**
- Import **Account #0** (admin + Kaduwela GN): private key
  `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`

### 6. Run one full election (demo script)

1. **Phone** → app opens → onboarding creates your hardware key → shows your **address QR**
2. **Web `/voting/admin`** (account #0) → set candidates/question if needed → **Start Registration** (Kaduwela)
3. **Web `/gn`** (account #0 is the Kaduwela GN) → **Register** → scan the phone's address QR → allowlist the voter
4. **Phone** → **Register to vote** → biometric → commitment submitted on-chain
5. **Web `/voting/admin`** → **Start Voting**
6. **Phone** → **Cast your vote** → OTP (code prints in the **Next.js terminal**) → biometric → pick candidate → WebView generates the ZK proof → funded burner submits the anonymous vote
7. **Web `/results`** → the vote appears in the live tally

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| Expo Go: "upgrade SDK" | App is SDK 54; update Expo Go to latest |
| Phone can't reach API/RPC | Ensure `-H 0.0.0.0` (Next) and `--hostname 0.0.0.0` (Hardhat); same network; correct `<LAN_IP>` |
| `npx expo` wants to install expo@57 | Use `yarn expo start` instead |
| Bundle "Unable to resolve X" | `cd packages/mobile; yarn add X`, then restart Metro (`yarn expo start --clear`) |
| GN page "Not a GN Officer" | Wallet must be the on-chain GN; account #0 is Kaduwela GN |
| Vote fails "insufficient funds" | Faucet must be reachable; it funds the burner from account #0 |
| On uni Wi-Fi behind proxy | `yarn config set httpProxy http://<proxy>:<port>` (and `httpsProxy`); unset on a direct network |

### Known gaps (deferred)

- **On-device native prover**: currently uses the WebView (reuses web bb.js). Native (Swoir/noir_android) needs `expo prebuild` + a dev build — see `packages/mobile/README.md`.
- **NIC/phone not persisted**: only the wallet address goes on-chain. Production needs a hashed-NIC registry for double-registration prevention (never link NIC↔address). See `/memories/repo/todos.md`.
- **Burner gas**: dev faucet on local chain; production needs an ERC-4337 paymaster / relayer.

