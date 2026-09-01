"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, http, parseEventLogs } from "viem";
import type { Abi } from "viem";
import { Section } from "~~/app/voting/admin/_components/Section";
import {
  DIVISION_CREATED_EVENT,
  SET_VOTING_CONTRACT_ABI,
  VOTING_CONTRACT_UPDATED_EVENT,
} from "~~/app/voting/admin/_components/adminContracts";
import deployedContracts from "~~/contracts/deployedContracts";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { LiveDivision, useDivisions } from "~~/hooks/useDivisions";
import { useElectionWriter } from "~~/hooks/useElectionWriter";
import { getDeployedAddress } from "~~/utils/deployedAddress";
import { notification } from "~~/utils/scaffold-eth";

/**
 * Deploy a new polling division, and repair ones that were never authorised.
 *
 * Moved out of `page.tsx` unchanged when the admin area became three routes.
 * It belongs on the Divisions tab rather than beside the phase controls: it
 * deploys a contract, which is a provisioning act done once, not something an
 * operator touches on election day.
 */
export const AddDivisionSection = () => {
  const [divisionName, setDivisionName] = useState("");
  const [isDeploying, setIsDeploying] = useState(false);
  const [authorising, setAuthorising] = useState<string | null>(null);
  /**
   * Lower-cased addresses only, never the division objects.
   *
   * Storing objects here would make this state a fresh array on every refresh,
   * which re-renders, which re-runs the effect below, which refreshes again —
   * an unbounded loop as soon as `useDivisions` returns a new array identity per
   * render. Addresses compare cheaply, so the setter below can return the
   * previous value unchanged and stop the cycle at its source.
   */
  const [unauthorisedAddresses, setUnauthorisedAddresses] = useState<string[]>([]);
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
   * Which divisions may not yet be used for GN enrolment.
   *
   * `NicRegistry.s_votingContracts` is a private mapping with no getter, so
   * authorisation cannot be read directly. `setVotingContract` emits
   * `VotingContractUpdated(address indexed votingContract, bool authorized)`
   * on every change, so the last event for an address is its current state —
   * and an address with no event was never authorised at all. That is the only
   * way a client can answer this question; `test/DivisionEnrolment.ts` pins the
   * event so a contract change cannot make this indicator quietly go blind.
   */
  const refreshAuthorisation = useCallback(async () => {
    if (!NIC_REGISTRY_ADDRESS || divisions.length === 0) {
      setUnauthorisedAddresses(prev => (prev.length === 0 ? prev : []));
      return;
    }
    try {
      const logs = await publicClient.getLogs({
        address: NIC_REGISTRY_ADDRESS,
        event: VOTING_CONTRACT_UPDATED_EVENT,
        fromBlock: 0n,
        toBlock: "latest",
      });

      // Last event wins: authorisation can be granted and revoked, and the
      // current state is whatever the most recent event said.
      const authorised = new Map<string, boolean>();
      for (const log of logs) {
        const target = (log.args as { votingContract?: string }).votingContract;
        const flag = (log.args as { authorized?: boolean }).authorized;
        if (target) authorised.set(target.toLowerCase(), Boolean(flag));
      }

      const next = divisions.map(d => d.votingContract.toLowerCase()).filter(address => !authorised.get(address));

      setUnauthorisedAddresses(prev =>
        prev.length === next.length && prev.every((address, i) => address === next[i]) ? prev : next,
      );
    } catch {
      // A read failure must not be reported as "everything is fine": clearing
      // the list would hide exactly the state this exists to surface. Keep the
      // last known answer and stay quiet — this is a repair tool, not a monitor.
    }
  }, [NIC_REGISTRY_ADDRESS, divisions, publicClient]);

  useEffect(() => {
    refreshAuthorisation();
  }, [refreshAuthorisation]);

  const unauthorised = useMemo(
    () => divisions.filter(d => unauthorisedAddresses.includes(d.votingContract.toLowerCase())),
    [divisions, unauthorisedAddresses],
  );

  /**
   * Authorise one division for NIC enrolment.
   *
   * Separated from creation so it can also repair divisions made before this
   * was wired up — of which there may be several on any chain that has been
   * used for a demo.
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

  const handleAuthorise = async (division: LiveDivision) => {
    setAuthorising(division.votingContract);
    try {
      await authoriseDivision(division.votingContract as `0x${string}`);
      notification.success(`✅ "${division.name}" can now be used for GN enrolment.`);
      await refreshAuthorisation();
    } catch (e: any) {
      notification.error(e?.shortMessage || e?.message || "Failed to authorise division");
    } finally {
      setAuthorising(null);
    }
  };

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
   * If the second call fails the division still exists, so this says so plainly
   * rather than reporting a clean failure — and the list below offers the
   * repair.
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
          `Division "${name}" was created, but its address could not be read back, so it was not authorised for GN enrolment. Use the list below.`,
        );
      } else {
        try {
          await authoriseDivision(votingContract);
          notification.success(`✅ Division "${name}" deployed, registered & authorised for enrolment!`);
        } catch (e: any) {
          notification.warning(
            `Division "${name}" was created, but authorising it for GN enrolment failed: ` +
              `${e?.shortMessage || e?.message || "unknown error"}. Use the list below to retry.`,
          );
        }
      }

      setDivisionName("");
      refetch();
      await refreshAuthorisation();
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

        {unauthorised.length > 0 && (
          <div className="alert alert-warning flex-col items-stretch gap-2 text-sm">
            <div>
              <span className="font-bold">
                {unauthorised.length} division{unauthorised.length === 1 ? "" : "s"} cannot be used for GN enrolment
                yet.
              </span>
              <p className="text-xs opacity-80 mt-1">
                A division must be authorised in the NIC Registry before a GN officer can enrol voters into it.
                Divisions created before this step was automatic need it applied once. Without it, the GN portal fails
                with &quot;Unregistered division&quot;.
              </p>
            </div>
            <ul className="space-y-1">
              {unauthorised.map(division => (
                <li key={division.votingContract} className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold truncate">{division.name}</span>
                  <button
                    className={`btn btn-xs btn-primary ${authorising === division.votingContract ? "loading" : ""}`}
                    disabled={authorising !== null}
                    onClick={() => handleAuthorise(division)}
                  >
                    Authorise
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
};
