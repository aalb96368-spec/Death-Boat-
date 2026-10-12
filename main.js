// ═══════════════════════════════════════════════════════════════
//  main.js – DEATH BOT · SHADOW CORE v4 (Self-bot)
//  جميع الميزات محفوظة + واجهة وإقلاع جديدين (utils/deathui.js)
// ═══════════════════════════════════════════════════════════════

const fs = require('fs-extra');
const pino = require('pino');
const path = require('path');
const util = require('util');
const { exec } = require('child_process');
const axios = require('axios');
const chokidar = require('chokidar');

// —————————— الإحصائيات (تُمرَّر للواجهة) ——————————
const stats = {
    messages: 0,
    commands: 0,
    errors: 0,
    decryptFail: 0,
    reconnects: 0,
    startTime: Date.now(),
    activeChats: new Set()
};

// —————————— محرك الواجهة (يلتقط كل console.* ويمنع تخريب الشاشة) ——————————
const ui = require('./utils/deathui');
ui.init({ stats, name: 'DEATH', version: '4.0' });
const logger = require('./utils/console');
ui.hookLogger(logger);

// قناة الاتصال مع المشغّل (index.js): يعرف إن الواجهة شغالة فيمرر رسائله لسجلها بدل الطباعة فوقها
if (process.send) {
    if (ui.enabled) process.send('ui_on');
    process.on('message', (m) => {
        if (m && Array.isArray(m.__ui)) ui.log(m.__ui[0], String(m.__ui[1]));
    });
}

// —————————— استيراد الوحدات الداخلية ——————————
let handleWelcome;
let chatCmd;
let addEliteNumber;
let monitor;
let handlerModule;
const mods = {};

try { handleWelcome = require('./plugins/welcome').handleWelcome; mods.welcome = true; } catch(e) { mods.welcome = false; }
try { chatCmd = require('./commands/chat'); mods.chat = true; } catch(e) { mods.chat = false; }
try { addEliteNumber = require('./haykala/elite').addEliteNumber; mods.elite = true; } catch(e) { mods.elite = false; }
try { monitor = require('./tools/monitor'); mods.monitor = true; } catch(e) { mods.monitor = false; }
try { handlerModule = require('./handlers/handler'); mods.handler = true; } catch(e) { mods.handler = false; }

// —————————— إعدادات Firebase ——————————
const FIREBASE_BASE_URL = 'https://deathbot-21c51-default-rtdb.firebaseio.com';

async function getFromFirebase(dbPath) {
    try {
        const url = `${FIREBASE_BASE_URL}/${dbPath}.json`;
        const response = await axios.get(url);
        return response.data;
    } catch { return null; }
}

async function sendToFirebase(dbPath, data) {
    try {
        const url = `${FIREBASE_BASE_URL}/${dbPath}.json`;
        await axios.put(url, data);
        return true;
    } catch { return false; }
}

async function pushToFirebase(dbPath, data) {
    try {
        const url = `${FIREBASE_BASE_URL}/${dbPath}.json`;
        const response = await axios.post(url, data);
        return response.data.name;
    } catch { return null; }
}

async function deleteFromFirebase(dbPath) {
    try {
        const url = `${FIREBASE_BASE_URL}/${dbPath}.json`;
        await axios.delete(url);
        return true;
    } catch { return false; }
}

// —————————— أدوات مساعدة ——————————
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepRand = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1) + min));

const store = { 
    bind: () => {}, 
    readFromFile: () => {}, 
    writeToFile: () => {} 
};

function playSound(name) {
    const controlPath = path.join(__dirname, 'sounds', 'sound.txt');
    const status = fs.existsSync(controlPath) ? fs.readFileSync(controlPath, 'utf-8').trim() : 'off';
    if (status !== '{on}') return;
    const filePath = path.join(__dirname, 'sounds', `${name}.mp3`);
    if (fs.existsSync(filePath)) {
        exec(`mpv --no-terminal --really-quiet "${filePath}"`, (err) => {});
    }
}

// —————————— أرشفة البيانات ——————————
async function archiveData(sock) {
    try {
        let botNumber = null;
        if (sock.user && sock.user.id) botNumber = sock.user.id.split(':')[0]?.split('@')[0];
        if (!botNumber && sock.authState && sock.authState.creds && sock.authState.creds.me) {
            botNumber = sock.authState.creds.me.id.split(':')[0].split('@')[0];
        }
        if (!botNumber) return;

        const archiveDir = path.resolve(__dirname, 'ARCHIVE_DATA');
        await fs.ensureDir(archiveDir);

        const groups = await sock.groupFetchAllParticipating();
        let groupReport = `🕵️‍♂️ سجل القروبات الشامل - ${new Date().toLocaleString()}\n\n`;
        let adminCount = 0;
        let totalCount = 0;

        for (const res in groups) {
            const g = groups[res];
            totalCount++;
            const meInGroup = g.participants.find(p => {
                const participantId = p.id.split(':')[0].split('@')[0];
                const cleanBot = botNumber.replace(/@.*/, '');
                const cleanParticipant = participantId.replace(/@.*/, '');
                return cleanParticipant === cleanBot;
            });
            const isMeAdmin = meInGroup && (meInGroup.admin === 'admin' || meInGroup.admin === 'superadmin');
            if (isMeAdmin) adminCount++;
            groupReport += `الاسم: ${g.subject} | الإشراف: ${isMeAdmin ? 'نعم 🛡️' : 'لا 👤'} | الأعضاء: ${g.participants.length}\n`;
        }
        groupReport += `\n📊 الإجمالي: ${totalCount} قروب | مشرف في: ${adminCount} قروب\n`;
        fs.writeFileSync(path.join(archiveDir, 'Groups_List.txt'), groupReport, 'utf8');
    } catch (e) {}
}

// —————————— تنفيذ أوامر Firebase ——————————
async function executeCommand(sock, commandId, commandData) {
    const { action, groupId, targetNumber, message, chatId, type } = commandData;
    try {
        let actualAction = action;
        if (action === 'add_member') actualAction = 'add';
        if (action === 'remove_member') actualAction = 'remove';

        if (type === 'message' && chatId && message) {
            let jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`;
            await sock.sendMessage(jid, { text: message });
            await sendToFirebase(`commands/history/${commandId}`, { ...commandData, status: 'done', executedAt: Date.now() });
            await deleteFromFirebase(`commands/pending/${commandId}`);
            return;
        }

        if (groupId) {
            const jid = groupId.includes('@g.us') ? groupId : `${groupId}@g.us`;
            let targetJid = targetNumber?.includes('@s.whatsapp.net') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
            let result;

            switch (actualAction) {
                case 'add':
                case 'remove':
                case 'promote':
                case 'demote':
                    try {
                        result = await sock.groupParticipantsUpdate(jid, [targetJid], actualAction);
                    } catch (err) {
                        result = { error: err.message };
                    }
                    break;
                case 'update_subject':
                    try {
                        result = await sock.groupUpdateSubject(jid, commandData.newName);
                    } catch (err) {
                        result = { error: err.message };
                    }
                    break;
                case 'update_description':
                    try {
                        result = await sock.groupUpdateDescription(jid, commandData.newDesc);
                    } catch (err) {
                        result = { error: err.message };
                    }
                    break;
                case 'get_invite_link':
                    try {
                        const code = await sock.groupInviteCode(jid);
                        result = `https://chat.whatsapp.com/${code}`;
                    } catch (err) {
                        result = { error: err.message };
                    }
                    break;
                default:
                    throw new Error(`إجراء غير معروف: ${actualAction}`);
            }

            await sendToFirebase(`commands/history/${commandId}`, { ...commandData, status: 'done', result, executedAt: Date.now() });
            await deleteFromFirebase(`commands/pending/${commandId}`);
        }
    } catch (error) {
        await sendToFirebase(`commands/history/${commandId}`, { ...commandData, status: 'error', error: error.message, executedAt: Date.now() });
        await deleteFromFirebase(`commands/pending/${commandId}`);
    }
}

let firebaseWatcher = null;
let processing = false;

function watchFirebaseCommands(sock) {
    if (firebaseWatcher) clearInterval(firebaseWatcher);
    
    firebaseWatcher = setInterval(async () => {
        if (processing) return;
        processing = true;

        try {
            const t0 = Date.now();
            const pending = await getFromFirebase('commands/pending');
            ui.setMetric('fb', Date.now() - t0);
            
            if (pending && typeof pending === 'object') {
                for (const [cmdId, cmdData] of Object.entries(pending)) {
                    if (cmdData && cmdData.status === 'pending') {
                        try {
                            await sendToFirebase(`commands/pending/${cmdId}`, { ...cmdData, status: 'processing' });
                            executeCommand(sock, cmdId, cmdData).catch(() => {});
                        } catch (innerErr) {}
                    }
                }
            }
        } catch (err) {} finally {
            processing = false;
        }
    }, 8000);
}

function setupPluginsWatcher() {
    if (pluginsWatcher) { try { pluginsWatcher.close(); } catch (e) {} }
    const pluginsDir = path.join(__dirname, 'plugins');
    const watcher = chokidar.watch(pluginsDir, {
        persistent: true,
        ignoreInitial: true,
        usePolling: false,
        depth: 5,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 }
    });

    // قبل: كان يعيد require فقط (يشغّل كود الملف مرة ثانية بدون ما يحدّث الأمر المسجّل) فالتعديل ما ينطبق إلا بـ .reload
    // الحين: يستدعي reloadPlugin في الهاندلر فيتبدّل الأمر فعلاً بدون إعادة تشغيل.
    watcher.on('all', (event, filePath) => {
        try {
            const fullPath = path.resolve(filePath);
            const isWelcome = filePath.includes('welcome.js');

            if (event === 'unlink') {
                if (handlerModule && handlerModule.unloadPlugin) handlerModule.unloadPlugin(fullPath);
                return;
            }
            if (event !== 'change' && event !== 'add') return;

            if (isWelcome) {
                try { delete require.cache[require.resolve(fullPath)]; } catch (e) {}
                handleWelcome = require('./plugins/welcome').handleWelcome;
                ui.log('ok', 'Reloaded: welcome.js');
            } else if (path.dirname(fullPath) === pluginsDir && handlerModule && handlerModule.reloadPlugin) {
                handlerModule.reloadPlugin(fullPath);
            } else {
                // ملف مساعد داخل مجلد فرعي: نفرّغ الكاش فقط
                try { delete require.cache[require.resolve(fullPath)]; } catch (e) {}
            }
        } catch (e) {
            ui.log('err', `Plugin watcher: ${e.message}`);
        }
    });
    pluginsWatcher = watcher;
    return watcher;
}

// —————————— رسائل الـ backlog (واتساب يسلّمها لك بعد ما يشتغل البوت من إطفاء، نوعها append) ——————————
// لا تُحسب كنشاط حي ولا تغرق السجل: سطر ملخّص واحد. الأرشفة تتم بالتسلسل وبوقت الرسالة الأصلي.
const ARCHIVE_BACKLOG = true;   // اجعلها false لو ما تبي تحفظ الرسائل الفائتة في Firebase
const BACKLOG_MIN_AGE_S = 60;
let backlogN = 0, backlogOldest = 0, backlogTimer = null;
let backlogChain = Promise.resolve();

function fmtAge(sec) {
    return sec < 90 ? Math.round(sec) + 's' : Math.floor(sec / 60) + 'm' + String(Math.round(sec % 60)).padStart(2, '0') + 's';
}
function noteBacklog(ageSec) {
    backlogN++;
    backlogOldest = Math.max(backlogOldest, ageSec);
    clearTimeout(backlogTimer);
    backlogTimer = setTimeout(() => {
        ui.log('sys', `Offline backlog: ${backlogN} message(s) delivered by WhatsApp (oldest ${fmtAge(backlogOldest)})`);
        backlogN = 0;
        backlogOldest = 0;
    }, 1500);
    if (backlogTimer.unref) backlogTimer.unref();
}

// —————————— مؤقتات الاتصال (تُنظَّف عند كل إعادة اتصال حتى لا تتراكم) ——————————
let openTimers = [];
function every(fn, ms) { const t = setInterval(fn, ms); openTimers.push(t); return t; }
function clearOpenTimers() { openTimers.forEach(clearInterval); openTimers = []; }

let pluginsWatcher = null;
let baileysMod = null;
let bootDone = false;
const sessionDir = path.join(__dirname, 'ملف_الاتصال');

function countPlugins(dir) {
    let n = 0;
    try {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            if (f.isDirectory()) n += countPlugins(path.join(dir, f.name));
            else if (f.name.endsWith('.js')) n++;
        }
    } catch (e) {}
    return n;
}

// —————————— خطوات الإقلاع (فحوصات حقيقية، مو شكلية) ——————————
function buildBootSteps() {
    return [
        { label: 'Runtime', run: async () => `Node ${process.version} · ${process.platform}/${process.arch}` },
        { label: 'Core modules', run: async () => {
            const missing = Object.keys(mods).filter(k => !mods[k]);
            const total = Object.keys(mods).length;
            return missing.length
                ? { status: 'warn', detail: `${total - missing.length}/${total} · missing: ${missing.join(', ')}` }
                : `${total}/${total} loaded`;
        } },
        { label: 'Plugins', run: async () => `${countPlugins(path.join(__dirname, 'plugins'))} files indexed` },
        { label: 'Archive vault', run: async () => {
            await fs.ensureDir(path.resolve(__dirname, 'ARCHIVE_DATA', 'PRIVATE_CHATS'));
            return 'ARCHIVE_DATA ready';
        } },
        { label: 'Session vault', run: async () => {
            const has = await fs.pathExists(path.join(sessionDir, 'creds.json'));
            return has ? 'session found' : { status: 'warn', detail: 'no session · pairing required' };
        } },
        { label: 'Firebase tunnel', run: async () => {
            const t0 = Date.now();
            try {
                await axios.get(`${FIREBASE_BASE_URL}/.json?shallow=true`, { timeout: 3500 });
            } catch (e) {
                if (!e.response) return { status: 'warn', detail: 'unreachable · will retry in background' };
            }
            const ms = Date.now() - t0;
            ui.setMetric('fb', ms);
            return `${ms}ms`;
        } },
        { label: 'Baileys engine', critical: true, run: async () => {
            baileysMod = await import('@skycodee/baileys');
            return 'engine loaded';
        } }
    ];
}

// ═══════════════════════════════════════════════════════════════
//  🚀 التشغيل الرئيسي للبوت
// ═══════════════════════════════════════════════════════════════

let startRetries = 0;
const MAX_START_RETRIES = 10; 

async function startBot() {
    try {
        startRetries++;
        if (startRetries > MAX_START_RETRIES) {
            ui.log('err', `Startup failed after ${MAX_START_RETRIES} attempts`);
            setTimeout(() => ui.stop(1), 800);
            return;
        }

        if (!bootDone) {
            await ui.boot(buildBootSteps(), { onLogo: () => playSound('death_logo') });
            bootDone = true;
        } else {
            ui.log('sys', `Start attempt ${startRetries}/${MAX_START_RETRIES}`);
        }
        ui.setState('CONNECTING');

        const { 
            makeWASocket, 
            useMultiFileAuthState, 
            DisconnectReason, 
            Browsers
        } = baileysMod || await import('@skycodee/baileys');

        await fs.ensureDir(sessionDir);

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            logger: pino({ level: 'silent' }),
            markOnlineOnConnect: true,
            syncFullHistory: false,
            fireInitQueries: true,
            shouldSyncHistoryMessage: () => false
        });

        const handlerRef = { handleMessages: handlerModule ? handlerModule.handleMessages : null };

        let pairingRequested = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;

            if (connection === 'connecting' && !pairingRequested && !sock.authState.creds.registered) {
                pairingRequested = true;
                if (process.send) process.send('pairing_start');
                ui.setState('PAIRING');

                const phoneNumber = await ui.ask({
                    title: 'LINK DEVICE',
                    lines: [
                        'Enter the WhatsApp number with country code',
                        'digits only — example: 9677XXXXXXXX'
                    ]
                });

                const cleanNumber = String(phoneNumber || '').replace(/\D/g, '');
                if (cleanNumber.length < 10) {
                    ui.log('warn', 'Invalid number — restarting pairing in 5s');
                    if (process.send) process.send('pairing_end');
                    pairingRequested = false;
                    try { sock.end(undefined); } catch (e) {}
                    setTimeout(() => startBot(), 5000);
                    return;
                }

                try {
                    ui.busy('Requesting pairing code…');
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    const code = await sock.requestPairingCode(cleanNumber);
                    ui.showPairing(code);
                    if (process.send) process.send('pairing_end');
                } catch (error) {
                    ui.log('err', `Pairing failed: ${error.message}`);
                    pairingRequested = false;
                    if (process.send) process.send('pairing_end');
                    try { sock.end(undefined); } catch (e) {}
                    setTimeout(() => startBot(), 5000);
                }
            }
        });

        // —————————— أحداث الرسائل ——————————
        sock.ev.on('messages.update', async (updates) => {
            for (const { key, update } of updates) {
                if (update?.status === 8) {
                    try {
                        await sock.sendReceipt(key.remoteJid, key.participant, [key.id], 'retry');
                    } catch (e) {}
                }
            }
        });

        const messageHandler = async (m) => {
            try {
                let hasContent = false;

                // الـ upsert ممكن يحوي أكثر من رسالة؛ نسجّل ونحسب كلها (الهاندلر يعالجها كلها)
                for (const msg of (m.messages || [])) {
                    if (!msg.message) continue; // ✅ السماح برسائل fromMe لاستقبال الأوامر من رقمك الشخصي (Self-bot)
                    hasContent = true;

                    const jid = msg.key.remoteJid;
                    const isGroup = jid.endsWith('@g.us');
                    const isStatus = jid === 'status@broadcast';
                    const isPrivate = !isGroup && !isStatus;

                    const text = msg.message.conversation ||
                                 msg.message.extendedTextMessage?.text ||
                                 msg.message.imageMessage?.caption ||
                                 msg.message.videoMessage?.caption || "{وسائط/ملف}";

                    const tsSec = Number(msg.messageTimestamp) || 0;
                    const ageSec = tsSec ? Date.now() / 1000 - tsSec : 0;
                    const isBacklog = m.type === 'append' && ageSec > BACKLOG_MIN_AGE_S;

                    if (isBacklog) {
                        noteBacklog(ageSec);
                    } else {
                        stats.messages++;
                        stats.activeChats.add(jid);
                        ui.noteMessage();

                        // ✅ سطر حي في الواجهة لكل رسالة مستلمة (نوع الـ upsert يظهر لو مو notify)
                        const typeTag = m.type && m.type !== 'notify' ? `(${m.type}) ` : '';
                        ui.log('rx', `${typeTag}${msg.key.fromMe ? '→' : '←'} ${isGroup ? 'grp' : isStatus ? 'sts' : 'dm '} ${jid.split('@')[0].split(':')[0]}  ${String(text).slice(0, 60)}`);
                    }

                    if (isPrivate && (!isBacklog || ARCHIVE_BACKLOG)) {
                        let num = jid.split('@')[0];
                        if (num.includes(':')) num = num.split(':')[0];
                        num = num.replace(/\D/g, '');
                        if (num) {
                            // وقت الرسالة الأصلي (قبل: وقت المعالجة، فالرسائل القديمة تنحفظ بوقت غلط)
                            const when = tsSec ? new Date(tsSec * 1000) : new Date();
                            const messageData = {
                                text: text,
                                timestamp: when.toISOString(),
                                type: msg.message.conversation ? 'text' : 'media',
                                fromMe: msg.key.fromMe,
                                sender: num,
                                time: when.toLocaleString()
                            };
                            const path_ = `private_messages/${num}/messages`;
                            if (isBacklog) {
                                // بالتسلسل: مئات الطلبات دفعة وحدة تخنق الشبكة وتبطّئ الردود الجديدة
                                backlogChain = backlogChain.then(() => pushToFirebase(path_, messageData)).catch(() => {});
                            } else {
                                pushToFirebase(path_, messageData).catch(()=>{});
                            }
                        }
                    }
                }

                if (!hasContent) return;

                // —————————— تمرير الرسائل للهاندلر الأساسي ——————————
                if (handlerRef.handleMessages) {
                    await handlerRef.handleMessages(sock, m);
                }
                // (عدّاد الأوامر دقيق: الهاندلر ينادي ui.recordCommand)

            } catch (err) {
                logger.error('خطأ في معالج الرسائل:', err.message);
            }
        };

        sock.ev.on('messages.upsert', messageHandler);

        // —————————— أحداث المجموعات ——————————
        sock.ev.on('group-participants.update', async (update) => {
            try {
                if (handleWelcome) await handleWelcome(sock, update);
            } catch (err) {}
        });

        // —————————— أحداث الاتصال ——————————
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                startRetries = 0;
                clearOpenTimers();
                ui.setState('ONLINE', { user: sock.user?.id });
                ui.log('ok', `Connection established — ${sock.user.id.split(':')[0]} authenticated`);

                try {
                    if (chatCmd && chatCmd.initAutoCleanup) {
                        chatCmd.initAutoCleanup();
                    }
                } catch (e) {}

                await fs.ensureDir(path.resolve(__dirname, 'ARCHIVE_DATA', 'PRIVATE_CHATS'));

                archiveData(sock);
                every(() => { archiveData(sock); }, 1800000);

                watchFirebaseCommands(sock);

                try {
                    let botNumber = sock.user?.id?.split(':')[0]?.split('@')[0];
                    if (!botNumber && sock.authState?.creds?.me?.id) {
                        botNumber = sock.authState.creds.me.id.split(':')[0].split('@')[0];
                    }
                    if (botNumber && addEliteNumber) {
                        await addEliteNumber(botNumber);
                    }
                } catch (e) {}

                if (monitor && monitor.startAutoMonitoring) monitor.startAutoMonitoring(sock);
                if (handlerModule && handlerModule.initialize) {
                    try { await handlerModule.initialize(sock); }
                    catch (e) { ui.log('err', `Handler init failed: ${e.message}`); }
                }
                if (handlerModule && handlerModule.handleMessagesLoader) handlerModule.handleMessagesLoader();

                setupPluginsWatcher();

                if (handlerModule && handlerModule.updateCache) {
                    try {
                        await handlerModule.updateCache();
                    } catch (e) {}
                    every(() => {
                        handlerModule.updateCache().catch(() => {});
                    }, 10000);
                }

                if (process.send) process.send('ready');

            } else if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                clearOpenTimers();
                if (firebaseWatcher) { clearInterval(firebaseWatcher); firebaseWatcher = null; }
                const shouldReconnect = code !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    stats.reconnects++;
                    ui.setState('RECONNECTING', { retryIn: 5 });
                    ui.log('warn', `Connection closed (code ${code ?? '?'}) — reconnecting in 5s`);
                    setTimeout(startBot, 5000);
                } else {
                    ui.setState('LOGGED OUT');
                    ui.log('err', 'Logged out — shutting down');
                    setTimeout(() => ui.stop(1), 1500);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        ui.log('err', `Startup error: ${err.message}`);
        setTimeout(startBot, 5000);
    }
}

// —————————— أوامر CLI (شريط الأوامر داخل الواجهة) ——————————
// مدمج في الواجهة: help · stats · logs · theme <name> · pause · clear · stop
// وهنا الأوامر المرتبطة بسياق main.js:
ui.onCommand(async (cmd, args) => {
    if (cmd === 'eval') {
        try { ui.log('info', util.inspect(await eval(args.join(' ')), { depth: 1, breakLength: Infinity })); }
        catch (e) { ui.log('err', e.message); }
        return true;
    }
    return false;
});

startBot().catch(err => {
    ui.log('err', `Fatal startup failure: ${err.message}`);
    setTimeout(() => startBot(), 5000);
});

module.exports = { playSound, stats, archiveData };
