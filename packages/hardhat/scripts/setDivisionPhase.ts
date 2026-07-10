import { ethers } from "hardhat";

/**
 * Advance election phase on the registered division contracts.
 *
 * Usage (from packages/hardhat):
 *   npx hardhat run scripts/setDivisionPhase.ts --network localhost
 *
 * Control via env vars:
 *   PHASE=registration|voting   (default: registration)
 *   DURATION=<seconds>          (default: 3600)
 *   DIVISION=<name|all>         (default: all)  e.g. DIVISION=Kaduwela
 */

const REGISTRY = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";

async function main() {
  const phase = (process.env.PHASE ?? "registration").toLowerCase();
  const duration = BigInt(process.env.DURATION ?? "3600");
  const filter = (process.env.DIVISION ?? "all").toLowerCase();

  const [admin] = await ethers.getSigners();
  const registry = await ethers.getContractAt("ElectionRegistry", REGISTRY);
  const divisions = await registry.getAllDivisions();

  console.log(`Admin: ${admin.address}`);
  console.log(`Action: ${phase}  duration: ${duration}s  target: ${filter}\n`);

  for (const d of divisions) {
    if (filter !== "all" && d.name.toLowerCase() !== filter) continue;

    const voting = await ethers.getContractAt("Voting", d.votingContract);
    const data = await voting.getVotingData();
    const currentPhase = Number(data[2]); // 0 Setup,1 Registration,2 Voting,3 Ended

    try {
      if (phase === "registration") {
        if (currentPhase !== 0) {
          console.log(`↺ ${d.name}: not in Setup (phase ${currentPhase}) — skipping`);
          continue;
        }
        const tx = await voting.startRegistration(duration);
        await tx.wait();
        console.log(`✅ ${d.name}: Registration started (${duration}s)`);
      } else if (phase === "voting") {
        const tx = await voting.startVoting(duration);
        await tx.wait();
        console.log(`✅ ${d.name}: Voting started (${duration}s)`);
      } else {
        console.log(`Unknown PHASE '${phase}'. Use registration|voting.`);
        return;
      }
    } catch (e: any) {
      console.log(`❌ ${d.name}: ${e?.shortMessage ?? e?.message ?? e}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
