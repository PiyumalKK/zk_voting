import { useConfirm } from "./ConfirmDialog";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

/**
 * The dialog that replaced `window.confirm` on the admin destructive actions.
 *
 * What is worth pinning down is not how it looks but what it *resolves to*.
 * Every call site branches on that boolean to decide whether to write to a
 * contract or delete an officer's key, so a dismissal that resolved `true` —
 * or one that never resolved at all, stranding the handler — would turn a
 * cancelled action into a performed one, or a confirmed one into a hang.
 *
 * Note also the environment: jsdom 26 implements neither `showModal` nor
 * `close`, so these cases exercise the component's fallback path. The
 * `showModal` path is the one that runs in a browser; the assertions below
 * hold on both because the component never relies on native dismissal.
 */

/** Drives `useConfirm` the way a real handler does, recording what it resolved to. */
const Harness = ({ onResolved }: { onResolved: (confirmed: boolean) => void }) => {
  const { confirm, confirmDialog } = useConfirm();

  const ask = async () => {
    const confirmed = await confirm({
      title: "Delete GN officer account",
      message: 'Delete the account "gn.kaduwela"?\n\nTheir signing key is destroyed.',
      confirmLabel: "Delete account",
      tone: "danger",
    });
    onResolved(confirmed);
  };

  return (
    <div>
      <button onClick={ask}>Delete</button>
      {confirmDialog}
    </div>
  );
};

describe("ConfirmDialog", () => {
  const open = async () => {
    const onResolved = vi.fn();
    const user = userEvent.setup();
    render(<Harness onResolved={onResolved} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog");

    return { user, onResolved };
  };

  it("is not mounted until something asks", () => {
    render(<Harness onResolved={vi.fn()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the prompt verbatim, newlines and all", async () => {
    await open();

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain('Delete the account "gn.kaduwela"?');
    expect(dialog.textContent).toContain("Their signing key is destroyed.");
  });

  it("resolves true when confirmed", async () => {
    const { user, onResolved } = await open();

    await user.click(screen.getByRole("button", { name: /delete account/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves false when cancelled", async () => {
    const { user, onResolved } = await open();

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /**
   * Escape and the backdrop are dismissals, and a dismissal is a refusal. If
   * either resolved `true` the operator would perform a destructive action by
   * pressing the key that means "get me out of here".
   */
  it("treats Escape as a refusal", async () => {
    const { user, onResolved } = await open();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("treats a backdrop click as a refusal", async () => {
    const { user, onResolved } = await open();

    // The backdrop's button is the only control labelled with the cancel text
    // that is not the Cancel button itself.
    const backdrop = screen.getByRole("dialog").querySelector(".modal-backdrop button")!;
    await user.click(backdrop);

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /** Focus starts on the safe option, not the one that destroys something. */
  it("opens with the cancel button focused", async () => {
    await open();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^cancel$/i }));
  });
});
