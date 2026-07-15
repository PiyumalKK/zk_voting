import { createHmac } from "crypto";

const OLD_NIC_FORMAT = /^\d{9}[VX]$/;
const NEW_NIC_FORMAT = /^\d{12}$/;

export function canonicalizeNic(nic: string): string | null {
  const canonicalNic = nic.trim().toUpperCase();
  return OLD_NIC_FORMAT.test(canonicalNic) || NEW_NIC_FORMAT.test(canonicalNic) ? canonicalNic : null;
}

export function hashNic(nic: string, pepper: string): `0x${string}` {
  return `0x${createHmac("sha256", pepper).update(nic, "utf8").digest("hex")}`;
}
