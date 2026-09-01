"use client";

import { AddDivisionSection } from "~~/app/voting/admin/_components/AddDivisionSection";
import { useAdminElection } from "~~/app/voting/admin/_components/AdminElectionProvider";
import { BulkDivisionsSection } from "~~/app/voting/admin/_components/BulkDivisionsSection";
import { BulkGnAccountsSection } from "~~/app/voting/admin/_components/BulkGnAccountsSection";
import { DivisionsListSection } from "~~/app/voting/admin/_components/DivisionsListSection";
import { GNManagementSection } from "~~/app/voting/admin/_components/GNManagementSection";
import { GnAccountsSection } from "~~/app/voting/admin/_components/GnAccountsSection";
import { GroupHeading } from "~~/app/voting/admin/_components/Section";

/**
 * Admin › Divisions.
 *
 * Provisioning, not operations: which divisions exist and who staffs them.
 * These panels have no phase gate and are used once when an election is set up,
 * so they no longer sit between the controls an operator needs on the day.
 */
const AdminDivisionsPage = () => {
  const { isCustom } = useAdminElection();

  return (
    <>
      <GroupHeading
        title="Registry administration"
        subtitle="Divisions and the officers who staff them. Changes here affect the whole election, not one ballot."
      />

      {/* Hardhat/dev only: a GN officer is a wallet address there. In custom
          (production) mode officers have credentials, so GnAccountsSection below
          is the single source of truth and this raw-address form is hidden to
          avoid creating orphaned officers that can never sign. */}
      {!isCustom && <GNManagementSection />}

      <AddDivisionSection />

      {/* Custom chain only: bulk creation goes through the server relay
          (`createDivisionOnChain`), which needs the admin's server-held
          signing key — hardhat mode has none, so its single-division form
          above (MetaMask) is the only option there. */}
      {isCustom && <BulkDivisionsSection />}

      {/* Custom mode only: GNManagementSection above already gives hardhat mode
          its own division table (with the same Hide/Show), so this would be a
          redundant second one there. */}
      {isCustom && <DivisionsListSection />}

      {/* Custom chain only: GN officers have credentials instead of wallets, so
          the Election Authority creates their accounts here. */}
      {isCustom && <GnAccountsSection />}
      {isCustom && <BulkGnAccountsSection />}
    </>
  );
};

export default AdminDivisionsPage;
