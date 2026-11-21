// Asteroid Shooter game script (moved out of index.html so it can load with `defer`;
// deferred scripts still run in order and before DOMContentLoaded, so every DOMContentLoaded hook below fires as before).
    // === v4.64 (front-end security pass) ===
    const ethers = window.ethers;
    let sdk, provider, signer, userAddress;
    let isConnecting = false;

    // === v5.0 economy config ===
    // Set LEADERBOARD_V2 to the deployed LeaderboardV2 address to switch the game to v2 (signed scores via
    // the /api backend, daily free lives, pack prices). While it is empty the page runs in "v1 legacy" mode
    // against 0xEFd9: reads still work, but score submits / purchases / free lives are disabled because the
    // v1 board cannot record scores and its USDC can't be withdrawn (see ISSUES.md).
    const ECONOMY = {
      LEADERBOARD_V2: "0xCcF3b3678f00f5AD8036897Cf17D0b5de67EfEca",
      SCORE_API: "/api/score",
      SESSION_API: "/api/session",
      GRANT_API: "/api/grant",
      LEGACY_LEADERBOARD: "0xEFd9a0865306244d4F5227F0eBA2679Dd6d47E6A",
    };
    const useV2 = /^0x[a-fA-F0-9]{40}$/.test(ECONOMY.LEADERBOARD_V2);
    const leaderboardAddress = useV2 ? ECONOMY.LEADERBOARD_V2 : ECONOMY.LEGACY_LEADERBOARD;
    const LEGACY_MSG = 'The leaderboard is being upgraded. Scores, purchases and free lives are paused until the new contract is live.';
    let currentGame = null; // v2: { gameId, session }
    const tokenAddress = "0xcEFB2484932595ffFC809a27B8A5b106A8E1715A";
    const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

    const isAddr = (a) => typeof a === "string" && /^0x[a-fA-F0-9]{40}$/.test(a);
    const contractsConfigured = isAddr(leaderboardAddress) && isAddr(tokenAddress) && isAddr(usdcAddress);

    const leaderboardAbi = [
      'function startGame(string calldata _playerName) external',
      'function submitScore(uint256 _score, string calldata _playerName) external',
      'function buyLives(uint256 amount) external',
      'function awardFreeLives(address player, uint256 amount) external',
      'function getTopScores(uint256 count) external view returns (tuple(address player, uint256 score, string playerName)[] memory)',
      'function hasFreeGame(address) external pure returns (bool)',
      'function playerLives(address) view returns (uint256)',
      'function playerHighScore(address) view returns (uint256)',
      'function allTimeHigh() view returns (uint256)',
      'function distributePrizes() external',
      'function lifePrice() view returns (uint256)',
      'function mintReward(address player, uint256 amount) external',
      'event LivesBought(address indexed player, uint256 amount)',
      'event ATHBeaten(address indexed player, uint256 score)'
    ];

    const leaderboardV2Abi = [
      'function startGame() returns (uint256)',
      'function submitScore(uint256 gameId, uint256 score, string name, uint256 deadline, bytes signature)',
      'function buyLives(uint256 lives)',
      'function claimDailyLives()',
      'function claimLifeGrant(uint256 amount, uint256 grantId, uint256 deadline, bytes signature)',
      'function grantUsed(address, uint256) view returns (bool)',
      'function packPrice(uint256 lives) view returns (uint256)',
      'function nextDailyClaimAt(address player) view returns (uint256)',
      'function lastDailyClaim(address) view returns (uint256)',
      'function dailyCooldown() view returns (uint256)',
      'function dailyLives() view returns (uint256)',
      'function prizePot() view returns (uint256)',
      'function getTopScores(uint256 count) view returns (tuple(address player, uint256 score, string playerName)[])',
      'function gamesStarted(address) view returns (uint256)',
      'function games(address, uint256) view returns (uint64 startedAt, bool submitted)',
      'function playerLives(address) view returns (uint256)',
      'function playerHighScore(address) view returns (uint256)',
      'function allTimeHigh() view returns (uint256)',
      'event GameStarted(address indexed player, uint256 indexed gameId, uint256 livesLeft)',
      'event ScoreSubmitted(address indexed player, uint256 indexed gameId, uint256 score, uint256 astReward, string name)'
    ];
    const lbAbi = useV2 ? leaderboardV2Abi : leaderboardAbi;

    const tokenAbi = [
      'function balanceOf(address) view returns (uint256)',
      'function totalSupply() view returns (uint256)',
      'function mint(address to, uint256 amount) external',
      'function grantMinterRole(address minter) external',
      'function hasRole(bytes32 role, address account) view returns (bool)',
      'function MINTER_ROLE() view returns (bytes32)'
    ];

    const usdcAbi = [
      'function approve(address,uint256) external returns (bool)',
      'function allowance(address,address) external view returns (uint256)',
      'function balanceOf(address) view returns (uint256)'
    ];

    // === v4.64: safe rendering helpers ===
    // Never interpolate on-chain / user-provided strings into innerHTML. Use these instead.
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"'`]/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
      }[c]));
    }
    const isTxHash = (h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);

    // Trim, strip control chars, cap at 32 UTF-8 bytes (Leaderboard requires 1..32 bytes).
    function cleanPlayerName(name, fallback = 'Player') {
      let n = String(name ?? '').replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').trim();
      const enc = new TextEncoder();
      while (n && enc.encode(n).length > 32) n = Array.from(n).slice(0, -1).join('');
      return n || fallback;
    }

    function safeHttpsUrl(u) {
      try { const url = new URL(String(u)); return url.protocol === 'https:' ? url.href : ''; }
      catch (e) { return ''; }
    }

    function shortError(err) {
      const msg = err?.shortMessage || err?.reason || err?.info?.error?.message || err?.message || String(err);
      if (err?.code === 'ACTION_REJECTED' || /user (rejected|denied)/i.test(msg)) return 'Transaction rejected in wallet.';
      return String(msg).slice(0, 160);
    }

    // Renders "<label><a href=basescan/tx/HASH>0x1234…abcd</a>" using DOM APIs only.
    function renderTxLink(container, txHash, label = 'Tx: ') {
      if (!container || !isTxHash(txHash)) return;
      const wrap = document.createElement('div');
      wrap.append(document.createTextNode(label));
      const a = document.createElement('a');
      a.href = `https://basescan.org/tx/${txHash}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.cssText = 'color:#32FF9A; text-decoration: underline;';
      a.textContent = `${txHash.slice(0, 10)}...${txHash.slice(-6)}`;
      wrap.appendChild(a);
      container.appendChild(wrap);
    }

    function setText(id, text) {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
      return el;
    }

    function showToast(text, isError = false) {
      const toast = document.createElement('div');
      toast.style.cssText = `position:fixed; bottom:90px; left:50%; transform:translateX(-50%); background:${isError ? '#FF5A5A' : '#32FF9A'}; color:#000; padding:14px 22px; border-radius:12px; font-weight:bold; z-index:999999; white-space:pre-line; text-align:center; max-width:90vw;`;
      toast.textContent = text;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 7000);
    }

    async function waitForSuccess(tx) {
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error('Transaction reverted on-chain');
      return receipt;
    }

    // In-page dialogs. window.confirm()/alert() are silently unsupported in some in-app WebViews (the Base app:
    // confirm() returns false immediately), which made "Start Game" do nothing at all.
    function uiDialog(text, withCancel) {
      console.log('[ui]', text);
      return new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.className = 'ui-dialog';
        wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:1000000;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#111;color:#fff;border:2px solid #32FF9A;border-radius:14px;padding:20px;max-width:88vw;white-space:pre-line;text-align:center;font-size:16px;';
        const p = document.createElement('div'); p.textContent = text; p.style.marginBottom = '16px'; box.appendChild(p);
        const done = (v) => { wrap.remove(); resolve(v); };
        const mk = (label, v, bg) => { const b = document.createElement('button'); b.textContent = label; b.className = 'ui-dialog-' + (v ? 'ok' : 'cancel');
          b.style.cssText = `margin:0 8px;padding:10px 18px;border-radius:10px;border:0;font-weight:bold;background:${bg};color:#000;`; b.onclick = () => done(v); box.appendChild(b); };
        if (withCancel) mk('Cancel', false, '#888');
        mk('OK', true, '#32FF9A');
        wrap.appendChild(box); document.body.appendChild(wrap);
      });
    }
    const uiAlert = (text) => { uiDialog(String(text), false); };
    const uiConfirm = (text) => uiDialog(String(text), true);

    // ---- Wallet calls that work for smart wallets (Base app / Coinbase Smart Wallet, EIP-7702, 4337) ----
    // Prefer EIP-5792 wallet_sendCalls (+ wallet_getCallsStatus); fall back to eth_sendTransaction. Never trust the
    // returned id/hash or a receipt: success = the expected on-chain state change, read back from the chain.
    let walletEip1193 = null;
    let sendCallsSupported = null;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const isUnsupportedErr = (e) => e?.code === 4200 || e?.code === -32601 || /not supported|unsupported|does not exist|not implemented|unknown method/i.test(String(e?.message || ''));
    async function supportsSendCalls() {
      if (sendCallsSupported !== null) return sendCallsSupported;
      try {
        const caps = await withTimeout(walletEip1193.request({ method: 'wallet_getCapabilities', params: [userAddress, ['0x2105']] }), 5000, 'wallet_getCapabilities');
        // v5.12: a non-empty answer is NOT enough. EOA wallets (MetaMask, Coinbase Wallet extension, Rabby) answer
        // wallet_getCapabilities but then reject wallet_sendCalls (or ask to "upgrade" the account). Only use it when
        // Base (0x2105) reports atomic batching as already "supported" (Base app / Coinbase Smart Wallet).
        const c = caps && (caps['0x2105'] || caps['0x2105'.toLowerCase()] || caps[8453] || caps['8453']);
        sendCallsSupported = !!(c && c.atomic && c.atomic.status === 'supported');
      } catch (e) { sendCallsSupported = false; }
      console.log('[tx] wallet_sendCalls supported:', sendCallsSupported);
      return sendCallsSupported;
    }
    async function callsFailed(sent) {
      try {
        if (sent.kind === 'calls') {
          const st = await withTimeout(walletEip1193.request({ method: 'wallet_getCallsStatus', params: [sent.id] }), 5000, 'getCallsStatus');
          const code = Number(st?.status);
          if ((code >= 400 && code < 700) || /fail|revert/i.test(String(st?.status))) return true;
          if ((st?.receipts || []).some((r) => r.status === '0x0' || r.status === 0)) return true;
        } else if (/^0x[0-9a-fA-F]{64}$/.test(String(sent.id))) {
          const rc = await readProvider().getTransactionReceipt(sent.id).catch(() => null);
          if (rc && rc.status === 0) return true; // a real tx hash that reverted
        }
      } catch (e) { /* status unknown; keep reading the chain */ }
      return false;
    }
    async function pollConfirm(check, sent, label, timeoutMs = 180000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        try { if (await check()) { console.log('[tx]', label, 'confirmed on-chain'); return; } } catch (e) { /* RPC hiccup */ }
        if (sent && await callsFailed(sent)) throw new Error(`${label} failed on-chain (wallet reports failure). Nothing changed.`);
        await sleep(2000);
      }
      throw new Error(`${label}: not confirmed after ${Math.round(timeoutMs / 60000)} min. Check your wallet activity, then refresh this page before retrying.`);
    }
    // calls: [{ to, data, check?: async () => bool }]; finalCheck confirms the whole action.
    // Base Builder Code attribution (ERC-8021): bc_x7d37t77, encoded with ox Attribution.toDataSuffix.
    // Appended to each call's calldata (contracts ignore trailing bytes); also offered to ERC-5792 wallets
    // via the optional dataSuffix capability so smart-wallet userOps are attributed too.
    const BUILDER_CODE_SUFFIX = '0x62635f78376433377437370b0080218021802180218021802180218021';
    const withBuilderCode = (data) => (typeof data === 'string' && data.startsWith('0x') && !data.endsWith(BUILDER_CODE_SUFFIX.slice(2)))
      ? data + BUILDER_CODE_SUFFIX.slice(2) : data;
    // v5.12: browser wallets can be on another chain (or be switched after connect). Make sure every tx goes to
    // Base, adding the chain if the wallet doesn't know it (MetaMask 4902).
    async function ensureBase(eth) {
      const cur = await withTimeout(eth.request({ method: 'eth_chainId' }), 10000, 'eth_chainId').catch(() => null);
      if (cur !== null && Number(cur) === 8453) return;
      try {
        await withTimeout(eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] }), 60000, 'Switch to Base');
      } catch (e) {
        if (e?.code !== 4902 && !/unrecognized|not been added|unknown chain/i.test(String(e?.message))) throw e;
        await withTimeout(eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x2105', chainName: 'Base',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'],
          blockExplorerUrls: ['https://basescan.org'] }] }), 60000, 'Add Base');
      }
    }
    async function sendAndConfirm(calls, finalCheck, label) {
      if (!walletEip1193 || !userAddress) throw new Error('Connect your wallet first');
      calls = calls.map((c) => ({ ...c, data: withBuilderCode(c.data) }));
      if (await supportsSendCalls()) {
        try {
          console.log('[tx]', label, 'via wallet_sendCalls', calls.length, 'call(s)');
          const base = { version: '2.0.0', chainId: '0x2105', from: userAddress, atomicRequired: false,
            calls: calls.map((c) => ({ to: c.to, data: c.data, value: '0x0' })) };
          let r;
          try {
            r = await withTimeout(walletEip1193.request({ method: 'wallet_sendCalls', params: [{ ...base,
              capabilities: { dataSuffix: { value: BUILDER_CODE_SUFFIX, optional: true } } }] }), 300000, label + ' (wallet approval)');
          } catch (capErr) {
            if (!isUnsupportedErr(capErr) && !/capabilit/i.test(capErr?.message || '')) throw capErr;
            console.warn('[tx] dataSuffix capability rejected, retrying without it', capErr?.message);
            r = await withTimeout(walletEip1193.request({ method: 'wallet_sendCalls', params: [base] }), 300000, label + ' (wallet approval)');
          }
          const sent = { kind: 'calls', id: typeof r === 'string' ? r : r?.id };
          console.log('[tx]', label, 'calls id', sent.id);
          await pollConfirm(finalCheck, sent, label);
          return sent;
        } catch (e) {
          // Only a user rejection or an on-chain failure is final; any other wallet_sendCalls error (5700/5710/5750,
          // -32602 bad params, ...) falls back to a plain eth_sendTransaction that every EOA wallet supports.
          if (e?.code === 4001 || /failed on-chain|not confirmed after/.test(String(e?.message))) throw e;
          console.warn('[tx] wallet_sendCalls failed, falling back to eth_sendTransaction', e?.code, e?.message);
          sendCallsSupported = false;
        }
      }
      await ensureBase(walletEip1193);
      let sent = null;
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        console.log('[tx]', label, `via eth_sendTransaction (${i + 1}/${calls.length})`);
        const id = await withTimeout(walletEip1193.request({ method: 'eth_sendTransaction', params: [{ from: userAddress, to: c.to, data: c.data, value: '0x0' }] }), 300000, label + ' (wallet approval)');
        sent = { kind: 'tx', id };
        console.log('[tx]', label, 'returned id', id, '(may be a smart-account operation id)');
        if (i < calls.length - 1) await pollConfirm(c.check || (async () => true), sent, label + ` step ${i + 1}`);
      }
      await pollConfirm(finalCheck, sent, label);
      return sent;
    }
    const lbIface = () => new ethers.Interface(lbAbi);
    // v5.12: reads that confirm a tx go to Base directly, never through the wallet's (possibly other-chain) RPC.
    let baseRead = null;
    const readProvider = () => (baseRead ||= new ethers.JsonRpcProvider('https://mainnet.base.org', { chainId: 8453, name: 'base' }, { staticNetwork: true }));
    const lbRead = () => new ethers.Contract(leaderboardAddress, lbAbi, readProvider());

    // v5.0: Farcaster / Base mini-app SDK. ready() hides the client's splash screen; without it the
    // app can hang on the splash inside Farcaster/Base clients. Outside a mini-app host sdk stays null.
    let fcProvider = null;
    // Every host call gets a timeout: in the Base app / Coinbase in-app browser window.ReactNativeWebView exists, so
    // SDK messages are posted to a "host" that never answers. An un-timed await there hung Connect forever.
    function withTimeout(p, ms, label) {
      return Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out after ' + ms + ' ms')), ms))]);
    }
    // Perf: the SDK bundle is ~780 KB, so it is only fetched inside something that can be a mini-app host
    // (an iframe or a ReactNativeWebView - the same test the SDK's own isInMiniApp() makes first), and it loads
    // async so it never delays the page or the game canvas.
    const MINIAPP_SDK_SRI = 'sha384-kneml2QskOvZYjSKuDfVPbF5Pf+tRd+bVBkKApQkUiNWQsnSnlxeghJY49fjc2pQ';
    function loadMiniAppSdk() {
      if (window.farcasterMiniAppSdk) return Promise.resolve(window.farcasterMiniAppSdk);
      if (!window.ReactNativeWebView && window === window.parent) return Promise.resolve(null);
      return new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = '/vendor/miniapp-sdk.js'; s.integrity = MINIAPP_SDK_SRI; s.async = true;
        s.onload = () => resolve(window.farcasterMiniAppSdk || null);
        s.onerror = () => { console.warn('[connect] mini-app SDK failed to load'); resolve(null); };
        document.head.appendChild(s);
      });
    }
    async function initSdk() {
      const fc = await loadMiniAppSdk();
      if (!fc) { console.log('[connect] mini-app SDK not loaded – browser wallet mode'); return; }
      let inMiniApp = false;
      try { inMiniApp = await withTimeout(fc.isInMiniApp(1500), 2000, 'isInMiniApp'); } catch (e) { console.warn('[connect]', e.message); }
      window.__inMiniApp = !!inMiniApp;
      if (!inMiniApp) { console.log('[connect] not inside a mini-app host – browser wallet mode'); return; }
      console.log('[connect] mini-app host detected');
      // Dismiss the host splash right away (the page and a "Loading game…" placeholder are already showing);
      // fire-and-forget with a timeout, never block on it. Context/provider lookups continue below.
      withTimeout(fc.actions.ready(), 3000, 'sdk.actions.ready').catch((e) => console.warn('[connect]', e.message));
      try {
        const context = await withTimeout(fc.context, 1500, 'sdk.context').catch(() => null);
        sdk = { actions: fc.actions, context: { user: context?.user ? { ...context.user, pfp_url: context.user.pfpUrl } : null } };
        fcProvider = await withTimeout(fc.wallet.getEthereumProvider(), 1500, 'getEthereumProvider').catch((e) => { console.warn('[connect]', e.message); return null; });
      } catch (e) {
        console.warn('[connect] mini-app SDK init failed', e);
      }
    }
    const sdkReady = initSdk();
    // v5.12: EIP-6963 wallet discovery for browsers where wallets don't set window.ethereum.
    const eip6963 = [];
    window.addEventListener('eip6963:announceProvider', (ev) => { if (ev.detail?.provider && !eip6963.some((w) => w.provider === ev.detail.provider)) eip6963.push(ev.detail); });
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    let gameplayActive = false;
    let gameEnded = true;       // v5.9: gameOver/submit run once per game
    let resultsLocked = false;  // v5.9: a confirmed result can't be overwritten
    const MAX_SHIELDS = 3;
    const MISSES_ALLOWED = 3;
    let lives = null; // v4.64: unknown until read from the Leaderboard contract
    let shields = MAX_SHIELDS;
    let misses = 0;
    let score = 0;
    let speedRampTimer = null;
    let speedMultiplier = 1.0;
    let canShoot = true;
    let ship, asteroids, lazerGroup, keys, spaceKey;
    let stars = [];
    // v5.4: starfield uniformly spread over the CURRENT world; count scales with area; per-star parallax speeds.
    function buildStars(scene) {
      const width = scene.scale.width, height = scene.scale.height;
      stars.forEach(st => st.destroy()); stars = [];
      if (!(width > 0 && height > 0)) return;
      const density = Phaser.Math.Clamp(width * height / (800 * 500), 0.3, 3); // 220 stars at 800x500
      const layers = [ { n: 120, speed: 0.5, alpha: 0.4, size: 1, color: 0xffffff },
                       { n: 60,  speed: 1.1, alpha: 0.65, size: 1.6, color: 0x4488FF },
                       { n: 40,  speed: 2.4, alpha: 0.95, size: 2.2, color: 0x32FF9A } ];
      const sizeK = Math.max(0.6, baseScale);
      layers.forEach(L => {
        for (let i = 0, n = Math.round(L.n * density); i < n; i++) {
          const star = scene.add.graphics({ x: Math.random() * width, y: Math.random() * height });
          star.fillStyle(L.color, L.alpha);
          star.fillCircle(0, 0, L.size * sizeK);
          star.speedY = L.speed * (0.6 + Math.random() * 0.8);
          star.setDepth(-0.5);
          stars.push(star);
        }
      });
      if (scene.bgRect) scene.bgRect.setDepth(-1);
      scene._starW = width; scene._starH = height;
    }
    let baseScale = 1.0;
    // v5.3: clamp so a transiently tiny/zero canvas (iOS reports the parent size late) can never shrink sprites to a speck.
    function computeBaseScale(w, h) {
      const r = Math.min(w / 800, h / 500, 1.0);
      return Math.max(0.5, Number.isFinite(r) ? r : 1);
    }
    let personalHighScore = 0;

    // v4.64: results overlay reflects the real submission state:
    // 'submitting' -> 'confirmed' (on-chain receipt) | 'failed' | 'offline' | 'zero'
    function showResultsOverlay(finalScore) {
      const overlay = document.getElementById('results-overlay');
      setText('results-score', `Score: ${finalScore}`);
      setText('results-title', finalScore > personalHighScore ? 'NEW HIGH SCORE!' : 'GAME OVER');
      document.getElementById('results-ast').replaceChildren();
      document.getElementById('results-tx').replaceChildren();
      overlay.style.display = 'block';
    }

    function setResultsState(state, { txHash = null, astMinted = null, error = '' } = {}) {
      if (resultsLocked && state !== 'confirmed') { console.warn('[results] ignored', state, 'after confirmed:', error); return; }
      if (state === 'confirmed') resultsLocked = true;
      const astDiv = document.getElementById('results-ast');
      const txDiv = document.getElementById('results-tx');
      astDiv.replaceChildren();
      txDiv.replaceChildren();
      const line = (text) => { const d = document.createElement('div'); d.textContent = text; return d; };
      if (state === 'submitting') {
        astDiv.append(line('⏳ Submitting score on-chain…'));
        txDiv.append(line('Confirm the transaction in your wallet. AST rewards are minted only after it confirms.'));
      } else if (state === 'confirmed') {
        astDiv.append(line('✅ Score confirmed on-chain'));
        if (astMinted !== null) astDiv.append(line(astMinted > 0 ? `+${astMinted} AST minted` : 'No AST earned this round'));
        const btn = document.createElement('button');
        btn.id = 'add-ast-metamask';
        btn.textContent = 'Add AST to wallet';
        btn.style.cssText = 'margin-top:8px;padding:8px 16px;font-size:14px;background:#F7931A;color:#000;border:none;border-radius:8px;cursor:pointer;';
        btn.addEventListener('click', addASTToMetaMask);
        astDiv.append(btn);
        renderTxLink(txDiv, txHash);
      } else if (state === 'failed') {
        astDiv.append(line('❌ Score NOT saved'));
        txDiv.append(line(`On-chain submission failed: ${error || 'unknown error'}. No AST was minted and the score was not stored anywhere.`));
        renderTxLink(txDiv, txHash, 'Failed tx: ');
      } else if (state === 'offline') {
        astDiv.append(line('Score not saved'));
        txDiv.append(line('Connect a wallet to submit scores to the on-chain leaderboard and earn AST.'));
      } else if (state === 'zero') {
        astDiv.append(line('Score of 0 is not submitted'));
      }
    }

    function hideResultsOverlay() {
      document.getElementById('results-overlay').style.display = 'none';
    }

    function showNewHighBanner() {
      const banner = document.getElementById('new-high-banner');
      banner.style.display = 'block';
      setTimeout(() => { banner.style.display = 'none'; }, 3000);
    }

    class GameScene extends Phaser.Scene {
      constructor() { super({ key: 'GameScene' }); }

      preload() { console.log('Preload complete – procedural only'); }

      create() {
        const width = this.scale.width;
        const height = this.scale.height;
        baseScale = computeBaseScale(width, height);

        // Force black background to cover any gaps
        this.bgRect = this.add.rectangle(0, 0, width, height, 0x000000).setOrigin(0);

        stars = [];
        buildStars(this);

        // === IMPROVED SHIP (v4.62) ===
        ship = this.add.graphics({ x: width / 2, y: height * 0.82 });
        // v5.3: geometry is drawn ONCE in fixed units (s=1); on-screen size comes from ship.setScale(shipScale())
        // in placeShip, recomputed absolutely from the current canvas size (never compounding, never 0).
        const s = 1;

        // Main body
        ship.fillStyle(0x0052FF, 1);
        ship.lineStyle(4, 0xF7931A, 1);
        ship.beginPath();
        ship.moveTo(0, -32 * s);
        ship.lineTo(26 * s, 18 * s);
        ship.lineTo(12 * s, 26 * s);
        ship.lineTo(0, 20 * s);
        ship.lineTo(-12 * s, 26 * s);
        ship.lineTo(-26 * s, 18 * s);
        ship.closePath();
        ship.fillPath();
        ship.strokePath();

        // Cockpit
        ship.fillStyle(0xFFFFFF, 0.95);
        ship.fillCircle(0, -10 * s, 6 * s);

        // Thrusters
        ship.fillStyle(0x32FF9A, 0.9);
        ship.fillTriangle(-10 * s, 22 * s, -3 * s, 22 * s, -6.5 * s, 34 * s);
        ship.fillTriangle( 3 * s, 22 * s, 10 * s, 22 * s,  6.5 * s, 34 * s);

        ship.fillStyle(0xF7931A, 0.85);
        ship.fillTriangle(-6 * s, 24 * s, 6 * s, 24 * s, 0, 32 * s);

        this.physics.add.existing(ship);
        ship.body.setCollideWorldBounds(false); // v5.6: x is clamped in code (bounds+offset body stopped it ~12px short of the right edge)
        ship.body.setAllowGravity(false);
        ship.body.immovable = true;
        ship.setDepth(5);
        this.add.existing(ship);
        placeShip(this, false);

        asteroids = this.physics.add.group();
        lazerGroup = this.physics.add.group();

        this.physics.add.overlap(ship, asteroids, this.hitShip, null, this);
        this.physics.add.overlap(lazerGroup, asteroids, this.destroyAsteroid, null, this);

        keys = this.input.keyboard.createCursorKeys();
        spaceKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

        // Touch controls
        // v5.5: RELATIVE drag. Absolute (ship.x = finger.x) made the ship jump to wherever a new touch began –
        // re-touching near the middle snapped it back toward the center.
        this._drag = null;
        this.input.on('pointerdown', (pointer) => { this._drag = { id: pointer.id, px: pointer.x, sx: ship.x }; });
        const endDrag = (pointer) => {
          if (this._drag && this._drag.id === pointer.id) {
            this._drag = null;
            if (gameplayActive) Tilt.settle(250); // ship stays where the finger left it; current angle becomes level
          }
        };
        this.input.on('pointerup', endDrag); this.input.on('pointerupoutside', endDrag);
        this.input.on('pointermove', (pointer) => {
          if (!gameplayActive || !pointer.isDown) return;
          if (!this._drag || this._drag.id !== pointer.id) this._drag = { id: pointer.id, px: pointer.x, sx: ship.x };
          const half = shipHalfWidth(this);
          ship.x = Phaser.Math.Clamp(this._drag.sx + (pointer.x - this._drag.px), half, this.scale.width - half);
          if (ship.body) ship.body.reset(ship.x, ship.y);
        });
      }

      update() {
        if (!gameplayActive) return;
        const width = this.scale.width;
        const height = this.scale.height;

        stars.forEach(star => {
          star.y += star.speedY;
          if (star.y > height + 4) { star.y = -Math.random() * 20; star.x = Math.random() * width; }
        });

        const moveSpeed = 5 / baseScale;
        if (keys.left.isDown) ship.x -= moveSpeed;
        else if (keys.right.isDown) ship.x += moveSpeed;
        else if (!this._drag) ship.x += Tilt.step(moveSpeed); // tilt steering; a finger on the screen always wins

        ship.x = Phaser.Math.Clamp(ship.x, shipHalfWidth(this), width - shipHalfWidth(this));
        if (ship.body) ship.body.reset(ship.x, ship.y);

        if (spaceKey.isDown && canShoot) {
          this.shootLaser();
          canShoot = false;
          this.time.delayedCall(250, () => { canShoot = true; });
        }

        asteroids.getChildren().forEach(asteroid => {
          // v5.6: removed setPosition(body.x, body.y) – it copied the hit-box corner onto the sprite every frame
          asteroid.rotation += 0.05;
        });

        lazerGroup.getChildren().forEach(laser => {
          laser.setPosition(laser.body.x, laser.body.y);
          if (laser.y < 0) laser.destroy();
        });

        asteroids.getChildren().forEach(asteroid => {
          if (asteroid.body.y > height + 40 * baseScale) {
            asteroid.destroy();
            misses++;
            updateScoreDisplay();
            if (misses >= MISSES_ALLOWED && !gameEnded) this.gameOver();
          }
        });
      }

      // v5.6: lasers/asteroids are scaled ONCE (they were drawn at k AND setScale(k) → k², and their hit boxes
      // hung off to the bottom-right of the sprite, so edge asteroids were unhittable). Hit boxes are centered.
      shootLaser() {
        const k = baseScale;
        // Arcade bodies on Graphics misbehave with negative offsets, so draw from (0,0) and place the
        // object's top-left so the laser's CENTER is exactly ship.x.
        const hw = LASER_HALF_W * k;
        const laser = this.add.graphics({ x: ship.x - hw, y: ship.y - 34 * k });
        laser.fillStyle(0x32FF9A, 1);
        laser.fillRect(0, 0, hw * 2, 26 * k);
        laser.fillStyle(0xF7931A, 0.9);
        laser.fillRect(hw - 1.2 * k, 4 * k, 2.4 * k, 18 * k);
        this.physics.add.existing(laser);
        lazerGroup.add(laser);
        laser.body.setAllowGravity(false);
        laser.body.setSize(hw * 2, 26 * k, false);
        laser.body.setVelocityY(-500 * k);
      }

      spawnAsteroid() {
        const k = baseScale;
        const [minX, maxX] = asteroidSpawnRange(this);
        const x = Phaser.Math.FloatBetween(minX, maxX);
        const R = 20 * k; // drawn around (0,0) so rotation spins in place; object x == center x
        const asteroid = this.add.graphics({ x: x, y: -45 * k });
        asteroid.fillStyle(0x3A3F5A, 1);
        asteroid.lineStyle(2.5, 0xF7931A, 0.9);
        asteroid.fillCircle(0, 0, R);
        asteroid.strokeCircle(0, 0, R);
        asteroid.fillStyle(0x1F2438, 1);
        asteroid.fillCircle(-5 * k, -7 * k, 4 * k);
        asteroid.fillCircle(6 * k, 5 * k, 5 * k);
        if (Math.random() > 0.55) {
          asteroid.fillStyle(0x32FF9A, 0.85);
          asteroid.fillCircle(4 * k, -4 * k, 2 * k);
        }
        this.physics.add.existing(asteroid);
        asteroids.add(asteroid);
        asteroid.body.setSize(AST_R * 2 * k, AST_R * 2 * k, false);
        asteroid.body.setOffset(-AST_R * k, -AST_R * k); // centered hit box
        asteroid.body.setAllowGravity(false);
        asteroid.body.setVelocityX(0);                  // straight down only – no sideways drift out of range
        const baseSpeed = 120;
        const currentSpeed = baseSpeed + (speedMultiplier * 45);
        asteroid.body.setVelocityY(currentSpeed * k);
      }

      hitShip(shipObj, asteroid) {
        if (!gameplayActive || gameEnded) return; // physics keeps running after game over
        asteroid.destroy();
        shields = Math.max(0, shields - 1);
        updateTopBar().catch(console.error);
        if (shields <= 0) {
          shields = MAX_SHIELDS;
          misses++;
          updateScoreDisplay();
          this.gameOver();
        }
      }

      destroyAsteroid(laser, asteroid) {
        if (!gameplayActive || gameEnded) return;
        if (laser) laser.destroy();
        if (asteroid) asteroid.destroy();
        score += 12;
        updateScoreDisplay();

        const hitX = asteroid ? asteroid.x : laser.x;
        const hitY = asteroid ? asteroid.y : laser.y;
        const effect = this.add.graphics({ x: hitX, y: hitY });
        effect.fillStyle(0x32FF9A, 0.8);
        effect.fillCircle(0, 0, 8);
        effect.fillStyle(0xF7931A, 0.6);
        effect.fillCircle(0, 0, 4);
        this.time.delayedCall(100, () => { if (effect) effect.destroy(); });
      }

      // === v4.61: gameOver() correctly inside class ===
      gameOver() {
        if (gameEnded) { console.warn('[gameOver] ignored duplicate call'); return; }
        gameEnded = true;
        gameplayActive = false;
        Awake.off();
        if (this.shootTimer) this.shootTimer.paused = true;
        if (this.spawnTimer) this.spawnTimer.paused = true;
        if (speedRampTimer) speedRampTimer.remove();

        const finalScore = score;
        showResultsOverlay(finalScore);

        if (finalScore < 1) {
          setResultsState('zero');
          updateLeaderboard();
        } else if (signer && contractsConfigured) {
          const shortName = cleanPlayerName(sdk?.context?.user?.username || document.getElementById('whoami').textContent);
          setResultsState('submitting');
          submitScoreToChain(finalScore, shortName)
            .then(async (result) => {
              if (result.status === 'confirmed') {
                setResultsState('confirmed', result);
                await Promise.all([updateLeaderboard(), getTokenBalance(), updateAstFacts()]);
                checkNewHighScoreAndShowBanner(finalScore);
              } else if (result.status === 'skipped' || resultsLocked) {
                console.warn('[submit] skipped:', result.error);
              } else {
                setResultsState('failed', result);
                showToast(`❌ Score not saved on-chain\n${result.error}`, true);
                updateLeaderboard();
              }
            })
            .catch((e) => { console.error(e); setResultsState('failed', { error: shortError(e) }); });
        } else {
          setResultsState('offline');
          updateLeaderboard();
        }

      }
    }

    if (!window.Phaser) { const l = document.getElementById('game-loading'); if (l) l.textContent = 'Could not load the game. Check your connection and reload.'; }
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game-container',
      width: 800,
      height: 500,
      scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
      physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
      scene: GameScene,
      callbacks: { postBoot: () => document.getElementById('game-loading')?.remove() } // perf: placeholder until the canvas exists
    });

    // v5.1: keep the whole world inside the canvas on every resize (width OR height), ship pinned near the bottom.
    // v5.6: ship may sit nearly flush with the edge (visual half width 26*S, minus a few px).
    function shipHalfWidth(scene) { return Math.max(8, 26 * baseScale * 1.6 - 4); }
    const AST_R = 19, LASER_HALF_W = 2.5; // unit (unscaled) hit radii
    function asteroidCenterX(a) { return a.x; }
    function shipXRange(scene) { const h = shipHalfWidth(scene); return [h, scene.scale.width - h]; }
    // Asteroid centers are spawned only where a laser from the ship (laser x == ship.x) can overlap them,
    // with a safety margin so the overlap is never a 1px graze.
    function asteroidSpawnRange(scene) {
      const [a, b] = shipXRange(scene);
      const reach = (AST_R + LASER_HALF_W) * baseScale * 0.6;
      return [Math.max(0, a - reach), Math.min(scene.scale.width, b + reach)];
    }
    function placeShip(scene, keepX) {
      if (!scene || !ship) return;
      const width = scene.scale.width, height = scene.scale.height;
      baseScale = computeBaseScale(width, height);
      const s = baseScale * 1.6;
      ship.setScale(s);
      if (ship.body) { ship.body.setSize(36, 48); ship.body.setOffset(-18, -24); /* unscaled units: Arcade multiplies by ship.scale */ }
      ship.setDepth(10);
      const halfW = shipHalfWidth(scene);
      // v5.5: keep x (proportionally if the width changed); only recenter when explicitly asked (new game).
      const prevW = scene._shipW || width;
      const keep = keepX !== false || gameplayActive;
      const x = Phaser.Math.Clamp(keep ? ship.x * (width / prevW) : width / 2, halfW, width - halfW);
      scene._shipW = width;
      const y = height - 34 * s - Math.max(10, height * 0.03); // thrusters end at +34*s below the origin
      ship.x = x; ship.y = y;
      if (ship.body) { ship.body.reset(x, y); }
      scene.physics.world.setBounds(0, 0, width, height);
      if (scene.bgRect) scene.bgRect.setSize(width, height);
      // v5.4: stars were spawned once at boot (tiny iOS canvas) → all bunched in a band. Rebuild for the real world size.
      if (!scene._starW || Math.abs(width - scene._starW) / scene._starW > 0.1 || Math.abs(height - scene._starH) / scene._starH > 0.1) buildStars(scene);
    }
    game.scale.on('resize', function() {
      const sceneInstance = game.scene.scenes[0];
      if (sceneInstance && sceneInstance.sys.isActive()) placeShip(sceneInstance, true);
    });

    // v5.2: measure the *real* visible area (visualViewport), never vh/innerHeight alone – in-app browsers
    // (Coinbase/Base app) overlay their own top bar and bottom toolbar.
    function vv() {
      const v = window.visualViewport;
      return v ? { h: v.height, top: v.offsetTop } : { h: window.innerHeight, top: 0 };
    }
    function visibleHeight() { return Math.round(vv().h); }
    let _safeProbe;
    function safeInsets() {
      if (!_safeProbe) {
        _safeProbe = document.createElement('div');
        _safeProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
        document.body.appendChild(_safeProbe);
      }
      const cs = getComputedStyle(_safeProbe);
      return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
    }
    function setViewportVar() { document.documentElement.style.setProperty('--vvh', visibleHeight() + 'px'); }

    let _lastSize = '';
    function optimizeGameSize() {
      setViewportVar();
      const container = document.getElementById('game-container');
      if (!container) return;
      const v = vv(), safe = safeInsets();
      let key;
      if (document.body.classList.contains('game-mode')) {
        // Pin to the visible viewport (offsetTop handles a toolbar-shifted visual viewport).
        const top = Math.round(v.top + safe.top), h = Math.floor(v.h - safe.top - safe.bottom);
        container.style.setProperty('top', top + 'px', 'important');
        container.style.setProperty('height', h + 'px', 'important');
        key = 'g' + top + 'x' + h;
      } else {
        container.style.removeProperty('top');
        // Pre-game: everything from the container's top to the bottom of the *visible* area, measured live
        // (connected state adds lines to the header, so this is re-run whenever the header resizes).
        const rect = container.getBoundingClientRect();
        const topInVisible = rect.top - v.top;
        const avail = Math.floor(v.h - topInVisible - safe.bottom - 10);
        const h = Math.max(140, Math.min(520, avail));
        container.style.setProperty('min-height', '0px', 'important');
        container.style.setProperty('box-sizing', 'border-box', 'important');
        container.style.setProperty('height', h + 'px', 'important');
        // Self-correct with the real rendered box (borders, rounding, anything we didn't account for).
        const over = Math.ceil(container.getBoundingClientRect().bottom - (v.top + v.h - safe.bottom - 10));
        if (over > 0) container.style.setProperty('height', Math.max(140, h - over) + 'px', 'important');
        key = 'p' + h + 'w' + Math.round(rect.width);
      }
      _lastSize = key;
      if (game && game.scale) {
        game.scale.refresh();
        // v5.4: refresh() alone can miss a parent that changed while Phaser was booting (iOS) → force the size.
        const cw = container.clientWidth, ch = container.clientHeight;
        if (cw > 0 && ch > 0 && (Math.round(game.scale.width) !== cw || Math.round(game.scale.height) !== ch)) game.scale.resize(cw, ch);
      }
      updateDebugOverlay();
    }
    // ?debug=1 → on-screen numbers Kevin can screenshot.
    const DEBUG_LAYOUT = /[?&]debug=1\b/.test(location.search);
    let _dbg;
    function updateDebugOverlay() {
      if (!DEBUG_LAYOUT) return;
      if (!_dbg) {
        _dbg = document.createElement('div');
        _dbg.id = 'layout-debug';
        _dbg.style.cssText = 'position:fixed;left:4px;top:calc(env(safe-area-inset-top,0px) + 34px);z-index:9999;background:rgba(0,0,0,.6);color:#0f0;font:11px/1.3 monospace;padding:4px 6px;border:1px solid #0f0;pointer-events:none;white-space:pre;text-align:left';
        document.body.appendChild(_dbg);
      }
      const v = vv(), safe = safeInsets();
      const cv = document.querySelector('#game-container canvas');
      const r = cv ? cv.getBoundingClientRect() : null;
      let shipLine = 'ship: –';
      try {
        const sc = game.scene.scenes[0];
        if (ship && r) {
          const k = r.height / sc.scale.height, s = baseScale * 1.6;
          shipLine = `ship y=${Math.round(ship.y)} screenBottom=${Math.round(r.top + (ship.y + 34 * s) * k)} world=${Math.round(sc.scale.width)}x${Math.round(sc.scale.height)}`;
        }
      } catch (e) {}
      const visBottom = Math.round(v.top + v.h);
      _dbg.textContent = `innerH=${innerHeight} vv.h=${Math.round(v.h)} vv.top=${Math.round(v.top)} visBottom=${visBottom}\n` +
        `safe t/b=${safe.top}/${safe.bottom} mode=${document.body.classList.contains('game-mode') ? 'play' : 'pre'} scrollY=${Math.round(scrollY)}\n` +
        (r ? `canvas top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} w=${Math.round(r.width)} ${r.bottom <= visBottom + 1 ? 'OK' : 'OFF-SCREEN'}` : 'canvas: –') + '\n' + shipLine;
    }
    if (DEBUG_LAYOUT) setInterval(updateDebugOverlay, 500);
    // Re-measure whenever anything above the canvas changes size (connect, token line, balances…).
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => optimizeGameSize());
      document.addEventListener('DOMContentLoaded', () => {
        let el = document.getElementById('game-container');
        while (el && el !== document.body) {
          let sib = el.previousElementSibling;
          while (sib) { ro.observe(sib); sib = sib.previousElementSibling; }
          el = el.parentElement;
        }
      });
    }
    if (window.visualViewport) window.visualViewport.addEventListener('scroll', optimizeGameSize);
    // Safety net: if anything above the canvas moved (e.g. the connected "Tokens" line appears), re-fit.
    let _lastTop = null;
    setInterval(() => {
      const c = document.getElementById('game-container'); if (!c) return;
      const t = Math.round(c.getBoundingClientRect().top) + '|' + visibleHeight();
      if (t !== _lastTop) { _lastTop = t; optimizeGameSize(); }
    }, 400);
    // ===== Keep the screen awake during a round (tilt players may not touch the screen for a while) =====
    // Two layers, both started from the Start Game TAP (a user gesture) and kept through countdown + round:
    //  1. Screen Wake Lock API (navigator.wakeLock) where it exists.
    //  2. NoSleep-style video, ALWAYS on iOS/iPadOS (WKWebView in Coinbase Wallet / X shipped a navigator.wakeLock
    //     that silently did nothing before iOS 18.4) and anywhere the API is missing or refuses.
    //     WebKit only keeps the display on for a PLAYING, UN-muted video WITH an audio track and WITHOUT the loop
    //     attribute (loop / muted / no audio = screen may sleep). So: a 3 s H.264+silent-AAC clip, unmuted (the track is
    //     silent; the game has no sound of its own), played inside the tap, and kept going by seeking back on
    //     timeupdate instead of `loop` (same trick as NoSleep.js). It is created only on those browsers.
    // Released at game over / leaving play; re-acquired when the page becomes visible again and on any tap during play.
    // Everything fails silently. Debug: __astWake.state(), or add ?debug=wake to the URL for a tiny status overlay.
    const Awake = (() => {
      const ua = navigator.userAgent || '';
      const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      let want = false, lock = null, video = null, lockErr = '', videoErr = '', requests = 0;
      const hasApi = () => !!(navigator.wakeLock && typeof navigator.wakeLock.request === 'function');
      const needVideo = () => isIOS || !hasApi() || !!lockErr;
      const makeVideo = () => {
        if (video) return video;
        video = document.createElement('video');
        video.setAttribute('title', 'Keep screen awake');
        video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', ''); video.playsInline = true;
        video.setAttribute('aria-hidden', 'true');
        video.muted = false;           // see note above: muted video does not hold the display on iOS
        video.preload = 'auto';
        video.src = '/assets/keepawake.mp4';
        video.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:0';
        video.addEventListener('timeupdate', () => { if (video.duration > 1 && video.currentTime > video.duration - 1) video.currentTime = 0.1 + Math.random() * 0.3; });
        video.addEventListener('ended', () => { if (want) { video.currentTime = 0; playVideo(); } });
        video.addEventListener('error', () => { videoErr = 'media error ' + (video.error && video.error.code); });
        document.body.appendChild(video);
        return video;
      };
      const playVideo = () => {
        try {
          const v = makeVideo();
          if (!v.paused) return;
          const pr = v.play();
          if (pr && pr.then) pr.then(() => { videoErr = ''; if (!want) v.pause(); }).catch((e) => { videoErr = (e && e.name) || String(e); });
        } catch (e) { videoErr = (e && e.name) || String(e); }
      };
      const requestLock = () => {
        if (!hasApi() || lock || document.visibilityState !== 'visible') return;
        requests++;
        try {
          navigator.wakeLock.request('screen').then((l) => {
            if (!want) { l.release().catch(() => {}); return; }
            lock = l; lockErr = '';
            l.addEventListener('release', () => { if (lock === l) lock = null; });
          }).catch((e) => { lockErr = (e && e.name) || String(e); if (want) playVideo(); });
        } catch (e) { lockErr = (e && e.name) || String(e); if (want) playVideo(); }
      };
      const acquire = () => {
        if (!want) return;
        requestLock();
        if (needVideo()) playVideo();
      };
      document.addEventListener('visibilitychange', () => { if (want && document.visibilityState === 'visible') acquire(); });
      // any tap while a round runs is a fresh user gesture: re-assert (cheap no-op when already held)
      document.addEventListener('pointerdown', () => { if (want) acquire(); }, true);
      const api = {
        // Call synchronously inside the Start Game tap (before any await).
        on() { want = true; acquire(); },
        off() {
          want = false;
          if (lock) { const l = lock; lock = null; l.release().catch(() => {}); }
          if (video) try { video.pause(); } catch (e) {}
        },
        state() {
          return { want, isIOS, api: hasApi(), locked: !!lock, lockErr, requests, videoUsed: !!video,
                   videoPlaying: !!video && !video.paused, videoTime: video ? +video.currentTime.toFixed(2) : null,
                   videoReady: video ? video.readyState : null, videoErr, visible: document.visibilityState };
        }
      };
      if (/[?&]debug=wake\b/.test(location.search)) {
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;right:4px;bottom:calc(env(safe-area-inset-bottom,0px) + 4px);z-index:10001;background:rgba(0,0,0,.75);color:#0f0;font:11px/1.3 monospace;padding:4px 6px;border:1px solid #0f0;pointer-events:none;white-space:pre;text-align:left';
        const draw = () => { const st = api.state(); box.textContent = 'wake ' + Object.entries(st).map(([k, v]) => k + '=' + v).join('\n'); };
        document.addEventListener('DOMContentLoaded', () => document.body.appendChild(box));
        setInterval(draw, 500); draw();
      }
      return api;
    })();
    window.__astAwake = Awake; // debug/test hook
    window.__astWake = Awake;

    function enterPlayMode() {
      window.scrollTo(0, 0);
      document.body.classList.add('game-mode');
      optimizeGameSize();
      // iOS sometimes reports the final viewport a frame later.
      setTimeout(optimizeGameSize, 60); setTimeout(optimizeGameSize, 300);
    }
    function exitPlayMode() {
      Awake.off();
      document.body.classList.remove('game-mode');
      optimizeGameSize(); setTimeout(optimizeGameSize, 60);
    }
    document.addEventListener('touchmove', (e) => { if (document.body.classList.contains('game-mode') && !e.target.closest('#results-overlay')) e.preventDefault(); }, { passive: false });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', optimizeGameSize);
    window.addEventListener('resize', optimizeGameSize);
    window.addEventListener('orientationchange', () => setTimeout(optimizeGameSize, 250));

    document.addEventListener('DOMContentLoaded', () => {
      updateTopBar();
      updateScoreDisplay();
      setTimeout(optimizeGameSize, 100);
    });

    // ===== Tilt steering (always on alongside touch + keyboard; no toggle) =====
    // iOS needs DeviceOrientationEvent.requestPermission() from a tap: we ask once, from Start Game, and remember the
    // answer in localStorage so a "Don't Allow" never nags again. Android/others just get the event. Neutral is
    // re-calibrated at GO each round, so whatever angle the phone is held at counts as level.
    const Tilt = (() => {
      const KEY = 'ast_tilt_perm_v1';
      const DEAD = 5;        // degrees of wobble ignored (a phone flat on a table with a camera bump tips ~2-4°)
      const FULL = 18;       // degrees past the dead zone for full (capped) ship speed
      const SMOOTH = 0.25;   // low-pass factor per frame
      const ON_KEY = 'ast_tilt_on';   // settings gear: '0' = off. Default (unset) = ON.
      const RECENTER_BAND = 2.5;  // a steady tilt within DEAD+this degrees of level ...
      const RECENTER_AFTER = 1200; // ... held this long (ms) slowly becomes the new level, so a constant slight tip never creeps
      const RECENTER_RATE = 0.04;  // per-frame easing of neutral toward the resting angle once recentering
      let raw = null, neutral = null, filtered = 0, listening = false, asked = false;
      // settle window: tilt is muted, readings are averaged, and the average becomes the new neutral
      let settleUntil = 0, settleSum = 0, settleN = 0;
      let slowRaw = null, steadySince = 0;
      const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const finishSettle = () => {
        if (!settleUntil || now() < settleUntil) return;
        settleUntil = 0;
        if (settleN > 0) neutral = settleSum / settleN; else if (raw != null) neutral = raw; else neutral = null;
        filtered = 0; steadySince = 0;
      };
      const enabled = () => { try { return localStorage.getItem(ON_KEY) !== '0'; } catch (e) { return true; } };
      const screenAngle = () => {
        const a = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle
                : (typeof window.orientation === 'number' ? window.orientation : 0);
        return ((a % 360) + 360) % 360;
      };
      // side-to-side tilt in degrees, + = right edge of the SCREEN tipped down
      const axis = (e) => {
        if (e.gamma == null || e.beta == null) return null;
        switch (screenAngle()) {
          case 90:  return e.beta;
          case 270: return -e.beta;
          case 180: return -e.gamma;
          default:  return e.gamma;
        }
      };
      const onOrient = (e) => {
        const v = axis(e);
        if (v == null || !isFinite(v)) return;
        raw = v;
        if (settleUntil) { settleSum += v; settleN++; finishSettle(); return; }
        if (neutral == null) neutral = v;
      };
      const listen = () => {
        if (listening || !enabled() || typeof window.DeviceOrientationEvent === 'undefined') return;
        listening = true;
        window.addEventListener('deviceorientation', onOrient);
      };
      const unlisten = () => {
        if (listening) window.removeEventListener('deviceorientation', onOrient);
        listening = false; raw = null; neutral = null; filtered = 0;
      };
      const needsPermission = () => typeof window.DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
      let stored = null; try { stored = localStorage.getItem(KEY); } catch (e) {}
      if (!needsPermission()) listen();             // Android / desktop: no prompt needed
      else if (stored === 'granted') listen();      // harmless if iOS has since forgotten; re-asked silently below
      return {
        enabled,
        // Settings gear switch. Called from the checkbox's change event, which is itself a tap, so turning tilt
        // back on can show the iOS prompt right there (unless they denied it before).
        setEnabled(on) {
          try { localStorage.setItem(ON_KEY, on ? '1' : '0'); } catch (e) {}
          if (!on) { unlisten(); return; }
          if (!needsPermission()) { listen(); return; }
          if (stored === 'granted') listen();
          asked = false; this.requestOnGesture();
        },
        // MUST be called synchronously inside a tap handler (before any await) for iOS to show the prompt.
        requestOnGesture() {
          if (asked || !enabled() || !needsPermission()) return;
          asked = true;
          if (stored === 'denied') return;          // they said no once – never nag; touch still works
          try {
            DeviceOrientationEvent.requestPermission().then((r) => {
              stored = r; try { localStorage.setItem(KEY, r); } catch (e) {}
              if (r === 'granted') listen();
            }).catch((e) => console.log('[tilt] permission unavailable:', e?.message || e));
          } catch (e) { console.log('[tilt] permission unavailable:', e?.message || e); }
        },
        // Mute tilt for `ms`, average the readings in that window and make it the new level. Used at GO (200 ms)
        // and when a finger lets go of the ship (250 ms), so releasing leaves the ship parked instead of creeping.
        settle(ms) { settleUntil = now() + ms; settleSum = 0; settleN = 0; filtered = 0; steadySince = 0; },
        calibrate() { this.settle(200); },
        // px to move this frame, proportional to tilt and capped at the ship's normal max speed
        step(maxSpeed) {
          if (!listening || raw == null) return 0;
          if (settleUntil) { finishSettle(); if (settleUntil) return 0; }
          if (neutral == null) return 0;
          let d = raw - neutral;
          if (d > 180) d -= 360; else if (d < -180) d += 360;
          filtered += (d - filtered) * SMOOTH;
          // slow auto-recenter: small AND steady tilt for a few seconds = the surface/grip, not steering
          slowRaw = slowRaw == null ? raw : slowRaw + (raw - slowRaw) * 0.05;
          const t = now();
          if (Math.abs(d) < DEAD + RECENTER_BAND && Math.abs(raw - slowRaw) < 0.75) {
            if (!steadySince) steadySince = t;
            else if (t - steadySince > RECENTER_AFTER) { neutral += (raw - neutral) * RECENTER_RATE; filtered *= (1 - RECENTER_RATE); }
          } else steadySince = 0;
          const mag = Math.abs(filtered) - DEAD;
          if (mag <= 0) return 0;
          return Math.sign(filtered) * Math.min(1, mag / FULL) * maxSpeed;
        },
        state() { return { enabled: enabled(), listening, raw, neutral, filtered, stored, settling: !!settleUntil }; }
      };
    })();
    window.__astTilt = Tilt; // debug/test hook (no secrets)
    // Settings gear on the start screen (the only setting so far: tilt steering on/off).
    (() => {
      const gear = document.getElementById('settings-btn'), panel = document.getElementById('settings-panel'), box = document.getElementById('tilt-setting');
      if (!gear || !panel || !box) return;
      box.checked = Tilt.enabled();
      gear.addEventListener('click', () => { const open = panel.hidden; panel.hidden = !open; gear.setAttribute('aria-expanded', String(open)); });
      box.addEventListener('change', () => Tilt.setEnabled(box.checked));
    })();
    window.addEventListener('orientationchange', () => setTimeout(() => Tilt.calibrate(), 300));

    // Fresh per-game state. Called on every start (first game AND Play Again) before the countdown.
    // Before this, score/misses/shields carried over: game 2 began at Missed 3/3 with game 1's score, so it
    // ended on the first miss and the server rightly rejected "score too high for game length".
    function resetRoundState(scene) {
      score = 0;
      misses = 0;
      shields = MAX_SHIELDS;
      speedMultiplier = 1.0;
      canShoot = true;
      if (scene) {
        if (scene.spawnTimer) { scene.spawnTimer.remove(false); scene.spawnTimer = null; }
        if (scene.shootTimer) { scene.shootTimer.remove(false); scene.shootTimer = null; }
        // leftover asteroids/lasers from the last game would otherwise fall in and count as misses
        if (asteroids) asteroids.clear(true, true);
        if (lazerGroup) lazerGroup.clear(true, true);
      }
      updateScoreDisplay();
    }

    function updateScoreDisplay() {
      document.getElementById('score-display').innerText = `Score: ${score} | Missed: ${misses}/${MISSES_ALLOWED}`;
    }

    async function updateTopBar() {
      document.getElementById('shields').innerText = `Shields: ${shields}/${MAX_SHIELDS}`;
      document.getElementById('lives').innerText = `Lives: ${lives === null ? '–' : lives}`;
      if (provider && userAddress) await updateUsdcBalance();
    }

    async function updatePersonalHighScore() {
      if (!contractsConfigured || !userAddress || !provider) return;
      try {
        const contract = new ethers.Contract(leaderboardAddress, lbAbi, provider);
        const high = await contract.playerHighScore(userAddress);
        personalHighScore = Number(high);
        document.getElementById('personal-high').innerText = `High: ${personalHighScore}`;
      } catch (e) { console.error('Personal high fetch error', e); }
    }

    // v5.13: silent=true restores a previously connected wallet on load with eth_accounts (never prompts).
    document.getElementById('connect-wallet').addEventListener('click', () => connectWallet(false));
    // Player name + avatar in the top bar (mini-app username/pfp when available, else the short address).
    function showIdentity() {
      let displayName = userAddress.slice(0,6) + '...' + userAddress.slice(-4);
      let avatarUrl = '';
      if (sdk && sdk.context && sdk.context.user) {
        const u = sdk.context.user;
        displayName = u.username || displayName;
        avatarUrl = u.pfp_url || u.avatar || '';
      }
      document.getElementById('whoami').textContent = cleanPlayerName(displayName, 'Player');
      avatarUrl = safeHttpsUrl(avatarUrl); // only https: images, never javascript:/data: etc.
      if (avatarUrl) {
        const av = document.getElementById('avatar');
        av.referrerPolicy = 'no-referrer';
        av.src = avatarUrl;
        av.style.display = 'block';
      }
    }
    async function connectWallet(silent) {
      if (isConnecting || userAddress) return;
      isConnecting = true;
      const button = document.getElementById('connect-wallet');
      const prevText = button.innerText;
      button.innerText = 'Connecting...';
      button.disabled = true;
      try {
        console.log('[connect] start');
        // Perf: an injected wallet (Coinbase / Base app browser, MetaMask) is preferred anyway, so only wait for the
        // mini-app SDK when there is none; the mini-app username/avatar is applied whenever the SDK finishes.
        if (!(window.ethereum || eip6963[0]?.provider)) {
          await withTimeout(sdkReady, 4000, 'mini-app SDK init').catch((e) => console.warn('[connect]', e.message));
        }
        // Prefer the injected wallet (Base app / Coinbase / MetaMask); the mini-app provider is the fallback.
        const eip1193 = window.ethereum || eip6963[0]?.provider || fcProvider;
        console.log('[connect] provider:', window.ethereum ? 'window.ethereum' : eip6963[0] ? 'EIP-6963 ' + eip6963[0].info?.name : fcProvider ? 'mini-app SDK' : 'none');
        if (!eip1193) { if (silent) throw Object.assign(new Error('no wallet'), { silentSkip: true }); throw new Error('No wallet found. Open this page in the Base app browser or a wallet browser.'); }
        if (!silent) button.innerText = 'Approve in wallet...';
        const accounts = await withTimeout(eip1193.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" }), silent ? 5000 : 120000, 'Wallet connection request');
        console.log('[connect] accounts', silent ? '(silent)' : '', accounts);
        if (!accounts || !accounts.length) { if (silent) throw Object.assign(new Error('not connected yet'), { silentSkip: true }); throw new Error('Wallet returned no account'); }
        const net = await withTimeout(eip1193.request({ method: "eth_chainId" }), 10000, 'eth_chainId');
        console.log('[connect] chainId', net);
        if (Number(net) !== 8453) {
          if (silent) throw Object.assign(new Error('wallet not on Base'), { silentSkip: true }); // switching would prompt
          button.innerText = 'Switch to Base in wallet...';
          await ensureBase(eip1193);
        }
        // Static network: skip ethers' network auto-detection (another place that can stall).
        walletEip1193 = eip1193; sendCallsSupported = null;
        provider = new ethers.BrowserProvider(eip1193, { chainId: 8453, name: 'base' }, { staticNetwork: true });
        userAddress = ethers.getAddress(accounts[0]);
        signer = await withTimeout(provider.getSigner(userAddress), 10000, 'getSigner');
        console.log('[connect] connected', userAddress);
        loadPackPrices().catch(() => {});

        showIdentity();
        sdkReady.then(() => { if (userAddress) showIdentity(); }); // mini-app username/avatar may arrive later

        button.innerText = 'Connected';
        button.disabled = true;
        document.getElementById('start-game').disabled = false;

        await updateUsdcBalance().catch(() => {});
        if (contractsConfigured && userAddress) {
          try {
            const c = new ethers.Contract(leaderboardAddress, lbAbi, provider);
            const onChainLives = await c.playerLives(userAddress);
            lives = Number(onChainLives); // v4.64: show the real on-chain count (was "|| 3")
          } catch (e) { console.error('Lives read failed', e); lives = null; }

          await Promise.allSettled([
            updateTopBar().catch(() => {}),
            updatePersonalHighScore().catch(() => {}),
            updateLeaderboard().catch(() => {}),
            getTokenBalance().catch(() => {}),
            updatePrizePot().catch(() => {}),
            updateAstFacts().catch(() => {})
          ]);
        }
        await refreshDailyFromChain();
        updateDailyClaim();
        refreshTasksFromChain();
      } catch (err) {
        button.innerText = prevText;
        button.disabled = false;
        if (silent) { console.log('[connect] silent reconnect skipped:', err?.message); return; }
        console.error('[connect] error:', err);
        const msg = err?.code === 4001 ? 'Request rejected in wallet' : (err?.shortMessage || err?.message || String(err));
        button.innerText = prevText;
        button.disabled = false;
        uiAlert('Could not connect: ' + msg);
      } finally {
        isConnecting = false;
      }
    }

let startButton = document.getElementById("start-game");
let freeClaimNeeded = false;
async function dailyClaimReady() {
  try {
    const next = BigInt(await lbRead().nextDailyClaimAt(userAddress));
    const blk = await provider.getBlock('latest');
    return next <= BigInt(blk.timestamp);
  } catch (e) { console.warn('[start] daily check failed', e?.message || e); return false; }
}
startButton.addEventListener("click", async () => {
  if (!userAddress) return uiAlert("Connect wallet first");
  Awake.on();              // wake lock + iOS video, from the tap itself (a later timer is not a user gesture on iOS)
  Tilt.requestOnGesture(); // iOS motion prompt (once, remembered) – must run before any await to keep the tap gesture
  freeClaimNeeded = false;

  // Check lives first
  if (contractsConfigured && provider && userAddress) {
    try {
      const c = new ethers.Contract(leaderboardAddress, lbAbi, provider);
      const onChainLives = Number(await c.playerLives(userAddress));
      lives = onChainLives;
      if (onChainLives <= 0) {
        // v5.7 free play: claim the free life and start in ONE wallet confirmation.
        freeClaimNeeded = useV2 && (await dailyClaimReady());
        if (!freeClaimNeeded) {
          let when = '';
          try { const next = Number(await c.nextDailyClaimAt(userAddress)); if (next) when = ' Next free life: ' + fmtWhen(next * 1000) + '.'; } catch (e) {}
          Awake.off();
          return uiAlert("You have 0 lives." + when);
        }
      }
    } catch (e) {
      console.error("Lives check failed", e);
    }
  }

  if (lives !== null && lives <= 0 && !freeClaimNeeded) { Awake.off(); return uiAlert("No lives left!"); }

  startButton.disabled = true;
  const playerName = cleanPlayerName(sdk?.context?.user?.username || document.getElementById('whoami').textContent, "Guest");

  try {
    if (contractsConfigured && signer) {
      const contract = new ethers.Contract(leaderboardAddress, lbAbi, signer);
      startButton.innerText = freeClaimNeeded ? 'Using your free daily life… confirm in wallet' : 'Starting… confirm in wallet';
      if (freeClaimNeeded) { setText('daily-timer', 'Using your free daily life…'); uiToast('Using your free daily life for this game'); }
      currentGame = null;
      if (useV2) {
        const before = BigInt(await lbRead().gamesStarted(userAddress));
        console.log('[start] gamesStarted before', before.toString());
        const startCall = { to: leaderboardAddress, data: lbIface().encodeFunctionData('startGame', []) };
        const calls = [];
        if (freeClaimNeeded) {
          // claim + start in one wallet_sendCalls batch (fallback: two txs, the first confirmed by its life landing)
          const livesBefore = BigInt(await lbRead().playerLives(userAddress));
          calls.push({ to: leaderboardAddress, data: lbIface().encodeFunctionData('claimDailyLives', []),
            check: async () => BigInt(await lbRead().playerLives(userAddress)) > livesBefore });
          console.log('[start] 0 lives → batching claimDailyLives + startGame');
        }
        calls.push(startCall);
        await sendAndConfirm(calls, async () => BigInt(await lbRead().gamesStarted(userAddress)) > before, freeClaimNeeded ? 'Claim free life + start' : 'Start game');
        refreshDailyFromChain().catch(() => {}); // the batch may have used the free life – never leave "Ready!" stale
        const gameId = BigInt(await lbRead().gamesStarted(userAddress));
        console.log('[start] game id', gameId.toString());
        startButton.innerText = 'Opening score session…';
        currentGame = await openGameSession(gameId);
      } else {
        await waitForSuccess(await contract.startGame(playerName));
      }
      startButton.innerText = 'Start Game';

      const c = new ethers.Contract(leaderboardAddress, lbAbi, provider);
      lives = Number(await c.playerLives(userAddress));
      console.log(`[Start Game v4.64] Lives after spend: ${lives}`);
      await updateTopBar();
    }

    // Takeover
    enterPlayMode();
    placeShip(game.scene.scenes[0], false);

    const sceneInstance = game.scene.scenes[0];
    resetRoundState(sceneInstance);
    updateTopBar().catch(console.error);
    setTimeout(() => {
      const countdownText = sceneInstance.add.text(sceneInstance.scale.width / 2, sceneInstance.scale.height / 2, "3", { 
        fontSize: `${Math.max(48 * baseScale, 60)}px`, fill: "#32FF9A", fontStyle: "bold",
        stroke: "#F7931A", strokeThickness: 3 
      }).setOrigin(0.5).setDepth(10);

      sceneInstance.time.delayedCall(1000, () => countdownText.setText("2"));
      sceneInstance.time.delayedCall(2000, () => countdownText.setText("1"));
      sceneInstance.time.delayedCall(3000, () => {
        countdownText.setText("GO!");
        sceneInstance.time.delayedCall(600, () => {
          countdownText.destroy();
          gameEnded = false; resultsLocked = false;
          Tilt.calibrate(); // the angle the phone is held at right now = level
          Awake.on();       // re-assert for the round (already started by the tap)
          gameplayActive = true;
          sceneInstance.spawnTimer = sceneInstance.time.addEvent({ 
            delay: 1200, callback: sceneInstance.spawnAsteroid, callbackScope: sceneInstance, loop: true 
          });
          sceneInstance.shootTimer = sceneInstance.time.addEvent({ 
            delay: 280, callback: sceneInstance.shootLaser, callbackScope: sceneInstance, loop: true 
          });
        });
      });
    }, 200);

  } catch (err) {
    console.error('Start game error:', err);
    uiAlert('Failed to start (no life was spent unless the transaction confirmed): ' + shortError(err));
    startButton.innerText = 'Start Game';
    startButton.disabled = false;
    exitPlayMode();
    refreshDailyFromChain().catch(() => {}); // a half-done claim+start (or a rejected one) – show what the chain says
  }
});

    // v2: get a backend session token for an on-chain game id (retries: the server's RPC can lag a block or two).
    async function openGameSession(gameId) {
      try {
        let lastErr;
        for (let attempt = 0; attempt < 5; attempt++) {
          const r = await withTimeout(fetch(ECONOMY.SESSION_API, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ player: userAddress, gameId: gameId.toString() })
          }), 15000, 'Score session request');
          const j = await r.json().catch(() => ({}));
          if (r.ok) { console.log('[start] session ok'); return { gameId, session: j.session }; }
          lastErr = new Error(j.error || `HTTP ${r.status}`);
          console.warn('[start] session attempt', attempt + 1, lastErr.message);
          if (r.status !== 404 && r.status !== 429 && r.status < 500) break;
          await sleep(2000);
        }
        throw lastErr;
      } catch (e) {
        console.warn('Session open failed; this score cannot be signed', e);
        showToast('⚠️ Score server unavailable: you can play, but this score may not be saved.', true);
        return { gameId, session: null, sessionError: shortError(e) };
      }
    }

    // v5.7: pack prices come from LeaderboardV2.packPrice(lives) on-chain (USDC, 6 decimals) – never hardcoded.
    // FALLBACK is only shown until the chain answers (current intended prices: $0.01/life, 10% off packs).
    const PACK_SIZES = [1, 10, 25, 50];
    const PACK_PRICE_FALLBACK = { 1: 0n, 10: 0n, 25: 0n, 50: 0n }; // free play: nothing for sale unless the chain says so
    const FREE_PLAY_HTML = 'Free to play — you only pay the network fee to save your score and earn AST.';
    const PAID_PRIZE_HTML = document.getElementById('prize-info').innerHTML;
    const packPrices = { ...PACK_PRICE_FALLBACK };
    let packPricesLive = false;
    function fmtUsd(micro) {
      const s = ethers.formatUnits(micro, 6); // e.g. "0.225", "0.01", "4.5"
      const [i, f = ''] = s.split('.');
      return '$' + i + '.' + f.replace(/0+$/, '').padEnd(2, '0');
    }
    function renderPackPrices() {
      PACK_SIZES.forEach((n) => {
        const btn = document.getElementById('buy-' + n); if (!btn) return;
        const p = packPrices[n];
        btn.textContent = `${n} ${n === 1 ? 'Life' : 'Lives'}: ${p > 0n ? fmtUsd(p) : 'n/a'}`;
        btn.disabled = !(p > 0n);
        btn.style.display = p > 0n ? '' : 'none'; // unsold packs hidden
      });
      // v5.7 free play: paid packs + USDC prize pot are shown only if the contract actually sells packs.
      const anyForSale = packPricesLive && PACK_SIZES.some((n) => packPrices[n] > 0n);
      const bb = document.querySelector('.buy-buttons'); if (bb) bb.style.display = anyForSale ? '' : 'none';
      const pi = document.getElementById('prize-info'); if (pi) pi.innerHTML = anyForSale ? PAID_PRIZE_HTML : FREE_PLAY_HTML;
      const note = document.getElementById('life-price-note');
      if (note) note.textContent = packPrices[1] > 0n ? ` · 1 life = ${fmtUsd(packPrices[1])}` : '';

    }
    async function loadPackPrices(prov) {
      if (!useV2) return renderPackPrices();
      try {
        const p = prov || provider || new ethers.JsonRpcProvider('https://mainnet.base.org', 8453, { staticNetwork: true });
        const c = new ethers.Contract(leaderboardAddress, lbAbi, p);
        const vals = await withTimeout(Promise.all(PACK_SIZES.map((n) => c.packPrice(n))), 8000, 'packPrice');
        PACK_SIZES.forEach((n, i) => { packPrices[n] = BigInt(vals[i]); });
        packPricesLive = true;
      } catch (e) { console.warn('[prices] using fallback', e?.message || e); }
      renderPackPrices();
    }
    renderPackPrices();
    document.addEventListener('DOMContentLoaded', () => loadPackPrices());
    PACK_SIZES.forEach((n) => document.getElementById('buy-' + n).addEventListener('click', () => buyLives(n, Number(packPrices[n]) / 1e6)));

    let buyInProgress = false;
    async function buyLives(amount, usdPrice) {
      if (!signer) return uiAlert("Connect first");
      if (buyInProgress) return;
      buyInProgress = true;
      const buyButtons = ['buy-1', 'buy-10', 'buy-25', 'buy-50'].map(id => document.getElementById(id));
      buyButtons.forEach(b => { if (b) b.disabled = true; });
      try {
        // v5.0: removed the sdk.pay() branch (it sent USD to the board without crediting lives).
        // v1 legacy mode: no purchases, USDC sent to 0xEFd9 can never be withdrawn.
        if (!useV2) throw new Error(LEGACY_MSG);
        showToast('⏳ Checking USDC…');
        const { cost, needApprove } = await ensureUsdcAllowance(amount);
        const livesBefore = BigInt(await lbRead().playerLives(userAddress));
        const usdcRead = new ethers.Contract(usdcAddress, usdcAbi, provider);
        const calls = [];
        if (needApprove) calls.push({ to: usdcAddress, data: new ethers.Interface(usdcAbi).encodeFunctionData('approve', [leaderboardAddress, cost]),
          check: async () => BigInt(await usdcRead.allowance(userAddress, leaderboardAddress)) >= cost });
        calls.push({ to: leaderboardAddress, data: lbIface().encodeFunctionData('buyLives', [amount]) });
        showToast(needApprove ? `⏳ Approve ${ethers.formatUnits(cost, 6)} USDC + buy ${amount} lives… confirm in your wallet` : '⏳ Buying lives… confirm in your wallet');
        await sendAndConfirm(calls, async () => BigInt(await lbRead().playerLives(userAddress)) >= livesBefore + BigInt(amount), 'Buy lives');
        if (contractsConfigured) {
          const c = new ethers.Contract(leaderboardAddress, lbAbi, provider);
          lives = Number(await c.playerLives(userAddress));
        }
        await updateTopBar();
        updatePrizePot();
        updateUsdcBalance();
        uiAlert(`✅ Purchase of ${amount} lives confirmed on-chain. Lives: ${lives === null ? 'refresh to see' : lives}`);
      } catch (err) {
        console.error("Buy lives error:", err);
        uiAlert("❌ Purchase failed, no lives were added: " + shortError(err));
      } finally {
        buyInProgress = false;
        buyButtons.forEach(b => { if (b) b.disabled = false; });
      }
    }

    // v4.64: returns { status: 'confirmed'|'failed'|'skipped', txHash, astMinted, error }.
    // The old version showed "Score saved locally" on failure, but nothing was ever saved locally.
    async function submitScoreToChain(finalScore, playerName = "Player") {
      if (!contractsConfigured || !signer || finalScore < 1) return { status: 'skipped', error: 'Not connected' };
      if (!useV2) return { status: 'failed', error: LEGACY_MSG };
      const game = currentGame;
      if (!game) return { status: 'skipped', error: 'No active game (already submitted)' };
      if (!game.session) return { status: 'failed', error: game.sessionError ? `No score session for this game (score server was unavailable at start: ${game.sessionError})` : 'No score session for this game' };
      let txHash = null;
      try {
        const r = await fetch(ECONOMY.SCORE_API, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ player: userAddress, gameId: game.gameId.toString(), score: finalScore,
                                 name: cleanPlayerName(playerName), session: game.session })
        });
        const signed = await r.json().catch(() => ({}));
        if (!r.ok) return { status: 'failed', error: `Score server: ${signed.error || 'HTTP ' + r.status}` };
        const token = new ethers.Contract(tokenAddress, tokenAbi, provider);
        const before = await token.balanceOf(userAddress).catch(() => null);
        const gid = BigInt(game.gameId);
        const data = lbIface().encodeFunctionData('submitScore', [gid, signed.score, signed.name, signed.deadline, signed.signature]);
        currentGame = null;
        const sent = await sendAndConfirm([{ to: leaderboardAddress, data }], async () => (await lbRead().games(userAddress, gid)).submitted, 'Submit score');
        txHash = sent.kind === 'tx' ? sent.id : null;
        let astMinted = null;
        if (before !== null) {
          const after = await token.balanceOf(userAddress).catch(() => null);
          if (after !== null) astMinted = Number(ethers.formatEther(after - before));
        }
        return { status: 'confirmed', txHash, astMinted };
      } catch (err) {
        console.error("Score submission failed:", err);
        return { status: 'failed', txHash, error: shortError(err) };
      }
    }

    async function checkNewHighScoreAndShowBanner(finalScore) {
      await updatePersonalHighScore();
      if (finalScore > personalHighScore) {
        personalHighScore = finalScore;
        showNewHighBanner();
      }
    }

    async function getTokenBalance() {
      if (!contractsConfigured || !userAddress || !provider) return;
      try {
        const contract = new ethers.Contract(tokenAddress, tokenAbi, provider);
        const balance = await contract.balanceOf(userAddress);
        document.getElementById("token-balance").innerText = `Tokens: ${ethers.formatEther(balance)} AST`;
        document.getElementById("token-balance").style.display = "block";
      } catch (err) { console.error("Token balance error:", err); }
    }

    async function updateLeaderboard() {
      if (!contractsConfigured || !provider) return;
      try {
        const contract = new ethers.Contract(leaderboardAddress, lbAbi, provider);
        let top = await contract.getTopScores(5);
        const ul = document.getElementById("leaderboard-list");
        // v4.64: names come from the chain (anyone can submit any string) - render as text only.
        ul.replaceChildren(...top.map(s => {
          const li = document.createElement('li');
          const addr = String(s.player || '');
          li.textContent = `${cleanPlayerName(s.playerName, 'Anonymous')} (${addr.slice(0,6)}…): ${String(s.score)}`;
          return li;
        }));
      } catch (err) {
        console.error("Leaderboard error:", err);
        const li = document.createElement('li');
        li.textContent = 'Leaderboard Error';
        document.getElementById("leaderboard-list").replaceChildren(li);
      }
    }

    async function updatePrizePot() {
      if (!provider) return;
      try {
        const bal = useV2
          ? await new ethers.Contract(leaderboardAddress, lbAbi, provider).prizePot()
          : await new ethers.Contract(usdcAddress, usdcAbi, provider).balanceOf(leaderboardAddress);
        const potEl = document.getElementById("pot-balance"); if (potEl) potEl.innerText = ethers.formatUnits(bal, 6);
      } catch (err) { console.error("Pot error:", err); }
    }

    async function updateUsdcBalance() {
      if (!provider || !userAddress) return;
      try {
        const usdc = new ethers.Contract(usdcAddress, usdcAbi, provider);
        const bal = await usdc.balanceOf(userAddress);
        document.getElementById("usdc-balance").innerText = `USDC: ${ethers.formatUnits(bal, 6)}`;
      } catch (err) { console.error("USDC balance error:", err); }
    }

    // v4.64: exact-amount USDC approval. Reads the live lifePrice from the Leaderboard
    // (contract charges amount * lifePrice), checks balance + existing allowance, and if the
    // allowance is short approves EXACTLY this purchase's cost. ERC-20 approve() sets (does not
    // add to) the allowance, so approving the full cost is the exact amount buyLives will pull.
    async function ensureUsdcAllowance(amount) {
      if (!signer || !provider || !userAddress) throw new Error('Connect first');
      const usdc = new ethers.Contract(usdcAddress, usdcAbi, provider);
      const lb = new ethers.Contract(leaderboardAddress, lbAbi, provider);
      // v2 charges the pack price (with discounts); a pack that isn't for sale reverts, so fail early.
      const cost = BigInt(await lb.packPrice(amount));
      if (cost === 0n) throw new Error(`The ${amount}-life pack is not for sale`);
      const balance = BigInt(await usdc.balanceOf(userAddress));
      if (balance < cost) throw new Error(`Not enough USDC: need ${ethers.formatUnits(cost, 6)}, have ${ethers.formatUnits(balance, 6)}`);
      const allowance = BigInt(await usdc.allowance(userAddress, leaderboardAddress));
      // Exact-amount approval is sent together with buyLives (one wallet_sendCalls batch when supported).
      return { cost, needApprove: allowance < cost };
    }

    async function updateAstFacts() {
      if (!provider) return;
      try {
        const token = new ethers.Contract(tokenAddress, tokenAbi, provider);
        const totalMinted = ethers.formatEther(await token.totalSupply());
        const cap = 1e9;
        const available = cap - Number(totalMinted);
        document.getElementById("ast-facts").innerText = `AST Facts: ${totalMinted} minted so far – ${available > 0 ? available + ' left to grind!' : 'Unlimited potential!'} 🚀`;
      } catch (err) {
        console.error("AST facts error:", err);
        document.getElementById("ast-facts").innerText = "AST Facts: Error loading";
      }
    }

    let nextDailyAtMs = 0; // v2: from nextDailyClaimAt() on-chain
    let lastDailyAtMs = 0; // v2: from lastDailyClaim() on-chain (0 = never claimed)
    // "today at 8:37 PM" / "tomorrow at 8:37 PM" / "Fri 8:37 PM", in the player's own time zone
    function fmtWhen(ms) {
      const d = new Date(ms), now = new Date();
      const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
      const diff = Math.round((day(d) - day(now)) / 86400000);
      if (diff === 0) return 'today at ' + t;
      if (diff === 1) return 'tomorrow at ' + t;
      if (diff === -1) return 'yesterday at ' + t;
      return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + t;
    }
    async function refreshDailyFromChain() {
      if (!useV2 || !provider || !userAddress) return;
      try {
        const c = new ethers.Contract(leaderboardAddress, lbAbi, provider);
        const [next, last] = await Promise.all([c.nextDailyClaimAt(userAddress), c.lastDailyClaim(userAddress).catch(() => 0n)]);
        nextDailyAtMs = Number(next) * 1000;
        lastDailyAtMs = Number(last) * 1000;
      } catch (e) { console.error('nextDailyClaimAt failed', e); }
      updateDailyClaim();
    }
    // coming back to the tab/app (e.g. after a day away, or from the wallet) re-reads the chain
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshDailyFromChain().catch(() => {}); });
    function updateDailyClaim() {
      const now = Date.now();
      const btn = document.getElementById("claim-daily");
      const timer = document.getElementById("daily-timer");
      if (!useV2) { btn.disabled = true; timer.innerText = 'Paused during upgrade'; return; }
      if (!userAddress) { btn.disabled = true; timer.innerText = 'Connect wallet'; return; }
      const timeLeft = nextDailyAtMs - now;
      if (timeLeft > 0) {
        btn.disabled = true;
        const h = Math.floor(timeLeft / 3600000);
        const m = Math.floor((timeLeft % 3600000) / 60000);
        const used = lastDailyAtMs ? `Used ${fmtWhen(lastDailyAtMs)} · ` : '';
        timer.innerText = `${used}Next free life: ${fmtWhen(nextDailyAtMs)} (in ${h}h ${m}m)`;
      } else {
        btn.disabled = false;
        timer.innerText = "Ready!";
      }
    }
    setInterval(updateDailyClaim, 60000);

    // v4.64: only report success when the award tx is confirmed on-chain. Previously the
    // failure was swallowed, a fake local +1 life was shown, and it said "saved on-chain".
    // NOTE: Leaderboard.awardFreeLives is onlyOwner, so this succeeds only for the owner wallet.
    // v5.0: v2 lets any wallet claim its daily life itself (claimDailyLives); v1 was owner-only.
    async function awardFreeLifeOnChain() {
      if (!signer || !contractsConfigured || !userAddress) throw new Error('Connect your wallet first');
      if (!useV2) throw new Error(LEGACY_MSG);
      const before = BigInt(await lbRead().nextDailyClaimAt(userAddress));
      await sendAndConfirm([{ to: leaderboardAddress, data: lbIface().encodeFunctionData('claimDailyLives', []) }],
        async () => BigInt(await lbRead().nextDailyClaimAt(userAddress)) > before, 'Claim daily life');
      const c = new ethers.Contract(leaderboardAddress, lbAbi, provider);
      lives = Number(await c.playerLives(userAddress));
      await updateTopBar();
    }

    document.getElementById("claim-daily").addEventListener("click", async () => {
      const btn = document.getElementById("claim-daily");
      btn.disabled = true;
      setText('daily-timer', 'Submitting…');
      try {
        await awardFreeLifeOnChain();
        await refreshDailyFromChain();
        uiAlert("✅ 1 free life confirmed on-chain!");
      } catch (e) {
        console.error("On-chain daily award failed", e);
        uiAlert("❌ Free life NOT added (nothing was saved): " + shortError(e));
      }
      updateDailyClaim();
    });

    // v5.2: the base.app / wallet.coinbase.com compose deep link is dead (404 in the Coinbase Wallet app).
    function uiToast(msg) {
      const t = document.createElement('div');
      t.textContent = msg;
      t.style.cssText = 'position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 24px);transform:translateX(-50%);z-index:10000;background:#111;color:#32FF9A;border:1px solid #32FF9A;border-radius:8px;padding:10px 16px;font-size:14px;max-width:90vw';
      document.body.appendChild(t); setTimeout(() => t.remove(), 2500);
    }
    function shareText(n) { return `Just scored ${n} in Asteroid Shooter on Base! 🚀 Can you beat me?`; }
    function shareUrl() { return window.location.origin + '/'; }
    async function copyShareLink(n) {
      const txt = `${shareText(n)} ${shareUrl()}`;
      try { await navigator.clipboard.writeText(txt); uiToast('Link copied to clipboard'); return; } catch (e) {}
      try {
        const ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove();
        if (ok) return uiToast('Link copied to clipboard');
      } catch (e) {}
      uiAlert(txt);
    }
    async function shareScore(theScore) {
      const n = Number(theScore) || 0;
      const compose = sdk?.actions?.composeCast;
      if (window.__inMiniApp && typeof compose === 'function') {
        try { await withTimeout(compose({ text: shareText(n), embeds: [shareUrl()] }), 8000, 'composeCast'); return; }
        catch (e) { console.warn('[share] composeCast failed', e?.message || e); }
      }
      if (navigator.share) {
        try { await navigator.share({ title: 'Asteroid Shooter', text: shareText(n), url: shareUrl() }); return; }
        catch (e) { if (e && e.name === 'AbortError') return; console.warn('[share] navigator.share failed', e); }
      }
      await copyShareLink(n);
    }
    // v5.11: window.open(..., 'noopener') always returns null, which also navigated the game tab away.
    // In a mini-app host use sdk.actions.openUrl; elsewhere a new tab, falling back to same-tab only if blocked.
    function miniOpenUrl() { const f = sdk?.actions?.openUrl; return window.__inMiniApp && typeof f === 'function' ? f : null; }
    function openExternal(url) {
      const openUrl = miniOpenUrl();
      if (openUrl) { Promise.resolve().then(() => openUrl(url)).catch(() => { location.href = url; }); return; }
      const w = window.open(url, '_blank');
      if (w) { try { w.opener = null; } catch (e) {} } else location.href = url;
    }
    document.getElementById('share-fc-btn').addEventListener('click', () => {
      const n = Number(score) || 0;
      openExternal(`https://farcaster.xyz/~/compose?text=${encodeURIComponent(shareText(n))}&embeds[]=${encodeURIComponent(shareUrl())}`);
    });
    // v5.8: X share must work inside in-app browsers (Base app / Farcaster) which block window.open.
    // Real <a href target=_blank> on a direct tap; mini-app hosts use sdk.actions.openUrl;
    // if nothing happened (page never lost focus), fall back to location.href; text is also copied.
    function xIntentUrl() { const n = Number(score) || 0; return `https://x.com/intent/post?text=${encodeURIComponent(shareText(n) + ' ' + shareUrl())}`; }
    function copyQuiet(txt) { try { navigator.clipboard?.writeText(txt).catch(() => {}); } catch (e) {} }
    const shareXEl = document.getElementById('share-x-btn');
    const refreshXHref = () => { shareXEl.href = xIntentUrl(); };
    shareXEl.addEventListener('pointerdown', refreshXHref);
    shareXEl.addEventListener('focus', refreshXHref);
    shareXEl.addEventListener('click', (ev) => {
      const url = xIntentUrl(); shareXEl.href = url;
      const n = Number(score) || 0; copyQuiet(shareText(n) + ' ' + shareUrl());
      const openUrl = sdk?.actions?.openUrl;
      // v5.11: inside a mini-app host, open the x.com intent via openUrl (no twitter:// scheme).
      if (window.__inMiniApp && typeof openUrl === 'function') {
        ev.preventDefault();
        Promise.resolve().then(() => openUrl(url)).catch(() => { location.href = url; });
        return;
      }
      // v5.10: on phones try the X app scheme first (universal links don't fire from in-app webviews),
      // then fall back to the x.com intent if the page is still visible after ~1.2s.
      if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
        ev.preventDefault();
        const appUrl = `twitter://post?message=${encodeURIComponent(shareText(n) + ' ' + shareUrl())}`;
        let left = false; const mark = () => { left = true; };
        // only a real app switch (page hidden) counts; a blur alone can be iOS's 'Open in X?' / error sheet
        window.addEventListener('pagehide', mark, { once: true });
        document.addEventListener('visibilitychange', mark, { once: true });
        try {
          location.href = appUrl;
        } catch (e) {}
        setTimeout(() => {
          window.removeEventListener('pagehide', mark); document.removeEventListener('visibilitychange', mark);
          if (left || document.visibilityState !== 'visible') return;
          if (window.__inMiniApp && typeof openUrl === 'function') Promise.resolve().then(() => openUrl(url)).catch(() => { location.href = url; });
          else { const w = window.open(url, '_blank', 'noopener'); if (!w) location.href = url; }
        }, 1200);
        return;
      }
      // let the native anchor navigation happen; verify it did
      let left = false; const mark = () => { left = true; };
      window.addEventListener('blur', mark, { once: true });
      document.addEventListener('visibilitychange', mark, { once: true });
      setTimeout(() => {
        window.removeEventListener('blur', mark); document.removeEventListener('visibilitychange', mark);
        if (!left && document.visibilityState === 'visible') {
          uiToast('Post text copied — opening X…');
          location.href = url;
        }
      }, 900);
    });
    document.getElementById("share-base-btn").addEventListener("click", () => shareScore(score));

    document.getElementById("return-home-btn").addEventListener("click", () => {
      hideResultsOverlay();
      exitPlayMode();
      if (document.fullscreenElement) document.exitFullscreen();
      document.getElementById('start-game').disabled = false;
    });

    document.getElementById("play-again-btn").addEventListener("click", () => {
      hideResultsOverlay();
      // v5.11: Start Game stays disabled after a successful start, and .click() on a disabled button is a no-op.
      const sb = document.getElementById("start-game");
      sb.disabled = false;
      sb.click();
    });

    function showManualAstImport(reason) {
      const host = document.getElementById('results-ast') || document.body;
      document.getElementById('ast-manual')?.remove();
      const box = document.createElement('div'); box.id = 'ast-manual';
      box.style.cssText = 'margin-top:8px;padding:8px;border:1px solid #F7931A;border-radius:8px;font-size:12px;text-align:left;word-break:break-all;';
      const p = (t) => { const d = document.createElement('div'); d.textContent = t; d.style.margin = '4px 0'; return d; };
      if (reason) box.append(p(reason));
      box.append(p('Import AST manually in your wallet: Base network → Import / Add custom token → paste this address:'));
      const code = document.createElement('code'); code.textContent = tokenAddress; code.style.cssText = 'display:block;color:#F7931A;margin:4px 0;';
      const copy = document.createElement('button'); copy.textContent = 'Copy token address';
      copy.style.cssText = 'padding:6px 12px;font-size:13px;background:#F7931A;color:#000;border:none;border-radius:6px;';
      copy.addEventListener('click', async () => {
        let ok = false;
        try { await navigator.clipboard.writeText(tokenAddress); ok = true; } catch (e) {
          try { const ta = document.createElement('textarea'); ta.value = tokenAddress; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (e2) {}
        }
        copy.textContent = ok ? 'Copied ✓' : 'Select & copy the address above';
      });
      const scan = document.createElement('a'); scan.href = `https://basescan.org/token/${tokenAddress}`; scan.target = '_blank'; scan.rel = 'noopener noreferrer';
      scan.textContent = 'View AST on BaseScan'; scan.style.cssText = 'display:block;margin-top:6px;color:#9cf;';
      box.append(code, copy, p('Symbol: AST · Decimals: 18 · Network: Base'), scan);
      host.append(box);
    }
    async function addASTToMetaMask() {
      const eth = walletEip1193 || window.ethereum || fcProvider;
      if (!eth) return showManualAstImport('No wallet detected.');
      try {
        const added = await withTimeout(eth.request({
          method: 'wallet_watchAsset',
          params: {
            type: 'ERC20',
            options: { address: tokenAddress, symbol: 'AST', decimals: 18, image: location.origin + '/icon.png' }
          }
        }), 20000, 'wallet_watchAsset');
        if (added === false) return showManualAstImport('The wallet did not add AST.');
        uiToast ? uiToast('✅ AST added to your wallet') : uiAlert('✅ AST added to your wallet');
        showManualAstImport('If AST still does not show, your wallet may need it imported manually:');
      } catch (err) {
        console.warn('[watchAsset]', err?.code, err?.message || err);
        showManualAstImport(err?.code === 4001 ? 'Request cancelled.' : 'Your wallet does not support adding tokens from apps.');
      }
    }

    // v5.11: task lives are LeaderboardV2.claimLifeGrant vouchers from /api/grant (server-side check, once per
    // wallet per task, enforced on-chain by grantUsed). Only tasks with a real check are wired (see docs/TASK-VERIFICATION.md).
    // grantId 2 (old Base App follow) is retired. 1 (X) is click-through: opening the link gets a server ticket that
    // /api/grant redeems after ~10 s. 3 (Accumulator) and 4 (Keep) are verified server-side against each app's status API.
    const TASK_KEYS = { 1: 'x', 3: 'accumulator', 4: 'keep' };
    const CLICK_TASKS = { 1: true };
    // v5.13: click-through tickets survive leaving the app / reloads: localStorage, keyed by wallet + task.
    const TICKET_TTL_MS = 3600 * 1000 - 60 * 1000; // server accepts tickets up to 1 h old
    const ticketKey = (id) => `ast:ticket:${String(userAddress).toLowerCase()}:${id}`;
    const clickTickets = new Proxy({}, {
      get(_, k) {
        try {
          const t = JSON.parse(localStorage.getItem(k) || 'null');
          if (!t || !t.ticket || Date.now() - t.issuedAt > TICKET_TTL_MS) { localStorage.removeItem(k); return undefined; }
          return t;
        } catch (e) { return undefined; }
      },
      set(_, k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} return true; },
      deleteProperty(_, k) { try { localStorage.removeItem(k); } catch (e) {} return true; },
    });
    async function startClickTicket(taskId) {
      if (!userAddress || !CLICK_TASKS[taskId]) return null;
      const cur = clickTickets[ticketKey(taskId)];
      if (cur) return cur;
      try {
        const r = await withTimeout(fetch(ECONOMY.GRANT_API, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ player: userAddress, task: TASK_KEYS[taskId], action: 'start' }) }), 15000, 'Task start');
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ticket) throw new Error(j.error || `HTTP ${r.status}`);
        const issuedAt = Date.now();
        const t = { ticket: j.ticket, issuedAt, readyAt: issuedAt + (Number(j.waitSeconds) || 10) * 1000 + 1500 };
        clickTickets[ticketKey(taskId)] = t;
        return t;
      } catch (e) { console.warn('[task] start failed', e?.message); return null; }
    }
    function countdown(taskId, buttonId) {
      const btn = document.getElementById(buttonId), t = clickTickets[ticketKey(taskId)];
      if (!btn || !t || btn.innerText === 'Completed') return;
      const left = Math.ceil((t.readyAt - Date.now()) / 1000);
      if (left > 0) { btn.disabled = true; btn.innerText = `Claim life (ready in ${left}s)`; setTimeout(() => countdown(taskId, buttonId), 1000); }
      else { btn.disabled = false; btn.innerText = 'Claim Life'; }
      updateTaskHints();
    }
    function updateTaskHints() {
      const hint = document.getElementById('task-x-hint'), btn = document.getElementById('task-x');
      if (hint) hint.style.display = userAddress && clickTickets[ticketKey(1)] && btn && btn.innerText !== 'Completed' ? 'block' : 'none';
    }
    function resumeClickTasks() {
      if (!userAddress) return;
      for (const [id, btnId] of TASK_BUTTONS) if (CLICK_TASKS[id] && clickTickets[ticketKey(id)]) countdown(id, btnId);
    }
    // Coming back from X (tab switch / app switch / bfcache restore) refreshes the countdown + hint.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resumeClickTasks(); });
    window.addEventListener('pageshow', resumeClickTasks);
    // Open an outbound link WITHOUT ever navigating the game window. Mini-app hosts: sdk.actions.openUrl (overlay /
    // external browser). Elsewhere: window.open(_blank). If the browser refuses a new window (some wallet webviews),
    // show the link instead of replacing the game.
    function openOutsideGame(url) {
      const openUrl = window.__inMiniApp && sdk?.actions?.openUrl;
      if (typeof openUrl === 'function') { Promise.resolve().then(() => openUrl(url)).catch((e) => { console.warn('[link] openUrl failed', e?.message); showLinkFallback(url); }); return; }
      let w = null;
      try { w = window.open(url, '_blank'); } catch (e) {}
      if (w) { try { w.opener = null; } catch (e) {} return; }
      showLinkFallback(url);
    }
    function showLinkFallback(url) {
      uiAlert('Your browser blocked opening X in a new window. Open ' + url + ' in your X app or browser, then come back here: your claim timer keeps running.');
    }
    // Opening the X / Keep link (directly, or via the Claim button) starts that task's ticket.
    // v5.14: on iOS / in wallet in-app browsers (Coinbase Wallet) window.open and https x.com links go through Safari,
    // so iOS's back link in X says "Safari". Open the X app's own scheme from the game window instead: iOS then shows
    // "◀ Coinbase Wallet". twitter:// is what the X app registers (x:// is tried once as a fallback); only if neither
    // app scheme leaves the page within ~1.5 s is the https intent opened, in a NEW window, never in the game window.
    const X_APP_URLS = ['twitter://user?screen_name=kevinmm8222', 'x://user?screen_name=kevinmm8222'];
    function useAppScheme() {
      if (window.__inMiniApp) return false; // Base app / Farcaster: sdk.actions.openUrl path unchanged
      const ua = navigator.userAgent || '';
      const iOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
      const mobile = iOS || /Android|Mobi/i.test(ua);
      // desktop Coinbase extension also sets isCoinbaseWallet, so only count it on mobile
      const walletBrowser = mobile && (/CoinbaseWallet|CoinbaseBrowser|Coinbase|BaseApp/i.test(ua) || !!window.ethereum?.isCoinbaseWallet);
      return iOS || walletBrowser;
    }
    function tryAppSchemes(urls, httpsUrl) {
      if (!urls.length) { openOutsideGame(httpsUrl); return; } // app not installed: https in a new window
      let left = false;
      const gone = () => { if (document.visibilityState === 'hidden') left = true; };
      const blur = () => { left = true; };
      document.addEventListener('visibilitychange', gone); window.addEventListener('pagehide', blur); window.addEventListener('blur', blur);
      try { window.__navigateApp ? window.__navigateApp(urls[0]) : (location.href = urls[0]); } catch (e) { console.warn('[x] scheme failed', e?.message); }
      setTimeout(() => {
        document.removeEventListener('visibilitychange', gone); window.removeEventListener('pagehide', blur); window.removeEventListener('blur', blur);
        if (!left) { console.log('[x] app did not open via', urls[0]); tryAppSchemes(urls.slice(1), httpsUrl); }
      }, 1500);
    }
    document.addEventListener('click', async (ev) => {
      const a = ev.target.closest && ev.target.closest('a[data-task]');
      if (!a) return;
      ev.preventDefault(); // the game window is never navigated to the https page
      const id = Number(a.dataset.task), btnId = TASK_BUTTONS.find(([i]) => i === id)?.[1];
      if (!(id === 1 && useAppScheme())) {
        openOutsideGame(a.href);
        if (userAddress) startClickTicket(id).then((t) => { if (t) countdown(id, btnId); });
        return;
      }
      // Start + persist the claim ticket BEFORE leaving for the X app (localStorage survives the app switch / reload).
      if (userAddress) { const t = await withTimeout(startClickTicket(id), 4000, 'Task start').catch(() => null); if (t) countdown(id, btnId); }
      tryAppSchemes(X_APP_URLS, a.href);
    });
    const TASK_BUTTONS = [[1, 'task-x'], [3, 'task-accumulator'], [4, 'task-keep']];
    function markTaskDone(buttonId) {
      const btn = document.getElementById(buttonId);
      if (btn) { btn.innerText = 'Completed'; btn.disabled = true; btn.style.opacity = '0.6'; }
    }
    async function claimOneTimeTask(taskId, buttonId) {
      if (!useV2) return uiAlert(LEGACY_MSG);
      const task = TASK_KEYS[taskId];
      if (!task) return uiAlert("This task can't be verified automatically yet, so it has no reward for now. Claim your daily free life meanwhile!");
      if (!signer || !userAddress) return uiAlert('Connect your wallet first (use the same wallet you used in that app).');
      const btn = document.getElementById(buttonId);
      if (CLICK_TASKS[taskId] && !clickTickets[ticketKey(taskId)]) {
        // First tap: open the link (synchronously, inside the tap, so popups/openUrl are allowed), then count down.
        const a = document.querySelector(`a[data-task="${taskId}"]`);
        if (a) a.click(); else startClickTicket(taskId).then(() => countdown(taskId, buttonId));
        if (btn) { btn.disabled = true; btn.innerText = 'Opening…'; }
        return;
      }
      if (CLICK_TASKS[taskId] && clickTickets[ticketKey(taskId)].readyAt > Date.now()) return countdown(taskId, buttonId);
      if (btn) { btn.disabled = true; btn.innerText = 'Checking…'; }
      try {
        if (await lbRead().grantUsed(userAddress, taskId)) { markTaskDone(buttonId); return uiAlert("You've already claimed this task with this wallet."); }
        const r = await withTimeout(fetch(ECONOMY.GRANT_API, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ player: userAddress, task, ticket: clickTickets[ticketKey(taskId)]?.ticket }) }), 20000, 'Task check');
        const g = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(g.error || `HTTP ${r.status}`);
        if (btn) btn.innerText = 'Confirm in wallet…';
        const livesBefore = BigInt(await lbRead().playerLives(userAddress));
        await sendAndConfirm([{ to: leaderboardAddress, data: lbIface().encodeFunctionData('claimLifeGrant', [g.amount, g.grantId, g.deadline, g.signature]) }],
          async () => BigInt(await lbRead().grantUsed(userAddress, taskId)), 'Claim task life');
        lives = Number(await lbRead().playerLives(userAddress));
        await updateTopBar();
        markTaskDone(buttonId);
        if (CLICK_TASKS[taskId]) delete clickTickets[ticketKey(taskId)];
        updateTaskHints();
        uiAlert(`✅ ${Number(BigInt(lives) - livesBefore) || 1} free life confirmed on-chain!`);
      } catch (e) {
        console.error('Task claim failed', e);
        if (/open the link|expired|invalid ticket/i.test(String(e?.message))) delete clickTickets[ticketKey(taskId)];
        if (btn) { btn.innerText = 'Claim Life'; btn.disabled = false; }
        uiAlert('❌ Free life NOT added (nothing was saved): ' + shortError(e));
      }
    }
    async function refreshTasksFromChain() {
      if (!useV2 || !provider || !userAddress) return;
      for (const [id, btnId] of TASK_BUTTONS) {
        try { if (await lbRead().grantUsed(userAddress, id)) { markTaskDone(btnId); if (CLICK_TASKS[id]) delete clickTickets[ticketKey(id)]; } } catch (e) {}
      }
      resumeClickTasks(); // e.g. back from X after a reload: "Claim life (ready in Ns)" / "Claim Life" + hint
      updateTaskHints();
    }
    // v5.11: outbound links. Normal browsers keep the link's own behaviour (new tab for follow links, same tab
    // for More apps). Inside a Base / Farcaster mini-app host, webviews block or trap these, so use the SDK.
    document.addEventListener('click', (ev) => {
      const a = ev.target.closest && ev.target.closest('a[data-ext]');
      if (!a || a.dataset.task || !window.__inMiniApp || !sdk?.actions) return; // task links: openOutsideGame
      const url = a.href;
      const openMini = sdk.actions.openMiniApp, openUrl = sdk.actions.openUrl;
      if (a.dataset.ext === 'miniapp' && typeof openMini === 'function') {
        ev.preventDefault();
        Promise.resolve().then(() => openMini({ url })).catch(() => (typeof openUrl === 'function' ? openUrl(url) : (location.href = url)));
      } else if (typeof openUrl === 'function') {
        ev.preventDefault();
        Promise.resolve().then(() => openUrl(url)).catch(() => { location.href = url; });
      }
    });

    // v4.64: wired here instead of inline onclick="" attributes (CSP-friendly)
    TASK_BUTTONS.forEach(([id, btnId]) => {
      const b = document.getElementById(btnId);
      if (b) b.addEventListener('click', () => claimOneTimeTask(id, btnId));
    });

    // v5.11: task completion now comes from the chain (grantUsed) after connect, not localStorage.
    function loadCompletedTasks() {}

    document.addEventListener('DOMContentLoaded', () => {
      loadCompletedTasks();
      updateDailyClaim();
      connectWallet(true); // v5.13: restore an already-authorised wallet without a prompt
    });
  