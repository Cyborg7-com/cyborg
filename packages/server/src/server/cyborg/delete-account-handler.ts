// Handler for the `cyborg:delete_account` guest RPC (App-Store 5.1.1(v) self-
// deletion). DESTRUCTIVE + irreversible. Extracted from relay-standalone.ts so
// the auth invariant and response contract are unit-testable with mocks (the real
// pg.deleteAccount cascade is injected, never run against a real DB in tests).
//
// SECURITY INVARIANT: there is NO target userId on the wire — `cyborg:delete_
// account` carries only a requestId. This handler acts ONLY on `userId` (the
// AUTHENTICATED socket's guest.userId), so a caller can never delete anyone
// else's account. Keep it that way: do not add a body-supplied id parameter.

export interface DeleteAccountDeps {
  /** The authenticated socket's userId — the only account this can ever delete. */
  userId: string | null | undefined;
  /** pg.deleteAccount — the transactional cascade. Injected so it's mockable. */
  deleteAccount: (userId: string) => Promise<void>;
  /** Send `cyborg:delete_account_response { ok: true }`. */
  respondOk: () => void;
  /** Send `cyborg:error` with the failure message. */
  respondError: (message: string) => void;
  /** Tear down the socket after deletion so nothing keeps acting as a gone user. */
  closeSocket: () => void;
  /** Optional structured logger for the failure path. */
  logError?: (message: string, err: unknown) => void;
}

export async function handleDeleteAccount(deps: DeleteAccountDeps): Promise<void> {
  const { userId, deleteAccount, respondOk, respondError, closeSocket, logError } = deps;
  // Auth gate: only the authenticated user, only their own account.
  if (!userId) {
    respondError("not authenticated");
    return;
  }
  try {
    await deleteAccount(userId);
  } catch (err) {
    // Log the detail server-side; return a GENERIC message to the client — a raw
    // DB error could leak schema/constraint/query internals (info disclosure).
    logError?.(`[delete_account] failed for ${userId}`, err);
    respondError("Failed to delete account");
    return;
  }
  respondOk();
  // Only after a SUCCESSFUL delete: drop the socket. On failure we leave it open
  // so the user can retry / stays logged in.
  closeSocket();
}
