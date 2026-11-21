// Bundled into /vendor/base-account.js (self-hosted, lazy-loaded only when a player picks "Sign in with Base").
import { createBaseAccountSDK } from "@base-org/account";
window.__astBaseAccount = { createBaseAccountSDK };
