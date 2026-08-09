"use client";

import { AddDivisionSection } from "~~/app/voting/admin/_components/AddDivisionSection";
import { useAdminElection } from "~~/app/voting/admin/_components/AdminElectionProvider";
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

      {/* Custom chain only: GN officers have credentials instead of wallets, so
          the Election Authority creates their accounts here. */}
      {isCustom && <GnAccountsSection />}
    </>
  );
};

export default AdminDivisionsPage;
