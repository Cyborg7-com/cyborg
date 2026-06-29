import { describe, it, expect, vi } from "vitest";
import { handleDeleteAccount, type DeleteAccountDeps } from "./delete-account-handler.js";

// All deps mocked — the real pg.deleteAccount cascade is never run here (no test
// PG is touched). These prove the auth invariant + response/teardown contract.
function makeDeps(over: Partial<DeleteAccountDeps> = {}): {
  deps: DeleteAccountDeps;
  deleteAccount: ReturnType<typeof vi.fn>;
  respondOk: ReturnType<typeof vi.fn>;
  respondError: ReturnType<typeof vi.fn>;
  closeSocket: ReturnType<typeof vi.fn>;
} {
  const deleteAccount = vi.fn(async () => {});
  const respondOk = vi.fn();
  const respondError = vi.fn();
  const closeSocket = vi.fn();
  const deps: DeleteAccountDeps = {
    userId: "u_me",
    deleteAccount,
    respondOk,
    respondError,
    closeSocket,
    ...over,
  };
  return { deps, deleteAccount, respondOk, respondError, closeSocket };
}

describe("handleDeleteAccount (#634)", () => {
  it("deletes ONLY the authenticated user's own account, responds ok, closes the socket", async () => {
    const { deps, deleteAccount, respondOk, respondError, closeSocket } = makeDeps();
    await handleDeleteAccount(deps);
    // Security invariant: deleteAccount is called with the authenticated userId
    // and nothing else — there is no body-supplied target to delete someone else.
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(deleteAccount).toHaveBeenCalledWith("u_me");
    expect(respondOk).toHaveBeenCalledTimes(1);
    expect(respondError).not.toHaveBeenCalled();
    expect(closeSocket).toHaveBeenCalledTimes(1);
  });

  it("refuses when the socket isn't authenticated (no userId) — never calls deleteAccount", async () => {
    const { deps, deleteAccount, respondOk, respondError, closeSocket } = makeDeps({
      userId: undefined,
    });
    await handleDeleteAccount(deps);
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(respondOk).not.toHaveBeenCalled();
    expect(closeSocket).not.toHaveBeenCalled();
    expect(respondError).toHaveBeenCalledWith("not authenticated");
  });

  it("on a delete failure: returns a GENERIC error (no DB internals leaked), logs the detail, no ok, socket stays open", async () => {
    const logError = vi.fn();
    const rawErr = new Error('duplicate key value violates constraint "users_pkey"');
    const { deps, respondOk, respondError, closeSocket } = makeDeps({
      deleteAccount: vi.fn(async () => {
        throw rawErr;
      }),
      logError,
    });
    await handleDeleteAccount(deps);
    expect(respondOk).not.toHaveBeenCalled();
    // The client gets a generic message — the raw DB error must NOT be exposed.
    expect(respondError).toHaveBeenCalledWith("Failed to delete account");
    // …but the detail IS logged server-side.
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("delete_account"), rawErr);
    // Failure path must not tear down the socket (user can retry / stays logged in).
    expect(closeSocket).not.toHaveBeenCalled();
  });

  it("the deleted id is always exactly deps.userId, regardless of value", async () => {
    const { deps, deleteAccount } = makeDeps({ userId: "u_other_session" });
    await handleDeleteAccount(deps);
    expect(deleteAccount).toHaveBeenCalledWith("u_other_session");
  });
});
