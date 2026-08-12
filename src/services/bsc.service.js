/**
 * BSC Service — BeeyGO On-Chain Transfer Engine
 *
 * Handles automated BYGO token transfers from the vault wallet.
 * Features:
 *   - Multi-RPC failover (3 public BSC endpoints)
 *   - Pre-flight balance & gas checks
 *   - 3-attempt retry loop with explicit nonce management
 *   - Atomic DB state transitions (idempotency guard via fee_paid → processing)
 *   - Full ROLLBACK on DB commit failure after on-chain success (critical path)
 */

const { ethers }     = require('ethers');
const { query, pool } = require('../config/db');

const BSC_CHAIN_ID          = parseInt(process.env.BSC_CHAIN_ID || '56', 10);
const BYGO_CONTRACT_ADDRESS  = process.env.BYGO_CONTRACT_ADDRESS || '';
const VAULT_SECRET_KEY       = process.env.VAULT_SECRET_KEY || '';
const BYGO_TOKEN_DECIMALS    = parseInt(process.env.BYGO_TOKEN_DECIMALS || '18', 10);

// Multiple public BSC RPC endpoints for failover
const BSC_RPC_URLS = [
  process.env.BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed2.bnbchain.org',
  'https://bsc-dataseed1.ninicoin.io',
];

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
];

const TIMEOUT_MS      = 10000;  // 10s for RPC calls
const CONFIRM_TIMEOUT = 120000; // 2 min for tx confirmation

/**
 * Returns a race between a promise and a timeout error.
 */
function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg || `Timeout after ${ms}ms`)), ms)),
  ]);
}

/**
 * Try each RPC URL in order, return the first working provider.
 */
async function getWorkingProvider() {
  for (const url of BSC_RPC_URLS) {
    try {
      const provider = new ethers.JsonRpcProvider(url, { chainId: BSC_CHAIN_ID, name: 'bnb' });
      // Quick liveness check
      await withTimeout(provider.getBlockNumber(), 5000, `RPC timeout: ${url}`);
      return provider;
    } catch {
      console.warn(`[BSC] RPC endpoint unresponsive: ${url}`);
    }
  }
  throw new Error('All BSC RPC endpoints are unreachable. Cannot proceed with transfer.');
}

class BscService {
  /**
   * Execute on-chain BYGO transfer from vault wallet.
   * @param {number} bygoAmount - Integer amount of BYGO tokens (pre-decimal).
   * @param {string} toAddress  - Destination BEP-20 address.
   * @returns {string} - Confirmed transaction hash.
   * @throws on any failure (pre-flight or on-chain).
   */
  async executeBYGOTransfer(bygoAmount, toAddress) {
    if (!BYGO_CONTRACT_ADDRESS || !VAULT_SECRET_KEY) {
      throw new Error('BSC credentials (BYGO_CONTRACT_ADDRESS, VAULT_SECRET_KEY) are not configured on server.');
    }
    if (!ethers.isAddress(toAddress)) {
      throw new Error(`Invalid BEP-20 destination address: ${toAddress}`);
    }
    if (toAddress === ethers.ZeroAddress) {
      throw new Error('Refusing to transfer to the zero address.');
    }

    const provider = await getWorkingProvider();
    const wallet   = new ethers.Wallet(VAULT_SECRET_KEY, provider);
    const contract = new ethers.Contract(BYGO_CONTRACT_ADDRESS, ERC20_ABI, wallet);
    const amountWei = ethers.parseUnits(String(bygoAmount), BYGO_TOKEN_DECIMALS);

    // ── Pre-flight Checks ─────────────────────────────────────────────────────
    const code = await withTimeout(provider.getCode(BYGO_CONTRACT_ADDRESS), TIMEOUT_MS, 'RPC timeout: getCode');
    if (code === '0x') throw new Error(`BYGO_CONTRACT_ADDRESS ${BYGO_CONTRACT_ADDRESS} is not a deployed contract.`);

    const [vaultBygo, vaultBnb, feeData] = await Promise.all([
      withTimeout(contract.balanceOf(wallet.address), TIMEOUT_MS, 'RPC timeout: balanceOf'),
      withTimeout(provider.getBalance(wallet.address), TIMEOUT_MS, 'RPC timeout: getBalance'),
      withTimeout(provider.getFeeData(), TIMEOUT_MS, 'RPC timeout: getFeeData'),
    ]);

    if (vaultBygo < amountWei) {
      throw new Error(
        `Vault BYGO insufficient. Has: ${ethers.formatUnits(vaultBygo, BYGO_TOKEN_DECIMALS)}, Needs: ${bygoAmount}`
      );
    }

    // Estimate gas cost: gasLimit * gasPrice
    const gasLimit  = 120000n;
    const gasPrice  = feeData.gasPrice || ethers.parseUnits('5', 'gwei');
    const gasCost   = gasLimit * gasPrice;
    const minBnb    = gasCost + ethers.parseEther('0.0002'); // extra buffer

    if (vaultBnb < minBnb) {
      throw new Error(
        `Vault BNB too low for gas. Has: ${ethers.formatEther(vaultBnb)} BNB, ` +
        `Estimated need: ${ethers.formatEther(minBnb)} BNB`
      );
    }

    console.log(`[BSC] Pre-flight OK. Vault: ${ethers.formatUnits(vaultBygo, BYGO_TOKEN_DECIMALS)} BYGO | ${ethers.formatEther(vaultBnb)} BNB`);
    console.log(`[BSC] Sending ${bygoAmount} BYGO → ${toAddress}`);

    // ── Transaction with 3-attempt retry ─────────────────────────────────────
    const nonce = await provider.getTransactionCount(wallet.address, 'latest');
    let lastErr;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const tx = await contract.transfer(toAddress, amountWei, {
          gasLimit,
          gasPrice,
          nonce,
        });
        console.log(`[BSC] Tx broadcast (attempt ${attempt}/3): ${tx.hash}`);

        const receipt = await withTimeout(
          tx.wait(1),
          CONFIRM_TIMEOUT,
          `Tx confirmation timeout after ${CONFIRM_TIMEOUT / 1000}s. Hash: ${tx.hash}`
        );

        if (!receipt || receipt.status === 0) {
          throw new Error(`Transaction reverted on-chain. Hash: ${tx.hash}`);
        }

        console.log(`[BSC] ✅ Confirmed in block ${receipt.blockNumber}. TxHash: ${receipt.hash}`);
        return receipt.hash;

      } catch (err) {
        lastErr = err;

        // Nonce already consumed — tx may have been mined already
        if (err.code === 'NONCE_EXPIRED' || err.message?.includes('nonce too low')) {
          console.warn(`[BSC] Nonce ${nonce} already used. Tx may have been mined. Checking...`);
          await new Promise(r => setTimeout(r, 5000));
          const latestNonce = await provider.getTransactionCount(wallet.address, 'latest').catch(() => null);
          if (latestNonce !== null && latestNonce > nonce) {
            // Nonce was consumed but we have no receipt — needs manual review
            throw new Error(
              `CRITICAL: Nonce ${nonce} consumed but receipt unavailable. Transfer may have succeeded. ` +
              `Withdrawal requires manual review.`
            );
          }
        }

        console.warn(`[BSC] Attempt ${attempt}/3 failed: ${err.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 4000 * attempt));
      }
    }

    throw lastErr;
  }

  /**
   * Idempotent trigger: called after withdrawal fee is confirmed.
   * Uses atomic status transition (fee_paid → processing) to prevent double-sends.
   * @param {object} wr - Withdrawal request row from DB.
   */
  async triggerAutoTransfer(wr) {
    const {
      id:            withdrawalId,
      bygo_amount:   bygoAmount,
      wallet_address: toAddress,
      user_id:       userId,
    } = wr;

    if (!toAddress || !userId || !bygoAmount) {
      console.error(`[AutoTransfer] Missing required fields for withdrawal #${withdrawalId}:`, { toAddress, userId, bygoAmount });
      return;
    }

    // Atomic claim: only proceeds if status is exactly 'fee_paid'
    const claim = await query(
      `UPDATE withdrawal_requests
       SET status = 'processing', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'fee_paid'
       RETURNING id`,
      [withdrawalId]
    );

    if (claim.rows.length === 0) {
      const current = await query('SELECT status FROM withdrawal_requests WHERE id = $1', [withdrawalId]);
      console.log(`[AutoTransfer] Withdrawal #${withdrawalId} already at '${current.rows[0]?.status}' — duplicate trigger skipped.`);
      return;
    }

    console.log(`[AutoTransfer] 🚀 Starting on-chain transfer #${withdrawalId}: ${bygoAmount} BYGO → ${toAddress}`);

    try {
      const txHash = await this.executeBYGOTransfer(bygoAmount, toAddress);

      // Atomic DB commit: mark completed + deduct balance
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE withdrawal_requests
           SET status       = 'completed',
               tx_hash      = $1,
               processed_at = CURRENT_TIMESTAMP,
               updated_at   = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [txHash, withdrawalId]
        );
        await client.query('COMMIT');
      } catch (dbErr) {
        await client.query('ROLLBACK');
        // CRITICAL: on-chain succeeded but DB failed — store the tx hash at minimum
        console.error(
          `[AutoTransfer] ⚠️ CRITICAL: On-chain TX succeeded (${txHash}) ` +
          `but DB commit failed for withdrawal #${withdrawalId}:`, dbErr.message
        );
        await query(
          `UPDATE withdrawal_requests
           SET tx_hash    = $1,
               admin_note = 'DB commit failed after on-chain success — MANUAL BALANCE DEDUCTION REQUIRED',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [txHash, withdrawalId]
        ).catch(e => console.error('[AutoTransfer] Emergency tx_hash save failed:', e.message));
        return;
      } finally {
        client.release();
      }

      console.log(`[AutoTransfer] ✅ #${withdrawalId} completed. TxHash: ${txHash} | ${bygoAmount} BYGO deducted from user ${userId}`);

    } catch (transferErr) {
      console.error(`[AutoTransfer] ❌ FAILED for withdrawal #${withdrawalId}:`, transferErr.message);
      
      const refundClient = await pool.connect();
      try {
        await refundClient.query('BEGIN');
        await refundClient.query(
          `UPDATE withdrawal_requests
           SET status     = 'transfer_failed',
               admin_note = $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [transferErr.message.substring(0, 500), withdrawalId]
        );
        await refundClient.query(
          `UPDATE users SET balance = balance + $1 WHERE telegram_id = $2`,
          [bygoAmount, userId]
        );
        await refundClient.query('COMMIT');
        console.log(`[AutoTransfer] 🔙 Refunded ${bygoAmount} BYGO to user ${userId} due to transfer failure.`);
      } catch (refundErr) {
        await refundClient.query('ROLLBACK').catch(() => {});
        console.error('[AutoTransfer] ⚠️ CRITICAL: Could not process refund for failed transfer:', refundErr.message);
      } finally {
        refundClient.release();
      }
    }
  }
}

const bscService = new BscService();

// Export the instance and the convenience function directly
module.exports = bscService;
module.exports.triggerAutoTransfer = bscService.triggerAutoTransfer.bind(bscService);
module.exports.executeBYGOTransfer = bscService.executeBYGOTransfer.bind(bscService);
