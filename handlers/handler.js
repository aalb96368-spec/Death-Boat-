// 🚀 handler.js - النسخة النهائية مع دعم استجابات الأزرار
const { loadPlugins: loadExternalPlugins } = require('./plugins');
const config = require('../config');
const logger = require('../utils/console');
const fs = require('fs-extra');
const path = require('path');
const { isElite } = require('../haykala/elite');
// [FIX 9] حذفت require('../main'): غير مستخدم، وكان يسبب require دائري (ولو تشغّل الملف لحاله يشغّل بوت ثاني!)
const { performance } = require('perf_hooks');

// ==========================================
// ✅ التأكد من وجود config.logging (حماية من الأخطاء)
// ==========================================
if (!config.logging) {
    config.logging = {
        level: 'info',
        type: 'console',
        maxLogs: 500,
        saveToFile: false,
        logFilePath: './logs/bot.log'
    };
}
if (!config.logging.type) config.logging.type = 'console';
if (!config.logging.level) config.logging.level = 'info';

// ==========================================
// ✅ التأكد من وجود config.messages
// ==========================================
if (!config.messages) {
    config.messages = {};
}
const defaultMessages = {
    error: '❌ حدث خطأ أثناء تنفيذ الأمر',
    ownerOnly: '👑 هذا الأمر للمالك فقط.',
    groupOnly: '👥 هذا الأمر للمجموعات فقط.',
    notFound: '❓ الأمر غير معروف.',
    noPermission: '⛔ ليس لديك صلاحية لاستخدام هذا الأمر',
    notAllowedGroup: '🚫 عذراً، البوت لا يعمل في هذه المجموعة',
    cooldown: '⏳ انتظر {time} ثانية قبل إعادة المحاولة'
};
for (const [key, value] of Object.entries(defaultMessages)) {
    if (!config.messages[key]) {
        config.messages[key] = value;
    }
}

// ==========================================
// ✅ الأوامر المتاحة للجميع (استثناء من فلتر النخبة)
// ==========================================
const PUBLIC_COMMANDS = ['help', 'menu', 'اوامر', 'مساعده'];

// ==========================================
// 1️⃣ بنية بيانات محسّنة مع TTL
// ==========================================
const cache = {
    commands: new Map(),
    botStatus: { value: null, lastUpdate: 0, duration: 5000 },
    eliteMode: { value: null, lastUpdate: 0, duration: 10000 },
    gamesStatus: { value: null, lastUpdate: 0, duration: 15000 },
    antispamStatus: { value: null, lastUpdate: 0, duration: 20000 },
    userRateLimits: new Map(),
    globalRateLimit: { hits: 0, windowStart: Date.now(), notified: false }
};

// ==========================================
// 2️⃣ Constants & Security Config
// ==========================================
const OWNER_NUMBER = "967733584324";
const FORBIDDEN_COMMANDS = ['تخريب', 'hack', 'destruct', 'crash', 'exec', 'eval', 'shell'];
const MAX_COMMAND_NAME_LENGTH = 50;
const RATE_LIMIT_WINDOW = 60000;
const GLOBAL_MAX_REQUESTS = Number(config.rateLimit?.globalPerMinute) || 60; // [FIX 1] لكل نافذة (دقيقة)
const PLUGINS_DIR = path.join(__dirname, '../plugins');
const MAX_MESSAGE_AGE_S = Number(config.maxMessageAgeSeconds) || 600; // [FIX 4] تجاهل رسائل أقدم من 10 دقايق (backlog بعد انقطاع)
const LATE_WARN_S = 15;        // [FIX 8] تنبيه إذا الأمر وصل متأخر
const SLOW_COMMAND_MS = 10000; // [FIX 8] تنبيه إذا الأمر طوّل
const fmtAge = (s) => (s < 90 ? Math.round(s) + 's' : Math.floor(s / 60) + 'm' + String(Math.round(s % 60)).padStart(2, '0') + 's');
const USER_MAX_REQUESTS = 10;

// ==========================================
// 3️⃣ Logging System
// ==========================================
const createLogger = (namespace) => ({
    success: (msg) => logger.success(`✅ [${namespace}] ${msg}`),
    error: (msg, err) => {
        // [FIX 10] نبقي أول سطرين من الـ stack (فيهم اسم الملف والسطر) بدل سطر واحد
        const detail = err
            ? ' | ' + (err.stack ? err.stack.split('\n').slice(0, 2).map(s => s.trim()).join(' <- ') : (err.message || err))
            : '';
        logger.error(`❌ [${namespace}] ${msg}${detail}`);
    },
    warn: (msg) => logger.warn(`⚠️ [${namespace}] ${msg}`),
    info: (msg) => logger.info(`ℹ️ [${namespace}] ${msg}`)
});

// 🐞 وضع التشخيص: يطبع مراحل المعالجة. اجعله false بعد ما تنحل المشكلة
const DEBUG = false; // ✅ تم التعديل: إيقاف وضع التشخيص نهائياً لتسريع البوت
const dbg = (...a) => { if (DEBUG) console.log('[DEBUG]', ...a); };

const systemLogger = createLogger('SYSTEM');
const cmdLogger = createLogger('COMMAND');
const securityLogger = createLogger('SECURITY');

// ==========================================
// 4️⃣ Rate Limiting Engine
// ==========================================
function checkRateLimit(senderNumber, bypass = false) {
    if (bypass) return { allowed: true }; // [FIX 1] المالك/رقم البوت ما ينحسبون
    const now = Date.now();
    const g = cache.globalRateLimit;

    // [FIX 1] نافذة عامة = دقيقة (كانت 5 دقايق ثابتة وتقفل كل الأوامر على الجميع)
    if (now - g.windowStart > RATE_LIMIT_WINDOW) {
        g.hits = 0;
        g.windowStart = now;
        g.notified = false;
        if (cache.userRateLimits.size > 500) cache.userRateLimits.clear();
    }

    if (g.hits >= GLOBAL_MAX_REQUESTS) {
        const first = !g.notified;
        g.notified = true;
        if (first) securityLogger.warn(`Global rate limit exceeded: ${g.hits}`);
        return { allowed: false, reason: 'global', silent: !first };
    }

    const userLimit = cache.userRateLimits.get(senderNumber) || { hits: [], notified: false };
    userLimit.hits = userLimit.hits.filter(time => now - time < RATE_LIMIT_WINDOW);

    if (userLimit.hits.length >= USER_MAX_REQUESTS) {
        const retryAfter = Math.ceil((RATE_LIMIT_WINDOW - (now - userLimit.hits[0])) / 1000);
        const first = !userLimit.notified;
        userLimit.notified = true;
        cache.userRateLimits.set(senderNumber, userLimit);
        if (first) securityLogger.warn(`User rate limit: ${senderNumber} | Retry after: ${retryAfter}s`);
        // [FIX 1] رد "انتظر" مرة وحدة فقط لكل نافذة (كان يرد على كل رسالة = سبام + خطر حظر)
        return { allowed: false, reason: 'user', retryAfter, silent: !first };
    }

    userLimit.notified = false;
    userLimit.hits.push(now);
    cache.userRateLimits.set(senderNumber, userLimit);
    g.hits++; // [FIX 1] يُحسب الطلب المقبول فقط (قبل: المزعج كان يستهلك حصة الجميع حتى لو انرفض)

    return { allowed: true };
}

// ==========================================
// 5️⃣ Cooldown System
// ==========================================
function checkCooldown(command, senderNumber) {
    if (!command.cooldown) return { allowed: true };
    if (!command.lastUsed) command.lastUsed = new Map();

    const now = Date.now();
    const lastUsed = command.lastUsed.get(senderNumber) || 0;
    const timeLeft = command.cooldown - Math.floor((now - lastUsed) / 1000);

    return timeLeft > 0 ? { allowed: false, timeLeft } : { allowed: true };
}

// [FIX 5] التسجيل بعد نجاح فحص الصلاحيات (قبل: يُحسب الكولداون حتى لو انرفض الأمر)
function commitCooldown(command, senderNumber) {
    if (!command.cooldown) return;
    if (!command.lastUsed) command.lastUsed = new Map();

    const now = Date.now();
    if (command.lastUsed.size > 100) {
        for (const [user, time] of command.lastUsed.entries()) {
            if (now - time > command.cooldown * 1000) command.lastUsed.delete(user);
        }
    }
    command.lastUsed.set(senderNumber, now);
}

// ==========================================
// 6️⃣ Message Parser
// ==========================================
// [FIX 3] فك الأغلفة في مكان واحد (كشف الأزرار كان يفشل في المحادثات المؤقتة لأنه ما يفك الغلاف)
function unwrapMessage(msg) {
    for (let i = 0; i < 5 && msg; i++) {
        const inner = msg.ephemeralMessage?.message
            || msg.viewOnceMessage?.message
            || msg.viewOnceMessageV2?.message
            || msg.documentWithCaptionMessage?.message
            || msg.deviceSentMessage?.message;
        if (!inner) break;
        msg = inner;
    }
    return msg;
}

function extractMessageText(message) {
    try {
        let msg = message.message;
        if (!msg) return null;

        // فك الأغلفة (رسائل مؤقتة / عرض مرة واحدة / مستند بتعليق)
        msg = unwrapMessage(msg);

        const textSources = [
            msg.conversation,
            msg.extendedTextMessage?.text,
            msg.imageMessage?.caption,
            msg.videoMessage?.caption,
            msg.documentMessage?.caption,
            msg.buttonsResponseMessage?.selectedDisplayText,
            msg.listResponseMessage?.title,
            msg.templateButtonReplyMessage?.selectedDisplayText,
            msg.viewOnceMessage?.message?.imageMessage?.caption,
            msg.viewOnceMessage?.message?.videoMessage?.caption
        ];

        return textSources.find(text => typeof text === 'string' && text.trim())?.trim() || null;
    } catch (error) {
        systemLogger.error('Failed to extract message text', error);
        return null;
    }
}

function botNumberOf(sock) {
    return sock?.user?.id?.split(':')[0]?.split('@')[0] || null;
}

// نفس طريقة الأصل (تُستخدم لمسار الأزرار/الأرقام عشان ما نكسر جلسات الإضافات)
function rawSenderNumber(message) {
    const sender = message.key.participant || message.key.remoteJid;
    return sender.split('@')[0];
}

function getSenderInfo(message, sock) {
    try {
        const remoteJid = message.key.remoteJid || '';
        const isGroup = remoteJid.endsWith('@g.us');

        const k = message.key;
        const pick = (...jids) => jids.find(j => typeof j === 'string' && j.endsWith('@s.whatsapp.net'))
            || jids.find(j => typeof j === 'string');
        const senderJid = isGroup
            ? pick(k.participantAlt, k.participantPn, k.participant)
            : pick(k.remoteJidAlt, k.senderPn, remoteJid);

        let number = senderJid?.split('@')[0]?.split(':')[0];

        // [FIX 6] الرسالة منك (fromMe) في خاص: remoteJid هو الطرف الثاني، فكان يُحسب "المرسل" = الشخص الثاني
        // ويتجاهلك فلتر النخبة. الصحيح: المرسل هو حساب البوت نفسه.
        if (message.key.fromMe) {
            const me = botNumberOf(sock);
            if (me) number = me;
        }

        return {
            number,
            isGroup,
            remoteJid,
            messageId: message.key.id,
            timestamp: message.messageTimestamp || Math.floor(Date.now() / 1000)
        };
    } catch (error) {
        systemLogger.error('Failed to get sender info', error);
        return null;
    }
}

// ==========================================
// 7️⃣ Cache Manager
// ==========================================
async function updateCache() {
    const now = Date.now();
    const dataDir = path.join(__dirname, '../data');

    const updateCacheEntry = async (key, fileName) => {
        const entry = cache[key];
        if (now - entry.lastUpdate < entry.duration) return;
        
        try {
            const filePath = path.join(dataDir, fileName);
            const content = await fs.readFile(filePath, 'utf8').catch(() => null);
            const next = content ? content.trim() : null;
            const changed = next !== entry.value;
            entry.value = next;
            entry.lastUpdate = now;
            // [FIX 7] نسجل فقط لما القيمة تتغير (قبل: سطر لوق كل 10-20 ثانية يغرق الشاشة)
            if (changed) systemLogger.info(`Cache ${key} -> ${next === null ? 'empty' : next}`);
        } catch (error) {
            systemLogger.error(`Failed to update cache: ${key}`, error?.message || error);
        }
    };

    await updateCacheEntry('botStatus', 'bot.txt');
    await updateCacheEntry('eliteMode', 'mode.txt');
    await updateCacheEntry('gamesStatus', 'games.txt');
    await updateCacheEntry('antispamStatus', 'antispam.txt');
}

// ==========================================
// 8️⃣ Command Registration
// ==========================================
function cmd(options = {}) {
    if (!options.name || typeof options.exec !== 'function') {
        throw new Error('❌ اسم الأمر ودالة التنفيذ إلزامية');
    }

    const commandKey = options.name.toLowerCase().trim();
    
    if (commandKey.length > MAX_COMMAND_NAME_LENGTH) {
        throw new Error(`❌ اسم الأمر طويل جداً: ${commandKey}`);
    }

    if (cache.commands.has(commandKey)) {
        cmdLogger.warn(`Duplicate command ignored: "${commandKey}"`);
        return;
    }

    const allNames = [commandKey, ...(options.aliases || []).map(a => a.toLowerCase().trim())];
    if (allNames.some(name => FORBIDDEN_COMMANDS.includes(name))) {
        securityLogger.warn(`Blocked dangerous command: ${commandKey}`);
        throw new Error(`❌ الأمر "${commandKey}" محظور لأسباب أمنية`);
    }

    cache.commands.set(commandKey, {
        name: options.name,
        aliases: allNames.slice(1),
        exec: options.exec,
        description: options.description || '',
        usage: options.usage || '',
        category: options.category || 'عام',
        cooldown: Math.max(0, options.cooldown || 0),
        owner: Boolean(options.owner),
        group: Boolean(options.group),
        elite: Boolean(options.elite),
        lastUsed: new Map(), 
        stats: { total: 0, errors: 0, avgExecTime: 0 },
        handleButton: options.handleButton || null // ✅ دعم الأزرار
    });

    // [FIX 7] كان يطبع سطر نجاح لكل أمر عند الإقلاع (ويُحسب كأنه أمر منفّذ في الواجهة)
    if (DEBUG) cmdLogger.info(`Registered: ${options.name} | Category: ${options.category}`);
}

// ==========================================
// 9️⃣ Internal Commands
// ==========================================
function registerInternalCommands() {
    cmd({
        name: 'help',
        aliases: ['menu', 'اوامر', 'مساعده'],
        description: '📜 عرض قائمة الأوامر المنظمة',
        usage: '.help [category]',
        category: 'General',
        exec: async (sock, m, args) => {
            const start = performance.now();
            const category = args[0]?.toLowerCase();
            const prefix = config.prefix || '.';
            
            const visibleCommands = Array.from(cache.commands.values()).filter(cmd => !cmd.isHiddenAlias);
            
            let text = `*\`[ ⎔ DEATH BOT SYSTEM ⎔ ]\`*\n\n`;
            text += `*👑 المالك :* ${config.ownerName || '.𝑫𝑬𝑨𝑻𝑯 𝑬𝑵𝑫.'}\n`;
            text += `*🤖 البوت :* ${config.botName || 'DEATH bot'}\n`;
            text += `*⚙️ البادئة :* \`[ ${prefix} ]\`\n`;
            text += `*📊 إجمالي الأوامر :* ${visibleCommands.length}\n`;
            // [FIX 8] القيمة القديمة كانت تقيس وقت بناء النص قبل الإرسال (دايم ~0ms). الحين: الفرق بين وقت إرسال الرسالة ووقت الرد
            const sentTs = Number(m.messageTimestamp) || 0;
            const delayMs = sentTs ? Math.max(0, Date.now() - sentTs * 1000) : null;
            text += `*⏱️ سرعة الاستجابة :* ${delayMs === null ? '--' : delayMs + 'ms'}\n`;
            text += `━─━─━─━─━─━─━─━─━─━\n\n`;

            const categories = {};
            visibleCommands.forEach(cmd => {
                const cat = cmd.category || 'عام';
                if (!categories[cat]) categories[cat] = [];
                if (!categories[cat].find(c => c.name === cmd.name)) {
                    categories[cat].push(cmd);
                }
            });

            const sortedCats = Object.entries(categories).sort((a, b) => a[0].localeCompare(b[0]));

            if (category) {
                const catCmds = categories[category];
                if (!catCmds) {
                    await sock.sendMessage(m.key.remoteJid, { text: `❌ القسم *${category}* غير موجود. استعمل ${prefix}help لعرض الأقسام.` }, { quoted: m });
                    return;
                }
                text += `*\`[ ✦ قـسـم: ${category.toUpperCase()} ✦ ]\`*\n\n`;
                catCmds.forEach(cmd => {
                    text += `⎔ *${prefix}${cmd.name}*\n`;
                    if (cmd.description) text += `  └ ◦ ${cmd.description}\n`;
                    if (cmd.usage) text += `  └ ◦ الاستخدام: \`${cmd.usage}\`\n`;
                });
            } else {
                sortedCats.forEach(([cat, cmds]) => {
                    text += `*\`[ ✦ ${cat.toUpperCase()} ✦ ]\`*\n`;
                    cmds.forEach(cmd => {
                        text += `⎔ *${prefix}${cmd.name}*\n`;
                        if (cmd.description) text += `  └ ◦ ${cmd.description}\n`;
                    });
                    text += `\n`;
                });
            }

            text += `> 💡 *تلميح:* لمعرفة تفاصيل قسم معين اكتب *${prefix}help <اسم_القسم>*\n`;
            await sock.sendMessage(m.key.remoteJid, { text: text }, { quoted: m });
        }
    });

    cmd({
        name: 'reload',
        description: 'إعادة تحميل الإضافات مع تحديث الكاش',
        usage: '.reload',
        category: 'مالك',
        owner: true,
        cooldown: 30,
        exec: async (sock, m) => {
            const start = performance.now();
            const oldCommands = new Map(cache.commands);
            
            try {
                cache.commands.clear();
                cache.userRateLimits.clear();
                pluginFiles.clear();
                
                registerInternalCommands();
                await initializePlugins(sock);
                
                const execTime = (performance.now() - start).toFixed(2);
                await sock.sendMessage(m.key.remoteJid, { text: `✅ تم Reload في ${execTime}ms\n📊 الأوامر: ${cache.commands.size}` }, { quoted: m });
                
                systemLogger.success(`Reload completed in ${execTime}ms`);
            } catch (error) {
                cache.commands.clear();
                for (const [k, v] of oldCommands) cache.commands.set(k, v);
                systemLogger.error('Reload failed', error);
                await sock.sendMessage(m.key.remoteJid, { text: `❌ فشل Reload: ${error.message}` }, { quoted: m });
            }
        }
    });
}

// ==========================================
// 🔟 Plugin Loader
// ==========================================
const pluginFiles = new Map(); // اسم الملف -> اسم الأمر (للتحميل الساخن والحذف)

function removeCommand(cmdName) {
    for (const [key, value] of cache.commands) {
        if (key === cmdName || value.name === cmdName) cache.commands.delete(key);
    }
}

// [FIX 2] كان نفس الكود مكرر 3 مرات (initializePlugins / watchPlugins / main.js). الحين مكان واحد.
function loadPluginFile(filePath, { replace = false } = {}) {
    const start = performance.now();
    delete require.cache[require.resolve(filePath)];
    const plugin = require(filePath);

    if (!plugin.command || typeof plugin.execute !== 'function') {
        return { ok: false, reason: 'invalid plugin structure' };
    }

    const cmdName = plugin.command.toLowerCase().trim();
    const aliases = (plugin.aliases || []).map(a => a.toLowerCase().trim());
    const fileName = path.basename(filePath);
    const prevName = pluginFiles.get(fileName);

    // نحتفظ بنسخة احتياطية: لو فشل التسجيل نرجّع الأمر القديم بدل ما نفقده
    const backup = replace
        ? [...cache.commands].filter(([k, v]) => k === cmdName || v.name === cmdName || (prevName && (k === prevName || v.name === prevName)))
        : [];

    try {
        if (replace) {
            if (prevName) removeCommand(prevName);
            removeCommand(cmdName);
        }

        cmd({
            name: cmdName,
            description: plugin.desc || '',
            usage: plugin.usage || '',
            category: plugin.category || 'عام',
            owner: Boolean(plugin.owner),
            elite: Boolean(plugin.elite),
            group: Boolean(plugin.group),
            cooldown: Math.max(0, plugin.cooldown || 0),
            aliases: aliases,
            exec: plugin.execute,
            handleButton: plugin.handleButton || null // ✅ دعم الأزرار
        });

        const mainCmdObj = cache.commands.get(cmdName);
        if (!mainCmdObj || mainCmdObj.exec !== plugin.execute) {
            backup.forEach(([k, v]) => cache.commands.set(k, v));
            return { ok: false, reason: 'duplicate command name' };
        }

        aliases.forEach(alias => {
            if (alias && !cache.commands.has(alias)) {
                cache.commands.set(alias, { ...mainCmdObj, name: cmdName, isHiddenAlias: true });
            }
        });

        pluginFiles.set(fileName, cmdName);
        return { ok: true, name: cmdName, ms: performance.now() - start };
    } catch (err) {
        backup.forEach(([k, v]) => cache.commands.set(k, v));
        throw err;
    }
}

async function initializePlugins(sock = null) {
    const files = await fs.readdir(PLUGINS_DIR).catch(() => []);
    const results = { loaded: 0, failed: 0, skipped: 0 };
    const t0 = performance.now();

    for (const file of files) {
        if (!file.endsWith('.js') || file.startsWith('.')) {
            results.skipped++;
            continue;
        }

        try {
            const r = loadPluginFile(path.join(PLUGINS_DIR, file));
            if (!r.ok) {
                systemLogger.warn(`Skipped ${file}: ${r.reason}`);
                results.failed++;
            } else {
                results.loaded++;
                if (r.ms > 150) systemLogger.warn(`Slow plugin load: ${file} | ${r.ms.toFixed(0)}ms`);
            }
        } catch (error) {
            results.failed++;
            systemLogger.error(`Failed to load: ${file}`, error);
        }

        // [FIX 2] الـ require متزامن ويجمّد البوت؛ نسمح للـ event loop يتنفس بين كل ملف (keep-alive وفك التشفير)
        await new Promise(resolve => setImmediate(resolve));
    }

    systemLogger.info(`Plugins loaded: ${results.loaded} ok, ${results.failed} failed, ${results.skipped} skipped | ${(performance.now() - t0).toFixed(0)}ms`);
    return results;
}

// ==========================================
// 1️⃣1️⃣ Permission Checkers
// ==========================================
function isSuperOwner(number) {
    return config.superOwners?.includes(number) || number === OWNER_NUMBER;
}

async function checkCommandPermissions(command, senderInfo, sock, message) {
    const isSuper = isSuperOwner(senderInfo.number);
    
    // ✅ تم التعديل: إزالة فلتر النخبة العام من هنا
    // الفحص صار مباشراً في handleMessages بعد التأكد من وجود الأمر

    if (command.owner && !isSuper && !config.owners?.includes(senderInfo.number)) {
        await sock.sendMessage(senderInfo.remoteJid, {
            text: config.messages?.ownerOnly || '👑 هذا الأمر للمالك فقط.'
        }, { quoted: message });
        return false;
    }

    if (command.group && !senderInfo.isGroup) {
        await sock.sendMessage(senderInfo.remoteJid, {
            text: config.messages?.groupOnly || '👥 هذا الأمر للمجموعات فقط.'
        }, { quoted: message });
        return false;
    }

    if (command.elite && !isSuper && !isElite(senderInfo.number)) {
        await sock.sendMessage(senderInfo.remoteJid, {
            text: '⭐ هذا الأمر للنخبة فقط.'
        }, { quoted: message });
        return false;
    }

    if (command.category === 'ألعاب' && cache.gamesStatus.value === '[off]') {
        await sock.sendMessage(senderInfo.remoteJid, {
            text: '🎮 الألعاب معطلة حالياً.'
        }, { quoted: message });
        return false;
    }

    return true;
}

// ==========================================
// 1️⃣2️⃣ Command Executor
// ==========================================
async function executeCommand(sock, message, command, args, senderInfo, startTime) {
    const execStart = performance.now();

    if (!command.stats) command.stats = { total: 0, errors: 0, avgExecTime: 0 };

    // [FIX 8] تنبيه إذا أمر طوّل (يساعدك تعرف أي إضافة هي البطيئة)
    const slowTimer = setTimeout(() => {
        cmdLogger.warn(`${command.name} still running after ${SLOW_COMMAND_MS / 1000}s`);
    }, SLOW_COMMAND_MS);

    try {
        const context = {
            ...message,
            args,
            command: command.name,
            prefix: config.prefix || '.',
            senderInfo,
            reply: async (text, options = {}) => {
                // [FIX 11] quoted لازم يكون في الوسيط الثالث (options) مو داخل المحتوى، وإلا ما يشتغل الاقتباس
                return sock.sendMessage(senderInfo.remoteJid, { text, ...options }, { quoted: message }).catch(err => {
                    systemLogger.error('Reply failed', err);
                });
            },
            edit: async (text) => {
                if (sock.sendMessage && message.key) {
                    return sock.sendMessage(senderInfo.remoteJid, {
                        text,
                        edit: message.key
                    }).catch(() => {
                        return context.reply(text);
                    });
                }
                return context.reply(text);
            }
        };

        await command.exec(sock, context, args);

        command.stats.total++;
        const execTime = performance.now() - execStart;

        const oldAvg = command.stats.avgExecTime;
        command.stats.avgExecTime = ((oldAvg * (command.stats.total - 1)) + execTime) / command.stats.total;

        cmdLogger.success(`${command.name} | ${execTime.toFixed(2)}ms | من: ${senderInfo.number}`);
        // عدّاد الواجهة (إن وُجدت) — دقيق ولا يعتمد على قراءة نص اللوق
        try { require('../utils/deathui').recordCommand({ ms: execTime }); } catch (e) {}

    } catch (error) {
        command.stats.errors++;
        cmdLogger.error(`${command.name} failed`, error);

        await sock.sendMessage(senderInfo.remoteJid, {
            text: config.messages?.error || '❌ حدث خطأ أثناء التنفيذ.'
        }, { quoted: message }).catch(() => {});
    } finally {
        clearTimeout(slowTimer);
    }
}

// ==========================================
// 1️⃣3️⃣ Watcher / Hot Reload
// ==========================================
// [FIX 2] main.js كان يراقب الملفات لكنه فقط يعيد require بدون ما يحدّث الأوامر (فالتعديلات ما تنطبق إلا بـ .reload).
// الحين main.js ينادي هذي الدوال.
function reloadPlugin(filePath) {
    const full = path.resolve(filePath);
    const file = path.basename(full);
    if (path.dirname(full) !== path.resolve(PLUGINS_DIR) || !file.endsWith('.js') || file.startsWith('.')) {
        return { ok: false, reason: 'not a top-level plugin file' };
    }
    try {
        const r = loadPluginFile(full, { replace: true });
        if (r.ok) systemLogger.success(`🔄 Hot-reloaded: ${file}`);
        else systemLogger.warn(`Hot-reload skipped ${file}: ${r.reason}`);
        return r;
    } catch (err) {
        systemLogger.error(`Hot-reload error for ${file}`, err);
        return { ok: false, reason: err.message };
    }
}

function unloadPlugin(filePath) {
    const full = path.resolve(filePath);
    const file = path.basename(full);
    const name = pluginFiles.get(file);
    try { delete require.cache[require.resolve(full)]; } catch (e) {}
    if (!name) return false;
    removeCommand(name);
    pluginFiles.delete(file);
    systemLogger.warn(`Unloaded plugin: ${file}`);
    return true;
}

// ==========================================
// 1️⃣4️⃣ Main Message Handler (مع دعم استجابات الأزرار)
// ==========================================
let isSystemInitialized = false;
let initPromise = null;

// [FIX 2] كان رسالتين بنفس اللحظة يشغّلون التهيئة مرتين (أوامر مكررة + تحميل مضاعف). الحين وعد واحد مشترك.
function ensureInitialized(sock) {
    if (!initPromise) {
        initPromise = (async () => {
            registerInternalCommands();
            await initializePlugins(sock);
            systemLogger.success('System initialized successfully');
            isSystemInitialized = true;
        })().catch((error) => {
            initPromise = null;
            systemLogger.error('Initialization failed', error);
            throw error;
        });
    }
    return initPromise;
}

// [FIX 3] يوجّه ردود الأزرار/النصوص للأوامر. الأمر يرجّع false = "هذا مو لي" فيكمل للي بعده.
// (قبل: أول أمر عنده handleButton ياخذ كل شي ويوقف الباقي)
async function dispatchButton(sock, message, payload, senderNumber) {
    for (const [name, cmd] of cache.commands) {
        if (cmd.isHiddenAlias || typeof cmd.handleButton !== 'function') continue;
        try {
            const result = await cmd.handleButton(sock, message, payload, senderNumber);
            if (result !== false) return true;
        } catch (err) {
            systemLogger.error(`خطأ في معالج الأزرار لأمر ${name}:`, err);
        }
    }
    return false;
}

// [FIX 4] كان يعالج أول رسالة بس من كل upsert والباقي يضيع. الحين الكل (بالترتيب) بدون ما نعطّل المستدعي.
async function handleMessages(sock, upsert) {
    const messages = upsert?.messages;
    if (!messages?.length) return;

    (async () => {
        for (const message of messages) {
            try {
                await processMessage(sock, message);
            } catch (e) {
                systemLogger.error('Unhandled processing error', e);
            }
        }
    })();
}

// [FIX 12] رسائل الـ backlog (اللي تنرسل لك بعد ما يشتغل البوت من إطفاء) كانت كل وحدة تطبع سطر تحذير؛ الحين سطر ملخّص واحد
let staleN = 0, staleOldest = 0, staleTimer = null;
function noteStale(ageSec) {
    staleN++;
    staleOldest = Math.max(staleOldest, ageSec);
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
        systemLogger.warn(`Ignored ${staleN} stale message(s) (oldest ${fmtAge(staleOldest)})`);
        staleN = 0;
        staleOldest = 0;
    }, 1500);
    if (staleTimer.unref) staleTimer.unref();
}

async function processMessage(sock, message) {
    const startTime = performance.now();

    try {
        if (!message?.key || !message.key.remoteJid) {
            systemLogger.warn('Invalid message structure');
            return;
        }

        if (message.key.remoteJid === 'status@broadcast') return; // الحالات ما فيها أوامر

        if (!message.message) {
            if (message.messageStubType === 2) systemLogger.warn('Undecryptable message - waiting for sender retry');
            else systemLogger.info('Encrypted message - ignored');
            return;
        }

        // [FIX 4] تجاهل رسائل قديمة جداً (تنعاد بعد انقطاع طويل) عشان ما تتنفذ أوامر قديمة
        const ts = Number(message.messageTimestamp) || 0;
        const ageSec = ts ? Date.now() / 1000 - ts : 0;
        if (ageSec > MAX_MESSAGE_AGE_S) {
            noteStale(ageSec);
            return;
        }

        if (!isSystemInitialized) {
            await ensureInitialized(sock);
        }

        const body = extractMessageText(message);
        const prefix = config.prefix || '.';

        if (!body || typeof body !== 'string') {
            return;
        }

        // ==========================================
        //  ✅ معالجة استجابات الأزرار (بدون بادئة)
        // ==========================================
        const inner = unwrapMessage(message.message); // [FIX 3] يشتغل داخل المحادثات المؤقتة
        const buttonResponse = inner?.buttonsResponseMessage;
        const listResponse = inner?.listResponseMessage;

        if (buttonResponse || listResponse) {
            const selectedId = buttonResponse?.selectedButtonId ||
                               listResponse?.singleSelectReply?.selectedRowId;

            if (selectedId) {
                const handled = await dispatchButton(sock, message, selectedId, rawSenderNumber(message));
                if (!handled) {
                    await sock.sendMessage(message.key.remoteJid, {
                        text: '❌ هذا الزر غير مدعوم حالياً.'
                    }).catch(() => {});
                }
                return;
            }
        }

        // ==========================================
        //  ✅ دعم الأرقام بدون نقطة لأمر .هات
        // ==========================================
        const isNumber = /^\d+$/.test(body);
        if (isNumber && message.key.remoteJid) {
            const senderNumber = rawSenderNumber(message);

            try {
                const hatModule = require('../plugins/هات');
                const userSessions = hatModule.userSessions || {};

                if (userSessions && userSessions[senderNumber]) {
                    const args = [body];
                    if (hatModule && hatModule.execute) {
                        await hatModule.execute(sock, message, args);
                        return;
                    }
                }
            } catch (e) {
                // تجاهل إذا كان ملف .هات غير موجود
            }
        }

        // ==========================================
        //  ✅ دعم عام للأزرار التفاعلية (بدون بادئة)
        // ==========================================
        if (!body.startsWith(prefix)) {
            await dispatchButton(sock, message, body, rawSenderNumber(message));
            return;
        }

        // ==========================================
        //  استمرار المعالجة العادية للأوامر
        // ==========================================
        const parts = body.slice(prefix.length).trim().split(/\s+/);
        const commandName = parts?.[0]?.toLowerCase()?.trim();

        if (!commandName || commandName.length > MAX_COMMAND_NAME_LENGTH) {
            systemLogger.warn(`Invalid command name: ${commandName}`);
            return;
        }

        const args = parts.slice(1);

        // [FIX 8] يكشف إذا التأخير من واتساب/فك التشفير (مو من الكود)
        if (ageSec > LATE_WARN_S) {
            systemLogger.warn(`Late message: "${commandName}" arrived ${fmtAge(ageSec)} after it was sent`);
        }

        if (cache.botStatus.value === '[off]' && commandName !== 'bot') {
            systemLogger.warn('Bot is disabled');
            return;
        }

        const senderInfo = getSenderInfo(message, sock);
        if (!senderInfo) return;

        // ==========================================
        //  ✅ فلتر النخبة المباشر — قبل أي تنفيذ
        // ==========================================
        if (!PUBLIC_COMMANDS.includes(commandName) && !isElite(senderInfo.number)) {
            systemLogger.warn(`Elite-only: ignored command "${commandName}" from ${senderInfo.number}`);
            return; // تجاهل صامت — بدون أي رد
        }

        systemLogger.info(`Command: ${commandName} | From: ${senderInfo.number} | Args: ${args.length}`);

        let command = cache.commands.get(commandName);
        if (!command) {
            for (const [name, cmd] of cache.commands) {
                if (cmd.aliases && cmd.aliases.includes(commandName)) {
                    command = cmd;
                    break;
                }
            }
        }

        if (!command) {
            systemLogger.warn(`Unknown command: ${commandName}`);

            if (config.suggestCommands) {
                const suggestion = findSimilarCommand(commandName);
                if (suggestion) {
                    await sock.sendMessage(senderInfo.remoteJid, {
                        text: `❓ هل تقصد: ${prefix}${suggestion.name}؟`
                    }, { quoted: message }).catch(() => {});
                }
            }
            return;
        }

        const isOwnerLike = isSuperOwner(senderInfo.number) || Boolean(message.key.fromMe);
        const rateLimit = checkRateLimit(senderInfo.number, isOwnerLike);
        if (!rateLimit.allowed) {
            if (rateLimit.silent) return; // [FIX 1] ردينا مرة، لا نكرر
            const msg = rateLimit.reason === 'global'
                ? '🌐 الحد العام للطلبات - انتظر قليلاً'
                : `⏳ انتظر ${rateLimit.retryAfter} ثانية.`;

            await sock.sendMessage(senderInfo.remoteJid, { text: msg }, { quoted: message }).catch(() => {});
            return;
        }

        const cooldown = checkCooldown(command, senderInfo.number);
        if (!cooldown.allowed) {
            await sock.sendMessage(senderInfo.remoteJid, {
                text: `⏳ انتظر ${cooldown.timeLeft} ثانية.`
            }, { quoted: message }).catch(() => {});
            return;
        }

        const hasPermission = await checkCommandPermissions(command, senderInfo, sock, message);
        if (!hasPermission) return;

        commitCooldown(command, senderInfo.number); // [FIX 5]

        await executeCommand(sock, message, command, args, senderInfo, startTime);

    } catch (error) {
        systemLogger.error(`Global error`, error);

        if (message?.key?.remoteJid) {
            await sock.sendMessage(message.key.remoteJid, {
                text: config.messages?.error || '❌ خطأ غير متوقع.'
            }, { quoted: message }).catch(() => {});
        }
    }
}

// ==========================================
// 1️⃣5️⃣ Helper Functions
// ==========================================
function findSimilarCommand(input) {
    const commands = Array.from(cache.commands.keys());
    const threshold = 0.7;
    
    for (const cmd of commands) {
        const similarity = calculateStringSimilarity(input, cmd);
        if (similarity > threshold) {
            return cache.commands.get(cmd);
        }
    }
    return null;
}

function calculateStringSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const editDistance = levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1, str2) {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
    
    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;
    
    for (let j = 1; j <= str2.length; j++) {
        for (let i = 1; i <= str1.length; i++) {
            const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1,
                matrix[j - 1][i] + 1,
                matrix[j - 1][i - 1] + indicator
            );
        }
    }
    
    return matrix[str2.length][str1.length];
}

// ==========================================
// 1️⃣6️⃣ Exports
// ==========================================
module.exports = {
    handleMessages,
    cmd,
    commands: cache.commands,
    
    handleMessagesLoader: () => {
        systemLogger.success('⚡ نظام الرسائل الجبار جاهز (توافقية)!');
    },
    
    createPluginHandler: (options = {}) => {
        if (!options.command || typeof options.execute !== 'function') {
            throw new Error('Invalid plugin options');
        }

        const handler = options.execute;
        Object.assign(handler, {
            elite: Boolean(options.elite),
            group: Boolean(options.group),
            desc: options.desc || 'لا يوجد وصف',
            command: options.command,
            usage: options.usage || '',
            category: options.category || 'عام',
            cooldown: Math.max(0, options.cooldown || 0),
            owner: Boolean(options.owner),
            aliases: Array.isArray(options.aliases) ? options.aliases : [],
            handleButton: options.handleButton || null,
            execute: options.execute
        });
        
        return handler;
    },
    
    initialize: async (sock) => {
        await ensureInitialized(sock);
    },
    
    updateCache: updateCache,
    reloadPlugin,
    unloadPlugin,
    
    getStats: () => ({
        commands: cache.commands.size,
        totalRequests: cache.globalRateLimit.hits,
        activeUsers: cache.userRateLimits.size,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    })
};

systemLogger.success('Bot handler module loaded successfully');