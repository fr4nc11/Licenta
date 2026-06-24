const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: 'secret-licenta-2026', resave: false, saveUninitialized: false }));
app.use(express.static('.'));

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: 'francesco.ciobanu@gmail.com', pass: 'mdeoipqawbjhguaw' }
});

const db = new sqlite3.Database('./database.sqlite');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT UNIQUE, password TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, created_by TEXT)`);
});

app.post('/api/register-step1', async (req, res) => {
    const { username, email, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? OR email = ?`, [username, email], async (err, row) => {
        if (row) return res.status(400).json({ error: "Utilizator sau email existent." });
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const hash = await bcrypt.hash(password, 10);
        req.session.pendingUser = { username, email, password: hash, code };
        transporter.sendMail({ from: 'adresa.ta@gmail.com', to: email, subject: 'Cod verificare - WebRTC', text: `Codul tău este: ${code}` }, (err) => {
            if (err) res.status(500).json({ error: "Eroare la trimiterea email-ului." });
            else res.json({ success: true });
        });
    });
});

app.post('/api/verify-code', (req, res) => {
    const { code } = req.body;
    if (req.session.pendingUser && code === req.session.pendingUser.code) {
        const p = req.session.pendingUser;
        db.run(`INSERT INTO users (username, email, password) VALUES (?, ?, ?)`, [p.username, p.email, p.password], () => {
            delete req.session.pendingUser;
            res.json({ success: true });
        });
    } else res.status(400).json({ error: "Cod incorect!" });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "Nume de utilizator sau parolă incorectă." });
        req.session.userId = user.id;
        req.session.username = user.username;
        res.json({ success: true, redirect: '/dashboard.html' });
    });
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login.html'); });
app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).send("Neautorizat");
    res.json({ username: req.session.username });
});

app.get('/api/rooms', (req, res) => {
    if (!req.session.userId) return res.status(401).send("Neautorizat");
    db.all(`SELECT * FROM rooms`, [], (err, rows) => {
        res.json(rows.map(r => ({ ...r, activeUsers: io.sockets.adapter.rooms.get(r.name)?.size || 0 })));
    });
});

app.post('/api/rooms', (req, res) => {
    if (!req.session.userId) return res.status(401).send("Neautorizat");
    db.run(`INSERT INTO rooms (name, created_by) VALUES (?, ?)`, [req.body.roomName, req.session.username], function(err) {
        if (err) res.status(400).send("Camera există deja."); else res.json({ id: this.lastID });
    });
});

app.delete('/api/rooms/:name', (req, res) => {
    if (!req.session.userId) return res.status(401).send("Neautorizat");
    const count = io.sockets.adapter.rooms.get(req.params.name)?.size || 0;
    if (count > 0) return res.status(400).json({ error: "Nu poți șterge camera! Există utilizatori activi în ea." });
    db.run(`DELETE FROM rooms WHERE name = ? AND created_by = ?`, [req.params.name, req.session.username], function() {
        if (this.changes === 0) res.status(403).json({ error: "Doar persoana care a creat această cameră o poate șterge!" });
        else res.json({ success: true });
    });
});

io.on('connection', (socket) => {
    socket.on('join', (data) => {
        if ((io.sockets.adapter.rooms.get(data.roomName)?.size || 0) >= 2) socket.emit('room-full');
        else { socket.join(data.roomName); socket.to(data.roomName).emit('user-joined', { username: data.username }); }
    });
    socket.on('message', (data) => { if (data.room) socket.to(data.room).emit('message', data); });
    socket.on('media-state-change', (data) => { if (data.room) socket.to(data.room).emit('remote-media-state', data); });
});

server.listen(3000, () => console.log('Serverul a pornit pe portul 3000!'));