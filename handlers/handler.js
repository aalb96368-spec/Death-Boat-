// ═══════════════════════════════════════════════════════════════
//  main.js – النسخة الصاروخية (Ultra-Optimized) + حظر الرسائل القديمة + الحماية المتقدمة
// ═══════════════════════════════════════════════════════════════

// —————————— المكتبات الأساسية ——————————
const fs = require('fs-extra');
const pino = require('pino');
const path = require('path');
const chalk = require('chalk');
const readline = require('readline');
const { exec } = require('child_process');
const logger = require('./utils/console');
const chokidar = require('chokidar');
const os = require('os');
const util = require('util'); // 👈 تمت الإضافة لمعالجة الأخطاء والنصوص بشكل صحيح

// 🛡️ جدار حماية لمنع الانهيار وإغلاق البوت (Global Error Handlers)
// هذا سيمنع البوت من الإغلاق فجأة وتخريب الجلسة إذا حدث خطأ غير متوقع في أي أمر
process.on('uncaughtException', (err) => {
    logger.error(`[CRITICAL] خطأ قاتل تم منعه: ${err.message}`);
});
process.on('unhandledRejection', (err) => {
    logger.error(`[CRITICAL] رفض غير معالج تم منعه: ${err.message}`);
});

// —————————— استيراد الوحدات الداخلية ——————————
let chatCmd;
let addEliteNumber;
let monitor;
let handlerModule;

try { chatCmd = require('./commands/chat'); } catch(e) {}
try { addEliteNumber = require('./haykala/elite').addEliteNumber; } catch(e) {}
try { monitor = require('./tools/monitor'); } catch(e) {}
try { handlerModule = require('./handlers/handler'); } catch(e) {}

// —————————— أدوات مساعدة ——————————
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepRand = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1) + min));

// 🚀 توقيت إقلاع البوت (لحظر الرسائل اللي أُرسلت قبله)
const botStartTime = Math.floor(Date.now() / 1000);

// ✅ تعريف stats مع جميع الخصائص
const stats = {
    messages: 0,
    commands: 0,
    errors: 0,
    startTime: Date.now(),
    activeChats: new Set()
};

// ✅ التعديل هنا: تحويل logs إلى مصفوفة عادية لإصلاح مشكلة العرض في الواجهة
const screenConfig = {
    autoClear: true,
    updateInterval: 1500,
    lastClearTime: 0,
    logs: [] 
};

global.stats = stats;
global.screenConfig = screenConfig;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (text) => new Promise((resolve) => {
    rl.question(text, resolve);
});

// 🚀 تشغيل الصوت بطريقة غير متزامنة
function playSound(name) {
    fs.readFile(path.join(__dirname, 'sounds', 'sound.txt'), 'utf-8', (err, data) => {
        if (!err && data.trim() === '{on}') {
            const filePath = path.join(__dirname, 'sounds', `${name}.mp3`);
            fs.access(filePath, fs.constants.F_OK, (errAccess) => {
                if (!errAccess) exec(`mpv --no-terminal --really-quiet "${filePath}"`, () => {});
            });
        }
    });
}

// —————————— شعار DEATH ——————————
const deathLogo = [
    "██████╗ ███████╗███████╗████████╗██╗  ██╗",
    "██╔══██╗██╔════╝██╔════╝╚══██╔══╝██║  ██║",
    "██║  ██║█████╗  █████╗     ██║   ███████║",
    "██║  ██║██╔══╝  ██╔══╝     ██║   ██╔══██║",
    "██████╔╝███████╗███████╗   ██║   ██║  ██║",
    "╚═════╝ ╚══════╝╚══════╝   ╚═╝   ╚═╝  ╚═╝"
];

// —————————— قراءة الموارد (CPU) ——————————
let lastCpuInfo = os.cpus();
function getSystemCpuLoad() {
    const currentCpuInfo = os.cpus();
    let idleDiff = 0, totalDiff = 0;
    for (let i = 0; i < currentCpuInfo.length; i++) {
        const current = currentCpuInfo[i].times;
        const last = lastCpuInfo[i].times;
        const currentTotal = Object.values(current).reduce((a, b) => a + b);
        const lastTotal = Object.values(last).reduce((a, b) => a + b);
        totalDiff += currentTotal - lastTotal;
        idleDiff += current.idle - last.idle;
    }
    lastCpuInfo = currentCpuInfo;
    if (totalDiff === 0) return 0;
    return Math.min(Math.max((1 - (idleDiff / totalDiff)) * 100, 0), 100);
}

function getProgressBar(value, max, length = 15) {
    const percent = Math.min(Math.max(value / max, 0), 1);
    const filledLength = Math.round(length * percent);
    const emptyLength = length - filledLength;
    const filled = chalk.cyan('█'.repeat(filledLength));
    const empty = chalk.gray('░'.repeat(emptyLength));
    return `[${filled}${empty}] ${Math.round(percent * 100).toString().padStart(3, ' ')}%`;
}

// —————————— واجهة eDEX-UI ——————————
function updateStatusBar(sock) {
    if (!screenConfig.autoClear) return;
    const now = Date.now();
    if (now - screenConfig.lastClearTime < screenConfig.updateInterval) return;
    screenConfig.lastClearTime = now;

    const uptime = process.uptime();
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpuPercent = getSystemCpuLoad();
    const userName = sock?.user?.id?.split(':')[0]?.split('@')[0] || 'AWAITING_AUTH';
    const primaryColor = '#8A2BE2';
    const accentColor = '#00FFCC';

    const errorsCount = (stats && typeof stats.errors !== 'undefined') ? stats.errors : 0;
    const messagesCount = (stats && typeof stats.messages !== 'undefined') ? stats.messages : 0;
    const commandsCount = (stats && typeof stats.commands !== 'undefined') ? stats.commands : 0;

    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);

    console.log('\n');
    deathLogo.forEach(line => console.log(chalk.hex('#FF0000').bold(line.padStart(50))));
    console.log(chalk.gray(' '.repeat(53) + "[ SYSTEM ONLINE ]\n"));

    console.log(chalk.hex(primaryColor)('╔════════════════════════════════════════════════════════════════════════════╗'));
    console.log(chalk.hex(primaryColor)(`║  ${chalk.bold.white('DEATH SYSTEM - SHADOW CORE V3.2')}             ${chalk.hex(accentColor)('[ NETWORK STATUS: SECURE ]')}  ║`));
    console.log(chalk.hex(primaryColor)('╠════════════════════════════════════════╦═══════════════════════════════════╣'));
    console.log(chalk.hex(primaryColor)(`║  ${chalk.bold.red('HARDWARE METRICS (LIVE)')}               ║  ${chalk.bold.red('TELEMETRY & ACTIVITY')}             ║`));
    console.log(chalk.hex(primaryColor)(`║  CPU LOAD: ${getProgressBar(cpuPercent, 100, 12)}           ║  USER ID: ${chalk.hex(accentColor)(userName.padEnd(21))} ║`));
    console.log(chalk.hex(primaryColor)(`║  RAM USAGE: ${getProgressBar(usedMem, totalMem, 12)}          ║  MESSAGES: ${chalk.yellow(messagesCount.toString().padEnd(20))} ║`));
    console.log(chalk.hex(primaryColor)(`║  HEAP MEM: ${(mem.heapUsed / 1024 / 1024).toFixed(1).padStart(6)} MB                   ║  COMMANDS: ${chalk.magenta(commandsCount.toString().padEnd(20))} ║`));
    console.log(chalk.hex(primaryColor)(`║  UPTIME: ${chalk.hex(accentColor)(new Date(uptime * 1000).toISOString().substr(11, 8)).padEnd(22)} ║  ERRORS: ${chalk.red(errorsCount.toString().padEnd(22))} ║`));
    console.log(chalk.hex(primaryColor)('╠════════════════════════════════════════╩═══════════════════════════════════╣'));
    console.log(chalk.hex(primaryColor)(`║  ${chalk.bold.red('LIVE TERMINAL LOGS')}                                                        ║`));
    console.log(chalk.hex(primaryColor)('╟────────────────────────────────────────────────────────────────────────────╢'));

    // ✅ التعديل هنا: جلب آخر 8 سجلات بشكل صحيح مع الحفاظ على التنسيق
    const validLogs = (screenConfig && screenConfig.logs) ? screenConfig.logs.slice(-8) : [];
    
    // ملء الفراغات للحفاظ على تصميم الواجهة
    while (validLogs.length < 8) {
        validLogs.push(''); 
    }

    validLogs.forEach(log => {
        if (log) {
            // اقتطاع النص الطويل حتى لا يخرب إطار الواجهة (الجدول)
            const truncated = log.length > 72 ? log.substring(0, 69) + '...' : log.padEnd(72, ' ');
            console.log(chalk.hex(primaryColor)('║ ') + chalk.gray(`> ${truncated}`) + chalk.hex(primaryColor)(' ║'));
        } else {
            console.log(chalk.hex(primaryColor)('║ ') + chalk.gray('>                                                                        ') + chalk.hex(primaryColor)(' ║'));
        }
    });
    console.log(chalk.hex(primaryColor)('╚════════════════════════════════════════════════════════════════════════════╝'));
}

// —————————— نظام الإقلاع السينمائي ——————————
async function runBootSequence() {
    console.clear();
    const terminalWidth = process.stdout.columns || 80;
    const terminalHeight = process.stdout.rows || 24;

    const bootLogs = [
        "BIOS Check... OK",
        "Loading Kernel modules...",
        "Mounting File Systems... [Done]",
        "Initializing Cryptographic Keys...",
        "Allocating memory buffers...",
        "Loading Hardware Drivers...",
        "Verifying OS Integrity...",
        "Checking Real Hardware Metrics Interface... OK",
        "Establishing secure connection to DeathBot Nodes...",
        "Bypassing standard security protocols...",
        "Patching kernel for WhatsApp API...",
        "Optimizing Memory Circular Buffers...",
        "Injecting Shadow payloads...",
        "Finalizing System Shadow Core...",
        "System Ready. Handing over control to UI..."
    ];

    for (const log of bootLogs) {
        console.log(chalk.green(`[OK] `) + chalk.gray(log));
        await sleepRand(100, 300); 
    }
    await sleep(500);
    console.clear();

    playSound('death_logo');

    const padTop = Math.max(0, Math.floor((terminalHeight - deathLogo.length - 2) / 2));
    for(let i=0; i<padTop; i++) console.log();

    deathLogo.forEach(line => {
        const padLeft = Math.max(0, Math.floor((terminalWidth - line.length) / 2));
        console.log(' '.repeat(padLeft) + chalk.hex('#FF0000').bold(line));
    });

    const subText = "[ INITIALIZING MAIN DASHBOARD ]";
    const subPadLeft = Math.max(0, Math.floor((terminalWidth - subText.length) / 2));
    console.log('\n' + ' '.repeat(subPadLeft) + chalk.gray(subText));

    await sleep(2000);
    console.clear();
}

// —————————— نظام السجلات ——————————
const originalLogger = {...logger};
for (const method in originalLogger) {
    if (typeof logger[method] === 'function') {
        const original = logger[method];
        logger[method] = function(...args) {
            // ✅ التعديل هنا: تنظيف الألوان (ANSI) والصيغ لضمان عدم تخريب حدود واجهة eDEX
            const logStr = util.format(...args).replace(/\x1B\[[0-9;]*m/g, '').replace(/\n/g, ' '); 
            const logEntry = `[${method.toUpperCase()}] ${new Date().toLocaleTimeString('en-US', {hour12: false})} - ${logStr}`;
            
            if (screenConfig && screenConfig.logs) {
                screenConfig.logs.push(logEntry);
                if (screenConfig.logs.length > 500) screenConfig.logs.shift(); // الإبقاء على آخر 500 سجل فقط بدلاً من المؤشر الدائري المعقد
            }
            original.apply(this, args);
        };
    }
}

// —————————— أرشفة البيانات محلياً فقط ——————————
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

let pluginsWatcher = null;
function setupPluginsWatcher() {
    if (pluginsWatcher) pluginsWatcher.close(); 
    
    pluginsWatcher = chokidar.watch('./plugins', {
        persistent: true,
        ignoreInitial: true,
        usePolling: false, 
        depth: 2, 
        awaitWriteFinish: {
            stabilityThreshold: 500,
            pollInterval: 200
        }
    });

    pluginsWatcher.on('all', (event, filePath) => {
        if (event === 'change' || event === 'add') {
            try {
                const fullPath = path.resolve(filePath);
                if (require.resolve && require.cache[require.resolve(fullPath)]) {
                    delete require.cache[require.resolve(fullPath)];
                }
                require(fullPath);
                const actionText = event === 'add' ? 'إضافة ملف جديد' : 'تحديث ملف';
                logger.info(`[ PLUGINS HOT RELOAD ] 🔄 تم رصد ${actionText} وتحميله تلقائياً: ${filePath}`);
            } catch (e) {
                logger.error(`[ PLUGINS WATCHER ] ❌ خطأ أثناء إعادة تحميل الملف ${filePath}: ${e.message}`);
            }
        }
    });
}

// ═══════════════════════════════════════════════════════════════
//  🚀 التشغيل الرئيسي للبوت
// ═══════════════════════════════════════════════════════════════

let startRetries = 0;
const MAX_START_RETRIES = 3;

let archiveInterval = null;
let uiInterval = null;

async function startBot() {
    try {
        startRetries++;
        if (startRetries > MAX_START_RETRIES) {
            console.log(chalk.red.bold('\n❌ فشل تشغيل البوت بعد 3 محاولات.'));
            process.exit(1);
        }

        console.log(chalk.cyan(`\n🔄 محاولة التشغيل ${startRetries}/${MAX_START_RETRIES}`));

        await runBootSequence();

        // ✅ التعديل هنا: استيراد أداة الكاش الخاصة بالمفاتيح لحماية الجلسة
        const { 
            makeWASocket, 
            useMultiFileAuthState, 
            DisconnectReason,
            makeCacheableSignalKeyStore
        } = await import('@skycodee/baileys');

        const sessionDir = path.join(__dirname, 'ملف_الاتصال');
        await fs.ensureDir(sessionDir);

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const loggerPino = pino({ level: 'silent' });

        // ✅ التعديل هنا: إضافة حماية الجلسة وتخزين المفاتيح في الذاكرة (keys)
        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, loggerPino) 
            },
            printQRInTerminal: false,
            browser: ['Windows', 'Chrome', '114.0.5735.198'],
            logger: loggerPino,
            markOnlineOnConnect: true,
            syncFullHistory: false,
            fireInitQueries: false,
            shouldSyncHistoryMessage: () => false,
            recvWindow: 5000 
        });

        const handlerRef = { handleMessages: handlerModule ? handlerModule.handleMessages : null };

        let pairingRequested = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;

            if (connection === 'connecting' && !pairingRequested && !sock.authState.creds.registered) {
                pairingRequested = true;
                if (process.send) process.send('pairing_start');

                console.log(chalk.red.bold('\n        [ SYSTEM LOCK ]'));
                console.log(chalk.gray('  Authentication Required for Shadow Mode\n'));

                const phoneNumber = await new Promise((resolve) => {
                    const rlPair = readline.createInterface({
                        input: process.stdin,
                        output: process.stdout
                    });
                    rlPair.question(chalk.cyan(' ❯ Enter Target Identity (Phone + Code) [e.g., 967xxxx]: '), (answer) => {
                        rlPair.close();
                        resolve(answer);
                    });
                });

                const cleanNumber = phoneNumber.replace(/\D/g, '');
                if (cleanNumber.length < 10) {
                    console.log(chalk.red('\n [!] ERROR: Invalid Format.'));
                    if (process.send) process.send('pairing_end');
                    pairingRequested = false;
                    setTimeout(() => startBot(), 5000);
                    return;
                }

                try {
                    console.log(chalk.gray('\n [~] Bypassing security protocols... Requesting access...'));
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    const code = await sock.requestPairingCode(cleanNumber);
                    console.log(chalk.bgHex('#000000').green.bold('\n [!] ACCESS GRANTED. PAIRING CODE GENERATED: '));
                    console.log(chalk.bold.white(`\n      >>  ${code}  <<\n`));
                    console.log(chalk.gray(' [~] Enter this code in WhatsApp > Linked Devices > Link a Device > Enter Code'));
                    if (process.send) process.send('pairing_end');
                } catch (error) {
                    console.error(chalk.red('\n [!] ERROR: Connection refused.'), error.message);
                    pairingRequested = false;
                    if (process.send) process.send('pairing_end');
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
                const msg = m.messages[0];
                if (!msg || !msg.message) return; 

                // 🚀 جدار الحماية الزمني: تجاهل أي رسالة أُرسلت قبل تشغيل البوت الحالي
                const msgTimestamp = msg.messageTimestamp;
                if (msgTimestamp && msgTimestamp < botStartTime) {
                    return; 
                }

                stats.messages++;

                if (handlerRef.handleMessages) {
                    await handlerRef.handleMessages(sock, m);
                }
                stats.commands++;

            } catch (err) {
                stats.errors++;
                logger.error('خطأ في معالج الرسائل:', err.message);
            }
        };

        sock.ev.on('messages.upsert', messageHandler);

        // —————————— أحداث الاتصال ——————————
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                startRetries = 0;
                logger.info(
                    chalk.hex('#8A2BE2').bold('\n[ SYSTEM ] ') +
                    chalk.hex('#00FFCC')('CONNECTION ESTABLISHED: ') +
                    chalk.white(`${sock.user.id.split(':')[0]}@SHADOW_CORE`) +
                    chalk.gray(' [ AUTHENTICATED ]\n')
                );

                try {
                    if (chatCmd && chatCmd.initAutoCleanup) chatCmd.initAutoCleanup();
                } catch (e) {}

                await fs.ensureDir(path.resolve(__dirname, 'ARCHIVE_DATA', 'PRIVATE_CHATS'));

                if (archiveInterval) clearInterval(archiveInterval);
                archiveData(sock);
                archiveInterval = setInterval(() => { archiveData(sock); }, 180000);

                try {
                    let botNumber = sock.user?.id?.split(':')[0]?.split('@')[0];
                    if (!botNumber && sock.authState?.creds?.me?.id) {
                        botNumber = sock.authState.creds.me.id.split(':')[0].split('@')[0];
                    }
                    if (botNumber && addEliteNumber) await addEliteNumber(botNumber);
                } catch (e) {}

                if (monitor && monitor.startAutoMonitoring) monitor.startAutoMonitoring(sock);
                if (handlerModule && handlerModule.handleMessagesLoader) handlerModule.handleMessagesLoader();

                setupPluginsWatcher();

                if (uiInterval) clearInterval(uiInterval);
                uiInterval = setInterval(() => updateStatusBar(sock), 2500);

                if (process.send) process.send('ready');

            } else if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log(chalk.yellow('🔄 إعادة الاتصال خلال 5 ثوانٍ...'));
                    setTimeout(startBot, 5000);
                } else {
                    console.log(chalk.red('❌ تم تسجيل الخروج، إنهاء البوت.'));
                    process.exit(1);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        console.error(chalk.red(`❌ خطأ: ${err.message}`));
        console.error(err.stack);
        setTimeout(startBot, 5000);
    }
}

// —————————— أوامر CLI ——————————
rl.on('line', async (line) => {
    const [command, ...args] = line.trim().split(/\s+/);
    switch (command.toLowerCase()) {
        case 'stats': console.log(stats); break;
        case 'clear': console.clear(); break;
        case 'stop': process.exit(0); break;
        case 'logs': console.log((screenConfig && screenConfig.logs) ? screenConfig.logs.filter(Boolean).slice(-15).join('\n') : 'لا توجد سجلات'); break;
        case 'eval':
            try { console.log(eval(args.join(' '))); } catch (e) { console.log(e.message); }
            break;
    }
});

startBot().catch(err => {
    console.error('❌ فشل تشغيل البوت:', err);
    setTimeout(() => startBot(), 5000);
});

module.exports = { playSound, stats, archiveData };
