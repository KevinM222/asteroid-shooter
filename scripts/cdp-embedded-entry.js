// Bundled into /vendor/cdp-embedded.js (self-hosted, lazy-loaded only when a player picks email/SMS sign-in).
import { initialize, signInWithEmail, verifyEmailOTP, signInWithSms, verifySmsOTP, isSignedIn, getCurrentUser, signOut, createCDPEmbeddedWallet } from "@coinbase/cdp-core";
import { http } from "viem";
import { base } from "viem/chains";
window.__astCdp = { initialize, signInWithEmail, verifyEmailOTP, signInWithSms, verifySmsOTP, isSignedIn, getCurrentUser, signOut,
  createWallet: () => createCDPEmbeddedWallet({ chains: [base], transports: { [base.id]: http("https://mainnet.base.org") } }) };
