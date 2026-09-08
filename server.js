var express = require('express')
var app = express()
require('dotenv').config();
// Fresh per-process demo signing secret if no private local value is configured.
process.env.JWT_SECRET ||= require('node:crypto').randomBytes(32).toString('hex');
const {router} = require('./routes/app');
const {ready} = require('./models/db');
const cookieParser = require('cookie-parser');

app.use((err, req, res, next) => {
    console.error(err.stack)
    res.status(500).send('Something broke!')
})

app.use(cookieParser());
app.set('view engine', 'ejs');
app.use(express.static('./assets'));
app.use(express.urlencoded({extended: true}));
app.use(express.json())
app.use(router);

const port = Number(process.env.PORT || 3000);
ready.then(() => app.listen(port, '127.0.0.1', () => {
    console.log(`FastPay local demo listening on ${port}; quantum results simulated`);
})).catch(() => { console.error('Database initialization failed'); process.exitCode = 1; });
