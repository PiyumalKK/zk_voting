import { useState } from "react";
import { Address } from "@scaffold-ui/components";
import { EyeIcon, UsersIcon } from "@heroicons/react/24/outline";
import { isCustomChain, useVoterList, useVoterStatusById } from "~~/services/chain/hooks";

export const ShowVotersButton = () => {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const openModal = () => setIsModalOpen(true);
  const closeModal = () => setIsModalOpen(false);

  // Backend-agnostic allowlist: VoterAdded events on the EVM backend,
  // GET /voters on the custom chain (see services/chain).
  const voters = useVoterList();
  const voterIds = voters.map(v => v.id);

  return (
    <>
      <label htmlFor="show-voters-modal" className="btn btn-outline btn-sm font-normal gap-1" onClick={openModal}>
        <UsersIcon className="h-4 w-4" />
        <span>View Voters ({voterIds.length})</span>
      </label>

      {/* Modal - only mounted when open */}
      {isModalOpen && <ShowVotersModal isOpen={isModalOpen} onClose={closeModal} uniqueVoters={voterIds} />}
    </>
  );
};

const VoterStatus = ({ voterId }: { voterId: string }) => {
  const status = useVoterStatusById(voterId);

  const isVoter = status?.allowed;
  const hasRegistered = status?.registered;

  return (
    <div className="flex items-center justify-between p-3 border border-base-300 rounded-lg">
      <div className="flex-1">
        {isCustomChain ? (
          <span className="font-mono text-sm break-all">{voterId}</span>
        ) : (
          <Address address={voterId as `0x${string}`} />
        )}
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="text-xs opacity-70">Status:</span>
          <span className={`badge badge-sm ${isVoter ? "badge-success" : "badge-error"}`}>
            {isVoter ? "Allowed" : "Revoked"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs opacity-70">Registered:</span>
          <span className={`badge badge-sm ${hasRegistered ? "badge-info" : "badge-ghost"}`}>
            {hasRegistered ? "Yes" : "No"}
          </span>
        </div>
      </div>
    </div>
  );
};

const ShowVotersModal = ({
  isOpen,
  onClose,
  uniqueVoters,
}: {
  isOpen: boolean;
  onClose: () => void;
  uniqueVoters: string[];
}) => {
  return (
    <>
      <input type="checkbox" id="show-voters-modal" className="modal-toggle" checked={isOpen} readOnly />
      <label htmlFor="show-voters-modal" className="modal cursor-pointer" onClick={onClose}>
        <label className="modal-box relative max-w-3xl" onClick={e => e.stopPropagation()}>
          {/* dummy input to capture event onclick on modal box */}
          <input className="h-0 w-0 absolute top-0 left-0" />
          <h3 className="text-xl font-bold flex items-center gap-2">
            <EyeIcon className="h-5 w-5" />
            All Voters
          </h3>
          <label
            htmlFor="show-voters-modal"
            className="btn btn-ghost btn-sm btn-circle absolute right-3 top-3"
            onClick={() => onClose()}
          >
            ✕
          </label>

          <div className="">
            <div className="flex items-center justify-between">
              <p className="text-sm opacity-70">List of all voters that have been added for this proposal.</p>
              <div className="stats stats-horizontal">
                <div className="stat py-2 px-3">
                  <div className="stat-title text-xs">Total Voters</div>
                  <div className="stat-value text-lg">{uniqueVoters.length}</div>
                </div>
              </div>
            </div>

            {uniqueVoters.length === 0 ? (
              <div className="text-center py-8 opacity-70">
                <UsersIcon className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>No voters have been added yet.</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-96 overflow-y-auto">
                <div className="text-sm font-medium opacity-80 pb-2 border-b border-base-300">Voters & Status</div>
                {uniqueVoters.map((voterId, index) => (
                  <VoterStatus key={`${voterId}-${index}`} voterId={voterId} />
                ))}
              </div>
            )}

            <div className="flex justify-between items-center pt-4 border-t border-base-300 mt-4">
              <div className="text-xs">
                • <span className="text-success">Allowed</span>: Can vote in this proposal
                <br />• <span className="text-error">Revoked</span>: Cannot vote (permissions removed)
                <br />• <span className="text-info">Registered</span>: Has submitted their commitment
              </div>
              <label htmlFor="show-voters-modal" className="btn btn-primary btn-sm" onClick={() => onClose()}>
                Close
              </label>
            </div>
          </div>
        </label>
      </label>
    </>
  );
};
