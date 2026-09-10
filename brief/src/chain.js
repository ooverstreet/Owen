import { ApiPromise, WsProvider } from '@polkadot/api';
import { web3Accounts, web3Enable, web3FromAddress } from '@polkadot/extension-dapp';

const RPCS = [
  'wss://entrypoint-finney.opentensor.ai:443',
  'wss://lite.chain.opentensor.ai:443',
  'wss://lite.sub.latent.to:443',
  'wss://bittensor-finney.api.onfinality.io/public-ws'
];
const CONNECT_MS = 20000;
const REQUEST_MS = 30000;
const SEND_MS = 90000;
const DEAD = 'The public chain nodes timed out. Your TAO did not move. Wait a few seconds and tap Stake again.';
const SLOW = 'The chain is taking too long. If you already approved in the wallet, check your book before tapping Stake again. If you never saw a sign screen, nothing moved.';

let api = null;
let connecting = null;

export function hasInjected() {
  const inj = typeof window !== 'undefined' ? window.injectedWeb3 : null;
  return !!(inj && Object.keys(inj).length);
}

export function injectedNames() {
  const inj = typeof window !== 'undefined' ? window.injectedWeb3 : null;
  return inj ? Object.keys(inj) : [];
}

export function taoToRao(tao) {
  const n = Number(tao);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter an amount greater than zero.');
  const s = String(tao).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Amount must be a number.');
  const [w, f = ''] = s.split('.');
  const frac = (f + '000000000').slice(0, 9);
  return (BigInt(w || '0') * 1000000000n + BigInt(frac)).toString();
}

export async function connect(appName) {
  if (!hasInjected()) {
    throw new Error('No wallet in this browser. Install Talisman, Polkadot.js, or SubWallet — or paste a public address. On a phone, open this site inside Nova or SubWallet.');
  }
  const exts = await web3Enable(appName || 'Subnet Brief');
  if (!exts.length) {
    throw new Error('The wallet did not authorize this site. Approve Subnet Brief in the extension, then try again.');
  }
  const accounts = await web3Accounts();
  if (!accounts.length) {
    throw new Error('The wallet is connected but has no account. Create or import a Bittensor coldkey in the extension.');
  }
  return accounts.map(a => ({
    address: a.address,
    name: a.meta?.name || '',
    source: a.meta?.source || ''
  }));
}

function sleepReject(ms, msg) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms));
}

async function withTimeout(promise, ms, msg) {
  let t;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })
    ]);
  } finally {
    clearTimeout(t);
  }
}

async function connectOne(url) {
  const provider = new WsProvider(url, false, undefined, REQUEST_MS);
  let next = null;
  try {
    await Promise.race([
      provider.connect(),
      sleepReject(CONNECT_MS, 'RPC timeout')
    ]);
    next = await Promise.race([
      ApiPromise.create({ provider, noInitWarn: true }),
      sleepReject(CONNECT_MS, 'RPC timeout')
    ]);
    if (!next.isConnected) throw new Error('RPC dropped');
    return next;
  } catch (e) {
    try { if (next) await next.disconnect(); } catch {}
    try { await provider.disconnect(); } catch {}
    throw e;
  }
}

function firstSuccess(promises) {
  return new Promise((resolve, reject) => {
    let left = promises.length;
    let last = new Error(DEAD);
    if (!left) {
      reject(last);
      return;
    }
    promises.forEach(p => {
      p.then(resolve, err => {
        last = err;
        left -= 1;
        if (!left) reject(last);
      });
    });
  });
}

export async function ready() {
  return getApi();
}

async function getApi() {
  if (api && api.isConnected) return api;
  if (connecting) return connecting;
  connecting = (async () => {
    const pending = RPCS.map(url => connectOne(url));
    try {
      api = await firstSuccess(pending);
      pending.forEach(p => {
        p.then(inst => { if (inst !== api) inst.disconnect().catch(() => {}); }).catch(() => {});
      });
      return api;
    } catch {
      api = null;
      throw new Error(DEAD);
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

function moduleTx(apiInst) {
  return apiInst.tx.subtensorModule || apiInst.tx.SubtensorModule;
}

function stakeCall(apiInst, { hotkey, netuid, amountRao, limitPriceRao }) {
  const m = moduleTx(apiInst);
  if (!m) throw new Error('This node has no SubtensorModule. Wrong network.');
  if (m.addStakeLimit && limitPriceRao) {
    return m.addStakeLimit(hotkey, netuid, amountRao, limitPriceRao, false);
  }
  if (!m.addStake) throw new Error('This node cannot add_stake.');
  return m.addStake(hotkey, netuid, amountRao);
}

function unstakeCall(apiInst, { hotkey, netuid, amountRao, limitPriceRao }) {
  const m = moduleTx(apiInst);
  if (!m) throw new Error('This node has no SubtensorModule. Wrong network.');
  if (m.removeStakeLimit && limitPriceRao) {
    return m.removeStakeLimit(hotkey, netuid, amountRao, limitPriceRao, false);
  }
  if (!m.removeStake) throw new Error('This node cannot remove_stake.');
  return m.removeStake(hotkey, netuid, amountRao);
}

async function signSend(address, tx) {
  const injector = await web3FromAddress(address);
  return new Promise((resolve, reject) => {
    let unsub = null;
    tx.signAndSend(address, { signer: injector.signer }, result => {
      if (result.status.hasIndex && result.status.isInBlock) {
        const failed = result.dispatchError;
        if (failed) {
          let msg = 'The chain rejected this extra.';
          if (failed.isModule && api) {
            const meta = api.registry.findMetaError(failed.asModule);
            msg = meta.section + '.' + meta.name;
          }
          unsub && unsub();
          reject(new Error(msg));
          return;
        }
        const hash = result.status.asInBlock.toHex();
        unsub && unsub();
        resolve({ hash, inBlock: true });
      } else if (result.status.isFinalized) {
        unsub && unsub();
        resolve({ hash: result.status.asFinalized.toHex(), inBlock: true });
      } else if (result.isError) {
        unsub && unsub();
        reject(new Error('The extra failed to send.'));
      }
    }).then(fn => { unsub = fn; }).catch(reject);
  });
}

export async function addStake({ address, hotkey, netuid, amountTao, limitPriceRao }) {
  const amountRao = taoToRao(amountTao);
  if (BigInt(amountRao) < 2000000n) throw new Error('Minimum stake is 0.002 TAO.');
  const apiInst = await getApi();
  const tx = stakeCall(apiInst, { hotkey, netuid: Number(netuid), amountRao, limitPriceRao });
  return withTimeout(signSend(address, tx), SEND_MS, SLOW);
}

export async function removeStake({ address, hotkey, netuid, amountTao, limitPriceRao }) {
  const amountRao = taoToRao(amountTao);
  if (BigInt(amountRao) < 2000000n) throw new Error('Minimum unstake is 0.002 TAO.');
  const apiInst = await getApi();
  const tx = unstakeCall(apiInst, { hotkey, netuid: Number(netuid), amountRao, limitPriceRao });
  return withTimeout(signSend(address, tx), SEND_MS, SLOW);
}

export async function priceRao(tao) {
  return taoToRao(tao);
}
