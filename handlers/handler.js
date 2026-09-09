// 🚀 handler.js - النسخة فائقة السرعة (Ultra-Optimized) + تشفير الأزرار + تجاهل صامت
const { loadPlugins: loadExternalPlugins } = require('./plugins');
const config = require('../config');
const logger = require('../utils/console');
const fs = require('fs-extra');
const path = require('path');
const { isElite } = require('../haykala/elite');
const { playSound } = require('../main');
const { performance } = require('perf_hooks');
const crypto = require('crypto');

// ==========================================
// ✅ نظام تشفير الأزرار (Secure Button System)
// ==========================================
const BUTTON_SECRET = config.buttonSecret || 'DEATH_BOT_SECRET_KEY_2026';

/**
 * توليد معرف زر مشفر (خاص بالمستخدم)
 */
function generateButtonId(payload, userJid, expiresIn = 300) {
    const timestamp = Date.now() + expiresIn * 1000;
    const data = `${payload}|${userJid}|${timestamp}`;
    const signature = crypto.createHmac('sha256', BUTTON_SECRET).update(data).digest('hex').slice(0, 16);
    return `${payload}|${userJid}|${timestamp}|${signature}`;
}

/**
 * التحقق من صحة الزر المشفر (خاص بالمستخدم)
 */
function verifyButton(buttonId, userJid) {
    const parts = buttonId.split('|');
    if (parts.length !== 4) {
        return { valid: false, payload: null, error: 'تنسيق الزر غير صحيح' };
    }

    const [payload, storedUserJid, timestampStr, signature] = parts;
    const timestamp = parseInt(timestampStr, 10);

    if (Date.now() > timestamp) {
        return { valid: false, payload: null, error: 'انتهت صلاحية الزر' };
    }

    if (storedUserJid !== userJid) {
        return { valid: false, payload: null, error: 'هذا الزر ليس لك' };
    }

    const data = `${payload}|${storedUserJid}|${timestamp}`;
    const expectedSignature = crypto.createHmac('sha256', BUTTON_SECRET).update(data).digest('hex').slice(0, 16);
    if (signature !== expectedSignature) {
        return { valid: false, payload: null, error: 'توقيع الزر غير صالح' };
    }

    return { valid: true, payload };
}

/**
 * توليد معرف زر عام (للمشرفين، لا يرتبط بمستخدم معين)
 */
function generatePublicButtonId(payload, expiresIn = 120) {
    const timestamp = Date.now() + expiresIn * 1000;
    const data = `public_${payload}|${timestamp}`;
    const signature = crypto.createHmac('sha256', BUTTON_SECRET).update(data).digest('hex').slice(0, 16);
    return `public_${payload}|${timestamp}|${signature}`;
}

/**
 * التحقق من الزر العام (يتجاوز التحقق من المستخدم)
 */
function verifyPublicButton(buttonId) {
    const cleanId = buttonId.replace(/^public_/, '');
    const parts = cleanId.split('|');
    if (parts.length !== 3) {
        return { valid: false, payload: null, error: 'تنسيق الزر غير صحيح' };
    }

    const [payload, timestampStr, signature] = parts;
    const timestamp = parseInt(timestampStr, 10);

    if (Date.now() > timestamp) {
        return { valid: false, payload: null, error: 'انتهت صلاحية الزر' };
    }

    const data = `public_${payload}|${timestamp}`;
    const expectedSignature = crypto.createHmac('sha256', BUTTON_SECRET).update(data).digest('hex').slice(0, 16);
    if (signature !== expectedSignature) {
        return { valid: false, payload: null, error: 'توقيع الزر غير صالح' };
    }

    return { valid: true, payload };
}

// ==========================================
// ✅ التأكد من وجود config (حماية من الأخطاء)
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
const IS_DEBUG = config.logging.level === 'debug';

if (!config.messages) config.messages = {};
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
    if (!config.messages[key]) config.messages[key] = value;
}

// ==========================================
// 1️⃣ بنية بيانات محسّنة مع TTL و Button Handlers
// ==========================================
const cache = {
    commands: new Map(),
    buttonHandlers: new Set(),
    botStatus: { value: null, lastUpdate: 0, duration: 5000 },
    eliteMode: { value: null, lastUpdate: 0, duration: 10000 },
    gamesStatus: { value: null, lastUpdate: 0, duration: 15000 },
    antispamStatus: { value: null, lastUpdate: 0, duration: 20000 },
    userRateLimits: new Map(),
    globalRateLimit: { hits: 0, windowStart: Date.now() }
};

// ==========================================
// 2️⃣ Constants & Security Config
// ==========================================
const OWNER_NUMBER = "967733584324";
const FORBIDDEN_COMMANDS = ['تخريب', 'hack', 'destruct', 'crash', 'exec', 'eval', 'shell'];
const MAX_COMMAND_NAME_LENGTH = 50;
const RATE_LIMIT_WINDOW = 60000;
const GLOBAL_MAX_REQUESTS = 50;
const USER_MAX_REQUESTS = 10;

// ==========================================
// 3️⃣ Logging System
// ==========================================
const createLogger = (namespace) => ({
    success: (msg) => logger.success(`✅ [${namespace}] ${msg}`),
    error: (msg, err) => logger.error(`❌ [${namespace}] ${msg}${err ? ' | ' + err.stack?.split('\n')[0] : ''}`),
    warn: (msg) => logger.warn(`⚠️ [${namespace}] ${msg}`),
    info: (msg) => logger.info(`ℹ️ [${namespace}] ${msg}`)
});
const systemLogger = createLogger('SYSTEM');
const cmdLogger = createLogger('COMMAND');
const securityLogger = createLogger('SECURITY');

// ==========================================
// 4️⃣ Rate Limiting Engine
// ==========================================
function checkRateLimit(senderNumber, now = Date.now()) {
    if (now - cache.globalRateLimit.windowStart > RATE_LIMIT_WINDOW * 5) {
        cache.userRateLimits.clear();
        cache.globalRateLimit.hits = 0;
        cache.globalRateLimit.windowStart = now;
    }

    if (cache.globalRateLimit.hits > GLOBAL_MAX_REQUESTS) {
        if(IS_DEBUG) securityLogger.warn(`Global rate limit exceeded: ${cache.globalRateLimit.hits}`);
        return { allowed: false, reason: 'global' };
    }
    cache.globalRateLimit.hits++;

    const userLimit = cache.userRateLimits.get(senderNumber) || { hits: [], windowStart: now };
    userLimit.hits = userLimit.hits.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (userLimit.hits.length >= USER_MAX_REQUESTS) {
        const retryAfter = Math.ceil((RATE_LIMIT_WINDOW - (now - userLimit.hits[0])) / 1000);
        return { allowed: false, reason: 'user', retryAfter };
    }
    
    userLimit.hits.push(now);
    cache.userRateLimits.set(senderNumber, userLimit);
    
    return { allowed: true };
}

// ==========================================
// 5️⃣ Cooldown System
// ==========================================
function checkCooldown(command, senderNumber, now = Date.now()) {
    if (!command.cooldown) return { allowed: true };
    if (!command.lastUsed) command.lastUsed = new Map();
    
    const lastUsed = command.lastUsed.get(senderNumber) || 0;
    const timeLeft = command.cooldown - Math.floor((now - lastUsed) / 1000);
    
    if (command.lastUsed.size > 100) { 
        for (const [user, time] of command.lastUsed.entries()) {
            if (now - time > command.cooldown * 1000) command.lastUsed.delete(user);
        }
    }

    if (timeLeft > 0) return { allowed: false, timeLeft };
    
    command.lastUsed.set(senderNumber, now);
    return { allowed: true };
}

// ==========================================
// 6️⃣ Message Parser 🚀 (محسّنة: Quick Extraction)
// ==========================================
function extractMessageText(message) {
    try {
        const msg = message.message;
        if (!msg) return null;

        const quickText = msg.conversation || msg.extendedTextMessage?.text;
        if (quickText) return quickText.trim();

        const textSources = [
            msg.imageMessage?.caption,
            msg.videoMessage?.caption,
            msg.documentMessage?.caption,
            msg.buttonsResponseMessage?.selectedDisplayText,
            msg.listResponseMessage?.title,
            msg.templateButtonReplyMessage?.selectedDisplayText,
            msg.viewOnceMessage?.message?.imageMessage?.caption,
            msg.viewOnceMessage?.message?.videoMessage?.caption,
            msg.interactiveResponseMessage?.body?.text,
            (() => {
                try {
                    if (msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
                        return JSON.parse(msg.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id;
                    }
                    return null;
                } catch(e) { return null; }
            })()
        ];

        return textSources.find(text => typeof text === 'string' && text.trim())?.trim() || null;
    } catch (error) {
        if(IS_DEBUG) systemLogger.error('Failed to extract message text', error);
        return null;
    }
}

function getSenderInfo(message) {
    try {
        const remoteJid = message.key.remoteJid || '';
        const isGroup = remoteJid.endsWith('@g.us');

        return {
            number: isGroup ? message.key.participant?.split('@')[0] : remoteJid.split('@')[0],
            isGroup,
            remoteJid,
            messageId: message.key.id,
            timestamp: message.messageTimestamp || Math.floor(Date.now() / 1000)
        };
    } catch (error) {
        return null;
    }
}

// ==========================================
// 7️⃣ Cache Manager (Background Task)
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
            entry.value = content ? content.trim() : null;
            entry.lastUpdate = now;
        } catch (error) {}
    };

    await updateCacheEntry('botStatus', 'bot.txt');
    await updateCacheEntry('eliteMode', 'mode.txt');
    await updateCacheEntry('gamesStatus', 'games.txt');
    await updateCacheEntry('antispamStatus', 'antispam.txt');
}
setInterval(() => updateCache(), 10000);

// ==========================================
// 8️⃣ Command Registration
// ==========================================
function cmd(options = {}) {
    if (!options.name || typeof options.exec !== 'function') throw new Error('❌ اسم الأمر ودالة التنفيذ إلزامية');

    const commandKey = options.name.toLowerCase().trim();
    if (commandKey.length > MAX_COMMAND_NAME_LENGTH) throw new Error(`❌ اسم الأمر طويل جداً`);
    if (cache.commands.has(commandKey)) return;

    const allNames = [commandKey, ...(options.aliases || []).map(a => a.toLowerCase().trim())];
    if (allNames.some(name => FORBIDDEN_COMMANDS.includes(name))) {
        throw new Error(`❌ الأمر "${commandKey}" محظور لأسباب أمنية`);
    }

    const cmdObject = {
        name: options.name,
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
        handleButton: options.handleButton || null
    };

    cache.commands.set(commandKey, cmdObject);
    if (typeof options.handleButton === 'function') cache.buttonHandlers.add(options.handleButton);
}

// ==========================================
// 9️⃣ Internal Commands
// ==========================================
function registerInternalCommands() {
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
            const oldHandlers = new Set(cache.buttonHandlers);
            
            try {
                cache.commands.clear();
                cache.buttonHandlers.clear();
                cache.userRateLimits.clear();
                
                registerInternalCommands();
                await loadExternalPlugins();
                
                const execTime = (performance.now() - start).toFixed(2);
                await sock.sendMessage(m.key.remoteJid, { text: `✅ تم Reload في ${execTime}ms\n📊 الأوامر: ${cache.commands.size}` }, { quoted: m });
                
                if (IS_DEBUG) systemLogger.success(`Reload completed in ${execTime}ms`);
            } catch (error) {
                cache.commands = oldCommands;
                cache.buttonHandlers = oldHandlers;
                if (IS_DEBUG) systemLogger.error('Reload failed', error);
                await sock.sendMessage(m.key.remoteJid, { text: `❌ فشل Reload: ${error.message}` }, { quoted: m });
            }
        }
    });
}

// ==========================================
// 🔟 Plugin Loader
// ==========================================
async function initializePlugins(sock = null) {
    const pluginsPath = path.join(__dirname, '../plugins');
    const files = await fs.readdir(pluginsPath).catch(() => []);
    let loaded = 0;

    for (const file of files) {
        if (!file.endsWith('.js') || file.startsWith('.')) continue;
        try {
            const filePath = path.join(pluginsPath, file);
            delete require.cache[require.resolve(filePath)];
            const plugin = require(filePath);
            
            if (!plugin.command || typeof plugin.execute !== 'function') continue;

            const cmdName = plugin.command.toLowerCase().trim();
            const aliases = (plugin.aliases || []).map(a => a.toLowerCase().trim());
            
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
                handleButton: plugin.handleButton || null
            });

            const mainCmdObj = cache.commands.get(cmdName);
            aliases.forEach(alias => {
                if (alias && !cache.commands.has(alias)) {
                    cache.commands.set(alias, { ...mainCmdObj, name: cmdName, isHiddenAlias: true });
                }
            });
            loaded++;
        } catch (error) {
            if(IS_DEBUG) systemLogger.error(`Failed to load: ${file}`, error);
        }
    }
    systemLogger.info(`Plugins loaded: ${loaded}`);
}

// ==========================================
// 1️⃣1️⃣ Permission Checkers (مع تجاهل صامت لغير النخبة)
// ==========================================
function isSuperOwner(number) {
    return config.superOwners?.includes(number) || number === OWNER_NUMBER;
}

async function checkCommandPermissions(command, senderInfo, sock, message) {
    const isSuper = isSuperOwner(senderInfo.number);
    
    // ✅ تجاهل صامت لغير النخبة (لا رسائل، لا ردود)
    if (cache.eliteMode.value === '[on]' && !isSuper && !isElite(senderInfo.number)) {
        return false; // تجاهل تام
    }
    if (command.elite && !isSuper && !isElite(senderInfo.number)) {
        return false; // تجاهل تام
    }

    if (command.owner && !isSuper && !config.owners?.includes(senderInfo.number)) {
        await sock.sendMessage(senderInfo.remoteJid, { text: config.messages?.ownerOnly, quoted: { key: message.key } });
        return false;
    }
    if (command.group && !senderInfo.isGroup) {
        await sock.sendMessage(senderInfo.remoteJid, { text: config.messages?.groupOnly, quoted: { key: message.key } });
        return false;
    }
    if (command.category === 'ألعاب' && cache.gamesStatus.value === '[off]') {
        await sock.sendMessage(senderInfo.remoteJid, { text: '🎮 الألعاب معطلة حالياً.', quoted: { key: message.key } });
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
    
    try {
        const context = {
            ...message,
            args,
            command: command.name,
            prefix: config.prefix || '.',
            senderInfo,
            commands: cache.commands,
            reply: async (text, options = {}) => {
                return sock.sendMessage(senderInfo.remoteJid, {
                    text,
                    ...options,
                    quoted: message 
                }).catch(err => {
                    if (IS_DEBUG) systemLogger.error('Reply failed', err);
                });
            }
        };

        await command.exec(sock, context, args);

        command.stats.total++;
        const execTime = performance.now() - execStart;
        command.stats.avgExecTime = ((command.stats.avgExecTime * (command.stats.total - 1)) + execTime) / command.stats.total;
        
        if (IS_DEBUG) cmdLogger.success(`${command.name} | ${execTime.toFixed(2)}ms`);

    } catch (error) {
        command.stats.errors++;
        if (IS_DEBUG) cmdLogger.error(`${command.name} failed`, error);
        try { playSound('ERROR'); } catch(e) {}
        
        await sock.sendMessage(senderInfo.remoteJid, {
            text: config.messages?.error || '❌ حدث خطأ أثناء التنفيذ.',
            quoted: { key: message.key } 
        }).catch(() => {});
    }
}

// ==========================================
// 1️⃣3️⃣ Watcher / Hot Reload
// ==========================================
function watchPlugins() {
    const pluginsDir = path.join(__dirname, '../plugins');
    fs.watch(pluginsDir, { recursive: false }, async (eventType, filename) => {
        if (!filename || !filename.endsWith('.js') || filename.startsWith('.')) return;
        const fullPath = path.join(pluginsDir, filename);
        
        try {
            if (require.resolve && require.cache[require.resolve(fullPath)]) {
                delete require.cache[require.resolve(fullPath)];
            }
            const plugin = require(fullPath);
            if (plugin.command && typeof plugin.execute === 'function') {
                const cmdName = plugin.command.toLowerCase().trim();
                const aliases = (plugin.aliases || []).map(a => a.toLowerCase().trim());
                
                const oldCmd = cache.commands.get(cmdName);
                if (oldCmd && oldCmd.handleButton) cache.buttonHandlers.delete(oldCmd.handleButton);

                cache.commands.delete(cmdName);
                aliases.forEach(alias => cache.commands.delete(alias));
                
                const cmdConfig = {
                    name: cmdName,
                    exec: plugin.execute,
                    handleButton: plugin.handleButton || null
                };

                cmd(cmdConfig);
                if (IS_DEBUG) systemLogger.success(`🔄 Hot-reloaded: ${filename}`);
            }
        } catch (err) {}
    });
}

let hatModuleCache = null;
try { hatModuleCache = require('../plugins/هات'); } catch (e) {}

// ==========================================
// 1️⃣4️⃣ Main Message Handler (مع تجاهل صامت لغير النخبة)
// ==========================================
let isSystemInitialized = false;

async function ensureInitialized(sock) {
    if (isSystemInitialized) return;
    try {
        registerInternalCommands();
        await initializePlugins(sock);
        watchPlugins();
        systemLogger.success('🚀 النظام الخارق جاهز مع تشفير الأزرار وتجاهل صامت!');
        isSystemInitialized = true;
    } catch (error) {}
}

async function handleMessages(sock, { messages }) {
    if (!messages?.[0]) return;

    const message = messages[0];
    const startTime = performance.now();
    const currentTimestamp = Date.now(); 

    try {
        if (!message.key?.remoteJid || !message.message) return;
        if (!isSystemInitialized) await ensureInitialized(sock);

        const body = extractMessageText(message);
        if (!body || typeof body !== 'string') return;

        const prefix = config.prefix || '.';
        const isCommand = body.startsWith(prefix);

        // ==========================================
        // 🚀 1. معالجة الأوامر العادية
        // ==========================================
        if (isCommand) {
            const parts = body.slice(prefix.length).trim().split(/\s+/);
            const commandName = parts?.[0]?.toLowerCase()?.trim();
            if (!commandName || commandName.length > MAX_COMMAND_NAME_LENGTH) return;

            const command = cache.commands.get(commandName);
            if (!command) return;

            const args = parts.slice(1);
            if (cache.botStatus.value === '[off]' && commandName !== 'bot') return;

            const senderInfo = getSenderInfo(message);
            if (!senderInfo) return;

            // ✅ التحقق من الصلاحية (مع تجاهل صامت)
            if (command.elite && !isSuperOwner(senderInfo.number) && !isElite(senderInfo.number)) {
                return; // تجاهل صامت
            }
            if (cache.eliteMode.value === '[on]' && !isSuperOwner(senderInfo.number) && !isElite(senderInfo.number)) {
                return; // تجاهل صامت
            }

            if (IS_DEBUG) systemLogger.info(`Command: ${commandName} | From: ${senderInfo.number}`);

            const rateLimit = checkRateLimit(senderInfo.number, currentTimestamp);
            if (!rateLimit.allowed) {
                const msg = rateLimit.reason === 'global' ? '🌐 الحد العام للطلبات' : `⏳ انتظر ${rateLimit.retryAfter} ث.`;
                await sock.sendMessage(senderInfo.remoteJid, { text: msg, quoted: { key: message.key } }).catch(() => {});
                return;
            }

            const cooldown = checkCooldown(command, senderInfo.number, currentTimestamp);
            if (!cooldown.allowed) {
                await sock.sendMessage(senderInfo.remoteJid, { text: `⏳ انتظر ${cooldown.timeLeft} ث.`, quoted: { key: message.key } }).catch(() => {});
                return;
            }

            const hasPermission = await checkCommandPermissions(command, senderInfo, sock, message);
            if (!hasPermission) return;

            setImmediate(async () => {
                await executeCommand(sock, message, command, args, senderInfo, startTime);
            });
            
            return;
        }

        // ==========================================
        //  ✅ 2. استخراج معرف الزر
        // ==========================================
        let selectedId = null;
        let buttonType = '';

        if (message.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
            try { 
                const parsed = JSON.parse(message.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
                selectedId = parsed.id;
                buttonType = 'native';
            } catch(e){}
        } else if (message.message?.buttonsResponseMessage) {
            selectedId = message.message.buttonsResponseMessage.selectedButtonId;
            buttonType = 'buttons';
        } else if (message.message?.listResponseMessage) {
            selectedId = message.message.listResponseMessage.singleSelectReply?.selectedRowId;
            buttonType = 'list';
        } else if (message.message?.templateButtonReplyMessage) {
            selectedId = message.message.templateButtonReplyMessage.selectedId;
            buttonType = 'template';
        }
        
        const senderInfo = getSenderInfo(message);
        if (!senderInfo) return;
        const senderNumber = senderInfo.number;

        // ==========================================
        //  ✅ 3. التحقق من النخبة (تجاهل صامت)
        // ==========================================
        const isEliteMember = isElite(senderNumber) || isSuperOwner(senderNumber);

        // ✅ إذا كان الزر خاصاً بالنخبة والمستخدم ليس نخبة → تجاهل صامت
        if (selectedId && !isEliteMember) {
            return; // تجاهل تام، لا ردود، لا رسائل
        }

// ==========================================
//  ✅ 4. معالجة الأزرار العامة (للمشرفين) - مع Debug كامل
// ==========================================
if (selectedId && selectedId.startsWith('public_')) {
    console.log('🔍 [DEBUG] تم استقبال زر عام:', selectedId);
    
    // ✅ استخراج وتأكيد معرف الشخص الذي ضغط على الزر
    const senderJid = message.key.participant || message.key.remoteJid;
    const senderNumber = senderJid.split('@')[0] || senderJid.split(':')[0]?.replace('lid', '');

    const verification = verifyPublicButton(selectedId);
    if (!verification.valid) {
        console.log('❌ [DEBUG] التحقق من الزر العام فشل:', verification.error);
        return;
    }

    const payload = verification.payload;
    console.log('✅ [DEBUG] الزر العام صالح، الـ payload:', payload);
    
    // ✅ استخدام | كفاصل بدلاً من :
    if (payload.startsWith('promote|')) {
        console.log('🔍 [DEBUG] تم التعرف على طلب ترقية');
        const parts = payload.split('|');
        if (parts.length < 3) {
            console.log('❌ [DEBUG] تنسيق payload غير صحيح:', payload);
            return;
        }
        
        const chatId = parts[1];
        const targetJid = parts[2];
        console.log(`📌 [DEBUG] المجموعة: ${chatId}, الهدف: ${targetJid}`);
        
        if (chatId !== message.key.remoteJid) {
            console.log('❌ [DEBUG] المجموعة لا تتطابق');
            await sock.sendMessage(senderJid, { 
                text: '❌ هذا الزر لمجموعة أخرى.', 
                quoted: { key: message.key } 
            }).catch(() => {});
            return;
        }

        // تحقق من أن الضاغط مشرف
        try {
            const groupMetadata = await sock.groupMetadata(chatId);
            console.log('🔍 [DEBUG] تم جلب بيانات المجموعة، عدد الأعضاء:', groupMetadata.participants.length);
            
            const isAdmin = groupMetadata.participants.some(p => 
                p.id === senderJid && (p.admin === 'admin' || p.admin === 'superadmin')
            );
            
            console.log(`🔍 [DEBUG] هل الضاغط مشرف؟ ${isAdmin}, المعرف: ${senderJid}`);
            
            if (!isAdmin) {
                console.log('⛔ [DEBUG] الضاغط ليس مشرفاً');
                await sock.sendMessage(senderJid, { 
                    text: '⛔ *أنت لست مشرفاً!* لا يمكنك استخدام هذا الزر.', 
                    quoted: { key: message.key } 
                }).catch(() => {});
                return;
            }

            // منع المشرف من ترقية نفسه
            if (targetJid === senderJid) {
                console.log('⛔ [DEBUG] محاولة ترقية النفس');
                await sock.sendMessage(senderJid, { 
                    text: '❌ *لا يمكنك ترقية نفسك!*', 
                    quoted: { key: message.key } 
                }).catch(() => {});
                return;
            }

            // ✅ التحقق من أن البوت مشرف (مع تنظيف معرف البوت من رقم الجلسة)
            const botJid = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
            
            const isBotAdmin = groupMetadata.participants.some(p => 
                p.id === botJid && (p.admin === 'admin' || p.admin === 'superadmin')
            );
            
            if (!isBotAdmin) {
                console.log('⛔ [DEBUG] البوت ليس مشرفاً، لا يمكنه الترقية');
                await sock.sendMessage(senderJid, { 
                    text: '❌ *أنا لست مشرفاً!* يرجى ترقيتي أولاً لأتمكن من ترقية الأعضاء.', 
                    quoted: { key: message.key } 
                }).catch(() => {});
                return;
            }

            console.log(`🚀 [DEBUG] جاري ترقية ${targetJid}...`);
            const result = await sock.groupParticipantsUpdate(chatId, [targetJid], 'promote');
            console.log('✅ [DEBUG] نتيجة الترقية:', result);
            
            await sock.sendMessage(chatId, {
                text: `🎉 *تمت الترقية بنجاح!*\n👤 العضو: @${targetJid.split('@')[0] || targetJid.split(':')[1]}\n🛡️ بواسطة: @${senderNumber}\n✅ أصبح مشرفاً الآن.`,
                mentions: [targetJid, senderJid]
            });
        } catch (err) {
            console.error('❌ [ERROR] فشل الترقية:', err);
            await sock.sendMessage(senderJid, { 
                text: `❌ فشل الترقية: ${err.message || 'خطأ غير معروف'}`, 
                quoted: { key: message.key } 
            }).catch(() => {});
        }
        
        return;
    }
    
    console.log('⚠️ [DEBUG] زر عام غير معروف:', payload);
    return;
}


        // ==========================================
        //  ✅ 5. التحقق من التشفير للأزرار الخاصة (للمستخدمين المسموح لهم)
        // ==========================================
        if (selectedId) {
            const verification = verifyButton(selectedId, senderNumber);
            if (!verification.valid) {
                return; // تجاهل صامت
            }

            const realButtonId = verification.payload;

            for (const handleBtn of cache.buttonHandlers) {
                try {
                    if (await handleBtn(sock, message, realButtonId, senderNumber)) {
                        return;
                    }
                } catch (err) {
                    if (IS_DEBUG) systemLogger.error('Button handler error:', err);
                }
            }
            
            return; // تجاهل صامت إذا لم يتم التعامل مع الزر
        }

        // ==========================================
        //  🚀 6. معالجة أمر .هات بدون بادئة (الأرقام)
        // ==========================================
        const isNumber = /^\d+$/.test(body);
        if (isNumber && hatModuleCache?.userSessions?.[senderNumber]) {
            if (!isEliteMember) {
                return; // تجاهل صامت
            }
            setImmediate(async () => {
                try {
                    await hatModuleCache.execute(sock, message, [body]);
                } catch(e){}
            });
            return;
        }

        // ==========================================
        //  🚀 7. الأزرار التفاعلية العادية (بدون بادئة)
        // ==========================================
        for (const handleBtn of cache.buttonHandlers) {
            try {
                if (!isEliteMember) {
                    return; // تجاهل صامت
                }
                
                const verification = verifyButton(body, senderNumber);
                if (!verification.valid) {
                    return; // تجاهل صامت
                }

                if (await handleBtn(sock, message, verification.payload, senderNumber)) {
                    return;
                }
            } catch (err) {
                if (IS_DEBUG) systemLogger.error('Button handler error:', err);
            }
        }

    } catch (error) {
        if (IS_DEBUG) systemLogger.error(`Global error`, error);
        try { playSound('ERROR'); } catch(e) {}
    }
}

// ==========================================
// 1️⃣6️⃣ Exports
// ==========================================
module.exports = {
    handleMessages,
    cmd,
    commands: cache.commands,
    generateButtonId,
    verifyButton,
    generatePublicButtonId,
    verifyPublicButton,
    createPluginHandler: (options = {}) => {
        const handler = options.execute;
        Object.assign(handler, options);
        return handler;
    },
    initialize: async (sock) => await ensureInitialized(sock)
};