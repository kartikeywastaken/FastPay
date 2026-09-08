// Acceptance against the four running localhost processes. Moves demo money.
const assert = require('node:assert/strict');
const base = process.env.FASTPAY_URL || 'http://127.0.0.1:3000';
const engine = process.env.QDS_ENGINE_URL || 'http://127.0.0.1:8000';
async function login(username) {
    const response = await fetch(base + '/login', {method:'POST',redirect:'manual',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({username,password:'demo-wallet-2026'})});
    assert.equal(response.status,302);
    return response.headers.getSetCookie()[0].split(';')[0];
}
async function main() {
    const alice=await login('alice'),bob=await login('bob');
    const balances=async()=>Promise.all([alice,bob].map(async cookie=>(await (await fetch(base+'/wallet',{headers:{cookie}})).json()).walletBalance));
    for(const [fraction,status,stage] of [[0,'ACCEPTED','committed'],[1,'REFUSED','quantum_channel'],[.1,'REFUSED','signature']]) {
        await fetch(engine+'/channel/attack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fraction})});
        const before=await balances();
        const response=await fetch(base+'/transfer',{method:'POST',headers:{cookie:alice,'Content-Type':'application/json'},body:JSON.stringify({to_user:'bob',amount_paise:10000,from_user:'bob'})});
        const result=await response.json();
        assert.equal(result.status,status,JSON.stringify(result)); assert.equal(result.stage,stage);
        assert.equal(result.transfer.from_user,'alice');
        assert.deepEqual(await balances(),fraction===0?[before[0]-10000,before[1]+10000]:before);
        const history=await(await fetch(base+'/transfers',{headers:{cookie:bob}})).json();
        assert.equal(history.transfers[0].id,result.transfer.id);
        assert.equal(history.transfers[0].reason,result.reason);
        console.log(JSON.stringify({fraction,status,stage,qber:result.transfer.qber,chsh_s:result.transfer.chsh_s,balances:await balances()}));
    }
    const beforeSession=(await(await fetch(engine+'/channel/latest')).json()).session_id;
    const insufficient=await fetch(base+'/transfer',{method:'POST',headers:{cookie:alice,'Content-Type':'application/json'},body:JSON.stringify({to_user:'bob',amount_paise:900000000})});
    assert.equal(insufficient.status,409);
    assert.equal((await(await fetch(engine+'/channel/latest')).json()).session_id,beforeSession);
    console.log('Insufficient balance: no gateway session created');
    await fetch(engine+'/channel/attack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fraction:0})});
}
main().catch(error=>{console.error(error);process.exitCode=1;});
