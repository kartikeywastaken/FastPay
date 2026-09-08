const Sequelize = require('sequelize');
const md5 = require('md5');


const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: process.env.FASTPAY_DB || './database.sqlite',
    logging: false
});

sequelize
    .authenticate()
    .then(() => {
        console.log('Connected to database!');
    })
    .catch((err) => {
        console.error('Unable to connect to SQLite database:', err);
    });


const Users = sequelize.define('users', {
    username: {type: Sequelize.STRING, unique: true},
    password: Sequelize.STRING,
    authToken_fp: Sequelize.STRING,
    jwt_token: Sequelize.STRING,
    walletBalance: Sequelize.INTEGER,
    paymentId: Sequelize.STRING
});

const Orders = sequelize.define('orders', {
    username: Sequelize.STRING,
    itemName: Sequelize.STRING
});

const MovieTickets = sequelize.define('movieTickets', {
    bookingReferenceId: Sequelize.STRING,
    movieName: Sequelize.STRING,
    username: Sequelize.STRING,
    ticketId: Sequelize.STRING
});

const FoodOrders = sequelize.define('foodOrders',{
    orderId: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    username: Sequelize.STRING,
    orderItem: Sequelize.STRING,
    amount: Sequelize.INTEGER,
    name: Sequelize.STRING,
    addressLine1: Sequelize.STRING,
    addressLine2: Sequelize.STRING,
    city: Sequelize.STRING,
    state: Sequelize.STRING,
    country: Sequelize.STRING,
    postalCode: Sequelize.STRING,
    paymentId: Sequelize.STRING,
    orderStatus: Sequelize.STRING
})

// Wallet amounts are integer paise, matching the existing Users balance unit.
const Transfers = sequelize.define('transfers', {
    id: {type: Sequelize.STRING, primaryKey: true},
    from_user: {type: Sequelize.STRING, allowNull: false},
    to_user: {type: Sequelize.STRING, allowNull: false},
    amount_paise: {type: Sequelize.INTEGER, allowNull: false},
    status: {type: Sequelize.STRING, allowNull: false, validate: {isIn: [['ACCEPTED', 'REFUSED']]}},
    stage: {type: Sequelize.STRING, allowNull: false, validate: {isIn: [['quantum_channel', 'signature', 'committed']]}},
    reason: {type: Sequelize.STRING, allowNull: false},
    session_id: Sequelize.STRING,
    qber: Sequelize.FLOAT,
    chsh_s: Sequelize.FLOAT,
    created_at: {type: Sequelize.DATE, defaultValue: Sequelize.NOW}
}, {timestamps: false});

const ready = (async () => {
    // Restarting the demo must never erase balances or transfer history.
    await sequelize.sync();
    for (const username of ['alice', 'bob']) {
        await Users.findOrCreate({where: {username}, defaults: {
            password: md5('demo-wallet-2026'), walletBalance: 100000,
            authToken_fp: require('node:crypto').randomBytes(32).toString('hex'), paymentId: 'demo'
        }});
    }
    await Users.findOrCreate({where: {username: 'charlie@fastpay.com'}, defaults: {
        password: md5('charliebravoalpha@secret'), walletBalance: 0, paymentId: 'test'
    }});
    await Orders.findOrCreate({where: {username: 'charlie@fastpay.com', itemName: 'white-polo'}});
    await MovieTickets.findOrCreate({where: {bookingReferenceId: 'BRID-SAMPLE'}, defaults: {
        movieName: 'SAMPLE MOVIE', username: 'charlie@fastpay.com', ticketId: 'TICKET-12123-12'
    }});
    await FoodOrders.findOrCreate({where: {orderId: 5545}, defaults: {
        username: 'charlie@fastpay.com', orderItem: 'burger', amount: 220, paymentId: 'test',
        orderStatus: 'Confirmed', name: 'charlie', addressLine1: 'demo', addressLine2: 'demo',
        city: 'demo', state: 'demo', country: 'demo', postalCode: '242001'
    }});
})();

module.exports = {Users, Orders, MovieTickets, FoodOrders, Transfers, sequelize, ready};
