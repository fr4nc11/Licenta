const socket = io();

const configuration = {
    iceServers: [
        {
            urls: "stun:stun.relay.metered.ca:80",
        },
        {
            urls: "turn:standard.relay.metered.ca:80",
            username: "59cbafc5f73a5a132450aeb4",
            credential: "fyQV8m6Ghxoi7K1t",
        },
        {
            urls: "turn:standard.relay.metered.ca:80?transport=tcp",
            username: "59cbafc5f73a5a132450aeb4",
            credential: "fyQV8m6Ghxoi7K1t",
        },
        {
            urls: "turn:standard.relay.metered.ca:443",
            username: "59cbafc5f73a5a132450aeb4",
            credential: "fyQV8m6Ghxoi7K1t",
        },
        {
            urls: "turns:standard.relay.metered.ca:443?transport=tcp",
            username: "59cbafc5f73a5a132450aeb4",
            credential: "fyQV8m6Ghxoi7K1t",
        }
    ]
};

let localStream;
let screenStream;
let peerConnection;
let dataChannel;
let timerInterval;
let callSeconds = 0;
let statsInterval;
let lastBytesReceived = 0;
let lastTimestamp = 0;

let isCallActive = false;
let isCameraOn = true;
let isMicOn = true;
let isScreenSharing = false;
let ROOM_ID = null;

let myUsername = "Anonim";
let remoteUsername = "Așteptare partener...";

const urlParams = new URLSearchParams(window.location.search);
const roomFromUrl = urlParams.get('room');

if (roomFromUrl) {
    const displayEl = document.getElementById('lobbyRoomNameDisplay');
    if (displayEl) displayEl.innerText = `Server: ${roomFromUrl}`;
} else {
    window.location.href = '/dashboard.html';
}

async function fetchMyUsername() {
    try {
        const res = await fetch('/api/me');
        if (res.ok) {
            const data = await res.json();
            myUsername = data.username;
            document.getElementById('localNameTag').innerText = myUsername + " (Eu)";
        }
    } catch (e) { console.warn("Nu am putut prelua numele."); }
}
fetchMyUsername();

async function joinRoom() {
    if (!roomFromUrl) return;
    ROOM_ID = roomFromUrl;

    document.getElementById('lobby-container').style.display = 'none';
    document.getElementById('call-interface').style.display = 'flex';
    document.getElementById('roomNameDisplay').innerText = ROOM_ID;

    setCallActiveUI(false); 
    await startCamera();
    socket.emit('join', { roomName: ROOM_ID, username: myUsername });
}

async function startCamera() {
    const videoId = document.getElementById('videoSourceLobby').value;
    const audioId = document.getElementById('audioSourceLobby').value;
    const constraints = {
        audio: { deviceId: audioId ? { exact: audioId } : undefined },
        video: { deviceId: videoId ? { exact: videoId } : undefined }
    };
    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        document.getElementById('localVideo').srcObject = localStream;
        updateCallSelectors(videoId, audioId);
    } catch (e) { 
        console.error(e); 
        alert("Te rog permite accesul la cameră și microfon!"); 
    }
}

socket.on('room-full', () => {
    alert("❌ Această cameră este deja plină. Vei fi trimis înapoi la servere.");
    window.location.href = '/dashboard.html';
});

socket.on('user-joined', async (data) => {
    remoteUsername = data.username;
    document.getElementById('remoteNameTag').innerText = remoteUsername;
    
    // Resetăm overlay-ul în caz că a intrat cineva nou după ce un altul a ieșit
    document.getElementById("remote-camera-off-overlay").style.display = "none";
    
    if (!isCallActive) await startCall();
});

socket.on('message', async (message) => {
    if (message.senderName && message.senderName !== myUsername) {
        remoteUsername = message.senderName;
        document.getElementById('remoteNameTag').innerText = remoteUsername;
    }

    if (message.type === 'offer') {
        if(!peerConnection) await createPeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        sendMessageToServer(answer);
        setCallActiveUI(true);
    } else if (message.type === 'answer') {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message));
    } else if (message.candidate) {
        if (peerConnection) await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
    } else if (message.type === 'hangup') {
        hangUp(false);
        
        // Logica vizuală când partenerul părăsește apelul
        document.getElementById('remoteNameTag').innerText = "Singur în apel";
        const overlay = document.getElementById("remote-camera-off-overlay");
        overlay.style.display = "flex";
        overlay.innerHTML = "<span style='font-size:40px'>👋</span><p style='color:var(--text-muted); margin-top:10px;'>Partenerul a părăsit apelul.</p>";
        
        appendSysMsg("Partenerul a părăsit conversația.");
    }
});

socket.on('remote-media-state', (data) => {
    if (data.type === 'video') {
        // Restaurăm HTML-ul standard al overlay-ului de cameră oprită
        const overlay = document.getElementById("remote-camera-off-overlay");
        overlay.innerHTML = "<span style='font-size:40px'>📷</span><p style='color:var(--text-muted); margin-top:10px;'>Camera este oprită</p>";
        overlay.style.display = data.enabled ? "none" : "flex";
    }
    if (data.type === 'audio') document.getElementById("remote-mic-off-icon").style.display = data.enabled ? "none" : "flex";
});

function sendMessageToServer(msg) { 
    msg.room = ROOM_ID; 
    msg.senderName = myUsername; 
    socket.emit('message', msg); 
}

async function startCall() {
    await createPeerConnection();
    dataChannel = peerConnection.createDataChannel("chat");
    setupDataChannel(dataChannel);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendMessageToServer(offer);
    setCallActiveUI(true);
}

async function createPeerConnection() {
    peerConnection = new RTCPeerConnection(configuration);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    peerConnection.ontrack = (event) => { document.getElementById('remoteVideo').srcObject = event.streams[0]; };
    peerConnection.ondatachannel = (e) => { dataChannel = e.channel; setupDataChannel(dataChannel); };
    peerConnection.onicecandidate = (e) => { if (e.candidate) sendMessageToServer({ candidate: e.candidate }); };
}

function hangUp(notifyPartner) {
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (isScreenSharing) stopScreenShare();
    stopStats(); 
    document.getElementById('remoteVideo').srcObject = null;
    if (notifyPartner) socket.emit('message', { type: 'hangup', room: ROOM_ID });
    setCallActiveUI(false);
    dataChannel = null;
    document.getElementById('chat-messages').innerHTML = '';
}

function setCallActiveUI(isActive) {
    isCallActive = isActive;
    const callBtn = document.getElementById('callBtn');
    if (isActive) {
        callBtn.style.display = "flex"; 
        callBtn.innerHTML = "📞 Încheie";
        callBtn.style.backgroundColor = "var(--danger)";
        ['chatBtn','shareBtn','settingsBtn'].forEach(id => document.getElementById(id).style.display = 'flex');
        document.getElementById('network-widget').style.display = 'block';
        startTimer();
        startStats(); 
    } else {
        callBtn.style.display = "flex"; 
        callBtn.innerHTML = "🚪 Ieși la Servere";
        callBtn.style.backgroundColor = "#334155";
        ['chatBtn','shareBtn','settingsBtn'].forEach(id => document.getElementById(id).style.display = 'none');
        document.getElementById('chat-container').style.display = 'none';
        document.getElementById('settings-panel').style.display = 'none';
        document.getElementById('network-widget').style.display = 'none';
        stopTimer();
    }
}

function startStats() {
    if(statsInterval) clearInterval(statsInterval);
    statsInterval = setInterval(async () => {
        if(!peerConnection) return;
        const stats = await peerConnection.getStats();
        stats.forEach(report => {
            if(report.type === 'inbound-rtp' && report.kind === 'video') {
                const bitrate = Math.round(((report.bytesReceived - lastBytesReceived) * 8) / (report.timestamp - lastTimestamp));
                lastBytesReceived = report.bytesReceived; lastTimestamp = report.timestamp;
                document.getElementById('stat-bitrate').innerText = `${bitrate} kbps`;
                document.getElementById('stat-res').innerText = `${report.frameWidth||0}x${report.frameHeight||0}`;
                document.getElementById('stat-fps').innerText = report.framesPerSecond||0;
                document.getElementById('stat-loss').innerText = report.packetsLost || 0;
            }
        });
    }, 1000);
}

function stopStats() { clearInterval(statsInterval); }
function startTimer() { callSeconds = 0; updateTimer(); clearInterval(timerInterval); timerInterval = setInterval(() => { callSeconds++; updateTimer(); }, 1000); }
function stopTimer() { clearInterval(timerInterval); callSeconds = 0; updateTimer(); }
function updateTimer() {
    const m = Math.floor(callSeconds/60).toString().padStart(2,'0');
    const s = (callSeconds%60).toString().padStart(2,'0');
    document.getElementById('callTimer').innerText = `${m}:${s}`;
}

function toggleCamera() {
    const t = localStream.getVideoTracks()[0];
    if (t) { isCameraOn = !isCameraOn; t.enabled = isCameraOn; document.getElementById("camBtn").classList.toggle("btn-off", !isCameraOn); document.getElementById("camera-off-overlay").style.display = isCameraOn ? "none" : "flex"; socket.emit('media-state-change', { type: 'video', enabled: isCameraOn, room: ROOM_ID }); }
}
function toggleMic() {
    const t = localStream.getAudioTracks()[0];
    if (t) { isMicOn = !isMicOn; t.enabled = isMicOn; document.getElementById("micBtn").classList.toggle("btn-off", !isMicOn); document.getElementById("mic-off-icon").style.display = isMicOn ? "none" : "flex"; socket.emit('media-state-change', { type: 'audio', enabled: isMicOn, room: ROOM_ID }); }
}

function toggleSettings() { const p = document.getElementById('settings-panel'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; }
async function changeCamera() {
    if(isScreenSharing) return;
    const id = document.getElementById('videoSourceCall').value;
    const ns = await navigator.mediaDevices.getUserMedia({video:{deviceId:{exact:id}}});
    const nt = ns.getVideoTracks()[0];
    if(peerConnection) peerConnection.getSenders().find(s=>s.track.kind==='video').replaceTrack(nt);
    localStream.removeTrack(localStream.getVideoTracks()[0]); localStream.addTrack(nt);
    document.getElementById('localVideo').srcObject = localStream; nt.enabled = isCameraOn;
}

async function changeMic() {
    const id = document.getElementById('audioSourceCall').value;
    const ns = await navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:id}}});
    const nt = ns.getAudioTracks()[0];
    if(peerConnection) peerConnection.getSenders().find(s=>s.track.kind==='audio').replaceTrack(nt);
    localStream.removeTrack(localStream.getAudioTracks()[0]); localStream.addTrack(nt); nt.enabled = isMicOn;
}
function updateCallSelectors(v, a) { document.getElementById('videoSourceCall').value=v; document.getElementById('audioSourceCall').value=a; }

async function toggleScreenShare() {
    if (!isScreenSharing) {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ cursor: true });
            const track = screenStream.getVideoTracks()[0];
            peerConnection.getSenders().find(s => s.track.kind === 'video').replaceTrack(track);
            document.getElementById('localVideo').srcObject = screenStream;
            document.getElementById('localVideo').classList.add("no-mirror");
            track.onended = () => stopScreenShare(); isScreenSharing = true; document.getElementById('shareBtn').innerHTML = "🛑";
        } catch (e) { console.error(e); }
    } else stopScreenShare();
}

function stopScreenShare() {
    const track = localStream.getVideoTracks()[0];
    peerConnection.getSenders().find(s => s.track.kind === 'video').replaceTrack(track);
    if(screenStream) screenStream.getTracks().forEach(t=>t.stop());
    document.getElementById('localVideo').srcObject = localStream;
    document.getElementById('localVideo').classList.remove("no-mirror"); isScreenSharing = false; document.getElementById('shareBtn').innerHTML = "🖥️";
}

function setupDataChannel(ch) {
    ch.onopen = () => appendSysMsg("Chat conectat!");
    ch.onmessage = e => {
        const d = JSON.parse(e.data);
        if(d.type === 'text') appendMsg(d.content, 'remote');
        else if(d.type === 'file') appendFile(d.fileName, d.content, 'remote');
        
        if(document.getElementById('chat-container').style.display === 'none') {
            document.getElementById('chatBtn').style.backgroundColor = "#e67c73";
        }
    };
}

function sendTextMessage() {
    const i = document.getElementById('msgInput');
    if (!i.value) return;
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({type: 'text', content: i.value})); 
        appendMsg(i.value, 'local'); 
        i.value = '';
    }
}

function sendFile() {
    const f = document.getElementById('fileInput').files[0];
    if (!f || !dataChannel || dataChannel.readyState !== 'open') return;
    if (f.size > 64 * 1024) return alert("Fișier prea mare pentru WebRTC nativ (Max 64KB).");
    const r = new FileReader();
    r.onload = e => { 
        dataChannel.send(JSON.stringify({ type: 'file', fileName: f.name, content: e.target.result })); 
        appendFile(f.name, e.target.result, 'local'); 
        document.getElementById('fileInput').value = ''; 
    };
    r.readAsDataURL(f);
}

function appendMsg(t, type) { 
    const d = document.createElement('div'); 
    d.className = `message ${type === 'local' ? 'my-msg' : 'remote-msg'}`; 
    const name = type === 'local' ? myUsername : remoteUsername;
    d.innerHTML = `<span class="sender-name">${name}</span>${t}`; 
    const chatBox = document.getElementById('chat-messages'); chatBox.appendChild(d); chatBox.scrollTop = chatBox.scrollHeight;
}

function appendFile(n, u, type) { 
    const d = document.createElement('div'); 
    d.className = `message ${type === 'local' ? 'my-msg' : 'remote-msg'}`; 
    const name = type === 'local' ? myUsername : remoteUsername;
    d.innerHTML = `<span class="sender-name">${name}</span>📎 ${n}<br><a href="${u}" download="${n}" style="color:white; text-decoration:underline; font-size: 13px; margin-top: 6px; display: inline-block;">Descarcă</a>`; 
    const chatBox = document.getElementById('chat-messages'); chatBox.appendChild(d); chatBox.scrollTop = chatBox.scrollHeight;
}

function appendSysMsg(t) { const d=document.createElement('div'); d.innerText=t; d.style="text-align:center;font-size:12px;color:var(--text-muted);margin-bottom:5px;"; document.getElementById('chat-messages').appendChild(d); }
function toggleChatUI() { const c=document.getElementById('chat-container'); c.style.display=c.style.display==='none'?'flex':'none'; if(c.style.display==='flex') document.getElementById('chatBtn').style.backgroundColor="var(--bg-card)"; }
function handleKeyPress(e) { if(e.key==='Enter') sendTextMessage(); }

async function getConnectedDevices() {
    try {
        await navigator.mediaDevices.getUserMedia({audio:true, video:true});
        const d = await navigator.mediaDevices.enumerateDevices();
        const vl=document.getElementById('videoSourceLobby'), al=document.getElementById('audioSourceLobby');
        const vc=document.getElementById('videoSourceCall'), ac=document.getElementById('audioSourceCall');
        [vl,al,vc,ac].forEach(e=>e.innerHTML='');
        d.forEach(dev => {
            const o = document.createElement('option'); o.value=dev.deviceId;
            if(dev.kind==='videoinput') { o.text=dev.label||'Cameră'; vl.appendChild(o.cloneNode(true)); vc.appendChild(o); }
            else if(dev.kind==='audioinput') { o.text=dev.label||'Microfon'; al.appendChild(o.cloneNode(true)); ac.appendChild(o); }
        });
    } catch(e) { console.warn(e); }
}
getConnectedDevices();