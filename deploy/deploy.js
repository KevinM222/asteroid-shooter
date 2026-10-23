// Owner-only deploy helper for LeaderboardV2. Uses the injected wallet (MetaMask); holds no keys.
(() => {
  const { ethers } = window;
  const ART = window.LEADERBOARD_V2_ARTIFACT;
  const CHAIN_ID = 8453n;
  const OWNER = "0xACfCA8Bc6567E7DB35AD8C814756695dad1cfB30";
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const AST = "0xcEFB2484932595ffFC809a27B8A5b106A8E1715A";
  const SIGNER = "0xE2741163168B434Ac58373834E0c22a5A253C962";
  const OLD_LB = "0xEFd9a0865306244d4F5227F0eBA2679Dd6d47E6A";
  const MINTER_ROLE = ethers.id("MINTER_ROLE");
  const ARGS = [USDC, AST, OWNER, SIGNER]; // constructor(usdc_, token_, owner_, signer_)
  const AST_ABI = [
    "function grantRole(bytes32 role, address account)",
    "function revokeRole(bytes32 role, address account)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
  ];
  const STORE_KEY = "leaderboardV2Address";
  const $ = (id) => document.getElementById(id);
  let provider, signer, v2 = null;

  const link = (kind, v) => {
    const a = document.createElement("a");
    a.href = `https://basescan.org/${kind}/${v}`; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = v;
    return a;
  };
  const setStatus = (text, ok) => { const s = $("status"); s.textContent = text; s.className = "box " + (ok === undefined ? "" : ok ? "ok" : "bad"); };
  const log = (t) => { const d = document.createElement("div"); d.textContent = new Date().toLocaleTimeString() + " " + t; $("log").prepend(d); };
  const errText = (e) => e?.shortMessage || e?.info?.error?.message || e?.reason || e?.message || String(e);

  // static info
  const rows = [["usdc_", USDC], ["token_ (AST)", AST], ["owner_", OWNER], ["signer_ (score signer)", SIGNER],
    ["pack prices", "set in constructor: 1=$0.10, 10=$0.90, 25=$2.25, 50=$4.50"],
    ["compiler", `${ART.compiler}, optimizer ${ART.optimizer.enabled ? "on" : "off"} ${ART.optimizer.runs} runs, EVM ${ART.evmVersion}`],
    ["source commit", ART.sourceCommit], ["bytecode keccak", ART.bytecodeHash]];
  for (const [k, v] of rows) { const tr = $("args").insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; }

  if (!window.ethereum) setStatus("No wallet found. Open this page inside the MetaMask app (Browser tab).", false);
  else setStatus("Wallet detected. Tap Connect.");

  async function ensureReady() {
    const net = await provider.getNetwork();
    if (net.chainId !== CHAIN_ID) {
      try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] }); }
      catch (e) { throw new Error("Please switch MetaMask to Base (chain 8453)"); }
      provider = new ethers.BrowserProvider(window.ethereum);
    }
    signer = await provider.getSigner();
    const addr = await signer.getAddress();
    if (ethers.getAddress(addr) !== OWNER) throw new Error(`Connected ${addr}. Switch MetaMask to ${OWNER}`);
    return addr;
  }

  async function connect() {
    try {
      provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send("eth_requestAccounts", []);
      const addr = await ensureReady();
      const bal = await provider.getBalance(addr);
      setStatus(`✅ Connected ${addr} on Base. Balance ${ethers.formatEther(bal)} ETH`, true);
      $("connect").disabled = true; $("deploy").disabled = false; $("usev2").disabled = false;
      await estimate();
      const saved = localStorage.getItem(STORE_KEY);
      if (saved && ethers.isAddress(saved)) await useV2(saved);
      else await refreshRoles();
    } catch (e) { setStatus("❌ " + errText(e), false); }
  }

  async function estimate() {
    try {
      const f = new ethers.ContractFactory(ART.abi, ART.bytecode, signer);
      const tx = await f.getDeployTransaction(...ARGS);
      const gas = await provider.estimateGas({ ...tx, from: OWNER });
      const fee = await provider.getFeeData();
      const price = fee.maxFeePerGas ?? fee.gasPrice;
      $("estimate").textContent = `Estimated gas ${gas.toString()} ≈ ${Number(ethers.formatEther(gas * price)).toFixed(7)} ETH max at current Base fees (usually less).`;
    } catch (e) { $("estimate").textContent = "Gas estimate failed: " + errText(e); }
  }

  async function deploy() {
    const btn = $("deploy"); btn.disabled = true; btn.textContent = "Confirm in MetaMask…";
    const out = $("deployOut"); out.style.display = "block"; out.replaceChildren();
    try {
      await ensureReady();
      if (localStorage.getItem(STORE_KEY) && !confirm("A V2 address is already saved from an earlier deploy. Deploy ANOTHER one?")) throw new Error("cancelled");
      const f = new ethers.ContractFactory(ART.abi, ART.bytecode, signer);
      const c = await f.deploy(...ARGS);
      const tx = c.deploymentTransaction();
      out.append("Tx sent: ", link("tx", tx.hash)); btn.textContent = "Waiting for confirmation…";
      const r = await tx.wait();
      if (r.status !== 1) throw new Error("deploy transaction reverted");
      const addr = await c.getAddress();
      localStorage.setItem(STORE_KEY, addr);
      out.append(document.createElement("br"), "✅ LeaderboardV2 deployed at ", link("address", addr));
      log("deployed " + addr);
      btn.textContent = "Deployed";
      await useV2(addr);
    } catch (e) { out.append(document.createElement("br"), "❌ " + errText(e)); btn.disabled = false; btn.textContent = "Deploy LeaderboardV2"; }
  }

  async function useV2(addr) {
    v2 = ethers.getAddress(addr); $("v2input").value = v2;
    const c = new ethers.Contract(v2, ART.abi, provider);
    const box = $("checks"); box.replaceChildren();
    const line = (label, ok, val) => { const d = document.createElement("div"); d.className = ok ? "ok" : "bad"; d.textContent = `${ok ? "✅" : "❌"} ${label}: ${val}`; box.append(d); return ok; };
    try {
      const code = await provider.getCode(v2);
      if (code === "0x") { line("contract code", false, "none at this address"); return; }
      const [owner, s, tok, usdc, p10, paused] = await Promise.all([c.owner(), c.scoreSigner(), c.token(), c.usdc(), c.packPrice(10), c.paused()]);
      let all = true;
      all &= line("owner", owner === OWNER, owner);
      all &= line("scoreSigner", s === SIGNER, s);
      all &= line("token (AST)", tok === AST, tok);
      all &= line("usdc", usdc === USDC, usdc);
      all &= line("10-pack price", p10 === 900000n, `${ethers.formatUnits(p10, 6)} USDC`);
      all &= line("paused", paused === false, String(paused));
      const a = document.createElement("div"); a.append("Basescan: ", link("address", v2)); box.append(a);
      $("grant").disabled = !all;
      $("revoke").disabled = false;
      const v = document.createElement("div"); v.className = "muted";
      v.textContent = `Put this in index.html ECONOMY.LEADERBOARD_V2 and Vercel env LEADERBOARD_V2_ADDRESS: ${v2}`;
      box.append(v);
    } catch (e) { line("read", false, errText(e)); }
    await refreshRoles();
  }

  async function refreshRoles() {
    const ast = new ethers.Contract(AST, AST_ABI, provider);
    const box = $("roles"); box.replaceChildren();
    const add = (t, cls) => { const d = document.createElement("div"); d.textContent = t; d.className = cls; box.append(d); };
    try {
      const old = await ast.hasRole(MINTER_ROLE, OLD_LB);
      add(`Old board 0xEFd9 MINTER_ROLE: ${old ? "YES (revoke it)" : "no ✅"}`, old ? "bad" : "ok");
      if (v2) {
        const has = await ast.hasRole(MINTER_ROLE, v2);
        add(`V2 ${v2.slice(0, 8)}… MINTER_ROLE: ${has ? "yes ✅" : "not yet"}`, has ? "ok" : "bad");
        if (has) { $("grant").disabled = true; $("grant").textContent = "V2 has MINTER_ROLE ✅"; }
      }
      if (!old) { $("revoke").disabled = true; $("revoke").textContent = "Old board has no MINTER_ROLE ✅"; }
    } catch (e) { add("role read failed: " + errText(e), "bad"); }
  }

  async function roleTx(kind) {
    const btn = $(kind); const prev = btn.textContent; btn.disabled = true; btn.textContent = "Confirm in MetaMask…";
    try {
      await ensureReady();
      const ast = new ethers.Contract(AST, AST_ABI, signer);
      const tx = kind === "grant" ? await ast.grantRole(MINTER_ROLE, v2) : await ast.revokeRole(MINTER_ROLE, OLD_LB);
      const d = document.createElement("div"); d.append(`${kind} tx: `, link("tx", tx.hash)); $("log").prepend(d);
      btn.textContent = "Waiting…";
      const r = await tx.wait();
      if (r.status !== 1) throw new Error("transaction reverted");
      log(`${kind} confirmed`);
      btn.textContent = prev;
    } catch (e) { log(`${kind} failed: ${errText(e)}`); btn.textContent = prev; btn.disabled = false; }
    await refreshRoles();
  }

  $("connect").onclick = connect;
  $("deploy").onclick = deploy;
  $("usev2").onclick = () => { const v = $("v2input").value.trim(); if (ethers.isAddress(v)) { localStorage.setItem(STORE_KEY, ethers.getAddress(v)); useV2(v); } else alert("Not an address"); };
  $("grant").onclick = () => v2 && roleTx("grant");
  $("revoke").onclick = () => roleTx("revoke");
})();
