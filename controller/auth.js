const jwt = require('jsonwebtoken');;
const { Users } = require('../models/db')
const md5 = require('md5');

function generateAccessToken(username) {
    const payload = { 'username': username };
    return jwt.sign(payload, process.env['JWT_SECRET']);
}

function authenticateToken(req, res, next) {
    const authToken_fp = req.cookies.authToken_fp || 'notauthenticated'
    if (authToken_fp == 'notauthenticated'){
        return res.redirect('/login')
    }
    Users.findOne({ attributes: ['id', 'username', 'jwt_token','walletBalance'], where: { authToken_fp: authToken_fp } })
        .then((queryResult) => {
            if (queryResult == null) {
                return res.redirect('/login');
            } else {
                req.user = queryResult;
                next();
            }
        });
}

const register_post = (req, res) => {
    const username = req.body.username
    const password = req.body.password
    Users.findAll({ where: { username: username } })
        .then((count) => {
            if (count.length != 0) {
                res.render('register', { msg: "User Already Registerd" })
            } else {
                if (username !== '' || password !== '') {
                    const jwt_token = generateAccessToken(username);
                    const authToken_fp = md5(jwt_token + "addFingerPrint")
                    Users.create({ username: username, password: md5(password), authToken_fp: authToken_fp, jwt_token: jwt_token, walletBalance: 0});
                    res.cookie('authToken_fp', authToken_fp, {domain: req.hostname, httpOnly: true});
                    res.redirect('/');
                } else {
                    res.render('register', { "msg": "Username or password cannot be blank" })
                }
            }
        });
}


const login = (req, res) => {
    res.render('login')
}

const register = (req, res) => {
    res.render('register')
}

const login_post = (req, res) => {
    const username = req.body.username;
    const password = req.body.password;
    if (username !== '' & password !== '') {
        Users.findOne({ where: { username: username, password: md5(password) } })
            .then((user) => {
                if (user) {
                    const jwt_token = generateAccessToken(username, user.username)
                    const authToken_fp = md5(jwt_token + "addFingerPrint")
                    Users.update({ jwt_token: jwt_token, authToken_fp: authToken_fp }, { where: { username: username } }).then(() => {
                        res.cookie('authToken_fp', authToken_fp, {httpOnly: true, sameSite: 'lax'});
                        res.redirect('/');
                    });
                } else {
                    res.render('login', { msg: "Invalid username/password" });
                }
            });
    } else {
        res.status(400).json({ "status": "failed", "message": "Invalid username or password" });
    }
}

module.exports = {
    login,
    login_post,
    register,
    register_post,
    authenticateToken
}
