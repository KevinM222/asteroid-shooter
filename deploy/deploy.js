// Owner-only deploy helper for LeaderboardV2. Uses the injected wallet (Base app / Coinbase Smart Wallet, MetaMask, …); holds no keys.
//
// Works for plain EOAs AND smart accounts (EIP-7702 / ERC-4337): the contract is created by the canonical
// CREATE2 deployer 0x4e59…956C through a normal call (data = salt ++ initcode), so the address is known up
// front and doesn't depend on who sends it. Success is only ever reported from chain state
// (eth_getCode / hasRole), never from receipt.contractAddress, nonces, or a returned hash, because a
// smart-account wallet may return a UserOp/bundle id instead of a tx hash.
(() => {
  const { ethers } = window;
  const ART = window.LEADERBOARD_V2_ARTIFACT;
  const CHAIN_ID = 8453n;
  const OWNER = "0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30";
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const AST = "0xcEFB2484932595ffFC809a27B8A5b106A8E1715A";
  const SIGNER = "0xE2741163168B434Ac58373834E0c22a5A253C962";
  const OLD_LB = "0xEFd9a0865306244d4F5227F0eBA2679Dd6d47E6A";
  const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
  const SALT = ART.salt;
  const KNOWN_BAD = ["0xeFEb9570acaD49e4ab1f4e4BBB816CaC899Ee3D7"]; // address shown by the old page; never deployed
  const MINTER_ROLE = ethers.id("MINTER_ROLE");
  const ARGS = [USDC, AST, OWNER, SIGNER]; // constructor(usdc_, token_, owner_, signer_)
  const DEPLOY_GAS_MIN = 4_000_000n;       // CREATE2 deploy uses ~3.2M; smart wallets also needs headroom
  const ROLE_GAS = 150_000n;
  const POLL_MS = 3000, POLL_MAX_MS = 6 * 60 * 1000;
  const AST_IFACE = new ethers.Interface([
    "function grantRole(bytes32 role, address account)",
    "function revokeRole(bytes32 role, address account)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
  ]);
  const STORE_KEY = "leaderboardV2Address";
  const $ = (id) => document.getElementById(id);
  const INITCODE = ethers.concat([ART.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "address"], ARGS)]);
  const EXPECTED = ethers.getCreate2Address(FACTORY, SALT, ethers.keccak256(INITCODE));
  if (ART.expectedAddress && ethers.getAddress(ART.expectedAddress) !== EXPECTED) throw new Error("artifact/expected address mismatch");
  let provider, account, v2 = null;

  const link = (kind, v) => {
    const a = document.createElement("a");
    a.href = `https://basescan.org/${kind}/${v}`; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = v;
    return a;
  };
  const setStatus = (text, ok) => { const s = $("status"); s.textContent = text; s.className = "box " + (ok === undefined ? "" : ok ? "ok" : "bad"); };
  const log = (t) => { const d = document.createElement("div"); d.textContent = new Date().toLocaleTimeString() + " " + t; $("log").prepend(d); };
  const errText = (e) => e?.shortMessage || e?.info?.error?.message || e?.data?.message || e?.reason || e?.message || String(e);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hasCode = async (a) => (await provider.getCode(a)) !== "0x";
  const isTxHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);

  // static info
  const rows = [["usdc_", USDC], ["token_ (AST)", AST], ["owner_", OWNER], ["signer_ (score signer)", SIGNER],
    ["method", `CREATE2 via deterministic deployer ${FACTORY}`], ["salt", SALT],
    ["expected V2 address", EXPECTED],
    ["pack prices", "set in constructor: 1=$0.10, 10=$0.90, 25=$2.25, 50=$4.50"],
    ["compiler", `${ART.compiler}, optimizer ${ART.optimizer.enabled ? "on" : "off"} ${ART.optimizer.runs} runs, EVM ${ART.evmVersion}`],
    ["source commit", ART.sourceCommit], ["creation bytecode keccak", ART.bytecodeHash]];
  for (const [k, v] of rows) { const tr = $("args").insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; }

  // Drop the bogus address the old page stored, right away (full code check happens on Connect).
  { const s0 = localStorage.getItem(STORE_KEY); if (s0 && (!ethers.isAddress(s0) || KNOWN_BAD.includes(ethers.getAddress(s0)))) localStorage.removeItem(STORE_KEY); }

  if (!window.ethereum) setStatus("No wallet found. Open this page in the Base app browser (or another wallet browser).", false);
  else setStatus("Wallet detected. Tap Connect.");

  async function ensureReady() {
    const chain = BigInt(await window.ethereum.request({ method: "eth_chainId" }));
    if (chain !== CHAIN_ID) {
      try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] }); }
      catch (e) { throw new Error("Please switch your wallet to Base (chain 8453)"); }
    }
    provider = new ethers.BrowserProvider(window.ethereum);
    const accts = await window.ethereum.request({ method: "eth_accounts" });
    account = accts && accts[0] ? ethers.getAddress(accts[0]) : null;
    if (account !== OWNER) throw new Error(`Connected ${account}. This page only works for the owner wallet ${OWNER}`);
    return account;
  }

  // Send one call from the owner. Prefers EIP-5792 wallet_sendCalls (what the Base app / Coinbase Smart
  // Wallet expects); falls back to eth_sendTransaction (lets us set a gas limit) if the wallet doesn't
  // support it. The returned id is for display only; success is always read from chain state.
  async function supportsSendCalls() {
    try {
      const caps = await window.ethereum.request({ method: "wallet_getCapabilities", params: [account, ["0x2105"]] });
      return !!caps; // any answer means the wallet speaks EIP-5792
    } catch (e) { return false; }
  }
  const isUnsupported = (e) => e?.code === 4200 || e?.code === -32601 || e?.code === -32602 && /method/i.test(errText(e)) || /not supported|unsupported|does not exist|not implemented/i.test(errText(e));
  async function sendCall(to, data, gas) {
    if (await supportsSendCalls()) {
      try {
        const r = await window.ethereum.request({ method: "wallet_sendCalls", params: [{
          version: "2.0.0", chainId: "0x2105", from: account, atomicRequired: false, calls: [{ to, data, value: "0x0" }] }] });
        return { kind: "wallet_sendCalls", id: typeof r === "string" ? r : r?.id };
      } catch (e) { if (!isUnsupported(e)) throw e; }
    }
    const id = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: account, to, data, value: "0x0", gas: ethers.toQuantity(gas) }] });
    return { kind: "eth_sendTransaction", id };
  }

  // For wallet_sendCalls: surface a wallet-reported failure early (EIP-5792 status 400/500/600 or "FAILURE").
  async function callsFailed(sent) {
    if (sent.kind !== "wallet_sendCalls" || !sent.id) return false;
    try {
      const st = await window.ethereum.request({ method: "wallet_getCallsStatus", params: [sent.id] });
      const code = Number(st?.status);
      if ((code >= 400 && code < 700) || /fail|revert/i.test(String(st?.status))) return true;
      const rc = st?.receipts?.[0];
      if (rc && (rc.status === "0x0" || rc.status === 0)) return true;
    } catch (e) { /* status not available; rely on chain reads */ }
    return false;
  }

  function showSent(container, label, sent) {
    const d = document.createElement("div");
    if (sent.kind === "eth_sendTransaction" && isTxHash(sent.id)) d.append(`${label}: `, link("tx", sent.id), " (may be a smart-account operation id; confirmation is checked on-chain)");
    else d.textContent = `${label}: ${sent.kind} id ${String(sent.id).slice(0, 80)}`;
    container.prepend(d);
  }

  async function pollUntil(check, what, sent) {
    const t0 = Date.now();
    while (Date.now() - t0 < POLL_MAX_MS) {
      try { if (await check()) return true; } catch (e) { /* RPC hiccup, keep polling */ }
      if (sent && await callsFailed(sent)) throw new Error(`The wallet reports the call failed (${what}). Nothing changed on-chain.`);
      await sleep(POLL_MS);
    }
    throw new Error(`Not confirmed on-chain after ${POLL_MAX_MS / 60000} min (${what}). Check Basescan; do not resend blindly.`);
  }

  async function connect() {
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      const addr = await ensureReady();
      const bal = await provider.getBalance(addr);
      const smart = await hasCode(addr);
      setStatus(`✅ Connected ${addr} on Base${smart ? " (smart account / EIP-7702)" : ""}. Balance ${ethers.formatEther(bal)} ETH`, true);
      $("connect").disabled = true; $("usev2").disabled = false;
      if (!(await hasCode(FACTORY))) throw new Error("CREATE2 deployer has no code on this chain");
      // drop any stored address that has no contract (e.g. the bogus one from the old page)
      const saved = localStorage.getItem(STORE_KEY);
      if (saved && (!ethers.isAddress(saved) || !(await hasCode(saved)))) { localStorage.removeItem(STORE_KEY); log(`cleared stored address ${saved} (no contract there)`); }
      if (await hasCode(EXPECTED)) {
        $("deploy").disabled = true; $("deploy").textContent = "Already deployed ✅";
        await useV2(EXPECTED);
      } else {
        $("deploy").disabled = false;
        await estimate();
        const s2 = localStorage.getItem(STORE_KEY);
        if (s2) await useV2(s2); else await refreshRoles();
      }
    } catch (e) { setStatus("❌ " + errText(e), false); }
  }

  let deployGas = DEPLOY_GAS_MIN;
  async function estimate() {
    try {
      const gas = await provider.estimateGas({ from: OWNER, to: FACTORY, data: ethers.concat([SALT, INITCODE]) });
      deployGas = gas * 13n / 10n > DEPLOY_GAS_MIN ? gas * 13n / 10n : DEPLOY_GAS_MIN;
      const fee = await provider.getFeeData();
      const price = fee.gasPrice ?? fee.maxFeePerGas;
      $("estimate").textContent = `Estimated gas ${gas} (limit set to ${deployGas}) ≈ ${Number(ethers.formatEther(gas * price)).toFixed(7)} ETH at current Base gas price, plus a tiny L1 data fee.`;
    } catch (e) { $("estimate").textContent = "Gas estimate failed (deploy will still use a 4,000,000 gas limit): " + errText(e); }
  }

  async function deploy() {
    const btn = $("deploy"); btn.disabled = true; btn.textContent = "Confirm in your wallet…";
    const out = $("deployOut"); out.style.display = "block"; out.replaceChildren();
    try {
      await ensureReady();
      if (await hasCode(EXPECTED)) { out.append("Already deployed at ", link("address", EXPECTED)); await useV2(EXPECTED); return; }
      const sent = await sendCall(FACTORY, ethers.concat([SALT, INITCODE]), deployGas);
      showSent(out, "Sent", sent);
      btn.textContent = "Waiting for the contract to appear on-chain…";
      await pollUntil(() => hasCode(EXPECTED), "contract code at " + EXPECTED, sent);
      localStorage.setItem(STORE_KEY, EXPECTED);
      const ok = document.createElement("div"); ok.append("✅ LeaderboardV2 code is live at ", link("address", EXPECTED)); out.append(ok);
      log("deployed " + EXPECTED);
      btn.textContent = "Deployed ✅";
      await useV2(EXPECTED);
    } catch (e) {
      const d = document.createElement("div"); d.textContent = "❌ " + errText(e); out.append(d);
      btn.disabled = false; btn.textContent = "Deploy LeaderboardV2";
    }
  }

  async function useV2(addr) {
    const box = $("checks"); box.replaceChildren();
    const line = (label, ok, val) => { const d = document.createElement("div"); d.className = ok ? "ok" : "bad"; d.textContent = `${ok ? "✅" : "❌"} ${label}: ${val}`; box.append(d); return ok; };
    if (!ethers.isAddress(addr)) { line("address", false, "not an address"); return; }
    const a = ethers.getAddress(addr);
    if (KNOWN_BAD.includes(a)) { line("address", false, `${a} was never deployed (old page bug)`); localStorage.removeItem(STORE_KEY); return; }
    if (!(await hasCode(a))) { line("contract code", false, `none at ${a}`); if (localStorage.getItem(STORE_KEY) === a) localStorage.removeItem(STORE_KEY); return; }
    v2 = a; $("v2input").value = v2; localStorage.setItem(STORE_KEY, v2);
    const c = new ethers.Contract(v2, ART.abi, provider);
    try {
      const [owner, s, tok, usdc, p10, paused] = await Promise.all([c.owner(), c.scoreSigner(), c.token(), c.usdc(), c.packPrice(10), c.paused()]);
      let all = true;
      if (v2 !== EXPECTED) line("address", false, `${v2} is not the expected CREATE2 address ${EXPECTED}`);
      all &= line("owner", owner === OWNER, owner);
      all &= line("scoreSigner", s === SIGNER, s);
      all &= line("token (AST)", tok === AST, tok);
      all &= line("usdc", usdc === USDC, usdc);
      all &= line("10-pack price", p10 === 900000n, `${ethers.formatUnits(p10, 6)} USDC`);
      all &= line("paused", paused === false, String(paused));
      const b = document.createElement("div"); b.append("Basescan: ", link("address", v2)); box.append(b);
      $("grant").disabled = !all;
      $("revoke").disabled = false;
      const v = document.createElement("div"); v.className = "muted";
      v.textContent = `Put this in index.html ECONOMY.LEADERBOARD_V2 and Vercel env LEADERBOARD_V2_ADDRESS: ${v2}`;
      box.append(v);
    } catch (e) { line("read", false, errText(e)); }
    await refreshRoles();
  }

  const hasRole = (who) => provider.call({ to: AST, data: AST_IFACE.encodeFunctionData("hasRole", [MINTER_ROLE, who]) })
    .then((r) => AST_IFACE.decodeFunctionResult("hasRole", r)[0]);

  async function refreshRoles() {
    const box = $("roles"); box.replaceChildren();
    const add = (t, cls) => { const d = document.createElement("div"); d.textContent = t; d.className = cls; box.append(d); };
    try {
      const old = await hasRole(OLD_LB);
      add(`Old board 0xEFd9 MINTER_ROLE: ${old ? "YES (revoke it)" : "no ✅"}`, old ? "bad" : "ok");
      if (v2) {
        const has = await hasRole(v2);
        add(`V2 ${v2.slice(0, 8)}… MINTER_ROLE: ${has ? "yes ✅" : "not yet"}`, has ? "ok" : "bad");
        if (has) { $("grant").disabled = true; $("grant").textContent = "V2 has MINTER_ROLE ✅"; }
      }
      if (!old) { $("revoke").disabled = true; $("revoke").textContent = "Old board has no MINTER_ROLE ✅"; }
    } catch (e) { add("role read failed: " + errText(e), "bad"); }
  }

  async function roleTx(kind) {
    const btn = $(kind); const prev = btn.textContent; btn.disabled = true; btn.textContent = "Confirm in your wallet…";
    try {
      await ensureReady();
      const data = kind === "grant" ? AST_IFACE.encodeFunctionData("grantRole", [MINTER_ROLE, v2])
                                    : AST_IFACE.encodeFunctionData("revokeRole", [MINTER_ROLE, OLD_LB]);
      const sent = await sendCall(AST, data, ROLE_GAS);
      showSent($("log"), kind, sent);
      btn.textContent = "Waiting for on-chain role change…";
      await pollUntil(async () => kind === "grant" ? await hasRole(v2) : !(await hasRole(OLD_LB)), `${kind} role`, sent);
      log(`${kind} confirmed on-chain (hasRole read)`);
      btn.textContent = prev;
    } catch (e) { log(`${kind} failed: ${errText(e)}`); btn.textContent = prev; btn.disabled = false; }
    await refreshRoles();
  }

  $("connect").onclick = connect;
  $("deploy").onclick = deploy;
  $("usev2").onclick = async () => { if (!provider) return alert("Connect first"); await useV2($("v2input").value.trim()); };
  $("grant").onclick = () => v2 && roleTx("grant");
  $("revoke").onclick = () => roleTx("revoke");
})();
