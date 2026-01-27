const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('.'));

io.on('connection', (socket) => {
    console.log('User conectat: ' + socket.id);

    // 1. Eveniment de intrare în cameră
    socket.on('join', (roomName) => {
        // Alăturăm socket-ul la camera specifică
        socket.join(roomName);
        console.log(`Socket ${socket.id} a intrat în camera: ${roomName}`);
        
        // Anunțăm colegii din cameră (opțional, pentru debug)
        socket.to(roomName).emit('user-joined', socket.id);
    });

    // 2. Mesaje de semnalizare (Video/Audio) - DOAR în cameră
    socket.on('message', (data) => {
        // data conține acum și { room: 'nume_camera' }
        if (data.room) {
            socket.to(data.room).emit('message', data);
        }
    });

    // 3. Stare Media (Mute/Cam) - DOAR în cameră
    socket.on('media-state-change', (data) => {
        if (data.room) {
            socket.to(data.room).emit('remote-media-state', data);
        }
    });

    socket.on('disconnect', () => {
        console.log('User deconectat');
    });
});

server.listen(3000, () => {
    console.log('Serverul a pornit pe portul 3000!');
});