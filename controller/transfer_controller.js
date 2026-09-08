// Local wallet authorization demonstration; E91 evidence is simulated on Qiskit Aer.
const crypto = require('node:crypto');
const {Op, Transaction, literal} = require('sequelize');
const {Users, Transfers, sequelize} = require('../models/db');
const aliceUrl = process.env.ALICE_GATEWAY_URL || 'http://127.0.0.1:8001';
const engineUrl = process.env.QDS_ENGINE_URL || 'http://127.0.0.1:8000';

// Serialize SQLite write transactions in this single Node process. Conditional
// SQL updates also protect against balances changing while HTTP was in flight.
let writes = Promise.resolve();
function writeSerial(fn) {
    const result = writes.then(fn);
    writes = result.catch(() => {});
    return result;
}

function rowFor(envelope, verdict) {
    return {id: envelope.transfer_id, from_user: envelope.from_user, to_user: envelope.to_user,
        amount_paise: envelope.amount_paise, status: 'REFUSED', stage: verdict.stage,
        reason: verdict.reason, session_id: verdict.session_id || null,
        qber: verdict.evidence?.qber ?? null, chsh_s: verdict.evidence?.chsh_s ?? null};
}

async function commitAccepted(envelope, verdict) {
    return writeSerial(() => sequelize.transaction({type: Transaction.TYPES.IMMEDIATE}, async transaction => {
        const amount = envelope.amount_paise;
        if (!Number.isSafeInteger(amount) || amount <= 0 || envelope.from_user === envelope.to_user) {
            throw new Error('Invalid transfer');
        }
        const [debits] = await Users.update({walletBalance: literal(`walletBalance - ${amount}`)}, {
            where: {username: envelope.from_user, walletBalance: {[Op.gte]: amount}}, transaction});
        if (debits !== 1) throw new Error('Insufficient balance; payment was not committed.');
        const [credits] = await Users.update({walletBalance: literal(`walletBalance + ${amount}`)}, {
            where: {username: envelope.to_user, walletBalance: {[Op.lte]: Number.MAX_SAFE_INTEGER - amount}}, transaction});
        if (credits !== 1) throw new Error('Recipient unavailable; payment was not committed.');
        return Transfers.create({...rowFor(envelope, verdict), status: 'ACCEPTED', stage: 'committed',
            reason: 'Both gateways verified the simulated channel MAC. Wallet transfer committed.'}, {transaction});
    }));
}

async function publish(envelope, row) {
    try {
        await fetch(engineUrl + '/channel/payment', {method: 'POST',
            headers: {'Content-Type': 'application/json'}, signal: AbortSignal.timeout(1500),
            body: JSON.stringify({envelope, session_id: row.session_id,
                status: row.status.toLowerCase(), stage: row.stage, reason: row.reason})});
    } catch (_) { /* A display outage cannot undo or authorize a wallet transfer. */ }
}

async function transfer(req, res) {
    if (!req.is('application/json')) return res.status(415).json({reason: 'Use a JSON wallet request.'});
    if (req.get('origin') && req.get('origin') !== `${req.protocol}://${req.get('host')}`) {
        return res.status(403).json({reason: 'Cross-origin wallet requests are refused.'});
    }
    const amount = req.body.amount_paise;
    const recipient = req.body.to_user;
    if (!Number.isSafeInteger(amount) || amount <= 0 || typeof recipient !== 'string' ||
        recipient === req.user.username || recipient.length > 100) {
        return res.status(400).json({reason: 'Choose a different recipient and a positive integer amount in paise.'});
    }
    try {
        const sender = await Users.findOne({where: {username: req.user.username}});
        const receiver = await Users.findOne({where: {username: recipient}});
        if (!receiver) return res.status(404).json({reason: 'Recipient not found.'});
        if (!sender || sender.walletBalance < amount) {
            return res.status(409).json({reason: 'Insufficient balance. Gateway was not called.'});
        }
        const envelope = {transfer_id: crypto.randomUUID(), from_user: req.user.username,
            to_user: recipient, amount_paise: amount, nonce: crypto.randomBytes(24).toString('hex')};
        let verdict = {status: 'refused', stage: 'quantum_channel', session_id: null,
            reason: 'Alice gateway unavailable. Payment refused.', evidence: {}};
        try {
            const response = await fetch(aliceUrl + '/gate/authorise', {method: 'POST',
                headers: {'Content-Type': 'application/json'}, signal: AbortSignal.timeout(25000),
                body: JSON.stringify({envelope})});
            if (!response.ok) throw new Error('Gateway refused');
            const value = await response.json();
            if (!['accepted', 'refused'].includes(value.status) || !['signature', 'quantum_channel'].includes(value.stage) ||
                typeof value.reason !== 'string' || value.reason.length > 600 ||
                (value.status === 'accepted' && (value.stage !== 'signature' ||
                !/^[0-9a-f]{64}$/.test(value.mac) || value.evidence?.aborted !== false || value.evidence?.keys_match !== true))) {
                throw new Error('Invalid gateway response');
            }
            verdict = value;
        } catch (_) { /* Keep the fail-closed verdict; no secrets in error output. */ }
        let row;
        if (verdict.status === 'accepted') {
            try {
                row = await commitAccepted(envelope, verdict);
            } catch (_) {
                verdict = {...verdict, status: 'refused', stage: 'signature',
                    reason: 'Wallet commit refused: balances changed or storage failed. No balance changes were committed.'};
            }
        }
        if (!row) row = await writeSerial(() => Transfers.create(rowFor(envelope, verdict)));
        await publish(envelope, row);
        return res.status(row.status === 'ACCEPTED' ? 200 : 409).json({
            status: row.status, stage: row.stage, reason: row.reason, transfer: row, simulated: true});
    } catch (_) {
        return res.status(503).json({status: 'REFUSED', reason: 'Wallet storage unavailable. Transfer could not be recorded.'});
    }
}

async function list(req, res) {
    const rows = await Transfers.findAll({where: {[Op.or]: [{from_user: req.user.username}, {to_user: req.user.username}]},
        order: [['created_at', 'DESC']], limit: 100});
    return res.json({transfers: rows, simulated: true});
}

async function wallet(req, res) {
    const user = await Users.findOne({attributes: ['username', 'walletBalance'], where: {username: req.user.username}});
    return res.json(user);
}

module.exports = {transfer, list, wallet, commitAccepted};
