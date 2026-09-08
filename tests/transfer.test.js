const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastpay-test-'));
process.env.FASTPAY_DB = path.join(temp, 'test.sqlite');
const {Users, Transfers, sequelize, ready} = require('../models/db');
const {commitAccepted, transfer} = require('../controller/transfer_controller');
const envelope = id => ({transfer_id: id, from_user: 'alice', to_user: 'bob', amount_paise: 10000, nonce: 'n'.repeat(32)});
const verdict = {stage:'signature', reason:'verified', session_id:'test', evidence:{qber:0,chsh_s:2.83}};
async function balances() {
    return (await Users.findAll({where:{username:['alice','bob']},order:[['username','ASC']]})).map(u=>u.walletBalance);
}
after(async () => {await sequelize.close(); fs.rmSync(temp,{recursive:true,force:true});});

test('SQLite atomic debit, credit, history, rollback and concurrent funds guard', async () => {
    await ready;
    const before = await balances();
    await commitAccepted(envelope('honest'), verdict);
    assert.deepEqual(await balances(), [before[0]-10000,before[1]+10000]);
    assert.equal((await Transfers.findByPk('honest')).status,'ACCEPTED');
    // A real SQLite trigger fails AFTER debit and credit, when the history row is inserted.
    await sequelize.query("CREATE TRIGGER fail_history BEFORE INSERT ON transfers WHEN NEW.id = 'fault' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    const prior = await balances();
    await assert.rejects(commitAccepted(envelope('fault'),verdict));
    assert.deepEqual(await balances(),prior);
    assert.equal(await Transfers.findByPk('fault'),null);
    await Users.update({walletBalance:10000},{where:{username:'alice'}});
    const outcomes = await Promise.allSettled([commitAccepted(envelope('race1'),verdict),commitAccepted(envelope('race2'),verdict)]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await balances())[0],0);
});

test('insufficient balance is rejected before any gateway fetch', async () => {
    await ready;
    const original = global.fetch;
    let calls=0, status, body;
    global.fetch=async()=>{calls++; throw new Error('must not call');};
    try {
        const req={is:()=>true,get:()=>undefined,body:{to_user:'bob',amount_paise:900000000},user:{username:'alice'}};
        const res={status(code){status=code;return this;},json(value){body=value;return this;}};
        await transfer(req,res);
        assert.equal(status,409); assert.equal(calls,0); assert.match(body.reason,/Insufficient/);
    } finally {global.fetch=original;}
});
