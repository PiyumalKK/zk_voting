import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import Constants, { ExecutionEnvironment } from "expo-constants";

/**
 * Keystore service — the security heart of the voter app.
 *
 * The voter's private key and ZK commitment secrets live in the device's
 * hardware-backed secure storage (iOS Keychain / Android Keystore) and are
 * released only after a biometric / device-passcode check.
 *
 * The public address is stored WITHOUT an auth gate so the app can display it
 * (e.g. the QR shown to the GN officer) without prompting for a fingerprint.
 *
 * Nothing sensitive is ever sent to a server.
 */

const KEY_PRIVATE = "slvote.privateKey"; // auth-gated when biometrics are available
const KEY_ADDRESS = "slvote.address"; // public, no auth
const KEY_NULLIFIER = "slvote.nullifier"; // auth-gated when biometrics are available
const KEY_SECRET = "slvote.secret"; // auth-gated when biometrics are available
const KEY_REGISTERED = "slvote.registered"; // public flag, set ONLY after a confirmed on-chain register
const KEY_DIVISION = "slvote.division"; // public: the voter's chosen division contract
const KEY_VOTED = "slvote.voted"; // public: JSON array of division contracts this identity has voted in
const KEY_AUTH_GATED = "slvote.authGated"; // "1" if the sensitive keys were written behind a biometric gate

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

const PUBLIC_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// SecureStore options that force a biometric check on read/write.
const GATED_OPTIONS: SecureStore.SecureStoreOptions = {
  requireAuthentication: true,
  authenticationPrompt: "Unlock your voting identity",
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

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

// Options for the sensitive keys, matching how they were written. The decision is
// persisted (KEY_AUTH_GATED) at identity creation so reads always use the same
// options the writes used, even if the user later enrolls or removes a fingerprint.
async function sensitiveOptions(): Promise<SecureStore.SecureStoreOptions> {
  const flag = await SecureStore.getItemAsync(KEY_AUTH_GATED, PUBLIC_OPTIONS).catch(() => null);
  if (flag === "1") return GATED_OPTIONS;
  if (flag === "0") return PUBLIC_OPTIONS;
  return (await canGate()) ? GATED_OPTIONS : PUBLIC_OPTIONS;
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

/** Explicit biometric / passcode prompt (used before sensitive actions). */
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

/**
 * First-launch onboarding: generate a fresh key inside secure storage and
 * return the public address. The private key never leaves the device.
 */
export async function createIdentity(): Promise<`0x${string}`> {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const gated = await canGate();
  await SecureStore.setItemAsync(KEY_PRIVATE, privateKey, gated ? GATED_OPTIONS : PUBLIC_OPTIONS);
  await SecureStore.setItemAsync(KEY_ADDRESS, account.address, PUBLIC_OPTIONS);
  await SecureStore.setItemAsync(KEY_AUTH_GATED, gated ? "1" : "0", PUBLIC_OPTIONS);
  return account.address;
}

export async function getAddress(): Promise<`0x${string}` | null> {
  const addr = await SecureStore.getItemAsync(KEY_ADDRESS, PUBLIC_OPTIONS);
  return (addr as `0x${string}`) ?? null;
}

/** Retrieve the private key — triggers the biometric prompt when the device is gated. */
export async function getPrivateKey(): Promise<`0x${string}`> {
  const pk = await SecureStore.getItemAsync(KEY_PRIVATE, await sensitiveOptions());
  if (!pk) throw new Error("No voting identity on this device");
  return pk as `0x${string}`;
}

/** Store the ZK commitment secrets generated during registration. */
export async function storeVoterSecrets(nullifier: string, secret: string): Promise<void> {
  const options = await sensitiveOptions();
  await SecureStore.setItemAsync(KEY_NULLIFIER, nullifier, options);
  await SecureStore.setItemAsync(KEY_SECRET, secret, options);
}

export async function getVoterSecrets(): Promise<{ nullifier: string; secret: string } | null> {
  const options = await sensitiveOptions();
  const nullifier = await SecureStore.getItemAsync(KEY_NULLIFIER, options);
  const secret = await SecureStore.getItemAsync(KEY_SECRET, options);
  if (!nullifier || !secret) return null;
  return { nullifier, secret };
}

export async function hasRegisteredLocally(): Promise<boolean> {
  // Only true once the register() tx actually confirmed on-chain — NOT merely when
  // secrets were generated (a failed tx must not look like a success).
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
  await Promise.all([
    SecureStore.deleteItemAsync(KEY_PRIVATE, PUBLIC_OPTIONS),
    SecureStore.deleteItemAsync(KEY_ADDRESS, PUBLIC_OPTIONS),
    SecureStore.deleteItemAsync(KEY_NULLIFIER, PUBLIC_OPTIONS),
    SecureStore.deleteItemAsync(KEY_SECRET, PUBLIC_OPTIONS),
    SecureStore.deleteItemAsync(KEY_REGISTERED, PUBLIC_OPTIONS),
    SecureStore.deleteItemAsync(KEY_DIVISION, PUBLIC_OPTIONS),
    SecureStore.deleteItemAsync(KEY_VOTED, PUBLIC_OPTIONS),
  ]);
}
