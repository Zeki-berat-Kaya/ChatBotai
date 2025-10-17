/**************************************************************************
 * Gelişmiş Chat - JS
 * - LocalStorage ile geçmiş ve ayarlar
 * - Retry/backoff
 * - Typing indicator / streaming simulation
 * - Markdown basit render
 * - Rate-limit (1s) ve mesaj limiti
 * - Eklenen Özellikler: Konuşma listesi, başlık düzenleme, API ayarı kaydı, Sıcaklık ve Max Token.
 **************************************************************************/

// ---------- CONFIG ----------
const DEFAULT_API_URL = "https://backend.buildpicoapps.com/aero/run/llm-api?pk=v1-Z0FBQUFBQm5IZkJDMlNyYUVUTjIyZVN3UWFNX3BFTU85SWpCM2NUMUk3T2dxejhLSzBhNWNMMXNzSllRRF9kYmlkR3dOVTZzYUd5aW5Tckx5T1Y1X29MNGwwdzV3PQ==";
const STORAGE_KEY_SETTINGS = "gelişmiş_chat_settings_v1"; // Ayarlar için yeni anahtar
const STORAGE_KEY_CONVERSATIONS = "gelişmiş_chat_conversations_v1"; // Geçmiş konuşmalar için yeni anahtar
const REQUEST_COOLDOWN_MS = 1000; // 1s throttle
const MAX_MESSAGES = 200; // sohbette tutulacak en fazla mesaj
const MAX_RETRIES = 3;

// ---------- Elementler ----------
const chatWindow = document.getElementById("chat-window");
const sendBtn = document.getElementById("send-btn");
const userInput = document.getElementById("user-input");
const apiUrlInput = document.getElementById("api-url");
const apiKeyInput = document.getElementById("api-key");
const systemPromptEl = document.getElementById("system-prompt");
const temperatureInput = document.getElementById("temperature-input"); 
const maxTokensInput = document.getElementById("max-tokens-input"); 
const statusInfo = document.getElementById("status-info");
const newConvBtn = document.getElementById("new-conv");
const exportConvBtn = document.getElementById("export-conv");
const toggleThemeBtn = document.getElementById("toggle-theme");
const clearStorageBtn = document.getElementById("clear-storage");
const convTitle = document.getElementById("conv-title");
const editTitleBtn = document.getElementById("edit-title-btn");
const conversationsEl = document.getElementById("conversations");
const msgLimitLabel = document.getElementById("msg-limit-label");
const appEl = document.getElementById("app");
const errorAlert = document.getElementById("error-alert");

// ---------- State ----------
let state = {
  convId: uid(), 
  messages: [], 
  lastRequestAt: 0,
  convName: "Yeni Konuşma",
  theme: "light"
};

let allConversations = {}; 
let isSending = false; 

// ---------- Util: ID ve Zaman ----------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}
function nowISO(){ return new Date().toISOString(); }
function prettyTime(iso){
  const d = new Date(iso);
  return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

// ---------- Basit Markdown renderer ----------
function renderMarkdownToHtml(text){
    if(!text) return "";
    const esc = text.replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
    const codeBlock = esc.replace(/```([\s\S]*?)```/g, (m,p1)=>`<div class="code-block">${p1}</div>`);
    const inline = codeBlock.replace(/`([^`]+)`/g, (m,p1)=>`<code style="padding:2px 6px;border-radius:4px">${p1}</code>`);
    const bold = inline.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    const italic = bold.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    const headers = italic.replace(/^#\s+(.*$)/gm, "<h2>$1</h2>").replace(/^##\s+(.*$)/gm, "<h3>$1</h3>");
    return headers.replace(/\n/g, "<br>");
}

// ---------- LocalStorage Yönetimi ----------
function saveSettings() {
    try {
        const settings = {
            apiUrl: apiUrlInput.value,
            apiKey: apiKeyInput.value,
            systemPrompt: systemPromptEl.value,
            theme: state.theme,
            temperature: temperatureInput.value, 
            maxTokens: maxTokensInput.value,     
        };
        localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
    } catch(e) { console.warn("Ayarlar kaydedilemedi", e); }
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
        if (raw) {
            const settings = JSON.parse(raw);
            apiUrlInput.value = settings.apiUrl || "";
            apiKeyInput.value = settings.apiKey || "";
            systemPromptEl.value = settings.systemPrompt || "Sen yardımcı, kısa ve nazik bir asistan olarak davran.";
            state.theme = settings.theme || "light";
            temperatureInput.value = settings.temperature || "0.7"; 
            maxTokensInput.value = settings.maxTokens || "";     
            applyTheme(state.theme);
        } else {
            temperatureInput.value = "0.7";
            systemPromptEl.value = "Sen yardımcı, kısa ve nazik bir asistan olarak davran.";
        }
    } catch(e) { console.warn("Ayarlar yüklenemedi", e); }
}

function saveConversations() {
    try {
        localStorage.setItem(STORAGE_KEY_CONVERSATIONS, JSON.stringify(allConversations));
    } catch(e) { console.warn("Konuşmalar kaydedilemedi", e); }
}

function loadConversations() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_CONVERSATIONS);
        if (raw) {
            allConversations = JSON.parse(raw);
        }
    } catch(e) { console.warn("Konuşmalar yüklenemedi", e); }
}

function saveCurrentState() {
    // Mesajlar boş olsa bile, konuşmanın ID'si varsa kaydet (aktif konuşmayı güncellemek için)
    if (state.messages.length > 0 || allConversations[state.convId]) {
        allConversations[state.convId] = {
            id: state.convId,
            convName: state.convName,
            messages: state.messages,
            time: nowISO() // En son kaydedildiği zaman
        };
        saveConversations();
        renderConversationList(); // Kayıt sonrası listeyi güncelle
    }
}

function loadConversation(id) {
    saveCurrentState(); // Önce mevcut olanı kaydet (yeniye geçmeden önce)

    const conv = allConversations[id];
    if (conv) {
        state.convId = conv.id;
        state.convName = conv.convName;
        state.messages = conv.messages;
        convTitle.textContent = state.convName;
        rerenderAll();
        renderConversationList(); // Active sınıfı güncelle
    }
}

// ---------- UI: render mesajlar ----------
function addMessageToDOM(msg){
    const wrapper = document.createElement("div");
    wrapper.classList.add("row");
    // avatar
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = msg.role === "user" ? "Z" : "AI";

    const bubble = document.createElement("div");
    bubble.className = "message " + (msg.role === "user" ? "msg-user" : "msg-bot");
    bubble.setAttribute("data-id", msg.id);

    // içerik
    const inner = document.createElement("div");
    inner.className = "inner";
    inner.innerHTML = renderMarkdownToHtml(msg.text || "");

    bubble.appendChild(inner);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span>${prettyTime(msg.time)}</span> <span class="status">${msg.status || ""}</span>`;
    bubble.appendChild(meta);

    if(msg.role === "user"){
        wrapper.appendChild(bubble);
        wrapper.appendChild(avatar);
    }else{
        wrapper.appendChild(avatar);
        wrapper.appendChild(bubble);
    }

    chatWindow.appendChild(wrapper);
    // 🔥 KRİTİK KURAL: HER MESAJ EKLENDİĞİNDE KAYDIRMA
    chatWindow.scrollTop = chatWindow.scrollHeight; 
}

function rerenderAll(){
    chatWindow.innerHTML = "";
    for(const m of state.messages){
        // addMessageToDOM, her mesajı eklerken kaydırma yapıyor.
        addMessageToDOM(m); 
    }
    // 🔥 KRİTİK KURAL: KAYITLI KONUŞMA YÜKLENDİĞİNDE EN ALTA KAYDIRMAYI GARANTİLE
    // (Bazen addMessageToDOM'daki döngü hızından dolayı kaydırma kaçabilir, bu garanti sağlar)
    setTimeout(() => {
        chatWindow.scrollTop = chatWindow.scrollHeight;
    }, 50); // Kısa bir gecikme eklemek, DOM render'ının tamamlanmasını garantiler.
}

// ---------- Message management ----------
function pushMessage(role, text, opts = {}){
    const msg = {
        id: uid(),
        role,
        text,
        time: nowISO(),
        status: opts.status || (role === "user" ? "sent" : "sending")
    };
    state.messages.push(msg);
    // trim if too many
    if(state.messages.length > MAX_MESSAGES){
        state.messages = state.messages.slice(state.messages.length - MAX_MESSAGES);
    }
    saveCurrentState(); // Her mesajda kaydet
    addMessageToDOM(msg);
    return msg;
}

function updateMessageStatus(id, status, newText){
    const idx = state.messages.findIndex(m=>m.id===id);
    if(idx===-1) return;
    state.messages[idx].status = status;
    if(typeof newText !== "undefined") state.messages[idx].text = newText;
    saveCurrentState(); // Güncelleme sonrası kaydet

    const el = chatWindow.querySelector(`[data-id="${id}"]`);
    if(el){
        const st = el.querySelector(".status");
        if(st) st.textContent = status;
        if(typeof newText !== "undefined"){
            el.querySelector(".inner").innerHTML = renderMarkdownToHtml(newText);
            // 🔥 KRİTİK KURAL: STREAMING SIRASINDA DA KAYDIRMA
            chatWindow.scrollTop = chatWindow.scrollHeight; 
        }
    }
}

// ---------- Konuşma Listesi Renderer ----------
function renderConversationList() {
    conversationsEl.innerHTML = "";
    // En son kaydedilenler en üstte olacak şekilde sırala
    const sortedConvs = Object.values(allConversations).sort((a,b) => new Date(b.time) - new Date(a.time));

    for (const conv of sortedConvs) {
        // Boş mesaj listesini gösterme
        if (conv.messages.length === 0) continue; 

        const item = document.createElement("div");
        item.className = "conv-item" + (conv.id === state.convId ? " active" : "");
        item.setAttribute("data-id", conv.id);
        item.title = conv.convName;
        item.innerHTML = `
            <div>
                ${conv.convName.slice(0, 30)}${conv.convName.length > 30 ? '...' : ''}
                <small>${prettyTime(conv.time)}</small>
            </div>
            <button class="delete-btn" title="Konuşmayı Sil">🗑️</button>
        `;

        item.querySelector(".delete-btn").addEventListener("click", (e) => {
            e.stopPropagation(); 
            if (confirm(`'${conv.convName}' konuşmasını silmek istediğinizden emin misiniz?`)) {
                delete allConversations[conv.id];
                saveConversations();
                renderConversationList();

                if (conv.id === state.convId) {
                    startNewConversation(false);
                }
            }
        });

        item.addEventListener("click", () => loadConversation(conv.id));
        conversationsEl.appendChild(item);
    }
}

// ---------- Throttle & Status ----------
function canSend(){
    const now = Date.now();
    return !isSending && (now - state.lastRequestAt) >= REQUEST_COOLDOWN_MS;
}
function markRequest(){
    state.lastRequestAt = Date.now();
    isSending = true;
    sendBtn.disabled = true;
}
function unmarkRequest(){
    isSending = false;
    sendBtn.disabled = false;
    hideErrorAlert();
}

function showErrorAlert(message) {
    errorAlert.textContent = "Hata: " + message;
    errorAlert.classList.add("show");
    setTimeout(hideErrorAlert, 5000);
}
function hideErrorAlert() {
    errorAlert.classList.remove("show");
    errorAlert.textContent = "";
}


// ---------- Streaming simulator ----------
async function simulateStreamWrite(msgId, fullText, speed = 12){
    let soFar = "";
    for(let i=0;i<fullText.length;i+=speed){
        soFar = fullText.slice(0,i+speed);
        // updateMessageStatus içinde kaydırma tetikleniyor.
        updateMessageStatus(msgId, "gönderiliyor...", soFar); 
        await new Promise(r=>setTimeout(r, 30));
    }
    // finalize
    updateMessageStatus(msgId, "tamamlandı", fullText);
}

// ---------- API call with retry/backoff ----------
async function callAPI(prompt, retries = MAX_RETRIES){
    const customUrl = apiUrlInput.value.trim();
    const url = customUrl || DEFAULT_API_URL;
    const apiKey = apiKeyInput.value.trim();
    
    const systemPrompt = systemPromptEl.value || "";
    const temperature = parseFloat(temperatureInput.value);
    const maxTokens = parseInt(maxTokensInput.value);

    // API Payload'u
    const payload = { 
        system: systemPrompt, 
        prompt: prompt 
    };
    
    // Geçerli LLM parametrelerini ekle
    if (!isNaN(temperature) && temperature >= 0 && temperature <= 1) {
        payload.temperature = temperature;
    }
    if (!isNaN(maxTokens) && maxTokens > 0) {
        payload.max_tokens = maxTokens; 
    }

    const headers = { "Content-Type":"application/json" };
    if(apiKey) headers["Authorization"] = "Bearer " + apiKey; 

    try{
        const res = await fetch(url, { method:"POST", headers, body: JSON.stringify(payload) });
        if(!res.ok){
            const txt = await res.text();
            throw new Error(`HTTP ${res.status}: ${txt}`);
        }
        const data = await res.json();
        return data;
    }catch(err){
        if(retries > 0){
            const wait = Math.pow(2, MAX_RETRIES - retries) * 500;
            statusInfo.textContent = `API Hatası, ${MAX_RETRIES - retries + 1}. denemede tekrar denenecek (${wait/1000}s)`;
            await new Promise(r=>setTimeout(r, wait));
            return callAPI(prompt, retries - 1);
        }else{
            throw err;
        }
    }
}

// ---------- Send flow ----------
async function sendMessage(){
    const text = userInput.value.trim();
    if(!text) return;

    if(!canSend()){
        statusInfo.textContent = "Çok hızlısınız, lütfen bekleyin...";
        showErrorAlert("Çok hızlısınız, lütfen bir saniye bekleyin.");
        return;
    }

    markRequest();
    userInput.value = "";
    statusInfo.textContent = "Gönderiliyor...";
    const userMsg = pushMessage("user", text, {status:"gönderildi"});
    const assistantMsg = pushMessage("assistant", "", {status:"gönderiliyor..."});

    try{
        // Prompt'u hazırla (son 12 mesaj)
        const recent = state.messages.slice(-12).map(m => {
            // Sadece text alanı dolu olan mesajları prompt'a dahil et
            if (!m.text) return null; 

            if (m.role === 'user') return `Kullanıcı: ${m.text}`;
            if (m.role === 'assistant') return `Asistan: ${m.text}`;
            return null;
        }).filter(m => m !== null).join("\n");

        const fullPrompt = `${systemPromptEl.value}\n\nSohbet geçmişi:\n${recent}\n\nAsistan cevap versin:`;

        const apiResult = await callAPI(fullPrompt);
        
        let replyText = "";
        if(apiResult && apiResult.output){ 
             replyText = typeof apiResult.output === "string" ? apiResult.output : JSON.stringify(apiResult.output);
        } else if (apiResult && apiResult.text) { 
             replyText = apiResult.text;
        } else {
             replyText = "API'den beklenmeyen yanıt alındı: " + JSON.stringify(apiResult);
        }

        // Başlık belirleme (İlk kullanıcı mesajından)
        if (state.messages.filter(m => m.role !== 'system').length === 2) {
             state.convName = text.slice(0, 20) + (text.length > 20 ? '...' : '');
             convTitle.textContent = state.convName;
             saveCurrentState(); // Başlık değişikliğini kaydet
        }

        // simulate streaming for UX
        await simulateStreamWrite(assistantMsg.id, replyText, 10);
        statusInfo.textContent = "Tamamlandı";
        
    }catch(err){
        console.error("API Hatası:", err);
        const errorMsg = (err.message || "Bilinmeyen Bağlantı Hatası").slice(0, 100);
        updateMessageStatus(assistantMsg.id, "HATA");
        statusInfo.textContent = "Hata oluştu.";
        showErrorAlert(errorMsg);
    }finally{
        unmarkRequest();
        saveCurrentState();
    }
}

// ---------- Konuşma Başlatma Fonksiyonu ----------
function startNewConversation(savePrevious = true) {
    if (savePrevious) {
        saveCurrentState();
    }
    
    // Yeni state oluştur
    state.convId = uid();
    state.messages = [];
    state.convName = "Yeni Konuşma";
    convTitle.textContent = state.convName;
    chatWindow.innerHTML = "";
    userInput.value = "";
    statusInfo.textContent = "Hazır";
    
    // Örnek başlangıç mesajı
    pushMessage("assistant","Merhaba! Ben gelişmiş asistan. Sana nasıl yardımcı olabilirim?", {status:"tamamlandı"});
}


// ---------- Handlers ----------
sendBtn.addEventListener("click", sendMessage);
userInput.addEventListener("keydown", (e)=>{
    if(e.key === "Enter" && !e.shiftKey){
        e.preventDefault();
        sendMessage();
    }
});
newConvBtn.addEventListener("click", () => {
    // Mesaj varsa sor
    if(state.messages.filter(m => m.role !== 'system').length > 0 && 
       !confirm("Yeni konuşma başlatılsın mı? Mevcut konuşma listeye kaydedilecek.")) return;
    startNewConversation();
});
exportConvBtn.addEventListener("click", ()=>{
    const data = {
        messages: state.messages,
        title: state.convName,
        exportedAt: nowISO(),
        allConversations: allConversations 
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `chat-export-${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.json`; 
    document.body.appendChild(a); 
    a.click(); 
    a.remove();
    URL.revokeObjectURL(url);
});
toggleThemeBtn.addEventListener("click", ()=>{
    const t = appEl.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(t);
    state.theme = t;
    saveSettings(); 
});
clearStorageBtn.addEventListener("click", ()=>{
    if(confirm("DİKKAT! LocalStorage tamamen temizlenecek mi? (Tüm kaydedilmiş geçmiş ve ayarlar silinir)")){
        localStorage.removeItem(STORAGE_KEY_SETTINGS);
        localStorage.removeItem(STORAGE_KEY_CONVERSATIONS);
        window.location.reload(); 
    }
});

// Ayarlar değiştiğinde kaydet
apiUrlInput.addEventListener("change", saveSettings);
apiKeyInput.addEventListener("change", saveSettings);
systemPromptEl.addEventListener("change", saveSettings);
temperatureInput.addEventListener("change", saveSettings); 
maxTokensInput.addEventListener("change", saveSettings);     

// Başlık Düzenleme
editTitleBtn.addEventListener("click", () => {
    const newTitle = prompt("Yeni Konuşma Başlığı:", state.convName);
    if (newTitle && newTitle.trim()) {
        state.convName = newTitle.trim();
        convTitle.textContent = state.convName;
        saveCurrentState();
        renderConversationList();
    }
});


// ---------- Theme ----------
function applyTheme(t){
    appEl.setAttribute("data-theme", t);
    toggleThemeBtn.textContent = t === "light" ? "Karanlık Mod" : "Açık Mod";
}

// ---------- Init (En son konuşmayı yükleme mantığı) ----------
function init(){
    msgLimitLabel.textContent = MAX_MESSAGES;
    loadSettings();
    loadConversations();
    
    applyTheme(state.theme);

    // En son kaydedilen (en yeni zamana sahip) konuşmayı bul ve yükle
    let latestConv = null;
    let latestTime = 0; 

    for (const id in allConversations) {
        const conv = allConversations[id];
        if (conv.messages && conv.messages.length > 0 && conv.time) {
             const convTime = new Date(conv.time).getTime();
             if (convTime > latestTime) {
                 latestTime = convTime;
                 latestConv = conv;
             }
        }
    }
    
    if (latestConv) {
        loadConversation(latestConv.id);
    } else {
        state.convId = uid(); 
        startNewConversation(false); 
    }

    renderConversationList(); 
    
    statusInfo.textContent = "Hazır";
    userInput.focus();
    
    // 🔥 KRİTİK KURAL: Başlangıçta kaydırmayı garanti et
    setTimeout(() => {
        chatWindow.scrollTop = chatWindow.scrollHeight;
    }, 100); 
}

// run
init();

// ---------- Accessibility: focus on textarea when clicking panel ----------
chatWindow.addEventListener("click", ()=> userInput.focus());