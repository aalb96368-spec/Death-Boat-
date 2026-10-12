// ═══════════════════════════════════════════════════════════════
//  index.js – MASTER NODE (المشغّل)
//  يشغّل main.js كعملية فرعية ويعيد تشغيله عند الانهيار.
//  تعديلات الواجهة الجديدة: رسائله تمر عبر IPC لسجل الواجهة (ما تطبع فوقها)،
//  وتصليح مؤقتات كانت تعيد تشغيل البوت بعد ما توقفه.
// ═══════════════════════════════════════════════════════════════
const { fork } = require('child_process');
const { join } = require('path');
const chalk = require('chalk');
const fs = require('fs-extra');

const PRINT = {
    sys:  (m) => console.log(chalk.hex('#8A2BE2')('[ MASTER NODE ] ') + chalk.gray(m)),
    warn: (m) => console.log(chalk.hex('#FFFF00')('[ WARNING ] ') + chalk.yellow(m)),
    err:  (m) => console.log(chalk.hex('#FF0000')('[ FATAL ] ') + chalk.red(m)),
    ok:   (m) => console.log(chalk.hex('#00FFCC')('[ SUCCESS ] ') + chalk.cyan(m))
};

const maxRetries = 3;
const retryDelay = 5000;

let isRunning = false;
let isPairing = false;     // يتتبع حالة الاقتران
let child = null;
let uiActive = false;      // الواجهة شغالة داخل الـ child؟
let shuttingDown = false;  // المستخدم طلب الإيقاف: لا إعادة تشغيل

// [FIX] طباعة المشغّل فوق واجهة الـ child كانت تخرّب الشاشة (الواجهة تحدّث الأسطر المتغيرة فقط فالتخريب يبقى).
// لو الواجهة شغالة نمرر الرسالة للـ child عشان تظهر داخل السجل الحي، وإلا نطبع عادي.
function say(level, msg) {
    if (uiActive && child && child.connected) {
        try { child.send({ __ui: [level, msg] }); return; } catch (e) {}
    }
    (PRINT[level] || PRINT.sys)(msg);
}

function handleConnection(retry = 0) {
    if (isRunning || shuttingDown) return;

    const connectionFolder = join(process.cwd(), 'ملف_الاتصال');
    if (!fs.existsSync(connectionFolder)) {
        say('warn', 'Session directory missing. Proceeding with initial setup sequence...');
    }

    isRunning = true;
    const me = fork(join(__dirname, 'main.js'), [], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, CONNECTION_FOLDER: connectionFolder }
    });
    child = me;

    let ready = false;
    let softReboot = false;

    // [FIX] المؤقت القديم (120 ثانية) كان: (1) ما ينلغي عند الخروج، فبعد ما توقف البوت بـ stop/Ctrl+C
    // يرجع يشغّله من جديد؛ (2) شرطه child.connected دايم true فما كان يسوي شي مفيد.
    // الحين: تنبيه فقط إذا ما وصلت إشارة ready، بدون قتل أي شي (قتل العملية أثناء الاقتران يخرّب الربط).
    const readyWarn = setTimeout(() => {
        if (!ready && !isPairing && me.connected) {
            say('warn', 'No ready signal after 120s - still waiting (check network / session).');
        }
    }, 120000);

    me.on('message', (data) => {
        if (data === 'ui_on') {
            uiActive = true;
        } else if (data === 'ready') {
            ready = true;
            retry = 0;            // [FIX] قبل: العدّاد ما يتصفر، وبعد 3 انهيارات متفرقة (بينها أيام) يوقف النظام نهائياً
            isPairing = false;
            say('ok', 'Shadow Core online and securely attached.');
        } else if (data === 'pairing_start') {
            isPairing = true;
            say('warn', 'Pairing process started. Waiting for user input...');
        } else if (data === 'pairing_end') {
            // [FIX] نترك الحالة "اقتران" لين ready: المستخدم للحين يدخل الكود في واتساب
            say('sys', 'Pairing code issued. Waiting for link...');
        } else if (data === 'reset') {
            if (isPairing) {
                say('warn', 'Reset request ignored (pairing in progress).');
            } else {
                say('warn', 'Soft reboot requested by internal process...');
                softReboot = true;
                me.kill();
            }
        } else if (data === 'uptime') {
            me.send(process.uptime());
        }
    });

    me.on('exit', async (code, signal) => {
        clearTimeout(readyWarn);
        isRunning = false;
        uiActive = false;      // من هنا الطباعة صارت على الشاشة العادية (الواجهة طلعت)
        isPairing = false;
        child = null;

        if (shuttingDown) return;

        if (softReboot) {
            setTimeout(() => handleConnection(0), 2000);
            return;
        }

        if (code === 0) {
            say('sys', 'Shadow Core gracefully disconnected.');
            return;
        }

        if (code === 429) {
            say('warn', 'Rate limit exceeded (Code 429). Tactical cooldown...');
            await delay(10000);
            return handleConnection(retry);
        }

        if (retry < maxRetries) {
            retry++;
            say('warn', `Recovery attempt (${retry}/${maxRetries}) in ${retryDelay / 1000}s... (exit ${code ?? signal})`);
            await delay(retryDelay);
            handleConnection(retry);
        } else {
            say('err', 'Maximum recovery attempts reached. System halt.');
            process.exit(1);
        }
    });

    me.on('error', (err) => {
        clearTimeout(readyWarn);
        isRunning = false;
        uiActive = false;
        say('err', `Sub-process critical failure: ${err.message}`);
        if (retry < maxRetries) {
            retry++;
            setTimeout(() => handleConnection(retry), retryDelay);
        } else {
            say('err', 'Maximum recovery attempts reached. System halt.');
            process.exit(1);
        }
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function shutdown(why) {
    shuttingDown = true;
    uiActive = false;
    PRINT.sys(why);
    if (child) { try { child.kill('SIGTERM'); } catch (e) {} }
    setTimeout(() => process.exit(0), 600);
}
process.on('SIGINT', () => shutdown('Manual interrupt received. Shutting down...'));
process.on('SIGTERM', () => shutdown('Termination requested. Shutting down...'));

process.on('uncaughtException', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'rate-overlimit') return;
    say('err', `Uncaught Exception: ${err.stack || err}`);
});

process.on('unhandledRejection', (reason) => {
    if (reason?.code === 429) return;
    say('err', `Unhandled Promise Rejection: ${reason}`);
});

// الإقلاع السينمائي صار داخل main.js (utils/deathui.js)، هنا سطر واحد فقط
PRINT.sys('Launching SHADOW CORE...');
handleConnection();
