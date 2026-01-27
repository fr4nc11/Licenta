const socket = io();

// Configurația pentru serverele STUN (Google)
const configuration = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// Variabile Globale
let localStream;
let screenStream;
let peerConnection;
let dataChannel;

// Variabile Timer
let timerInterval;
let callSeconds = 0;

// Variabile Înregistrare
let mediaRecorder;
let recordedChunks = [];
let isRecording = false;
let recordingStream = null; // Stream special pentru tot ecranul

// Variabile Statistici Rețea
let statsInterval;
let lastBytesReceived = 0;
let lastTimestamp = 0;

// Stări aplicație
let isCallActive = false;
let isCameraOn = true;
let isMicOn = true;
let isScreenSharing = false;
let ROOM_ID = null;

// ===================== 1. CONFIGURARE & LOBBY =====================
async function joinRoom() {
    const input = document.getElementById('roomInput');
    const roomName = input.value.trim();
    
    if (!roomName) { 
        alert("Te rog introdu un nume de cameră!"); 
        return; 
    }
    ROOM_ID = roomName;

    // Ascundem lobby-ul și arătăm interfața de apel
    document.getElementById('lobby-container').style.display = 'none';
    document.getElementById('call-interface').style.display = 'flex';
    document.getElementById('roomNameDisplay').innerText = ROOM_ID;

    socket.emit('join', ROOM_ID);
    await startCamera();
}

async function startCamera() {
    // Luăm dispozitivele selectate în Lobby
    const videoId = document.getElementById('videoSourceLobby').value;
    const audioId = document.getElementById('audioSourceLobby').value;
    
    const constraints = {
        audio: { deviceId: audioId ? { exact: audioId } : undefined },
        video: { deviceId: videoId ? { exact: videoId } : undefined }
    };

    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        document.getElementById('localVideo').srcObject = localStream;
        // Actualizăm și selectoarele din meniul de setări
        updateCallSelectors(videoId, audioId);
    } catch (e) { 
        console.error(e); 
        alert("Te rog permite accesul la cameră și microfon!"); 
    }
}

// ===================== 2. SOCKET.IO (COMUNICARE SERVER) =====================
socket.on('message', async (message) => {
    if (message.type === 'offer') {
        // Am primit o ofertă de apel
        await createPeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        sendMessageToServer(answer);
        setCallActiveUI(true);
    } else if (message.type === 'answer') {
        // Am primit răspuns la oferta noastră
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message));
    } else if (message.candidate) {
        // Candidați ICE (ruta de rețea)
        if (peerConnection) await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
    } else if (message.type === 'hangup') {
        // Partenerul a închis
        hangUp(false);
        alert("Partenerul s-a deconectat.");
    }
});

// Ascultăm starea media a partenerului (Mute/Camera Off)
socket.on('remote-media-state', (data) => {
    if (data.type === 'video') document.getElementById("remote-camera-off-overlay").style.display = data.enabled ? "none" : "flex";
    if (data.type === 'audio') document.getElementById("remote-mic-off-icon").style.display = data.enabled ? "none" : "flex";
});

function sendMessageToServer(msg) { 
    msg.room = ROOM_ID; 
    socket.emit('message', msg); 
}

// ===================== 3. LOGICA APEL & WEBRTC =====================
function handleCallButton() { 
    if (!isCallActive) startCall(); 
    else hangUp(true); 
}

async function startCall() {
    await createPeerConnection();
    // Creăm canal de date pentru chat
    dataChannel = peerConnection.createDataChannel("chat");
    setupDataChannel(dataChannel);
    
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendMessageToServer(offer);
    setCallActiveUI(true);
}

async function createPeerConnection() {
    peerConnection = new RTCPeerConnection(configuration);
    
    // Adăugăm fluxurile locale
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    
    // Când primim flux video de la partener
    peerConnection.ontrack = (event) => {
        document.getElementById('remoteVideo').srcObject = event.streams[0];
    };
    
    // Când primim canal de date (Chat)
    peerConnection.ondatachannel = (e) => { 
        dataChannel = e.channel; 
        setupDataChannel(dataChannel); 
    };
    
    peerConnection.onicecandidate = (e) => { 
        if (e.candidate) sendMessageToServer({ candidate: e.candidate }); 
    };
}

function hangUp(notifyPartner) {
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (isScreenSharing) stopScreenShare();
    if (isRecording) stopRecording();
    stopStats(); 

    document.getElementById('remoteVideo').srcObject = null;
    if (notifyPartner) socket.emit('message', { type: 'hangup', room: ROOM_ID });
    
    setCallActiveUI(false);
    dataChannel = null;
    document.getElementById('chat-messages').innerHTML = '';
    
    // Resetăm statisticile
    document.getElementById('stat-bitrate').innerText = "0 kbps";
    document.getElementById('stat-res').innerText = "0x0";
    document.getElementById('stat-fps').innerText = "0";
    document.getElementById('stat-loss').innerText = "0";
}

// ===================== 4. STATISTICI REȚEA =====================
function startStats() {
    if(statsInterval) clearInterval(statsInterval);
    statsInterval = setInterval(async () => {
        if(!peerConnection) return;
        const stats = await peerConnection.getStats();
        stats.forEach(report => {
            if(report.type === 'inbound-rtp' && report.kind === 'video') {
                // Calcul Bitrate
                const bitrate = Math.round(((report.bytesReceived - lastBytesReceived) * 8) / (report.timestamp - lastTimestamp));
                lastBytesReceived = report.bytesReceived;
                lastTimestamp = report.timestamp;
                
                // Actualizare Widget
                document.getElementById('stat-bitrate').innerText = `${bitrate} kbps`;
                document.getElementById('stat-res').innerText = `${report.frameWidth||0}x${report.frameHeight||0}`;
                document.getElementById('stat-fps').innerText = report.framesPerSecond||0;
                document.getElementById('stat-loss').innerText = report.packetsLost || 0;
            }
        });
    }, 1000);
}
function stopStats() { clearInterval(statsInterval); }

// ===================== 5. INTERFAȚĂ & CONTROL =====================
function setCallActiveUI(isActive) {
    isCallActive = isActive;
    const callBtn = document.getElementById('callBtn');
    if (isActive) {
        callBtn.innerHTML = "📞 Încheie";
        callBtn.classList.add('hangup-btn');
        // Afișăm butoanele extra
        ['chatBtn','shareBtn','recordBtn','settingsBtn'].forEach(id => document.getElementById(id).style.display = 'flex');
        document.getElementById('network-widget').style.display = 'block';
        startTimer();
        startStats(); 
    } else {
        callBtn.innerHTML = "📞 Apel";
        callBtn.classList.remove('hangup-btn');
        // Ascundem butoanele extra
        ['chatBtn','shareBtn','recordBtn','settingsBtn'].forEach(id => document.getElementById(id).style.display = 'none');
        document.getElementById('chat-container').style.display = 'none';
        document.getElementById('settings-panel').style.display = 'none';
        document.getElementById('network-widget').style.display = 'none';
        stopTimer();
    }
}

// ===================== 6. TIMER =====================
function startTimer() { callSeconds = 0; updateTimer(); clearInterval(timerInterval); timerInterval = setInterval(() => { callSeconds++; updateTimer(); }, 1000); }
function stopTimer() { clearInterval(timerInterval); callSeconds = 0; updateTimer(); }
function updateTimer() {
    const m = Math.floor(callSeconds/60).toString().padStart(2,'0');
    const s = (callSeconds%60).toString().padStart(2,'0');
    document.getElementById('callTimer').innerText = `${m}:${s}`;
}

// ===================== 7. GESTIONARE DISPOZITIVE =====================
function toggleCamera() {
    const t = localStream.getVideoTracks()[0];
    if (t) {
        isCameraOn = !isCameraOn; t.enabled = isCameraOn;
        document.getElementById("camBtn").classList.toggle("btn-off", !isCameraOn);
        document.getElementById("camera-off-overlay").style.display = isCameraOn ? "none" : "flex";
        socket.emit('media-state-change', { type: 'video', enabled: isCameraOn, room: ROOM_ID });
    }
}
function toggleMic() {
    const t = localStream.getAudioTracks()[0];
    if (t) {
        isMicOn = !isMicOn; t.enabled = isMicOn;
        document.getElementById("micBtn").classList.toggle("btn-off", !isMicOn);
        document.getElementById("mic-off-icon").style.display = isMicOn ? "none" : "flex";
        socket.emit('media-state-change', { type: 'audio', enabled: isMicOn, room: ROOM_ID });
    }
}

function toggleSettings() {
    const p = document.getElementById('settings-panel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
}

// Schimbare cameră din mers (Hot Swap)
async function changeCamera() {
    if(isScreenSharing) return;
    const id = document.getElementById('videoSourceCall').value;
    const ns = await navigator.mediaDevices.getUserMedia({video:{deviceId:{exact:id}}});
    const nt = ns.getVideoTracks()[0];
    
    // Înlocuim track-ul pentru partener
    if(peerConnection) peerConnection.getSenders().find(s=>s.track.kind==='video').replaceTrack(nt);
    
    // Înlocuim local
    localStream.removeTrack(localStream.getVideoTracks()[0]);
    localStream.addTrack(nt);
    document.getElementById('localVideo').srcObject = localStream;
    nt.enabled = isCameraOn;
}

// Schimbare microfon din mers
async function changeMic() {
    const id = document.getElementById('audioSourceCall').value;
    const ns = await navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:id}}});
    const nt = ns.getAudioTracks()[0];
    
    if(peerConnection) peerConnection.getSenders().find(s=>s.track.kind==='audio').replaceTrack(nt);
    
    localStream.removeTrack(localStream.getAudioTracks()[0]);
    localStream.addTrack(nt);
    nt.enabled = isMicOn;
}
function updateCallSelectors(v, a) { document.getElementById('videoSourceCall').value=v; document.getElementById('audioSourceCall').value=a; }

// ===================== 8. SCREEN SHARE & ÎNREGISTRARE COMPLETĂ =====================

async function toggleScreenShare() {
    if (!isScreenSharing) {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ cursor: true });
            const track = screenStream.getVideoTracks()[0];
            peerConnection.getSenders().find(s => s.track.kind === 'video').replaceTrack(track);
            document.getElementById('localVideo').srcObject = screenStream;
            document.getElementById('localVideo').classList.add("no-mirror");
            track.onended = () => stopScreenShare();
            isScreenSharing = true;
            document.getElementById('shareBtn').innerHTML = "🛑";
        } catch (e) { console.error(e); }
    } else stopScreenShare();
}

function stopScreenShare() {
    const track = localStream.getVideoTracks()[0];
    peerConnection.getSenders().find(s => s.track.kind === 'video').replaceTrack(track);
    if(screenStream) screenStream.getTracks().forEach(t=>t.stop());
    document.getElementById('localVideo').srcObject = localStream;
    document.getElementById('localVideo').classList.remove("no-mirror");
    isScreenSharing = false;
    document.getElementById('shareBtn').innerHTML = "🖥️";
}

// --- LOGICĂ NOUĂ ÎNREGISTRARE TOT ECRANUL ---
async function toggleRecording() { 
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
}

async function startRecording() {
    try {
        // Cerem permisiunea de a captura TOT ecranul (inclusiv UI-ul nostru)
        recordingStream = await navigator.mediaDevices.getDisplayMedia({ 
            video: { mediaSource: "screen" },
            audio: true // Încearcă să captureze și sunetul sistemului
        });

        recordedChunks = [];
        try { 
            mediaRecorder = new MediaRecorder(recordingStream, {mimeType:'video/webm;codecs=vp9,opus'}); 
        } catch(e) { 
            mediaRecorder = new MediaRecorder(recordingStream); 
        }
        
        mediaRecorder.ondataavailable = e => { if(e.data.size > 0) recordedChunks.push(e.data); };
        
        mediaRecorder.onstop = () => {
            downloadRecording();
            // Oprim track-urile când se termină înregistrarea
            recordingStream.getTracks().forEach(track => track.stop());
            recordingStream = null;
        };

        // Dacă utilizatorul apasă "Stop sharing" din bara browserului
        recordingStream.getVideoTracks()[0].onended = () => {
            if (isRecording) stopRecording();
        };

        mediaRecorder.start();
        isRecording = true;
        document.getElementById('recordBtn').style.backgroundColor = "#d93025";
        
    } catch (err) {
        console.error("Înregistrare anulată: " + err);
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
    }
    isRecording = false;
    document.getElementById('recordBtn').style.backgroundColor = "#3c4043";
}

function downloadRecording() {
    const blob = new Blob(recordedChunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); 
    document.body.appendChild(a); 
    a.style = "display:none"; 
    a.href = url; 
    a.download = `Inregistrare_Ecran_${Date.now()}.webm`; 
    a.click();
    window.URL.revokeObjectURL(url);
    alert("Înregistrarea a fost salvată!");
}

// ===================== 9. CHAT =====================
function setupDataChannel(ch) {
    ch.onopen = () => appendSysMsg("Chat conectat!");
    ch.onmessage = e => {
        const d = JSON.parse(e.data);
        if(d.type==='text') appendMsg(d.content, 'remote');
        else if(d.type==='file') appendFile(d.fileName, d.content, 'remote');
        if(document.getElementById('chat-container').style.display === 'none') document.getElementById('chatBtn').style.backgroundColor = "#e67c73";
    };
}
function sendTextMessage() {
    const i = document.getElementById('msgInput');
    if(i.value && dataChannel?.readyState==='open') {
        dataChannel.send(JSON.stringify({type:'text', content:i.value})); appendMsg(i.value,'local'); i.value='';
    }
}
function sendFile() {
    const f = document.getElementById('fileInput').files[0];
    if(f && dataChannel?.readyState==='open') {
        if(f.size>5*1024*1024) return alert("Maxim 5MB!");
        const r = new FileReader();
        r.onload = e => { dataChannel.send(JSON.stringify({type:'file', fileName:f.name, content:e.target.result})); appendFile(f.name,e.target.result,'local'); document.getElementById('fileInput').value=''; };
        r.readAsDataURL(f);
    }
}
function appendMsg(t, type) { const d=document.createElement('div'); d.className=`message ${type==='local'?'my-msg':'remote-msg'}`; d.innerText=t; document.getElementById('chat-messages').appendChild(d); }
function appendFile(n, u, type) { const d=document.createElement('div'); d.className=`message ${type==='local'?'my-msg':'remote-msg'}`; d.innerHTML=`<div>📎 ${n}</div><a href="${u}" download="${n}" style="color:white;">Descarcă</a>`; document.getElementById('chat-messages').appendChild(d); }
function appendSysMsg(t) { const d=document.createElement('div'); d.innerText=t; d.style="text-align:center;font-size:12px;color:#aaa;"; document.getElementById('chat-messages').appendChild(d); }
function toggleChatUI() { const c=document.getElementById('chat-container'); c.style.display=c.style.display==='none'?'flex':'none'; if(c.style.display==='flex') document.getElementById('chatBtn').style.backgroundColor="#3c4043"; }
function handleKeyPress(e) { if(e.key==='Enter') sendTextMessage(); }

// ===================== 10. DETECTARE DISPOZITIVE =====================
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