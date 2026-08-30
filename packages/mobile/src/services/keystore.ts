import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { generateSecrets } from "./crypto";

/**
 * Keystore service — the security heart of the voter app.
 *
 * The voter's private key and ZK commitment secrets live in the device's
 * hardware-backed secure storage (iOS Keychain / Android Keystore) and are
 * released only after a biometric / device-passcode check.
 *
 * They live there as ONE entry, not three. The OS prompts per protected item,
 * so a flow that read the key, the nullifier and the secret separately asked
 * the voter for a fingerprint three times to do one thing. Everything sensitive
 * is a single JSON blob, released by a single prompt — see `unlockIdentity`,
 * which is the only way in.
 *
 * The public address is stored WITHOUT an auth gate so the app can display it
 * (e.g. the QR shown to the GN officer) without prompting for a fingerprint.
 *
 * Nothing sensitive is ever sent to a server.
 */

const KEY_IDENTITY = "slvote.identity"; // auth-gated when biometrics are available: VoterIdentity as JSON
const KEY_ADDRESS = "slvote.address"; // public, no auth
const KEY_REGISTERED = "slvote.registered"; // public flag, set ONLY after a confirmed on-chain register
const KEY_DIVISION = "slvote.division"; // public: the voter's chosen division contract
const KEY_VOTED = "slvote.voted"; // public: JSON array of division contracts this identity has voted in
const KEY_AUTH_GATED = "slvote.authGated"; // "1" if the sensitive keys were written behind a biometric gate

// Superseded by KEY_IDENTITY. Read once, by `migrateLegacyIdentity`, then deleted.
const LEGACY_KEY_PRIVATE = "slvote.privateKey";
const LEGACY_KEY_NULLIFIER = "slvote.nullifier";
const LEGACY_KEY_SECRET = "slvote.secret";

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

const PUBLIC_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// SecureStore options that force a biometric check on read/write. The prompt
// text is per-call: it is the only thing the voter sees explaining why their
// phone is asking, so "Confirm to cast your vote" beats a generic unlock.
function gatedOptions(prompt: string): SecureStore.SecureStoreOptions {
  return {
    requireAuthentication: true,
    authenticationPrompt: prompt,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
}

// Whether this device can biometric-gate secure storage. `requireAuthentication`
// on Android needs an ENROLLED BIOMETRIC: phones with no fingerprint/face
// hardware (or none enrolled) reject the write with "No hardware available for
// biometric authentication". So we gate only when it is truly available and fall
// back to un-gated (still hardware-backed, device-only) storage otherwise, so the
// app works on every phone. Expo Go cannot gate at all.
async function canGate(): Promise<boolean> {
  if (isExpoGo) return false;
  const cap = await getBiometricCapability();
  return cap.supported;
}

// Whether the sensitive entry was written behind a gate. The decision is
// persisted (KEY_AUTH_GATED) at identity creation so reads always use the same
// options the writes used, even if the user later enrolls or removes a fingerprint.
async function storeIsGated(): Promise<boolean> {
  const flag = await SecureStore.getItemAsync(KEY_AUTH_GATED, PUBLIC_OPTIONS).catch(() => null);
  if (flag === "1") return true;
  if (flag === "0") return false;
  return canGate();
}

export interface BiometricCapability {
  hasHardware: boolean;
  isEnrolled: boolean;
  supported: boolean;
}

export async function getBiometricCapability(): Promise<BiometricCapability> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const isEnrolled = await LocalAuthentication.isEnrolledAsync();
  return { hasHardware, isEnrolled, supported: hasHardware && isEnrolled };
}

export const AUTH_CANCELLED = "Authentication cancelled";

/**
 * Did this failure come from the voter dismissing the biometric prompt, rather
 * than from storage itself? Callers use it to stay quiet (or say something
 * gentle) instead of reporting a scary failure for a deliberate "not now".
 */
export function isAuthCancellation(e: unknown): boolean {
  const message = String((e as { message?: string })?.message ?? e).toLowerCase();
  return message.includes("cancel") || message.includes("authenticat");
}

/** Explicit biometric / passcode prompt. Only used where the store cannot gate. */
export async function authenticate(reason = "Confirm it's you"): Promise<boolean> {
  const cap = await getBiometricCapability();
  if (!cap.supported) {
    // No biometric enrolled — SecureStore auth gate still applies on retrieval.
    return true;
  }
  const res = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    disableDeviceFallback: false,
  });
  return res.success;
}

export async function hasIdentity(): Promise<boolean> {
  const addr = await SecureStore.getItemAsync(KEY_ADDRESS, PUBLIC_OPTIONS);
  return !!addr;
}

/** Everything secret about a voter, released together by one prompt. */
export interface VoterIdentity {
  privateKey: `0x${string}`;
  nullifier: string;
  secret: string;
}

/**
 * First-launch onboarding: generate a fresh key and the ZK commitment secrets
 * inside secure storage, and return the public address. Nothing here leaves the
 * device.
 *
 * The secrets are minted here rather than at registration on purpose. They are
 * only two random field elements, and nothing about them is specific to
 * registering; generating them now means `register` never has to WRITE to the
 * gated entry, and a write is a second prompt.
 */
export async function createIdentity(): Promise<`0x${string}`> {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const identity: VoterIdentity = { privateKey, ...generateSecrets() };
  const gated = await canGate();
  await SecureStore.setItemAsync(
    KEY_IDENTITY,
    JSON.stringify(identity),
    gated ? gatedOptions("Secure your voting identity") : PUBLIC_OPTIONS,
  );
  await SecureStore.setItemAsync(KEY_ADDRESS, account.address, PUBLIC_OPTIONS);
  await SecureStore.setItemAsync(KEY_AUTH_GATED, gated ? "1" : "0", PUBLIC_OPTIONS);
  return account.address;
}

export async function getAddress(): Promise<`0x${string}` | null> {
  const addr = await SecureStore.getItemAsync(KEY_ADDRESS, PUBLIC_OPTIONS);
  return (addr as `0x${string}`) ?? null;
}

/**
 * The one gated read — and the only entry point to anything secret.
 *
 * Costs exactly one biometric prompt, carrying `reason` as its message. Callers
 * unlock once at the top of a flow and pass the result down; asking twice in one
 * flow is the bug this function exists to make hard.
 *
 * Throws `AUTH_CANCELLED` when the voter dismisses the prompt — see
 * `isAuthCancellation`.
 */
export async function unlockIdentity(reason = "Unlock your voting identity"): Promise<VoterIdentity> {
  const gated = await storeIsGated();
  const options = gated ? gatedOptions(reason) : PUBLIC_OPTIONS;

  // The store could not be gated when this identity was created (Expo Go, or no
  // fingerprint enrolled at the time), so reading it prompts for nothing. If the
  // phone can authenticate NOW, ask explicitly — one prompt, never zero where one
  // is possible. On a phone with no biometric at all this is a no-op, exactly as
  // before.
  if (!gated && !(await authenticate(reason))) throw new Error(AUTH_CANCELLED);

  const raw = await SecureStore.getItemAsync(KEY_IDENTITY, options);
  if (raw) return JSON.parse(raw) as VoterIdentity;

  const migrated = await migrateLegacyIdentity(options);
  if (migrated) return migrated;
  throw new Error("No voting identity on this device");
}

/**
 * One-time move from the old three-entry layout to the single blob.
 *
 * Runs inside the caller's unlock, so a voter upgrading the app pays the old
 * prompt count once, and one prompt on every flow after that.
 *
 * The reads are deliberately NOT wrapped in `.catch(() => null)`: a dismissed
 * prompt returning null would look identical to "this voter never registered",
 * and we would mint fresh secrets over the ones matching their on-chain leaf.
 * Letting the error propagate leaves the old entries untouched, so a retry
 * migrates correctly.
 */
async function migrateLegacyIdentity(
  options: SecureStore.SecureStoreOptions,
): Promise<VoterIdentity | null> {
  const privateKey = await SecureStore.getItemAsync(LEGACY_KEY_PRIVATE, options);
  if (!privateKey) return null;

  const nullifier = await SecureStore.getItemAsync(LEGACY_KEY_NULLIFIER, options);
  const secret = await SecureStore.getItemAsync(LEGACY_KEY_SECRET, options);
  const hasSecrets = !!nullifier && !!secret;

  // A registered voter with no secrets cannot be repaired by generating new
  // ones — their commitment is already an anonymous leaf in the tree, and fresh
  // secrets would prove membership of nothing. Say so rather than quietly
  // replacing them.
  if (!hasSecrets && (await hasRegisteredLocally())) {
    throw new Error(
      "Your registration secrets are missing from this phone. Contact your GN officer.",
    );
  }

  const identity: VoterIdentity = {
    privateKey: privateKey as `0x${string}`,
    ...(hasSecrets ? { nullifier: nullifier as string, secret: secret as string } : generateSecrets()),
  };

  await SecureStore.setItemAsync(KEY_IDENTITY, JSON.stringify(identity), options);
  await Promise.all(
    [LEGACY_KEY_PRIVATE, LEGACY_KEY_NULLIFIER, LEGACY_KEY_SECRET].map(key =>
      SecureStore.deleteItemAsync(key, PUBLIC_OPTIONS).catch(() => undefined),
    ),
  );
  return identity;
}

export async function hasRegisteredLocally(): Promise<boolean> {
  // Only true once the register() tx actually confirmed on-chain — NOT merely when
  // secrets were generated (a failed tx must not look like a success). The secrets
  // now exist from onboarding onwards, so this flag is the ONLY answer to "has this
  // voter registered?" — their presence no longer implies anything.
  const flag = await SecureStore.getItemAsync(KEY_REGISTERED, PUBLIC_OPTIONS).catch(() => null);
  return flag === "1";
}

/** Mark the voter as registered — call ONLY after the register() tx confirms. */
export async function markRegistered(): Promise<void> {
  await SecureStore.setItemAsync(KEY_REGISTERED, "1", PUBLIC_OPTIONS);
}

/**
 * Cache of the division (Voting contract address) resolved from the on-chain
 * allowlist. This is a cache, not a choice — see `services/division.ts`, which
 * owns resolution and is the only thing that should write here.
 */
export async function setSelectedDivision(votingContract: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_DIVISION, votingContract, PUBLIC_OPTIONS);
}

export async function getSelectedDivision(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_DIVISION, PUBLIC_OPTIONS).catch(() => null);
}

export async function clearSelectedDivision(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_DIVISION, PUBLIC_OPTIONS).catch(() => undefined);
}

async function getVotedList(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(KEY_VOTED, PUBLIC_OPTIONS).catch(() => null);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

export async function markVoted(divisionContract: string): Promise<void> {
  const list = await getVotedList();
  const c = divisionContract.toLowerCase();
  if (!list.includes(c)) {
    list.push(c);
    await SecureStore.setItemAsync(KEY_VOTED, JSON.stringify(list), PUBLIC_OPTIONS);
  }
}

export async function hasVoted(divisionContract: string): Promise<boolean> {
  const list = await getVotedList();
  return list.includes(divisionContract.toLowerCase());
}

/** Danger: wipe all identity data from the device. */
export async function wipeIdentity(): Promise<void> {
  await Promise.all(
    [
      KEY_IDENTITY,
      KEY_ADDRESS,
      KEY_AUTH_GATED,
      KEY_REGISTERED,
      KEY_DIVISION,
      KEY_VOTED,
      LEGACY_KEY_PRIVATE,
      LEGACY_KEY_NULLIFIER,
      LEGACY_KEY_SECRET,
    ].map(key => SecureStore.deleteItemAsync(key, PUBLIC_OPTIONS).catch(() => undefined)),
  );
}
