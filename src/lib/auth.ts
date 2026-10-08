import {
  ConfidentialClientApplication,
  CryptoProvider,
  type AccountInfo,
} from "@azure/msal-node";
import { ServiceTransport, type Transport } from "./workiq";
import { WORKIQ_SCOPE } from "./workiq/service";

/**
 * Sign in with Microsoft, so Work IQ answers as the person using the page
 * rather than as whoever is signed in to the CLI on the machine serving it.
 *
 * The server is the OAuth client: the browser only ever holds a random session
 * id in an http-only cookie. Tokens stay in MSAL's cache in this process and
 * are refreshed silently. One process holds them, which suits one replica;
 * more replicas would need a shared cache.
 *
 * Work IQ has no app-only mode, so every call here is delegated: Graph for the
 * record reads and searches, the Work IQ gateway for the composed answer.
 */

/** Everything the record reads and the searches in router.ts touch. */
const GRAPH_SCOPES = [
  "User.Read",
  "User.Read.All",
  "People.Read",
  "Mail.Read",
  "Calendars.Read",
  "Chat.Read",
  "Presence.Read",
  "Tasks.Read",
  "Files.Read.All",
  "Sites.Read.All",
  "Team.ReadBasic.All",
  "GroupMember.Read.All",
].map((scope) => `https://graph.microsoft.com/${scope}`);

const LOGIN_SCOPES = ["openid", "profile", "offline_access", ...GRAPH_SCOPES];
const COOKIE = "workiq_decision_api_session";
/** A sign-in that never comes back is forgotten after this long. */
const PENDING_MS = 10 * 60_000;

type Session = { account: AccountInfo; transport?: Transport };

// Kept on globalThis so a dev-server reload does not sign everyone out.
const store = ((globalThis as Record<string, unknown>).__workiqDecisionApiAuth ??= {
  sessions: new Map<string, Session>(),
  pending: new Map<string, { verifier: string; at: number }>(),
  app: null as ConfidentialClientApplication | null,
}) as {
  sessions: Map<string, Session>;
  pending: Map<string, { verifier: string; at: number }>;
  app: ConfidentialClientApplication | null;
};

export function authConfigured(): boolean {
  return Boolean(
    process.env.ENTRA_CLIENT_ID && process.env.ENTRA_CLIENT_SECRET,
  );
}

function client(): ConfidentialClientApplication {
  if (!authConfigured()) {
    throw new Error(
      "Sign-in is not set up. Set ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET.",
    );
  }
  store.app ??= new ConfidentialClientApplication({
    auth: {
      clientId: process.env.ENTRA_CLIENT_ID!,
      clientSecret: process.env.ENTRA_CLIENT_SECRET!,
      // "organizations" lets any work account sign in, subject to its own
      // tenant's consent rules. A tenant id pins it to one.
      authority: `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID || "organizations"}`,
    },
  });
  return store.app;
}

/**
 * Where Entra sends the person back. Behind a proxy the request's own host
 * can be an internal one, so a deployment sets AUTH_REDIRECT_URI.
 */
function redirectUri(request: Request): string {
  return (
    process.env.AUTH_REDIRECT_URI ||
    new URL("/api/auth/callback", request.url).toString()
  );
}

/** The Microsoft sign-in page to send the browser to. */
export async function signInUrl(request: Request): Promise<string> {
  const now = Date.now();
  for (const [state, entry] of store.pending) {
    if (now - entry.at > PENDING_MS) store.pending.delete(state);
  }
  const crypto = new CryptoProvider();
  const { verifier, challenge } = await crypto.generatePkceCodes();
  const state = crypto.createNewGuid();
  store.pending.set(state, { verifier, at: now });
  return client().getAuthCodeUrl({
    scopes: LOGIN_SCOPES,
    // Consent to Work IQ in the same visit, so the composed answer does not
    // need a second sign-in the first time it is asked for.
    extraScopesToConsent: [WORKIQ_SCOPE],
    redirectUri: redirectUri(request),
    state,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    prompt: "select_account",
  });
}

/** Redeems the code Entra sent back, and returns a new session id. */
export async function finishSignIn(request: Request): Promise<string> {
  const url = new URL(request.url);
  const problem =
    url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (problem) throw new Error(problem);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const pending = store.pending.get(state);
  store.pending.delete(state);
  if (!pending || !code)
    throw new Error("That sign-in expired or was not started here. Try again.");

  const result = await client().acquireTokenByCode({
    code,
    scopes: LOGIN_SCOPES,
    redirectUri: redirectUri(request),
    codeVerifier: pending.verifier,
  });
  if (!result.account) throw new Error("Microsoft did not return an account.");
  const id = new CryptoProvider().createNewGuid();
  store.sessions.set(id, { account: result.account });
  return id;
}

export function sessionCookie(id: string, request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}${secure}`;
}

export function clearedCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function sessionId(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=") || null;
  }
  return null;
}

/** Who this request is signed in as, if anyone. */
export function signedIn(
  request: Request,
): { name: string; username: string } | null {
  const session = store.sessions.get(sessionId(request) ?? "");
  if (!session) return null;
  return {
    name: session.account.name ?? session.account.username,
    username: session.account.username,
  };
}

export async function signOut(request: Request): Promise<void> {
  const id = sessionId(request);
  const session = id ? store.sessions.get(id) : undefined;
  if (!id || !session) return;
  store.sessions.delete(id);
  // Only dropped from the cache when no other browser is signed in as them.
  const shared = [...store.sessions.values()].some(
    (s) => s.account.homeAccountId === session.account.homeAccountId,
  );
  if (!shared) await client().getTokenCache().removeAccount(session.account);
}

/**
 * The signed-in person's own Work IQ transport, or null. One per session, so
 * a follow-up continues their Work IQ conversation and nobody else's.
 */
export function userTransport(
  request: Request,
  place: ConstructorParameters<typeof ServiceTransport>[1],
): Transport | null {
  const session = store.sessions.get(sessionId(request) ?? "");
  if (!session) return null;
  const token = async (scopes: string[]) => {
    try {
      const result = await client().acquireTokenSilent({
        account: session.account,
        scopes,
      });
      return result.accessToken;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Your Microsoft sign-in needs renewing. Sign in again. (${detail})`,
      );
    }
  };
  session.transport ??= new ServiceTransport(
    { graph: () => token(GRAPH_SCOPES), workiq: () => token([WORKIQ_SCOPE]) },
    place,
  );
  return session.transport;
}
