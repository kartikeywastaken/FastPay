'use strict';
/**
 * RSA Attack Demo Controller — Project Bellwatch
 * -----------------------------------------------
 * GET  /api/rsa-keys       — Alice's public key (N, e) as seen on the wire by Eve
 * POST /api/rsa-transfer   — accepts RSA-signed forged payload, verifies math, moves funds
 *
 * Verification: modPow(sig, e, N) === sha256(message) mod N
 * If valid → transfer executes. No JWT. No session. Just math.
 */

const crypto = require('node:crypto');
const { Users, Transfers, sequelize } = require('../models/db');

// BigInt modular exponentiation
function modPow(base, exp, mod) {
  if (mod === 1n) return 0n;
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp = exp / 2n;
    base = (base * base) % mod;
  }
  return result;
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function messageToInt(message, N) {
  return BigInt('0x' + sha256Hex(message)) % N;
}

// GET /api/rsa-keys
async function getPublicKeys(req, res) {
  try {
    const alice = await Users.findOne({ where: { username: 'alice' } });
    if (!alice || !alice.rsaPublicN) {
      return res.status(503).json({ error: 'RSA keys not initialised. Restart FastPay.' });
    }
    res.json({
      username: 'alice',
      N: alice.rsaPublicN,
      e: alice.rsaPublicE,
      note: 'Public key visible to any network observer'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/rsa-transfer
// Body: { from, to, amount_paise, message, signature }
async function rsaTransfer(req, res) {
  const { from = 'alice', to = 'eve', amount_paise, message, signature } = req.body || {};
  if (!amount_paise || !message || !signature) {
    return res.status(400).json({ error: 'amount_paise, message, and signature required.' });
  }
  try {
    const alice = await Users.findOne({ where: { username: from } });
    if (!alice || !alice.rsaPublicN) {
      return res.status(404).json({ error: `No RSA key for user "${from}".` });
    }
    const N   = BigInt(alice.rsaPublicN);
    const e   = BigInt(alice.rsaPublicE);
    const sig = BigInt('0x' + signature);

    const recovered = modPow(sig, e, N);
    const expected  = messageToInt(message, N);

    if (recovered !== expected) {
      return res.status(403).json({
        verified: false,
        gateway: 'REJECTED',
        reason:  'Signature mismatch — not valid.',
        recovered: recovered.toString(),
        expected:  expected.toString()
      });
    }

    // Signature valid — execute transfer
    const result = await sequelize.transaction(async (t) => {
      const sender = await Users.findOne({ where: { username: from }, lock: true, transaction: t });
      let receiver = await Users.findOne({ where: { username: to  }, lock: true, transaction: t });

      if (!receiver) {
        receiver = await Users.create({
          username: to, password: 'n/a', walletBalance: 0, paymentId: 'eve-demo'
        }, { transaction: t });
      }

      if (sender.walletBalance < amount_paise) throw new Error('Insufficient balance');

      const newAlice = sender.walletBalance - amount_paise;
      const newEve   = receiver.walletBalance + amount_paise;
      await sender.update(  { walletBalance: newAlice }, { transaction: t });
      await receiver.update({ walletBalance: newEve   }, { transaction: t });

      const tid = crypto.randomBytes(8).toString('hex');
      await Transfers.create({
        id: tid, from_user: from, to_user: to,
        amount_paise, status: 'ACCEPTED', stage: 'committed',
        reason: 'RSA forged transfer — key cracked by Eve', session_id: null, qber: null, chsh_s: null
      }, { transaction: t });

      return { tid, newAlice, newEve };
    });

    res.json({
      verified: true, gateway: 'ACCEPTED', status: '200 OK',
      note: 'Signature mathematically valid. Alice has no idea.',
      transfer_id: result.tid,
      alice_balance_inr: (result.newAlice / 100).toFixed(2),
      eve_balance_inr:   (result.newEve   / 100).toFixed(2)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/alice-balance — live balance for the HUD
async function aliceBalance(req, res) {
  try {
    const alice = await Users.findOne({ where: { username: 'alice' } });
    const eve   = await Users.findOne({ where: { username: 'eve'   } });
    res.json({
      alice_inr: alice ? (alice.walletBalance / 100).toFixed(2) : '?',
      eve_inr:   eve   ? (eve.walletBalance   / 100).toFixed(2) : '0.00'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { getPublicKeys, rsaTransfer, aliceBalance };
