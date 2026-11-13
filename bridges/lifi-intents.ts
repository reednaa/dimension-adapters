import ADDRESSES from "../helpers/coreAssets.json";
import { evmToTronAddress } from "@defillama/sdk/build/generalUtil";
import { FetchOptions, SimpleAdapter } from "../adapters/types";
import { CHAIN } from "../helpers/chains";
import { base58Encode } from "../helpers/solana";
import { httpGet } from "../utils/fetchURL";

// LI.FI Intents. A user opens an Intent on the origin chain's InputSettlerEscrow (Open: the input tokens leave the chain) and a
// solver fills each output on its destination chain's OutputSettler (OutputFilled: output.token and finalAmount arrive).
// The contracts share one address on every EVM chain, Tron has its own: https://order.li.fi/api/v1/contracts
const EVM_SETTLERS = { input: "0x00fC00edbe7C003b006f870068c548940000223e", output: "0x75220B7600c300005038432a0000f308e0000068" };
const TRON_SETTLERS = { input: "TRV3PsTLRiWpY6sWi5UAvB7Tacb2FLtCNq", output: "TLwJhhq7fExHWdJQfMnsSY7VcreipmhLRm" };
const OUTPUT = "(bytes32 oracle, bytes32 settler, uint256 chainId, bytes32 token, uint256 amount, bytes32 recipient, bytes callbackData, bytes context)";
const OPEN = `event Open(bytes32 indexed orderId, (address user, uint256 nonce, uint256 originChainId, uint32 expires, uint32 fillDeadline, address inputOracle, uint256[2][] inputs, ${OUTPUT}[] outputs) order)`;
const OUTPUT_FILLED = `event OutputFilled(bytes32 indexed orderId, bytes32 solver, uint32 timestamp, ${OUTPUT} output, uint256 finalAmount)`;

// bytes32 token -> address; anything wider than 20 bytes is not a token on these chains
const tokenOf = (bytes32: string) => /^0x0{24}/.test(bytes32) ? "0x" + bytes32.slice(26).toLowerCase() : null;

type Output = { oracle: string; settler: string; chainId: bigint; token: string };
type OpenLog = { order: { originChainId: bigint; inputs: [bigint, bigint][]; outputs: Output[] } };
type OutputFilledLog = { output: Output; finalAmount: bigint };

// Solana has no logs to read, so its Intents come from the LI.FI Intents API: GET /orders with a time window [from, to)
// lists every order with an indexed open or fill in it, once per window, newest first and paged by cursor.
// https://order.li.fi/docs
const ORDERS_API = "https://order.li.fi/orders";
const SOLANA_CHAIN_ID = "1151111081099710";
// the API names native SOL by the zero pubkey; prices know it as the wSOL mint
const solanaToken = (mint: string) => mint === "11111111111111111111111111111111" ? ADDRESSES.solana.SOL : mint;

type ApiOutput = { chainId: string; token: string; amount: string };
type ApiOrder = { originChainId: string; inputs: [string, string][]; outputs: ApiOutput[] };

const windowOrders = async (options: FetchOptions, filter: Record<string, string>): Promise<ApiOrder[]> => {
  const orders: ApiOrder[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ ...filter, from: String(options.startTimestamp), to: String(options.endTimestamp), limit: "500" });
    if (cursor) query.set("cursor", cursor);
    const { data, meta } = await httpGet(`${ORDERS_API}?${query}`);
    for (const { order } of data) orders.push(order);
    cursor = meta.nextCursor;
  } while (cursor);
  return orders;
};

const fetchSolana = async (options: FetchOptions) => {
  const dailyOutgoingVolume = options.createBalances();
  const dailyIncomingVolume = options.createBalances();
  let dailyOutgoingTxCount = 0;
  let dailyIncomingTxCount = 0;

  // status Open: orders whose open is in the window, whatever their status is now
  for (const order of await windowOrders(options, { originChainId: SOLANA_CHAIN_ID, status: "Open" })) {
    if (order.outputs.every((output) => output.chainId === order.originChainId)) continue;
    for (const [mint, amount] of order.inputs) dailyOutgoingVolume.add(solanaToken(mint), amount);
    dailyOutgoingTxCount++;
  }
  // status Delivered: orders with an output filled in the window. destinationChainId matches the first output only, and the
  // API does not say which output was filled or for how much, so each Solana output counts its signed amount; only
  // Dutch-auction outputs (context types 0x01 and 0xe1) fill a different amount.
  for (const order of await windowOrders(options, { destinationChainId: SOLANA_CHAIN_ID, status: "Delivered" })) {
    if (order.originChainId === SOLANA_CHAIN_ID) continue;
    for (const output of order.outputs) {
      if (output.chainId !== SOLANA_CHAIN_ID) continue;
      dailyIncomingVolume.add(solanaToken(base58Encode(Buffer.from(output.token.slice(2), "hex"))), output.amount);
      dailyIncomingTxCount++;
    }
  }

  return { dailyOutgoingVolume, dailyIncomingVolume, dailyOutgoingTxCount, dailyIncomingTxCount };
};

const fetch = async (options: FetchOptions) => {
  if (options.chain === CHAIN.SOLANA) return fetchSolana(options);
  const isTron = options.chain === CHAIN.TRON;
  const settlers = isTron ? TRON_SETTLERS : EVM_SETTLERS;
  // tron prices are keyed by base58, the zero address stays native
  const priced = (address: string) => isTron && !/^0x0{40}$/.test(address) ? evmToTronAddress(address) : address;
  const dailyOutgoingVolume = options.createBalances();
  const dailyIncomingVolume = options.createBalances();
  const opened: OpenLog[] = await options.getLogs({ target: settlers.input, eventAbi: OPEN });
  const filled: OutputFilledLog[] = await options.getLogs({ target: settlers.output, eventAbi: OUTPUT_FILLED });

  let dailyOutgoingTxCount = 0;
  let dailyIncomingTxCount = 0;
  for (const { order } of opened) {
    // an Intent with every output on its origin chain is a swap, not a transfer between chains
    if (order.outputs.every((output) => output.chainId === order.originChainId)) continue;
    // inputs are [tokenId, amount]; for the escrow the tokenId is the token address as a uint256
    for (const [tokenId, amount] of order.inputs) dailyOutgoingVolume.add(priced("0x" + tokenId.toString(16).padStart(40, "0")), amount);
    dailyOutgoingTxCount++;
  }
  for (const { output, finalAmount } of filled) {
    // a same-chain swap is verified by the OutputSettler itself, so its output names its own settler as the oracle
    if (output.oracle.toLowerCase() === output.settler.toLowerCase()) continue;
    const token = tokenOf(output.token);
    if (!token) continue;
    dailyIncomingVolume.add(priced(token), finalAmount);
    dailyIncomingTxCount++;
  }

  return { dailyOutgoingVolume, dailyIncomingVolume, dailyOutgoingTxCount, dailyIncomingTxCount };
};

// First day each chain had an Intent on the settlers above, which every EVM chain uses since 2026-08-06 and Tron since
// 2026-09-09. The API also lists Intents on older settlers, so Solana starts with the EVM chains.
const START: Record<string, string> = {
  [CHAIN.ETHEREUM]: "2026-08-06", [CHAIN.BASE]: "2026-08-06", [CHAIN.OPTIMISM]: "2026-08-06", [CHAIN.ARBITRUM]: "2026-08-06",
  [CHAIN.POLYGON]: "2026-08-06", [CHAIN.BSC]: "2026-08-06", [CHAIN.ROBINHOOD]: "2026-08-06", [CHAIN.PHAROS]: "2026-08-06",
  [CHAIN.STABLE]: "2026-08-12", [CHAIN.MONAD]: "2026-08-18", [CHAIN.AVAX]: "2026-08-24", [CHAIN.UNICHAIN]: "2026-08-24",
  [CHAIN.HYPERLIQUID]: "2026-08-24", [CHAIN.PLASMA]: "2026-09-01", [CHAIN.TRON]: "2026-09-09", [CHAIN.ARC]: "2026-09-10",
  [CHAIN.WC]: "2026-09-11", [CHAIN.INK]: "2026-09-12", [CHAIN.ELYSIUM]: "2026-11-05", [CHAIN.SOLANA]: "2026-08-06",
};

const adapter: SimpleAdapter = {
  version: 2,
  pullHourly: true,
  adapter: Object.fromEntries(Object.entries(START).map(([chain, start]) => [chain, { fetch, start }])),
  methodology: {
    OutgoingVolume: "Value of the input tokens of LI.FI Intents opened on each chain with at least one output on another chain. Intents that are refunded later stay counted; same-chain swaps are excluded. EVM and Tron are read from the input settler's Open events, Solana from the LI.FI Intents API.",
    IncomingVolume: "Value of the tokens solvers delivered to recipients on each chain for LI.FI Intents opened on another chain, counted when the output is filled on-chain, whatever happens to the Intent on its origin chain later. Unfilled outputs add no incoming volume. EVM and Tron are read from the output settler's OutputFilled events, Solana from the LI.FI Intents API.",
    OutgoingTxCount: "Number of LI.FI Intents opened on each chain with at least one output on another chain.",
    IncomingTxCount: "Number of LI.FI Intent outputs filled on each chain for Intents opened on another chain.",
  },
};

export default adapter;
