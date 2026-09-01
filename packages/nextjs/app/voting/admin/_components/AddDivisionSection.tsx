"use client";

import { useCallback, useMemo, useState } from "react";
import { createPublicClient, http, parseEventLogs } from "viem";
import type { Abi } from "viem";
import { Section } from "~~/app/voting/admin/_components/Section";
import { DIVISION_CREATED_EVENT, SET_VOTING_CONTRACT_ABI } from "~~/app/voting/admin/_components/adminContracts";
import deployedContracts from "~~/contracts/deployedContracts";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { useDivisions } from "~~/hooks/useDivisions";
import { useElectionWriter } from "~~/hooks/useElectionWriter";
import { getDeployedAddress } from "~~/utils/deployedAddress";
import { notification } from "~~/utils/scaffold-eth";

/**
 * Deploy a new polling division.
 *
 * Moved out of `page.tsx` unchanged when the admin area became three routes.
 * It belongs on the Divisions tab rather than beside the phase controls: it
 * deploys a contract, which is a provisioning act done once, not something an
 * operator touches on election day.
 */
export const AddDivisionSection = () => {
  const [divisionName, setDivisionName] = useState("");
  const [isDeploying, setIsDeploying] = useState(false);
  const { divisions, refetch } = useDivisions();
  const { targetNetwork } = useTargetNetwork();
  const { write } = useElectionWriter();

  const REGISTRY_ABI = useMemo(
    () => (deployedContracts as Record<number, any>)[targetNetwork.id]?.ElectionRegistry?.abi ?? [],
    [targetNetwork.id],
  );
  const REGISTRY_ADDRESS = useMemo(
    () =>
      (deployedContracts as Record<number, any>)[targetNetwork.id]?.ElectionRegistry?.address as
        | `0x${string}`
        | undefined,
    [targetNetwork.id],
  );
  const NIC_REGISTRY_ADDRESS = useMemo(() => getDeployedAddress(targetNetwork.id, "NicRegistry"), [targetNetwork.id]);

  const publicClient = useMemo(
    () => createPublicClient({ chain: targetNetwork, transport: http(targetNetwork.rpcUrls.default.http[0]) }),
    [targetNetwork],
  );

  /**
   * Authorise one division for NIC enrolment. Always called as the second
   * half of `handleCreateDivision` below — a division deployed through this
   * panel is authorised automatically, in the same click.
   */
  const authoriseDivision = useCallback(
    async (votingContract: `0x${string}`) => {
      if (!NIC_REGISTRY_ADDRESS) {
        notification.error("NicRegistry contract not found.");
        return false;
      }
      await write({
        address: NIC_REGISTRY_ADDRESS,
        abi: SET_VOTING_CONTRACT_ABI as unknown as Abi,
        functionName: "setVotingContract",
        args: [votingContract, true],
      });
      return true;
    },
    [NIC_REGISTRY_ADDRESS, write],
  );

  /**
   * Create a division and finish setting it up.
   *
   * Two transactions, not one. `createDivision` deploys the `Voting` contract
   * and registers it, but the division must additionally be authorised in
   * `NicRegistry` — and `ElectionRegistry` cannot do that itself: it knows the
   * registry's address (it passes it to every `Voting` it deploys) but
   * `setVotingContract` is `onlyOwner` on a contract it does not own. Before
   * this, the panel made only the first call and reported success, so a
   * hand-made division looked complete and then failed at the GN portal with the
   * bare revert string "Unregistered division".
   *
   * That authorisation now gates registration as well as enrolment — an
   * unauthorised division cannot accept a leaf from an enrolled device, because
   * `Voting.register()` calls `NicRegistry.commitDevice` — so skipping it leaves
   * a division that is broken for voters, not merely for officers.
   *
   * If the second call fails the division still exists, so this says so
   * plainly rather than reporting a clean failure.
   */
  const handleCreateDivision = async () => {
    const name = divisionName.trim();
    if (!name) {
      notification.error("Enter a division name.");
      return;
    }
    // Case-insensitive: `ElectionRegistry.createDivision` has no uniqueness
    // check of its own, so nothing on-chain stops "Kaduwela" and "kaduwela"
    // from both existing. Same rule the bulk import applies server-side
    // (`normaliseDivisionName` in `services/divisions/divisionCreation.ts`).
    if (divisions.some(d => d.name.trim().toLowerCase() === name.toLowerCase())) {
      notification.error(`A division named "${name}" already exists.`);
      return;
    }
    if (!REGISTRY_ADDRESS) {
      notification.error("ElectionRegistry contract not found.");
      return;
    }
    setIsDeploying(true);
    try {
      const hash = await write({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: "createDivision",
        args: [name],
      });

      // The new contract's address comes from the receipt rather than from
      // re-reading the division list: reading back the "last" division would be
      // wrong if two admins created one at the same time, and this is exact.
      let votingContract: `0x${string}` | undefined;
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash });
        const created = parseEventLogs({
          abi: [DIVISION_CREATED_EVENT],
          logs: receipt.logs,
        }) as unknown as { args: { votingContract: `0x${string}` } }[];
        votingContract = created[0]?.args?.votingContract;
      } catch {
        votingContract = undefined;
      }

      if (!votingContract) {
        notification.warning(
          `Division "${name}" was created, but its address could not be read back, so it was not authorised for GN enrolment. Voters won't be able to enrol until it is.`,
        );
      } else {
        try {
          await authoriseDivision(votingContract);
          notification.success(`✅ Division "${name}" deployed, registered & authorised for enrolment!`);
        } catch (e: any) {
          notification.warning(
            `Division "${name}" was created, but authorising it for GN enrolment failed: ` +
              `${e?.shortMessage || e?.message || "unknown error"}. Voters won't be able to enrol until it is authorised.`,
          );
        }
      }

      setDivisionName("");
      refetch();
    } catch (e: any) {
      const msg = e?.shortMessage || e?.message || "Failed to create division";
      notification.error(msg);
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <Section
      title="Add New Division"
      hint="Deploy a new Voting contract, register it as a polling division, and authorise it for NIC enrolment. Assign a GN officer afterwards in GN Officer Management above."
    >
      <div className="space-y-4">
        <div className="form-control">
          <label className="label">
            <span className="label-text text-sm font-bold">Division Name</span>
          </label>
          <input
            type="text"
            className="input input-bordered w-full"
            placeholder="e.g. Kandy, Matara, Jaffna..."
            value={divisionName}
            onChange={e => setDivisionName(e.target.value)}
            disabled={isDeploying}
          />
        </div>
        <p className="text-xs opacity-50">
          This deploys a fresh Voting contract on-chain via the ElectionRegistry factory, then authorises it in the NIC
          Registry so GN officers can enrol voters into it. Two transactions. The new division starts in the Setup phase
          with no question, candidates, or voters. Configure it from the Operations and Ballot tabs.
        </p>
        <div className="flex justify-end">
          <button
            className={`btn btn-primary btn-sm ${isDeploying ? "loading" : ""}`}
            disabled={isDeploying || !divisionName.trim()}
            onClick={handleCreateDivision}
          >
            {isDeploying ? "Deploying..." : "Deploy & Register Division"}
          </button>
        </div>
      </div>
    </Section>
  );
};
