import * as dotenv from "dotenv";
dotenv.config();
import { Wallet } from "ethers";
import password from "@inquirer/password";
import { spawn } from "child_process";
import { config } from "hardhat";

/**
 * Networks whose signing keys come from the public Hardhat test mnemonic and
 * therefore need no encrypted deployer key: the in-process `hardhat` network,
 * a local `hardhat node` (`localhost`), and the custom Go chain (`custom`,
 * added in M08 — see hardhat.config.ts).
 *
 * `custom` belongs here for exactly the same reason `localhost` does: it is a
 * local development chain whose accounts are the well-known test mnemonic,
 * prefunded at genesis. Without this entry `yarn deploy --network custom`
 * falls through to the branch below and stops with "You don't have a deployer
 * account", because that path expects a real deployer key for a real network.
 *
 * Every other network is still treated as real and continues to require
 * DEPLOYER_PRIVATE_KEY_ENCRYPTED — that behaviour is deliberately unchanged.
 */
const LOCAL_NETWORKS = new Set(["localhost", "hardhat", "custom"]);

/**
 * Unencrypts the private key and runs the hardhat deploy command
 */
async function main() {
  const networkIndex = process.argv.indexOf("--network");
  const networkName = networkIndex !== -1 ? process.argv[networkIndex + 1] : config.defaultNetwork;

  if (LOCAL_NETWORKS.has(networkName)) {
    // Deploy command on the localhost network
    const hardhat = spawn("hardhat", ["deploy", ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });

    hardhat.on("exit", code => {
      process.exit(code || 0);
    });
    return;
  }

  const encryptedKey = process.env.DEPLOYER_PRIVATE_KEY_ENCRYPTED;

  if (!encryptedKey) {
    console.log("🚫️ You don't have a deployer account. Run `yarn generate` or `yarn account:import` first");
    return;
  }

  const pass = await password({ message: "Enter password to decrypt private key:" });

  try {
    const wallet = await Wallet.fromEncryptedJson(encryptedKey, pass);
    process.env.__RUNTIME_DEPLOYER_PRIVATE_KEY = wallet.privateKey;

    const hardhat = spawn("hardhat", ["deploy", ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });

    hardhat.on("exit", code => {
      process.exit(code || 0);
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (e) {
    console.error("Failed to decrypt private key. Wrong password?");
    process.exit(1);
  }
}

main().catch(console.error);
