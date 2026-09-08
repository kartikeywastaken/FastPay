'use strict';
const Sequelize = require('sequelize');
const md5 = require('md5');
const crypto = require('node:crypto');

const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: process.env.FASTPAY_DB || './database.sqlite',
    logging: false
});

sequelize.authenticate()
    .then(() => console.log('Connected to database!'))
    .catch(err => console.error('Unable to connect to SQLite:', err));

// ── RSA helpers (BigInt, 64-bit key size) ─────────────────────────────────────
function isPrime(n) {
  if (n < 2n) return false;
  if (n === 2n || n === 3n) return true;
  if (n % 2n === 0n || n % 3n === 0n) return false;
  for (let i = 5n; i * i <= n; i += 6n) {
    if (n % i === 0n || n % (i + 2n) === 0n) return false;
  }
  return true;
}

function randomPrime32() {
  // Generate a random 32-bit odd number and scan upward for a prime
  const buf = crypto.randomBytes(4);
  let n = BigInt('0x' + buf.toString('hex')) | 1n; // ensure odd
  n = n | (1n << 31n); // ensure high bit set (roughly 32-bit)
  while (!isPrime(n)) n += 2n;
  return n;
}

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

function modInverseBigInt(e, phi) {
  let [old_r, r] = [e, phi];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % phi) + phi) % phi;
}

function generate64BitRSA() {
  let p, q, N, phi, d;
  const e = 65537n;
  do {
    p = randomPrime32();
    q = randomPrime32();
    if (p === q) continue;
    N   = p * q;
    phi = (p - 1n) * (q - 1n);
    // e must be coprime to phi
    function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
    if (gcd(e, phi) !== 1n) continue;
    d = modInverseBigInt(e, phi);
  } while (d === e); // very unlikely but guard
  return { N: N.toString(), e: e.toString(), d: d.toString(), p: p.toString(), q: q.toString() };
}

// ── Models ────────────────────────────────────────────────────────────────────
const Users = sequelize.define('users', {
    username:     { type: Sequelize.STRING, unique: true },
    password:     Sequelize.STRING,
    authToken_fp: Sequelize.STRING,
    jwt_token:    Sequelize.STRING,
    walletBalance:Sequelize.INTEGER,
    paymentId:    Sequelize.STRING,
    // 64-bit RSA keypair (stored as decimal strings for BigInt compat)
    rsaPublicN:   Sequelize.STRING,   // N = p*q
    rsaPublicE:   Sequelize.STRING,   // e = 65537
    rsaPrivateD:  Sequelize.STRING,   // d = e^-1 mod phi(N)
});

const Orders = sequelize.define('orders', {
    username: Sequelize.STRING,
    itemName: Sequelize.STRING,
});

const MovieTickets = sequelize.define('movieTickets', {
    bookingReferenceId: Sequelize.STRING,
    movieName: Sequelize.STRING,
    username: Sequelize.STRING,
    ticketId: Sequelize.STRING,
});

const FoodOrders = sequelize.define('foodOrders', {
    orderId:      { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    username:     Sequelize.STRING,
    orderItem:    Sequelize.STRING,
    amount:       Sequelize.INTEGER,
    name:         Sequelize.STRING,
    addressLine1: Sequelize.STRING,
    addressLine2: Sequelize.STRING,
    city:         Sequelize.STRING,
    state:        Sequelize.STRING,
    country:      Sequelize.STRING,
    postalCode:   Sequelize.STRING,
    paymentId:    Sequelize.STRING,
    orderStatus:  Sequelize.STRING,
});

const Transfers = sequelize.define('transfers', {
    id:           { type: Sequelize.STRING, primaryKey: true },
    from_user:    { type: Sequelize.STRING, allowNull: false },
    to_user:      { type: Sequelize.STRING, allowNull: false },
    amount_paise: { type: Sequelize.INTEGER, allowNull: false },
    status:       { type: Sequelize.STRING, allowNull: false, validate: { isIn: [['ACCEPTED', 'REFUSED']] } },
    stage:        { type: Sequelize.STRING, allowNull: false, validate: { isIn: [['quantum_channel', 'signature', 'committed']] } },
    reason:       { type: Sequelize.STRING, allowNull: false },
    session_id:   Sequelize.STRING,
    qber:         Sequelize.FLOAT,
    chsh_s:       Sequelize.FLOAT,
    created_at:   { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
}, { timestamps: false });

// ── Seed ──────────────────────────────────────────────────────────────────────
const ready = (async () => {
    await sequelize.sync({ alter: true }); // alter:true adds new columns without dropping data

    for (const username of ['alice', 'bob']) {
        const [user, created] = await Users.findOrCreate({ where: { username }, defaults: {
            password: md5('demo-wallet-2026'),
            walletBalance: 1000000, // ₹10,000
            authToken_fp: crypto.randomBytes(32).toString('hex'),
            paymentId: 'demo'
        }});
        // Generate RSA keys if not already set
        if (!user.rsaPublicN) {
            const keys = generate64BitRSA();
            await user.update({ rsaPublicN: keys.N, rsaPublicE: keys.e, rsaPrivateD: keys.d });
            console.log(`[RSA] Generated 64-bit RSA key for ${username}: N=${keys.N.slice(0,12)}...`);
        }
    }

    // Eve — the attacker wallet (starts empty)
    await Users.findOrCreate({ where: { username: 'eve' }, defaults: {
        password: md5('eve-hacker'), walletBalance: 0, paymentId: 'eve-demo'
    }});

    // Legacy demo fixtures
    await Users.findOrCreate({ where: { username: 'charlie@fastpay.com' }, defaults: {
        password: md5('charliebravoalpha@secret'), walletBalance: 0, paymentId: 'test'
    }});
    await Orders.findOrCreate({ where: { username: 'charlie@fastpay.com', itemName: 'white-polo' }});
    await MovieTickets.findOrCreate({ where: { bookingReferenceId: 'BRID-SAMPLE' }, defaults: {
        movieName: 'SAMPLE MOVIE', username: 'charlie@fastpay.com', ticketId: 'TICKET-12123-12'
    }});
    await FoodOrders.findOrCreate({ where: { orderId: 5545 }, defaults: {
        username: 'charlie@fastpay.com', orderItem: 'burger', amount: 220, paymentId: 'test',
        orderStatus: 'Confirmed', name: 'charlie', addressLine1: 'demo', addressLine2: 'demo',
        city: 'demo', state: 'demo', country: 'demo', postalCode: '242001'
    }});
})();

module.exports = { Users, Orders, MovieTickets, FoodOrders, Transfers, sequelize, ready };
