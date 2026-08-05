"use client";

import React from "react";
import { AdminElectionProvider } from "~~/app/voting/admin/_components/AdminElectionProvider";

/**
 * The admin area's shell.
 *
 * A layout rather than three independent pages, because Next.js keeps a layout
 * mounted while you navigate between its children — which is what lets the
 * selected division, the live contract reads and the in-progress form drafts
 * survive a move from Operations to Ballot and back.
 */
const AdminLayout = ({ children }: { children: React.ReactNode }) => (
  <div className="grow w-full p-6 lg:p-8">
    <AdminElectionProvider>{children}</AdminElectionProvider>
  </div>
);

export default AdminLayout;
